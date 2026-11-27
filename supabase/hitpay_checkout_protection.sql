
BEGIN;

-- 1. Add checkout tracking columns.
ALTER TABLE public.payment_transactions
ADD COLUMN IF NOT EXISTS checkout_state
    text NOT NULL DEFAULT 'NOT_STARTED',
ADD COLUMN IF NOT EXISTS checkout_claimed_at
    timestamptz;


-- 2. Restrict checkout state values.
ALTER TABLE public.payment_transactions
ADD CONSTRAINT hitpay_checkout_state_check
CHECK (
    checkout_state IN (
        'NOT_STARTED',
        'CREATING',
        'CREATED',
        'REVIEW_REQUIRED'
    )
);


-- 3. Atomically claim checkout creation.
CREATE OR REPLACE FUNCTION public.hitpay_claim_checkout(
    p_transaction_id uuid,
    p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated integer;
BEGIN

    UPDATE public.payment_transactions t
    SET
        checkout_state = 'CREATING',
        checkout_claimed_at = now()
    WHERE t.transaction_id = p_transaction_id
      AND t.user_id = p_user_id
      AND t.payment_provider = 'HITPAY'
      AND t.is_sandbox = true
      AND t.transaction_status = 'PENDING_PAYMENT'
      AND t.checkout_state = 'NOT_STARTED'
      AND t.gateway_request_id IS NULL
      AND t.gateway_verified_at IS NULL
      AND t.reconciliation_required = false
      AND public.hitpay_is_sandbox_allowed(
          t.user_id,
          t.session_id
      );

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    RETURN v_updated = 1;

END;
$$;


-- 4. Save successfully created checkout details.
CREATE OR REPLACE FUNCTION public.hitpay_save_checkout(
    p_transaction_id uuid,
    p_user_id uuid,
    p_gateway_request_id text,
    p_checkout_url text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated integer;
BEGIN

    IF NULLIF(TRIM(p_gateway_request_id), '') IS NULL
       OR p_checkout_url IS NULL
       OR p_checkout_url NOT LIKE 'https://%'
    THEN

        RAISE EXCEPTION
            'Invalid checkout information.';

    END IF;


    UPDATE public.payment_transactions t
    SET
        gateway_request_id = p_gateway_request_id,
        gateway_checkout_url = p_checkout_url,
        checkout_state = 'CREATED'
    WHERE t.transaction_id = p_transaction_id
      AND t.user_id = p_user_id
      AND t.payment_provider = 'HITPAY'
      AND t.is_sandbox = true
      AND t.transaction_status = 'PENDING_PAYMENT'
      AND t.checkout_state = 'CREATING'
      AND t.gateway_request_id IS NULL
      AND t.reconciliation_required = false;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    RETURN v_updated = 1;

END;
$$;


-- 5. Flag uncertain checkout creation outcomes.
CREATE OR REPLACE FUNCTION public.hitpay_checkout_review(
    p_transaction_id uuid,
    p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated integer;
BEGIN

    UPDATE public.payment_transactions t
    SET
        checkout_state = 'REVIEW_REQUIRED',
        reconciliation_required = true,
        reconciliation_reason =
            'Checkout creation outcome requires verification.',
        reconciliation_requested_at = now()
    WHERE t.transaction_id = p_transaction_id
      AND t.user_id = p_user_id
      AND t.payment_provider = 'HITPAY'
      AND t.is_sandbox = true
      AND t.transaction_status = 'PENDING_PAYMENT'
      AND t.checkout_state = 'CREATING'
      AND t.gateway_verified_at IS NULL
      AND t.reconciliation_required = false;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    RETURN v_updated = 1;

END;
$$;


-- 6. Identify interrupted checkout creation.
-- Do not automatically create a replacement checkout.
CREATE OR REPLACE FUNCTION
public.hitpay_review_stale_checkouts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated integer;
BEGIN

    UPDATE public.payment_transactions t
    SET
        checkout_state = 'REVIEW_REQUIRED',
        reconciliation_required = true,
        reconciliation_reason =
            'Checkout creation was interrupted or timed out.',
        reconciliation_requested_at = now()
    WHERE t.payment_provider = 'HITPAY'
      AND t.is_sandbox = true
      AND t.transaction_status = 'PENDING_PAYMENT'
      AND t.checkout_state = 'CREATING'
      AND t.checkout_claimed_at
          <= now() - interval '10 minutes'
      AND t.gateway_verified_at IS NULL
      AND t.reconciliation_required = false;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    RETURN v_updated;

END;
$$;


-- 7. Protect checkout reconciliation state.
CREATE OR REPLACE FUNCTION
public.hitpay_protect_checkout_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN

    IF OLD.payment_provider IS DISTINCT FROM 'HITPAY' THEN
        RETURN NEW;
    END IF;


    -- Prevent reviewed payments from starting another checkout.
    IF OLD.reconciliation_required = true
       AND NEW.checkout_state
           IS DISTINCT FROM OLD.checkout_state
       AND NEW.checkout_state IN (
           'NOT_STARTED',
           'CREATING'
       )
    THEN

        RAISE EXCEPTION
            'Payment requires reconciliation before another checkout.';

    END IF;


    -- Preserve verified gateway evidence while under review.
    IF OLD.reconciliation_required = true
       AND OLD.gateway_verified_at IS NOT NULL
    THEN

        IF NEW.hitpay_reference_id
            IS DISTINCT FROM OLD.hitpay_reference_id
        OR NEW.hmac_signature
            IS DISTINCT FROM OLD.hmac_signature
        OR NEW.gateway_payload
            IS DISTINCT FROM OLD.gateway_payload
        OR NEW.gateway_verified_at
            IS DISTINCT FROM OLD.gateway_verified_at
        OR NEW.payment_channel
            IS DISTINCT FROM OLD.payment_channel
        OR NEW.transaction_status
            IS DISTINCT FROM OLD.transaction_status
        OR NEW.reconciliation_required
            IS DISTINCT FROM OLD.reconciliation_required
        THEN

            RAISE EXCEPTION
                'Verified payment evidence requires controlled reconciliation.';

        END IF;

    END IF;

    RETURN NEW;

END;
$$;


DROP TRIGGER IF EXISTS
    trg_hitpay_checkout_reconciliation
ON public.payment_transactions;

CREATE TRIGGER trg_hitpay_checkout_reconciliation
BEFORE UPDATE
ON public.payment_transactions
FOR EACH ROW
EXECUTE FUNCTION
public.hitpay_protect_checkout_reconciliation();


-- 8. Restrict checkout functions to the trusted backend.
REVOKE ALL ON FUNCTION
public.hitpay_claim_checkout(uuid, uuid)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
public.hitpay_save_checkout(uuid, uuid, text, text)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
public.hitpay_checkout_review(uuid, uuid)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
public.hitpay_review_stale_checkouts()
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
public.hitpay_protect_checkout_reconciliation()
FROM PUBLIC, anon, authenticated;


GRANT EXECUTE ON FUNCTION
public.hitpay_claim_checkout(uuid, uuid)
TO service_role;

GRANT EXECUTE ON FUNCTION
public.hitpay_save_checkout(uuid, uuid, text, text)
TO service_role;

GRANT EXECUTE ON FUNCTION
public.hitpay_checkout_review(uuid, uuid)
TO service_role;

GRANT EXECUTE ON FUNCTION
public.hitpay_review_stale_checkouts()
TO service_role;

COMMIT;
