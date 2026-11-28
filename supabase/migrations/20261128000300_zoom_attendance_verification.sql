-- GameChanger / Zoom identity verification
-- REVIEW CANDIDATE: local clean-install validation only. Not approved for production.

ALTER TABLE public.attendance_logs
ADD COLUMN zoom_duration_seconds INTEGER;

ALTER TABLE public.attendance_logs
ADD CONSTRAINT chk_zoom_duration_seconds
CHECK (
    zoom_duration_seconds IS NULL
    OR zoom_duration_seconds >= 0
);

ALTER TABLE public.attendance_logs
ADD COLUMN zoom_identity_verified BOOLEAN
NOT NULL DEFAULT false;

ALTER TABLE public.attendance_logs
ADD CONSTRAINT chk_zoom_identity_verified
CHECK (
    zoom_identity_verified IS FALSE
    OR (
        user_id IS NOT NULL
        AND zoom_duration_seconds IS NOT NULL
        AND nullif(btrim(zoom_user_email), '') IS NOT NULL
    )
);

CREATE OR REPLACE FUNCTION public.evaluate_zoom_attendance_threshold() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    target_duration INTEGER;
    attended_seconds NUMERIC;
    target_seconds NUMERIC;
BEGIN
    SELECT duration_minutes
    INTO target_duration
    FROM public.training_sessions
    WHERE session_id = NEW.session_id;

    IF target_duration IS NULL
       OR target_duration <= 0
    THEN
        RAISE EXCEPTION 'Invalid session duration.';
    END IF;

    IF NEW.zoom_duration_seconds IS NOT NULL THEN
        attended_seconds := NEW.zoom_duration_seconds;

        NEW.duration_minutes :=
            floor(attended_seconds / 60)::INTEGER;
    ELSE
        attended_seconds :=
            NEW.duration_minutes::NUMERIC * 60;
    END IF;

    target_seconds := target_duration::NUMERIC * 60;

    NEW.attendance_percentage := LEAST(
        100,
        ROUND(
            attended_seconds * 100 / target_seconds,
            2
        )
    );

    NEW.meets_80_percent_threshold :=
        attended_seconds * 100 >= target_seconds * 80;

    RETURN NEW;
END;
$$;

DROP TRIGGER trg_eval_attendance_threshold ON public.attendance_logs;
CREATE TRIGGER trg_eval_attendance_threshold BEFORE INSERT OR UPDATE OF duration_minutes, zoom_duration_seconds ON public.attendance_logs FOR EACH ROW EXECUTE FUNCTION public.evaluate_zoom_attendance_threshold();

CREATE FUNCTION public.zoom_attendance_payment_eligible(p_registration uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
    r public.session_registrations%ROWTYPE;
BEGIN
    SELECT *
    INTO r
    FROM public.session_registrations
    WHERE registration_id = p_registration;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF r.payment_status NOT IN (
        'FREE', 'PAID', 'WAIVED'
    )
       OR r.zoom_access_released IS NOT TRUE
    THEN
        RETURN false;
    END IF;

    -- Preserve ordinary session eligibility.

    IF NOT public.hitpay_is_sandbox_session(
        r.session_id
    ) THEN
        RETURN true;
    END IF;

    -- Protected paid sessions require PAID status.

    IF r.payment_status IS DISTINCT FROM 'PAID' THEN
        RETURN false;
    END IF;

    -- Preserve approved historical legacy payments.

    IF EXISTS (
        SELECT 1
        FROM public.hitpay_legacy_paid_registrations l
        JOIN public.payment_transactions t
          ON t.registration_id = l.registration_id
         AND t.user_id = l.user_id
         AND t.session_id = l.session_id
        WHERE l.registration_id = r.registration_id
          AND l.user_id = r.user_id
          AND l.session_id = r.session_id
          AND t.transaction_status = 'PAID'
          AND t.payment_provider IS DISTINCT FROM 'HITPAY'
          AND t.is_sandbox = false
    ) THEN
        RETURN true;
    END IF;

    -- Reject unresolved payment reconciliation.

    IF EXISTS (
        SELECT 1
        FROM public.payment_transactions t
        WHERE t.user_id = r.user_id
          AND t.session_id = r.session_id
          AND t.payment_provider = 'HITPAY'
          AND (
              t.reconciliation_required = true
              OR t.checkout_state = 'REVIEW_REQUIRED'
          )
    ) THEN
        RETURN false;
    END IF;

    -- Require complete verified HitPay evidence.

    RETURN EXISTS (
        SELECT 1
        FROM public.payment_transactions t
        WHERE t.registration_id = r.registration_id
          AND t.user_id = r.user_id
          AND t.session_id = r.session_id
          AND t.payment_provider = 'HITPAY'
          AND t.is_sandbox = true
          AND t.transaction_status = 'PAID'
          AND t.checkout_state = 'CREATED'
          AND t.reconciliation_required = false
          AND t.gateway_verified_at IS NOT NULL
          AND t.confirmed_at IS NOT NULL
          AND nullif(
              btrim(t.gateway_request_id), ''
          ) IS NOT NULL
          AND nullif(
              btrim(t.hitpay_reference_id), ''
          ) IS NOT NULL
          AND t.hmac_signature ~ '^[0-9a-fA-F]{64}$'
          AND jsonb_typeof(t.gateway_payload) = 'object'
          AND t.payment_channel IS NOT NULL
          AND t.amount > 0
          AND t.amount::TEXT NOT IN (
              'NaN', 'Infinity', '-Infinity'
          )
          AND t.currency = 'PHP'
    );
END;
$_$;

REVOKE ALL ON FUNCTION public.zoom_attendance_payment_eligible(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.zoom_import_verified_attendance(p_admin_id uuid, p_session uuid, p_expected_meeting_id text, p_rows jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
    s public.training_sessions%ROWTYPE;
    v_meeting public.zoom_verified_meetings%ROWTYPE;
    v_verified BOOLEAN;
    r JSONB;
    v_email TEXT;
    v_uid UUID;
    v_matches INTEGER;
    v_seconds INTEGER;
    v_join TIMESTAMPTZ;
    v_leave TIMESTAMPTZ;
    v_count INTEGER := 0;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        JOIN public.users u
          ON u.user_id = p.id
        WHERE p.id = p_admin_id
          AND p.role = 'admin'
          AND p.status = 'Active'
          AND u.role = 'HR_ADMIN'
          AND u.account_status = 'Active'
    ) THEN
        RAISE EXCEPTION 'Administrator access required.';
    END IF;

    SELECT *
    INTO s
    FROM public.training_sessions
    WHERE session_id = p_session
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found.';
    END IF;

    IF s.zoom_meeting_id IS NULL
       OR nullif(btrim(p_expected_meeting_id), '') IS NULL
       OR s.zoom_meeting_id::TEXT
          IS DISTINCT FROM p_expected_meeting_id
    THEN
        RAISE EXCEPTION 'Meeting identity mismatch.';
    END IF;

    IF s.session_status NOT IN (
        'Upcoming', 'Live', 'Completed'
    )
       OR s.scheduled_end IS NULL
       OR s.scheduled_end > now()
    THEN
        RAISE EXCEPTION 'Session is not ready for attendance import.';
    END IF;

    SELECT *
    INTO v_meeting
    FROM public.zoom_verified_meetings
    WHERE session_id = p_session;

    v_verified := FOUND;

    IF v_verified THEN
        IF v_meeting.zoom_meeting_id
           IS DISTINCT FROM p_expected_meeting_id
           OR v_meeting.lifecycle_status <> 'ACTIVE'
           OR s.zoom_auto_created IS NOT TRUE
        THEN
            RAISE EXCEPTION 'Meeting requires review.';
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.attendance_logs
        WHERE session_id = p_session
    ) THEN
        RAISE EXCEPTION
            'Existing attendance records are protected.';
    END IF;

    IF p_rows IS NULL
       OR jsonb_typeof(p_rows) <> 'array'
    THEN
        RAISE EXCEPTION 'Invalid attendance report.';
    END IF;

    IF jsonb_array_length(p_rows) = 0 THEN
        RAISE EXCEPTION 'Empty attendance report.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_rows) AS x(row_data)
        WHERE nullif(
            lower(btrim(x.row_data ->> 'email')), ''
        ) IS NOT NULL
        GROUP BY lower(btrim(x.row_data ->> 'email'))
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'Duplicate attendance emails.';
    END IF;

    FOR r IN
        SELECT value
        FROM jsonb_array_elements(p_rows)
    LOOP
        v_uid := NULL;
        v_matches := 0;

        v_email := lower(
            btrim(coalesce(r ->> 'email', ''))
        );

        IF jsonb_typeof(r) <> 'object'
           OR jsonb_typeof(r -> 'seconds')
              IS DISTINCT FROM 'number'
           OR (r ->> 'seconds') !~ '^[0-9]+$'
        THEN
            RAISE EXCEPTION 'Invalid attendance duration.';
        END IF;

        v_seconds := (r ->> 'seconds')::INTEGER;
        v_join := (r ->> 'join')::TIMESTAMPTZ;
        v_leave := (r ->> 'leave')::TIMESTAMPTZ;

        IF v_join IS NULL
           OR v_leave IS NULL
           OR NOT isfinite(v_join)
           OR NOT isfinite(v_leave)
           OR v_leave < v_join
           OR v_seconds >
              extract(epoch FROM v_leave - v_join)
        THEN
            RAISE EXCEPTION 'Invalid attendance timestamps.';
        END IF;

        IF v_email <> '' THEN

            IF v_verified THEN

                SELECT count(*)
                INTO v_matches
                FROM public.zoom_registrants z
                JOIN public.session_registrations sr
                  ON sr.registration_id = z.registration_id
                WHERE sr.session_id = p_session
                  AND z.zoom_meeting_id =
                      p_expected_meeting_id
                  AND lower(btrim(z.registered_email)) =
                      v_email;

                IF v_matches = 1 THEN
                    SELECT sr.user_id
                    INTO v_uid
                    FROM public.zoom_registrants z
                    JOIN public.session_registrations sr
                      ON sr.registration_id =
                         z.registration_id
                    JOIN public.users u
                      ON u.user_id = sr.user_id
                    WHERE sr.session_id = p_session
                      AND z.zoom_meeting_id =
                          p_expected_meeting_id
                      AND lower(btrim(z.registered_email)) =
                          v_email
                      AND u.role = 'MEMBER'
                      AND u.account_status = 'Active'
                      AND sr.zoom_access_released IS TRUE
                      AND public.zoom_attendance_payment_eligible(sr.registration_id)
                      AND sr.payment_status IN (
                          'FREE', 'PAID', 'WAIVED'
                      );
                END IF;

            ELSE

                SELECT count(*)
                INTO v_matches
                FROM public.users u
                WHERE lower(btrim(u.email)) = v_email;

                IF v_matches = 1 THEN
                    SELECT u.user_id
                    INTO v_uid
                    FROM public.users u
                    JOIN public.session_registrations sr
                      ON sr.user_id = u.user_id
                    WHERE sr.session_id = p_session
                      AND lower(btrim(u.email)) = v_email
                      AND u.role = 'MEMBER'
                      AND u.account_status = 'Active'
                      AND sr.zoom_access_released IS TRUE
                      AND public.zoom_attendance_payment_eligible(sr.registration_id)
                      AND sr.payment_status IN (
                          'FREE', 'PAID', 'WAIVED'
                      );
                END IF;

            END IF;
        END IF;

        INSERT INTO public.attendance_logs (
            session_id,
            user_id,
            zoom_user_email,
            zoom_display_name,
            join_time,
            leave_time,
            duration_minutes,
            zoom_duration_seconds,
            zoom_identity_verified
        )
        VALUES (
            p_session,
            v_uid,
            v_email,
            left(coalesce(r ->> 'name', ''), 150),
            v_join,
            v_leave,
            floor(v_seconds / 60.0)::INTEGER,
            v_seconds,
            (v_uid IS NOT NULL)
        );

        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$_$;

REVOKE ALL ON FUNCTION public.zoom_import_verified_attendance(uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.zoom_import_verified_attendance(uuid,uuid,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_sync_attendance(p_session uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    s public.training_sessions%ROWTYPE;
    v_logs INTEGER;
    v_updated INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        JOIN public.users u
          ON u.user_id = p.id
        WHERE p.id = auth.uid()
          AND p.role = 'admin'
          AND p.status = 'Active'
          AND u.role = 'HR_ADMIN'
          AND u.account_status = 'Active'
    ) THEN
        RAISE EXCEPTION 'Administrator access required.';
    END IF;

    SELECT *
    INTO s
    FROM public.training_sessions
    WHERE session_id = p_session
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found.';
    END IF;

    IF s.session_status NOT IN (
        'Upcoming', 'Live', 'Completed'
    )
       OR s.scheduled_end IS NULL
       OR s.scheduled_end > now()
    THEN
        RAISE EXCEPTION
            'Session is not ready for attendance synchronization.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.zoom_verified_meetings v
        WHERE v.session_id = p_session
          AND (
              v.lifecycle_status <> 'ACTIVE'
              OR v.zoom_meeting_id
                 IS DISTINCT FROM s.zoom_meeting_id::TEXT
              OR s.zoom_auto_created IS NOT TRUE
          )
    ) THEN
        RAISE EXCEPTION 'Meeting requires review.';
    END IF;

    SELECT count(*)
    INTO v_logs
    FROM public.attendance_logs
    WHERE session_id = p_session;

    IF v_logs = 0 THEN
        RETURN jsonb_build_object(
            'no_logs', true
        );
    END IF;

    UPDATE public.session_registrations r
    SET attendance_status = (
        CASE
            WHEN EXISTS (
                SELECT 1
                FROM public.attendance_logs l
                WHERE l.session_id = p_session
                  AND l.user_id = r.user_id
                  AND l.zoom_duration_seconds IS NOT NULL
                  AND l.zoom_identity_verified IS TRUE
                  AND l.meets_80_percent_threshold
            )
            THEN 'ATTENDED'
            ELSE 'INCOMPLETE'
        END
    )::public.attendance_status_enum

    WHERE r.session_id = p_session

      AND r.attendance_status = 'REGISTERED'

      AND r.payment_status IN (
          'FREE', 'PAID', 'WAIVED'
      )

      AND r.zoom_access_released IS TRUE
      AND public.zoom_attendance_payment_eligible(r.registration_id)

      AND EXISTS (
          SELECT 1
          FROM public.users u
          WHERE u.user_id = r.user_id
            AND u.role = 'MEMBER'
            AND u.account_status = 'Active'
      )

      AND EXISTS (
          SELECT 1
          FROM public.attendance_logs l
          WHERE l.session_id = p_session
            AND l.user_id = r.user_id
            AND l.zoom_duration_seconds IS NOT NULL
                  AND l.zoom_identity_verified IS TRUE
            AND nullif(
                btrim(l.zoom_user_email), ''
            ) IS NOT NULL
      )

      AND NOT EXISTS (
          SELECT 1
          FROM public.issued_certificates c
          WHERE c.registration_id =
              r.registration_id
      );

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF s.session_status IN ('Upcoming', 'Live') THEN
        UPDATE public.training_sessions
        SET session_status = 'Completed'
        WHERE session_id = p_session;
    END IF;

    RETURN jsonb_build_object(
        'no_logs', false,

        'attendees', (
            SELECT count(*)
            FROM public.attendance_logs
            WHERE session_id = p_session
        ),

        'qualified', (
            SELECT count(*)
            FROM public.session_registrations
            WHERE session_id = p_session
              AND attendance_status = 'ATTENDED'
        ),

        'below', (
            SELECT count(*)
            FROM public.session_registrations
            WHERE session_id = p_session
              AND attendance_status IN (
                  'INCOMPLETE', 'ABSENT'
              )
        ),

        'unmatched', (
            SELECT count(*)
            FROM public.attendance_logs
            WHERE session_id = p_session
              AND user_id IS NULL
        ),

        'pending_review', (
            SELECT count(*)
            FROM public.session_registrations
            WHERE session_id = p_session
              AND attendance_status = 'REGISTERED'
        ),

        'updated', v_updated,

        'needs_certs', (
            SELECT count(*)
            FROM public.session_registrations r
            WHERE r.session_id = p_session
              AND r.attendance_status = 'ATTENDED'
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.issued_certificates c
                  WHERE c.registration_id =
                      r.registration_id
              )
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_sync_attendance(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_sync_attendance(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_import_zoom_attendance(uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;

REVOKE INSERT, UPDATE, DELETE,
       TRUNCATE, REFERENCES, TRIGGER
ON public.attendance_logs,
   public.session_registrations,
   public.issued_certificates
FROM PUBLIC, anon, authenticated;
