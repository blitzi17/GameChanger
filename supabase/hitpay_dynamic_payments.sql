BEGIN;

-- Allow eligible members to use HitPay Sandbox
-- for any available paid session in the prototype.

CREATE OR REPLACE FUNCTION public.hitpay_is_sandbox_allowed(
    p_user_id uuid,
    p_session_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.users u
        CROSS JOIN public.training_sessions s
        WHERE u.user_id = p_user_id
          AND u.role = 'MEMBER'
          AND u.account_status = 'Active'
          AND s.session_id = p_session_id
          AND s.admission_fee > 0
          AND s.admission_fee::text NOT IN (
              'NaN', 'Infinity', '-Infinity'
          )
          AND s.session_status IN ('Upcoming', 'Live')
          AND s.scheduled_end > now()
    );
$$;

REVOKE ALL ON FUNCTION
public.hitpay_is_sandbox_allowed(uuid, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.hitpay_is_sandbox_allowed(uuid, uuid)
TO service_role;


-- DYNAMIC_SESSION_IDENTIFICATION_V1

CREATE OR REPLACE FUNCTION public.hitpay_is_sandbox_session(
    p_session_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.hitpay_sandbox_allowlist a
        WHERE a.session_id = p_session_id
    )
    OR EXISTS (
        SELECT 1
        FROM public.training_sessions s
        WHERE s.session_id = p_session_id
          AND s.admission_fee > 0
          AND s.admission_fee::text NOT IN (
              'NaN', 'Infinity', '-Infinity'
          )
    );
$$;

REVOKE ALL ON FUNCTION
public.hitpay_is_sandbox_session(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.hitpay_is_sandbox_session(uuid)
TO service_role;



-- LEGACY_PAID_COMPATIBILITY_V1

CREATE TABLE public.hitpay_legacy_paid_registrations (
    registration_id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.hitpay_legacy_paid_registrations
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
public.hitpay_legacy_paid_registrations
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
public.hitpay_legacy_paid_registrations
TO service_role;

INSERT INTO public.hitpay_legacy_paid_registrations (
    registration_id,
    user_id,
    session_id
)
SELECT DISTINCT
    r.registration_id,
    r.user_id,
    r.session_id
FROM public.session_registrations r
JOIN public.payment_transactions t
    ON t.registration_id = r.registration_id
   AND t.user_id = r.user_id
   AND t.session_id = r.session_id
WHERE r.payment_status = 'PAID'
  AND t.transaction_status = 'PAID'
  AND t.payment_provider IS DISTINCT FROM 'HITPAY'
  AND t.is_sandbox = false;



-- DYNAMIC_REGISTRATION_PROTECTION_V2

CREATE OR REPLACE FUNCTION
public.hitpay_protect_registration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_registration public.session_registrations%ROWTYPE;
BEGIN

    -- Retrieve the current registration state instead
    -- of relying only on the earlier trigger event.
    SELECT *
    INTO v_registration
    FROM public.session_registrations
    WHERE registration_id = NEW.registration_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;


    -- Leave ordinary sessions unchanged.
    IF NOT public.hitpay_is_sandbox_session(
        v_registration.session_id
    ) THEN

        RETURN NEW;

    END IF;



    -- Preserve historical completed legacy payments.
    IF v_registration.payment_status = 'PAID'
       AND EXISTS (
           SELECT 1
           FROM public.hitpay_legacy_paid_registrations l
           JOIN public.payment_transactions t
             ON t.registration_id = l.registration_id
            AND t.user_id = l.user_id
            AND t.session_id = l.session_id
           WHERE l.registration_id =
                 v_registration.registration_id
             AND l.user_id = v_registration.user_id
             AND l.session_id = v_registration.session_id
             AND t.transaction_status = 'PAID'
             AND t.payment_provider IS DISTINCT FROM 'HITPAY'
             AND t.is_sandbox = false
       )
    THEN
        RETURN NEW;
    END IF;

    -- Preserve existing unpaid registrations during
    -- non-payment updates without releasing Zoom access.
    IF TG_OP = 'UPDATE' THEN
        IF OLD.registration_id = v_registration.registration_id
           AND OLD.user_id = v_registration.user_id
           AND OLD.session_id = v_registration.session_id
           AND OLD.payment_status IN ('UNPAID', 'PENDING_PAYMENT')
           AND v_registration.payment_status = OLD.payment_status
           AND NOT COALESCE(
               v_registration.zoom_access_released,
               false
           )
        THEN
            RETURN NEW;
        END IF;
    END IF;

    -- Prevent premature registration.
    IF v_registration.payment_status
        IS DISTINCT FROM 'PAID'
    THEN

        RAISE EXCEPTION
            'Complete verified HitPay payment before registration.';

    END IF;


    -- Require matching verified payment evidence.
    IF NOT EXISTS (
        SELECT 1
        FROM public.payment_transactions t
        WHERE t.user_id = v_registration.user_id
          AND t.session_id = v_registration.session_id
          AND t.registration_id =
              v_registration.registration_id
          AND t.payment_provider = 'HITPAY'
          AND t.is_sandbox = true
          AND t.transaction_status = 'PAID'
          AND t.reconciliation_required = false
          AND t.gateway_verified_at IS NOT NULL
          AND t.gateway_request_id IS NOT NULL
          AND t.hitpay_reference_id IS NOT NULL
          AND t.hmac_signature IS NOT NULL
          AND t.gateway_payload IS NOT NULL
          AND t.payment_channel IS NOT NULL
          AND t.confirmed_at IS NOT NULL
    ) THEN

        RAISE EXCEPTION
            'Verified HitPay payment is required.';

    END IF;

    RETURN NEW;

END;
$$;

REVOKE ALL ON FUNCTION
public.hitpay_protect_registration()
FROM PUBLIC, anon, authenticated;



-- DYNAMIC_JOIN_PROTECTION_V2

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
$function$;

REVOKE ALL ON FUNCTION public.member_join_link(uuid)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.member_join_link(uuid)
TO authenticated, service_role;



-- DYNAMIC_TRANSACTION_PROTECTION_V2

CREATE OR REPLACE FUNCTION
public.hitpay_protect_legacy_transactions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN


    -- Preserve historical completed legacy transactions
    -- without allowing changes to their payment identity.
    IF TG_OP = 'UPDATE' THEN
        IF OLD.payment_provider IS DISTINCT FROM 'HITPAY'
           AND EXISTS (
               SELECT 1
               FROM public.hitpay_legacy_paid_registrations l
               WHERE l.registration_id = OLD.registration_id
                 AND l.user_id = OLD.user_id
                 AND l.session_id = OLD.session_id
           )
        THEN
            IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
               OR NEW.registration_id IS DISTINCT FROM OLD.registration_id
               OR NEW.user_id IS DISTINCT FROM OLD.user_id
               OR NEW.session_id IS DISTINCT FROM OLD.session_id
               OR NEW.payment_provider IS DISTINCT FROM OLD.payment_provider
               OR NEW.is_sandbox IS DISTINCT FROM OLD.is_sandbox
               OR NEW.amount IS DISTINCT FROM OLD.amount
               OR NEW.currency IS DISTINCT FROM OLD.currency
               OR NEW.transaction_status IS DISTINCT FROM OLD.transaction_status
               OR NEW.order_reference_id IS DISTINCT FROM OLD.order_reference_id
            THEN
                RAISE EXCEPTION
                    'Historical payment details cannot be modified.';
            END IF;

            RETURN NEW;
        END IF;
    END IF;

    -- Sandbox sessions remain protected even when
    -- new payment authorization is disabled.
    IF public.hitpay_is_sandbox_session(
        NEW.session_id
    ) THEN

        IF NEW.payment_provider IS DISTINCT FROM 'HITPAY'
           OR NEW.is_sandbox IS DISTINCT FROM true
        THEN

            RAISE EXCEPTION
                'This session requires HitPay Sandbox payment.';

        END IF;

    END IF;


    -- Protect existing HitPay transaction information.
    IF TG_OP = 'UPDATE' THEN

        IF OLD.payment_provider = 'HITPAY' THEN

            IF NEW.amount IS DISTINCT FROM OLD.amount
               OR NEW.currency IS DISTINCT FROM OLD.currency
               OR NEW.order_reference_id
                   IS DISTINCT FROM OLD.order_reference_id
            THEN

                RAISE EXCEPTION
                    'HitPay payment details cannot be modified.';

            END IF;


            -- Prevent replacement of an existing gateway ID.
            IF OLD.gateway_request_id IS NOT NULL
               AND NEW.gateway_request_id
                   IS DISTINCT FROM OLD.gateway_request_id
            THEN

                RAISE EXCEPTION
                    'Gateway request ID cannot be changed.';

            END IF;

        END IF;

    END IF;

    RETURN NEW;

END;
$$;

REVOKE ALL ON FUNCTION
public.hitpay_protect_legacy_transactions()
FROM PUBLIC, anon, authenticated;



-- DYNAMIC_ADMIN_REPORTING_V1

DO $migration$
DECLARE
    v_definition text;
    v_old text;
    v_new text;
BEGIN
    SELECT pg_get_functiondef(
        'public.admin_payments()'::regprocedure
    )
    INTO v_definition;

    v_old := $patch$COALESCE(t.is_sandbox, false)
                        OR public.hitpay_is_sandbox_session(
                            t.session_id
                        )$patch$;

    v_new := 'COALESCE(t.is_sandbox, false)';

    IF strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION
            'Admin transaction classification anchor not found.';
    END IF;

    v_definition := replace(
        v_definition,
        v_old,
        v_new
    );

    EXECUTE v_definition;
END;
$migration$;


COMMIT;
