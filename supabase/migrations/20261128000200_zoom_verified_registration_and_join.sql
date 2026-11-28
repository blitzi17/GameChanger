-- GameChanger / Zoom identity verification
-- REVIEW CANDIDATE: local clean-install validation only. Not approved for production.

CREATE FUNCTION public.member_zoom_access_check(p_session uuid, p_require_join_window boolean DEFAULT true) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
    v_uid UUID := auth.uid();
    s public.training_sessions%ROWTYPE;
    r public.session_registrations%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not signed in';
    END IF;

    SELECT * INTO s
    FROM public.training_sessions
    WHERE session_id = p_session;

    IF s.session_id IS NULL
       OR s.session_status NOT IN ('Upcoming', 'Live')
    THEN
        RAISE EXCEPTION 'This session is not available.';
    END IF;

    SELECT * INTO r
    FROM public.session_registrations
    WHERE session_id = p_session
      AND user_id = v_uid;

    IF r.registration_id IS NULL THEN
        RAISE EXCEPTION 'Register for this session first.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.user_id = v_uid
          AND u.role = 'MEMBER'
          AND u.account_status = 'Active'
    ) THEN
        RAISE EXCEPTION 'An active member account is required.';
    END IF;

    -- Preserve the existing HitPay sandbox verification.
    IF public.hitpay_is_sandbox_session(p_session)
       AND NOT (
           r.payment_status = 'PAID'
           AND EXISTS (
               SELECT 1
               FROM public.hitpay_legacy_paid_registrations l
               JOIN public.payment_transactions t
                 ON t.registration_id = l.registration_id
                AND t.user_id = l.user_id
                AND t.session_id = l.session_id
               WHERE l.registration_id = r.registration_id
                 AND l.user_id = v_uid
                 AND l.session_id = p_session
                 AND t.transaction_status = 'PAID'
                 AND t.payment_provider IS DISTINCT FROM 'HITPAY'
                 AND t.is_sandbox = false
           )
       )
    THEN
        IF r.payment_status IS DISTINCT FROM 'PAID'
           OR NOT EXISTS (
            SELECT 1
            FROM public.payment_transactions t
            WHERE t.registration_id = r.registration_id
              AND t.user_id = v_uid
              AND t.session_id = p_session
              AND t.payment_provider = 'HITPAY'
              AND t.is_sandbox = true
              AND t.transaction_status = 'PAID'
              AND t.checkout_state = 'CREATED'
              AND t.reconciliation_required = false
              AND t.gateway_verified_at IS NOT NULL
              AND t.confirmed_at IS NOT NULL
              AND NULLIF(BTRIM(t.gateway_request_id), '') IS NOT NULL
              AND NULLIF(BTRIM(t.hitpay_reference_id), '') IS NOT NULL
              AND t.hmac_signature ~ '^[0-9a-fA-F]{64}$'
              AND jsonb_typeof(t.gateway_payload) = 'object'
              AND t.payment_channel IS NOT NULL
              AND t.amount > 0
              AND t.amount::text NOT IN (
                  'NaN', 'Infinity', '-Infinity'
              )
              AND t.currency = 'PHP'
        ) THEN
            RAISE EXCEPTION
                'Verified HitPay payment is required to join.';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.payment_transactions t
            WHERE t.user_id = v_uid
              AND t.session_id = p_session
              AND t.payment_provider = 'HITPAY'
              AND (
                  t.reconciliation_required = true
                  OR t.checkout_state = 'REVIEW_REQUIRED'
              )
        ) THEN
            RAISE EXCEPTION
                'Payment reconciliation is required. Contact the administrator.';
        END IF;
    END IF;

    -- Require eligible registration and released access.

IF NOT COALESCE(
       r.payment_status IN ('FREE', 'PAID', 'WAIVED'),
       FALSE
   )
   OR NOT COALESCE(r.zoom_access_released, FALSE)
THEN

        RAISE EXCEPTION
            'Your seat is not confirmed yet. Complete the payment to unlock the Zoom link.';
    END IF;

    IF NULLIF(BTRIM(s.zoom_join_url), '') IS NULL THEN
        RAISE EXCEPTION
            'The Zoom link for this session is not ready yet.';
    END IF;



-- Validate the session schedule for all requests.
IF s.scheduled_start IS NULL
   OR s.scheduled_end IS NULL
   OR s.scheduled_end <= s.scheduled_start THEN
    RAISE EXCEPTION 'Invalid session schedule.';
END IF;

-- Registration and joining must stop after the session ends.
IF now() >= s.scheduled_end THEN
    RAISE EXCEPTION 'This session has already ended.';
END IF;

-- Only joining requires the 15-minute opening window.
IF p_require_join_window THEN
    IF now() < s.scheduled_start - interval '15 minutes' THEN
        RAISE EXCEPTION
            'Joining opens 15 minutes before the scheduled start (Philippine time).';
    END IF;
END IF;


END;
$_$;

REVOKE ALL ON FUNCTION public.member_zoom_access_check(uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.member_zoom_access_check(uuid,boolean) TO service_role;

CREATE FUNCTION public.member_verified_zoom_eligibility(p_session uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_registration public.session_registrations%ROWTYPE;
    v_member public.users%ROWTYPE;
    v_meeting_id TEXT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not signed in.';
    END IF;

    -- Only the signed-in member's registration is accepted.
    SELECT *
    INTO v_registration
    FROM public.session_registrations
    WHERE session_id = p_session
      AND user_id = v_uid;

    IF v_registration.registration_id IS NULL THEN
        RAISE EXCEPTION 'Register for this session first.';
    END IF;

    SELECT *
    INTO v_member
    FROM public.users
    WHERE user_id = v_uid;

    IF v_member.user_id IS NULL
       OR v_member.role IS DISTINCT FROM 'MEMBER'
       OR v_member.account_status IS DISTINCT FROM 'Active'
    THEN
        RAISE EXCEPTION 'An active member account is required.';
    END IF;

    -- Explicit payment and access-release validation.
    IF v_registration.payment_status NOT IN (
        'FREE', 'PAID', 'WAIVED'
    )
       OR NOT COALESCE(
           v_registration.zoom_access_released, false
       )
    THEN
        RAISE EXCEPTION 'Zoom access has not been authorized.';
    END IF;

    -- Only meetings explicitly marked as verified qualify.
    SELECT vm.zoom_meeting_id
    INTO v_meeting_id
    FROM public.zoom_verified_meetings vm
    JOIN public.training_sessions s
      ON s.session_id = vm.session_id
     AND s.zoom_meeting_id::text = vm.zoom_meeting_id
    WHERE vm.session_id = p_session
      AND vm.lifecycle_status = 'ACTIVE'
      AND s.zoom_auto_created = true
      AND s.session_status IN ('Upcoming', 'Live');

    IF v_meeting_id IS NULL THEN
        RAISE EXCEPTION
            'This session does not have a verified Zoom meeting.';
    END IF;

    -- Apply the same protected joining checks used by legacy sessions.

PERFORM public.member_zoom_access_check(
    p_session,
    FALSE
);


    RETURN jsonb_build_object(
        'registration_id', v_registration.registration_id,
        'zoom_meeting_id', v_meeting_id,
        'email', v_member.email,
        'first_name', v_member.first_name,
        'last_name', v_member.last_name
    );
END;
$$;

REVOKE ALL ON FUNCTION public.member_verified_zoom_eligibility(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.member_verified_zoom_eligibility(uuid) TO authenticated, service_role;

CREATE FUNCTION public.member_verified_zoom_join_eligibility(p_session uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_eligibility jsonb;
BEGIN
    -- Validate the authenticated member and verified meeting.
    v_eligibility :=
        public.member_verified_zoom_eligibility(p_session);

    -- Enforce the existing 15-minute joining restriction.
    PERFORM public.member_zoom_access_check(
        p_session,
        TRUE
    );

    RETURN v_eligibility;
END;
$$;

REVOKE ALL ON FUNCTION public.member_verified_zoom_join_eligibility(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.member_verified_zoom_join_eligibility(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.member_join_link(p_session uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
    v_uid uuid := auth.uid();
    s public.training_sessions%ROWTYPE;
    r public.session_registrations%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not signed in';
    END IF;

    SELECT *
    INTO s
    FROM public.training_sessions
    WHERE session_id = p_session;

    IF s.session_id IS NULL
       OR s.session_status IN ('Draft', 'Cancelled') THEN
        RAISE EXCEPTION 'This session is not available.';
    END IF;

IF EXISTS (
    SELECT 1
    FROM public.zoom_verified_meetings vm
    WHERE vm.session_id = p_session
) THEN
    RAISE EXCEPTION
        'This meeting requires an individual verified Zoom link.';
END IF;

    SELECT *
    INTO r
    FROM public.session_registrations
    WHERE session_id = p_session
      AND user_id = v_uid;

    IF r.registration_id IS NULL THEN
        RAISE EXCEPTION 'Register for this session first.';
    END IF;

    -- Additional protection for HitPay sandbox sessions.
    IF public.hitpay_is_sandbox_session(p_session)
       AND NOT (
           r.payment_status = 'PAID'
           AND EXISTS (
               SELECT 1
               FROM public.hitpay_legacy_paid_registrations l
               JOIN public.payment_transactions t
                 ON t.registration_id = l.registration_id
                AND t.user_id = l.user_id
                AND t.session_id = l.session_id
               WHERE l.registration_id = r.registration_id
                 AND l.user_id = v_uid
                 AND l.session_id = p_session
                 AND t.transaction_status = 'PAID'
                 AND t.payment_provider IS DISTINCT FROM 'HITPAY'
                 AND t.is_sandbox = false
           )
       )
    THEN

        IF NOT EXISTS (
            SELECT 1
            FROM public.users u
            WHERE u.user_id = v_uid
              AND u.role = 'MEMBER'
              AND u.account_status = 'Active'
        ) THEN
            RAISE EXCEPTION 'An active member account is required.';
        END IF;

        IF s.session_status NOT IN ('Upcoming', 'Live') THEN
            RAISE EXCEPTION 'This session is not available.';
        END IF;

        IF r.payment_status IS DISTINCT FROM 'PAID'
           OR NOT EXISTS (
            SELECT 1
            FROM public.payment_transactions t
            WHERE t.registration_id = r.registration_id
              AND t.user_id = v_uid
              AND t.session_id = p_session
              AND t.payment_provider = 'HITPAY'
              AND t.is_sandbox = true
              AND t.transaction_status = 'PAID'
              AND t.checkout_state = 'CREATED'
              AND t.reconciliation_required = false
              AND t.gateway_verified_at IS NOT NULL
              AND t.confirmed_at IS NOT NULL
              AND NULLIF(BTRIM(t.gateway_request_id), '') IS NOT NULL
              AND NULLIF(BTRIM(t.hitpay_reference_id), '') IS NOT NULL
              AND t.hmac_signature ~ '^[0-9a-fA-F]{64}$'
              AND jsonb_typeof(t.gateway_payload) = 'object'
              AND t.payment_channel IS NOT NULL
              AND t.amount > 0
              AND t.amount::text NOT IN (
                  'NaN', 'Infinity', '-Infinity'
              )
              AND t.currency = 'PHP'
        ) THEN
            RAISE EXCEPTION
                'Verified HitPay payment is required to join.';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.payment_transactions t
            WHERE t.user_id = v_uid
              AND t.session_id = p_session
              AND t.payment_provider = 'HITPAY'
              AND (
                  t.reconciliation_required = true
                  OR t.checkout_state = 'REVIEW_REQUIRED'
              )
        ) THEN
            RAISE EXCEPTION
                'Payment reconciliation is required. Contact the administrator.';
        END IF;

    END IF;

    -- Preserve existing Zoom access requirements.
    IF NOT COALESCE(r.zoom_access_released, false) THEN
        RAISE EXCEPTION
            'Your seat is not confirmed yet. Complete the payment to unlock the Zoom link.';
    END IF;

    IF NULLIF(BTRIM(s.zoom_join_url), '') IS NULL THEN
        RAISE EXCEPTION
            'The Zoom link for this session is not ready yet.';
    END IF;

    IF s.scheduled_start IS NULL
       OR s.scheduled_end IS NULL
       OR s.scheduled_end <= s.scheduled_start THEN
        RAISE EXCEPTION 'Invalid session schedule.';
    END IF;

    IF now() < s.scheduled_start - interval '15 minutes' THEN
        RAISE EXCEPTION
            'Joining opens 15 minutes before the scheduled start (Philippine time).';
    END IF;

    IF now() >= s.scheduled_end THEN
        RAISE EXCEPTION 'This session has already ended.';
    END IF;

    RETURN jsonb_build_object(
        'url', s.zoom_join_url,
        'passcode', s.zoom_passcode
    );
END;
$_$;

REVOKE ALL ON FUNCTION public.member_join_link(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.member_join_link(uuid) TO authenticated, service_role;

CREATE FUNCTION public.zoom_claim_registration(p_registration_id uuid, p_zoom_meeting_id text, p_email text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_claim_token uuid;
BEGIN
    IF p_registration_id IS NULL
        OR p_zoom_meeting_id IS NULL
        OR p_email IS NULL
        OR btrim(p_zoom_meeting_id) = ''
        OR btrim(p_email) = ''
    THEN
        RAISE EXCEPTION 'Invalid registration claim.';
    END IF;



    -- Coordinate with verified meeting removal.
    PERFORM ts.session_id
    FROM public.training_sessions ts
    JOIN public.session_registrations sr
      ON sr.session_id = ts.session_id
    WHERE sr.registration_id = p_registration_id
    FOR UPDATE OF ts;

-- Validate the registration, meeting and member identity.

    IF NOT EXISTS (
        SELECT 1
        FROM public.session_registrations sr
        JOIN public.users u
            ON u.user_id = sr.user_id
        JOIN public.training_sessions ts
            ON ts.session_id = sr.session_id
        JOIN public.zoom_verified_meetings vm
            ON vm.session_id = sr.session_id
        WHERE sr.registration_id = p_registration_id
          AND vm.zoom_meeting_id = p_zoom_meeting_id
          AND vm.lifecycle_status = 'ACTIVE'
          AND ts.zoom_meeting_id::text = p_zoom_meeting_id
          AND ts.zoom_auto_created = TRUE
          AND lower(btrim(u.email)) = lower(btrim(p_email))
          AND u.role = 'MEMBER'
          AND u.account_status = 'Active'
          AND sr.zoom_access_released = TRUE
          AND sr.payment_status IN ('FREE', 'PAID', 'WAIVED')
          AND ts.session_status IN ('Upcoming', 'Live')
          AND ts.scheduled_end > now()
    ) THEN
        RAISE EXCEPTION 'Invalid registration identity or access.';
    END IF;

    -- Existing registrants must be validated and reused
    -- by the backend instead of creating another one.

    IF EXISTS (
        SELECT 1
        FROM public.zoom_registrants
        WHERE registration_id = p_registration_id
    ) THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.zoom_registration_claims (
        registration_id,
        zoom_meeting_id,
        registered_email
    )
    VALUES (
        p_registration_id,
        btrim(p_zoom_meeting_id),
        lower(btrim(p_email))
    )
    ON CONFLICT (registration_id) DO NOTHING
    RETURNING claim_token INTO v_claim_token;

    RETURN v_claim_token;
END;
$$;

REVOKE ALL ON FUNCTION public.zoom_claim_registration(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.zoom_claim_registration(uuid,text,text) TO service_role;

CREATE FUNCTION public.zoom_complete_registration(p_registration_id uuid, p_claim_token uuid, p_registrant_id text, p_join_url text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
    v_claim public.zoom_registration_claims%ROWTYPE;
BEGIN
    IF NULLIF(btrim(p_registrant_id), '') IS NULL
       OR p_join_url IS NULL
       OR p_join_url !~*
          '^https://(zoom[.]us|us[0-9]+web[.]zoom[.]us)/[^[:space:]]+$'
    THEN
        RAISE EXCEPTION 'Invalid Zoom registrant details.';
    END IF;



    -- Coordinate with verified meeting removal.
    PERFORM ts.session_id
    FROM public.training_sessions ts
    JOIN public.session_registrations sr
      ON sr.session_id = ts.session_id
    WHERE sr.registration_id = p_registration_id
    FOR UPDATE OF ts;

-- Lock and validate the registration claim.

    SELECT *
    INTO v_claim
    FROM public.zoom_registration_claims
    WHERE registration_id = p_registration_id
      AND claim_token = p_claim_token
      AND claim_status = 'CREATING'
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    -- Confirm the registration identity has not changed.

    IF NOT EXISTS (
        SELECT 1
        FROM public.session_registrations sr
        JOIN public.users u
          ON u.user_id = sr.user_id
        JOIN public.training_sessions ts
          ON ts.session_id = sr.session_id
        JOIN public.zoom_verified_meetings vm
          ON vm.session_id = sr.session_id
        WHERE sr.registration_id = p_registration_id
          AND vm.zoom_meeting_id = v_claim.zoom_meeting_id
          AND vm.lifecycle_status = 'ACTIVE'
          AND ts.zoom_meeting_id::text = v_claim.zoom_meeting_id
          AND ts.zoom_auto_created = true
          AND lower(btrim(u.email)) = v_claim.registered_email
          AND u.account_status = 'Active'
          AND u.role = 'MEMBER'
          AND sr.zoom_access_released = true
          AND sr.payment_status IN ('FREE', 'PAID', 'WAIVED')
          AND ts.session_status IN ('Upcoming', 'Live')
          AND ts.scheduled_start IS NOT NULL
          AND ts.scheduled_end > ts.scheduled_start
          AND ts.scheduled_end > now()
    ) THEN
        UPDATE public.zoom_registration_claims
        SET claim_status = 'REVIEW_REQUIRED',
            updated_at = now()
        WHERE registration_id = p_registration_id;

        RETURN false;
    END IF;

    -- Store the individual registrant without overwriting
    -- an existing registrant.

    INSERT INTO public.zoom_registrants (
        registration_id,
        zoom_meeting_id,
        zoom_registrant_id,
        registered_email,
        zoom_join_url
    )
    VALUES (
        p_registration_id,
        v_claim.zoom_meeting_id,
        btrim(p_registrant_id),
        v_claim.registered_email,
        p_join_url
    )
    ON CONFLICT DO NOTHING;

    IF NOT FOUND THEN
        UPDATE public.zoom_registration_claims
        SET claim_status = 'REVIEW_REQUIRED',
            updated_at = now()
        WHERE registration_id = p_registration_id;

        RETURN false;
    END IF;

    -- Complete the claim in the same transaction.

    UPDATE public.zoom_registration_claims
    SET claim_status = 'COMPLETED',
        updated_at = now()
    WHERE registration_id = p_registration_id;

    RETURN true;
END;
$_$;

REVOKE ALL ON FUNCTION public.zoom_complete_registration(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.zoom_complete_registration(uuid,uuid,text,text) TO service_role;

CREATE FUNCTION public.zoom_mark_registration_review(p_registration_id uuid, p_claim_token uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
    UPDATE public.zoom_registration_claims
    SET claim_status = 'REVIEW_REQUIRED',
        updated_at = now()
    WHERE registration_id = p_registration_id
      AND claim_token = p_claim_token
      AND claim_status = 'CREATING';

    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.zoom_mark_registration_review(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.zoom_mark_registration_review(uuid,uuid) TO service_role;

CREATE FUNCTION public.zoom_store_verified_meeting(p_admin_id uuid, p_session uuid, p_expected_meeting_id text, p_meeting_id text, p_join_url text, p_passcode text, p_authentication_profile_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
    v_session public.training_sessions%ROWTYPE;
    v_verified public.zoom_verified_meetings%ROWTYPE;
BEGIN
    -- Validate the administrator independently.

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
        RAISE EXCEPTION 'Admins only.';
    END IF;

    -- Validate meeting details.

    IF p_meeting_id IS NULL
       OR p_meeting_id !~ '^[0-9]+$'
       OR NULLIF(btrim(p_authentication_profile_id), '') IS NULL
       OR p_join_url IS NULL
       OR p_join_url !~*
          '^https://(zoom[.]us|us[0-9]+web[.]zoom[.]us)/[^[:space:]]+$'
    THEN
        RAISE EXCEPTION 'Invalid verified meeting details.';
    END IF;

    -- Lock the session to protect concurrent database changes.

    SELECT *
    INTO v_session
    FROM public.training_sessions
    WHERE session_id = p_session
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found.';
    END IF;

    IF v_session.session_status NOT IN (
        'Draft', 'Upcoming', 'Live'
    ) THEN
        RAISE EXCEPTION 'Session is not available.';
    END IF;

    IF v_session.scheduled_start IS NULL
       OR v_session.scheduled_end IS NULL
       OR v_session.scheduled_end <= v_session.scheduled_start
       OR v_session.scheduled_end <= now()
    THEN
        RAISE EXCEPTION 'Invalid session schedule.';
    END IF;

    -- Reject a stale meeting creation request.

    IF v_session.zoom_meeting_id::text
       IS DISTINCT FROM p_expected_meeting_id
    THEN
        RAISE EXCEPTION 'Meeting identity has changed.';
    END IF;

    -- Inspect existing verification metadata.

    SELECT *
    INTO v_verified
    FROM public.zoom_verified_meetings
    WHERE session_id = p_session
    FOR UPDATE;

    IF FOUND THEN


        IF v_verified.lifecycle_status <> 'ACTIVE' THEN
            RAISE EXCEPTION
                'Meeting lifecycle requires reconciliation.';
        END IF;

        IF v_verified.zoom_meeting_id
           IS DISTINCT FROM p_meeting_id
        THEN
            RAISE EXCEPTION
                'Verified meeting replacement requires reconciliation.';
        END IF;

        IF v_verified.authentication_profile_id
           IS DISTINCT FROM btrim(p_authentication_profile_id)
        THEN
            RAISE EXCEPTION
                'Authentication profile cannot be changed automatically.';
        END IF;

    END IF;

    -- Do not silently mark an existing legacy meeting as verified.

    IF v_verified.session_id IS NULL
       AND v_session.zoom_meeting_id::text = p_meeting_id
    THEN
        RAISE EXCEPTION
            'Existing legacy meeting cannot be marked as verified.';
    END IF;

    -- Store session meeting details.

    UPDATE public.training_sessions
    SET zoom_meeting_id = p_meeting_id,
        zoom_join_url = p_join_url,
        zoom_passcode = p_passcode,
        zoom_auto_created = true
    WHERE session_id = p_session;

    -- Store verified metadata in the same transaction.

    INSERT INTO public.zoom_verified_meetings (
        session_id,
        zoom_meeting_id,
        authentication_profile_id
    )
    VALUES (
        p_session,
        p_meeting_id,
        btrim(p_authentication_profile_id)
    )
    ON CONFLICT (session_id) DO NOTHING;

    RETURN true;
END;
$_$;

REVOKE ALL ON FUNCTION public.zoom_store_verified_meeting(uuid,uuid,text,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.zoom_claim_meeting_creation(p_admin_id uuid, p_session uuid, p_expected_meeting_id text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_session public.training_sessions%ROWTYPE;
    v_token UUID;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        JOIN public.users u ON u.user_id = p.id
        WHERE p.id = p_admin_id
          AND p.role = 'admin'
          AND p.status = 'Active'
          AND u.role = 'HR_ADMIN'
          AND u.account_status = 'Active'
    ) THEN
        RAISE EXCEPTION 'Active administrator required.';
    END IF;

    SELECT *
    INTO v_session
    FROM public.training_sessions
    WHERE session_id = p_session
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found.';
    END IF;

    IF v_session.session_status NOT IN (
        'Draft', 'Upcoming', 'Live'
    )
       OR v_session.scheduled_start IS NULL
       OR v_session.scheduled_end IS NULL
       OR v_session.scheduled_end <= now()
       OR v_session.scheduled_end <=
          v_session.scheduled_start
    THEN
        RAISE EXCEPTION 'Session not available.';
    END IF;

    IF v_session.zoom_meeting_id::TEXT
       IS DISTINCT FROM p_expected_meeting_id
    THEN
        RAISE EXCEPTION 'Meeting identity changed.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.zoom_verified_meetings
        WHERE session_id = p_session
    ) THEN
        RAISE EXCEPTION
            'Verified meeting already exists.';
    END IF;

    INSERT INTO public.zoom_meeting_creation_claims (
        session_id,
        claimed_by,
        expected_meeting_id
    )
    VALUES (
        p_session,
        p_admin_id,
        p_expected_meeting_id
    )
    ON CONFLICT (session_id) DO NOTHING
    RETURNING claim_token INTO v_token;

    RETURN v_token;
END;
$$;

REVOKE ALL ON FUNCTION public.zoom_claim_meeting_creation(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.zoom_claim_meeting_creation(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.zoom_complete_meeting_creation(p_admin_id uuid, p_session uuid, p_claim_token uuid, p_meeting_id text, p_join_url text, p_passcode text, p_authentication_profile_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_claim public.zoom_meeting_creation_claims%ROWTYPE;
    v_stored BOOLEAN;
BEGIN
    PERFORM session_id
    FROM public.training_sessions
    WHERE session_id = p_session
    FOR UPDATE;

    SELECT *
    INTO v_claim
    FROM public.zoom_meeting_creation_claims
    WHERE session_id = p_session
      AND claim_token = p_claim_token
      AND claimed_by = p_admin_id
      AND claim_status = 'CREATING'
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE public.zoom_meeting_creation_claims
    SET external_meeting_id = p_meeting_id,
        updated_at = now()
    WHERE session_id = p_session;

    BEGIN
        v_stored := public.zoom_store_verified_meeting(
            p_admin_id,
            p_session,
            v_claim.expected_meeting_id,
            p_meeting_id,
            p_join_url,
            p_passcode,
            p_authentication_profile_id
        );

        IF v_stored IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'Meeting storage failed.';
        END IF;

        UPDATE public.zoom_meeting_creation_claims
        SET claim_status = 'COMPLETED',
            updated_at = now()
        WHERE session_id = p_session;

        RETURN TRUE;

    EXCEPTION WHEN OTHERS THEN
        UPDATE public.zoom_meeting_creation_claims
        SET claim_status = 'REVIEW_REQUIRED',
            updated_at = now()
        WHERE session_id = p_session;

        RETURN FALSE;
    END;
END;
$$;

REVOKE ALL ON FUNCTION public.zoom_complete_meeting_creation(uuid,uuid,uuid,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.zoom_complete_meeting_creation(uuid,uuid,uuid,text,text,text,text) TO service_role;

CREATE FUNCTION public.zoom_mark_meeting_creation_review(p_session uuid, p_claim_token uuid, p_external_meeting_id text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
    UPDATE public.zoom_meeting_creation_claims
    SET claim_status = 'REVIEW_REQUIRED',
        external_meeting_id = COALESCE(
            p_external_meeting_id,
            external_meeting_id
        ),
        updated_at = now()
    WHERE session_id = p_session
      AND claim_token = p_claim_token
      AND claim_status = 'CREATING';

    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.zoom_mark_meeting_creation_review(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.zoom_mark_meeting_creation_review(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.zoom_retire_verified_meeting(p_admin_id uuid, p_session uuid, p_expected_meeting_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_session public.training_sessions%ROWTYPE;
    v_verified public.zoom_verified_meetings%ROWTYPE;
BEGIN

    -- Validate the administrator.

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
        RAISE EXCEPTION 'Admins only.';
    END IF;

    -- Coordinate with member registration operations.

    SELECT *
    INTO v_session
    FROM public.training_sessions
    WHERE session_id = p_session
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found.';
    END IF;

    IF v_session.session_status <> 'Cancelled' THEN
        RAISE EXCEPTION 'Session must be cancelled first.';
    END IF;

    SELECT *
    INTO v_verified
    FROM public.zoom_verified_meetings
    WHERE session_id = p_session
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Verified meeting not found.';
    END IF;

    -- Reject outdated or incorrect meeting identities.

    IF NULLIF(btrim(p_expected_meeting_id), '') IS NULL
       OR v_verified.zoom_meeting_id
          IS DISTINCT FROM p_expected_meeting_id
       OR v_session.zoom_meeting_id::text
          IS DISTINCT FROM p_expected_meeting_id
    THEN
        RAISE EXCEPTION 'Meeting identity has changed.';
    END IF;

    -- Make repeated retirement requests safe.

    IF v_verified.lifecycle_status = 'RETIRED' THEN
        RETURN true;
    END IF;

    -- Preserve unresolved registration operations.

    IF EXISTS (
        SELECT 1
        FROM public.zoom_registration_claims c
        JOIN public.session_registrations r
          ON r.registration_id = c.registration_id
        WHERE r.session_id = p_session
          AND c.claim_status IN (
              'CREATING', 'REVIEW_REQUIRED'
          )
    ) THEN

        UPDATE public.zoom_verified_meetings
        SET lifecycle_status = 'REVIEW_REQUIRED'
        WHERE session_id = p_session;

        RETURN false;

    END IF;

    -- Retire the meeting while preserving historical records.

    UPDATE public.zoom_verified_meetings
    SET lifecycle_status = 'RETIRED',
        retired_at = now()
    WHERE session_id = p_session;

    RETURN true;

END;
$$;

REVOKE ALL ON FUNCTION public.zoom_retire_verified_meeting(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.zoom_retire_verified_meeting(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.zoom_protect_verified_meeting() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN

    -- Ordinary session edits remain permitted.

    IF NEW.zoom_meeting_id
           IS NOT DISTINCT FROM OLD.zoom_meeting_id
       AND NEW.zoom_join_url
           IS NOT DISTINCT FROM OLD.zoom_join_url
       AND NEW.zoom_auto_created
           IS NOT DISTINCT FROM OLD.zoom_auto_created
       AND NEW.zoom_passcode
           IS NOT DISTINCT FROM OLD.zoom_passcode
    THEN
        RETURN NEW;
    END IF;

    -- Existing verified meetings cannot be modified
    -- through ordinary session updates.

    IF EXISTS (
        SELECT 1
        FROM public.zoom_verified_meetings
        WHERE session_id = OLD.session_id
    ) THEN

        RAISE EXCEPTION
            'Verified Zoom meeting changes require reconciliation.';

    END IF;

    RETURN NEW;

END;
$$;

REVOKE ALL ON FUNCTION public.zoom_protect_verified_meeting() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.zoom_protect_session_deletion() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.zoom_meeting_creation_claims
        WHERE session_id = OLD.session_id
    ) THEN
        RAISE EXCEPTION
            'Zoom meeting creation claim exists. Administrator reconciliation is required before deletion.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.zoom_verified_meetings
        WHERE session_id = OLD.session_id
    ) THEN
        RAISE EXCEPTION
            'Verified Zoom meeting exists. Administrator reconciliation is required before deletion.';
    END IF;

    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.zoom_protect_session_deletion() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.member_dashboard() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v jsonb := public.member_dashboard_raw();
BEGIN
    RETURN jsonb_set(v, '{upcoming}', COALESCE((
        SELECT jsonb_agg(e || jsonb_build_object(
            'zoom_verified', vm.session_id IS NOT NULL,
            'zoom_ready', nullif(e ->> 'zoom_join_url', '') IS NOT NULL
                AND (vm.session_id IS NULL OR (
                    vm.lifecycle_status = 'ACTIVE'
                    AND s.zoom_auto_created IS TRUE
                    AND s.zoom_meeting_id::text = vm.zoom_meeting_id
                )),
            'zoom_join_url', NULL,
            'zoom_passcode', NULL
        ) ORDER BY ord)
        FROM jsonb_array_elements(COALESCE(v -> 'upcoming', '[]'::jsonb))
            WITH ORDINALITY AS t(e, ord)
        JOIN public.training_sessions s ON s.session_id = (e ->> 'session_id')::uuid
        LEFT JOIN public.zoom_verified_meetings vm ON vm.session_id = s.session_id
    ), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.member_dashboard() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.member_dashboard() TO authenticated, service_role;

CREATE TRIGGER zoom_protect_verified_meeting_changes BEFORE UPDATE OF zoom_meeting_id, zoom_join_url, zoom_auto_created, zoom_passcode ON public.training_sessions FOR EACH ROW EXECUTE FUNCTION public.zoom_protect_verified_meeting();

CREATE TRIGGER zoom_protect_session_deletion_trigger BEFORE DELETE ON public.training_sessions FOR EACH ROW EXECUTE FUNCTION public.zoom_protect_session_deletion();

-- Restore the intended raw dashboard permissions.

REVOKE ALL ON FUNCTION
    public.member_dashboard_raw()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.member_dashboard_raw()
TO service_role;


-- Restore the intended admin RPC permissions.

REVOKE ALL ON FUNCTION
    public.admin_save_session(uuid, jsonb)
FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION
    public.admin_session_for_zoom(uuid)
FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION
    public.admin_set_zoom_meeting(uuid, text, text, text)
FROM PUBLIC, anon;


-- Remove unnecessary destructive table privileges.
-- RLS remains enabled and unchanged.

REVOKE TRUNCATE, TRIGGER, REFERENCES
ON TABLE public.training_sessions
FROM PUBLIC, anon, authenticated;
