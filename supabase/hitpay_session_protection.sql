
BEGIN;

-- 1. Protect sessions with pending HitPay payments.
CREATE OR REPLACE FUNCTION
public.hitpay_protect_session_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN

    -- Leave sessions without pending HitPay payments unchanged.
    IF NOT EXISTS (
        SELECT 1
        FROM public.payment_transactions t
        WHERE t.session_id = OLD.session_id
          AND t.payment_provider = 'HITPAY'
          AND t.is_sandbox = true
          AND t.transaction_status = 'PENDING_PAYMENT'
    ) THEN
        RETURN NEW;
    END IF;

    -- Prevent admission fee changes during payment.
    IF NEW.admission_fee
        IS DISTINCT FROM OLD.admission_fee
    THEN
        RAISE EXCEPTION
            'Admission fee cannot be changed while HitPay payments are pending.';
    END IF;

    -- Prevent cancellation while payments are pending.
    IF NEW.session_status
        IS DISTINCT FROM OLD.session_status
    AND NEW.session_status::text
        IN ('Cancelled', 'Draft', 'Completed')
    THEN
        RAISE EXCEPTION
            'Resolve pending HitPay payments before changing the session status.';
    END IF;

    -- Protect session capacity during payment.
    IF NEW.capacity < OLD.capacity THEN
        RAISE EXCEPTION
            'Session capacity cannot be reduced while HitPay payments are pending.';
    END IF;

    -- Prevent schedule changes during payment.
    IF NEW.scheduled_start
        IS DISTINCT FROM OLD.scheduled_start
    OR NEW.scheduled_end
        IS DISTINCT FROM OLD.scheduled_end
    THEN
        RAISE EXCEPTION
            'Session schedule cannot be changed while HitPay payments are pending.';
    END IF;

    RETURN NEW;

END;
$$;

REVOKE ALL ON FUNCTION
public.hitpay_protect_session_changes()
FROM PUBLIC, anon, authenticated;


-- 2. Attach the session protection trigger.
DROP TRIGGER IF EXISTS trg_hitpay_session_protection
ON public.training_sessions;

CREATE TRIGGER trg_hitpay_session_protection
BEFORE UPDATE
ON public.training_sessions
FOR EACH ROW
EXECUTE FUNCTION
public.hitpay_protect_session_changes();

COMMIT;
