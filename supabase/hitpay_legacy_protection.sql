
BEGIN;

-- 1. Protect sandbox sessions from legacy payments.
CREATE OR REPLACE FUNCTION
public.hitpay_protect_legacy_transactions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN

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


DROP TRIGGER IF EXISTS trg_hitpay_legacy_protection
ON public.payment_transactions;

CREATE TRIGGER trg_hitpay_legacy_protection
BEFORE INSERT OR UPDATE
ON public.payment_transactions
FOR EACH ROW
EXECUTE FUNCTION
public.hitpay_protect_legacy_transactions();


-- 2. Protect sandbox registration identity.
CREATE OR REPLACE FUNCTION
public.hitpay_protect_registration_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN

    -- Prevent existing sandbox registrations from
    -- being transferred to another member or session.
    IF public.hitpay_is_sandbox_session(
        OLD.session_id
    ) THEN

        IF NEW.registration_id
            IS DISTINCT FROM OLD.registration_id
        OR NEW.user_id
            IS DISTINCT FROM OLD.user_id
        OR NEW.session_id
            IS DISTINCT FROM OLD.session_id
        THEN

            RAISE EXCEPTION
                'Sandbox registration identity cannot be changed.';

        END IF;

    END IF;

    RETURN NEW;

END;
$$;


REVOKE ALL ON FUNCTION
public.hitpay_protect_registration_identity()
FROM PUBLIC, anon, authenticated;


DROP TRIGGER IF EXISTS
    trg_hitpay_registration_identity
ON public.session_registrations;

CREATE TRIGGER trg_hitpay_registration_identity
BEFORE UPDATE
ON public.session_registrations
FOR EACH ROW
EXECUTE FUNCTION
public.hitpay_protect_registration_identity();


-- 3. Validate the final sandbox registration state.
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


    -- Require a designated sandbox member and session.
    -- Historical authorization remains valid for
    -- previously completed registrations.
    IF NOT EXISTS (
        SELECT 1
        FROM public.hitpay_sandbox_allowlist a
        WHERE a.user_id = v_registration.user_id
          AND a.session_id = v_registration.session_id
    ) THEN

        RAISE EXCEPTION
            'Unauthorized sandbox registration.';

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


-- 4. Attach the deferred registration constraint.
DROP TRIGGER IF EXISTS
    trg_hitpay_registration_protection
ON public.session_registrations;

CREATE CONSTRAINT TRIGGER
    trg_hitpay_registration_protection
AFTER INSERT OR UPDATE
ON public.session_registrations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION
public.hitpay_protect_registration();

COMMIT;
