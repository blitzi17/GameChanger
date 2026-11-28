-- GameChanger / Zoom identity verification
-- REVIEW CANDIDATE: local clean-install validation only. Not approved for production.

CREATE OR REPLACE FUNCTION public.admin_generate_certificates(p_session uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    s public.training_sessions%ROWTYPE;
    r RECORD;
    n INTEGER := 0;
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

    IF s.session_status <> 'Completed'
       OR s.scheduled_end IS NULL
       OR s.scheduled_end > now()
    THEN
        RAISE EXCEPTION
            'Session is not ready for certificate generation.';
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

    FOR r IN
        SELECT sr.registration_id
        FROM public.session_registrations sr
        JOIN public.users u
          ON u.user_id = sr.user_id
        WHERE sr.session_id = p_session

          AND sr.attendance_status = 'ATTENDED'

          AND sr.payment_status IN (
              'FREE', 'PAID', 'WAIVED'
          )

          AND sr.zoom_access_released IS TRUE
          AND public.zoom_attendance_payment_eligible(sr.registration_id)

          AND u.role = 'MEMBER'

          AND u.account_status = 'Active'

          AND EXISTS (
              SELECT 1
              FROM public.attendance_logs l
              WHERE l.session_id = p_session
                AND l.user_id = sr.user_id
                AND l.zoom_identity_verified IS TRUE
                AND l.zoom_duration_seconds IS NOT NULL
                AND l.meets_80_percent_threshold IS TRUE
                AND l.zoom_duration_seconds::NUMERIC * 100
                    >= s.duration_minutes::NUMERIC * 60 * 80
                AND nullif(
                    btrim(l.zoom_user_email), ''
                ) IS NOT NULL
          )

          AND NOT EXISTS (
              SELECT 1
              FROM public.issued_certificates c
              WHERE c.registration_id =
                    sr.registration_id
          )

        FOR UPDATE OF sr
    LOOP
        PERFORM public.gc_issue_certificate(
            r.registration_id
        );

        n := n + 1;
    END LOOP;

    RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_generate_certificates(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_generate_certificates(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_override_certificate(p_registration uuid, p_reason text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    r public.session_registrations%ROWTYPE;
    s public.training_sessions%ROWTYPE;
    v_session UUID;
    v_id UUID;
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
        RAISE EXCEPTION
            'Administrator access required.';
    END IF;

    IF nullif(btrim(p_reason), '') IS NULL THEN
        RAISE EXCEPTION
            'Certificate override reason is required.';
    END IF;

    SELECT session_id
    INTO v_session
    FROM public.session_registrations
    WHERE registration_id = p_registration;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Registration not found.';
    END IF;

    SELECT *
    INTO s
    FROM public.training_sessions
    WHERE session_id = v_session
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found.';
    END IF;

    SELECT *
    INTO r
    FROM public.session_registrations
    WHERE registration_id = p_registration
      AND session_id = v_session
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Registration not found.';
    END IF;

    SELECT certificate_id
    INTO v_id
    FROM public.issued_certificates
    WHERE registration_id = p_registration;

    IF FOUND THEN
        RETURN v_id;
    END IF;

    IF s.session_status <> 'Completed'
       OR s.scheduled_end IS NULL
       OR s.scheduled_end > now()
    THEN
        RAISE EXCEPTION
            'Session is not ready for certificate generation.';
    END IF;

    IF r.payment_status NOT IN (
        'FREE', 'PAID', 'WAIVED'
    )
       OR r.zoom_access_released IS NOT TRUE
       OR NOT public.zoom_attendance_payment_eligible(r.registration_id)
    THEN
        RAISE EXCEPTION
            'Registration payment or access is not eligible.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.users u
        WHERE u.user_id = r.user_id
          AND u.role = 'MEMBER'
          AND u.account_status = 'Active'
    ) THEN
        RAISE EXCEPTION
            'Member account is not eligible.';
    END IF;

    v_id := public.gc_issue_certificate(
        p_registration
    );

    PERFORM public.log_admin_action(
        'Overrode certificate threshold',
        p_registration::TEXT,
        jsonb_build_object(
            'reason', btrim(p_reason),
            'certificate_id', v_id,
            'administrator_id', auth.uid(),
            'session_id', r.session_id
        )
    );

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_override_certificate(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_override_certificate(uuid,text) TO authenticated;

REVOKE ALL ON FUNCTION public.gc_issue_certificate(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Align permissions with the original exported schema.

-- Member-accessible functions

REVOKE ALL ON FUNCTION
    public.hitpay_check_eligibility(uuid)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.hitpay_check_eligibility(uuid)
    TO authenticated, service_role;

REVOKE ALL ON FUNCTION
    public.hitpay_create_pending(uuid)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.hitpay_create_pending(uuid)
    TO authenticated, service_role;

-- Trusted backend functions

REVOKE ALL ON FUNCTION
    public.hitpay_claim_checkout(uuid, uuid)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.hitpay_claim_checkout(uuid, uuid)
    TO service_role;

REVOKE ALL ON FUNCTION
    public.hitpay_save_checkout(uuid, uuid, text, text)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.hitpay_save_checkout(uuid, uuid, text, text)
    TO service_role;

REVOKE ALL ON FUNCTION
    public.hitpay_finalize_payment(
        text, text, text, numeric, text,
        public.payment_channel_enum, text, jsonb
    )
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.hitpay_finalize_payment(
        text, text, text, numeric, text,
        public.payment_channel_enum, text, jsonb
    )
    TO service_role;

REVOKE ALL ON FUNCTION
    public.hitpay_update_status(
        text, text, text, text, jsonb
    )
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.hitpay_update_status(
        text, text, text, text, jsonb
    )
    TO service_role;

REVOKE ALL ON FUNCTION
public.hitpay_checkout_review(UUID, UUID)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
public.hitpay_preserve_gateway_evidence(UUID, UUID, TEXT)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
public.hitpay_review_stale_checkouts()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.hitpay_checkout_review(UUID, UUID),
public.hitpay_preserve_gateway_evidence(UUID, UUID, TEXT),
public.hitpay_review_stale_checkouts()
TO service_role;

REVOKE INSERT, UPDATE, DELETE,
       TRUNCATE, REFERENCES, TRIGGER
ON public.payment_transactions,
   public.hitpay_legacy_paid_registrations,
   public.hitpay_audit_records
FROM PUBLIC, anon, authenticated;
