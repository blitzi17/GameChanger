BEGIN;

CREATE OR REPLACE FUNCTION public.member_join_link(
    p_session uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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

    SELECT *
    INTO r
    FROM public.session_registrations
    WHERE session_id = p_session
      AND user_id = v_uid;

    IF r.registration_id IS NULL THEN
        RAISE EXCEPTION 'Register for this session first.';
    END IF;

    -- Additional protection for HitPay sandbox sessions.
    IF public.hitpay_is_sandbox_session(p_session) THEN

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
$function$;

REVOKE ALL ON FUNCTION public.member_join_link(uuid)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.member_join_link(uuid)
TO authenticated, service_role;

COMMIT;