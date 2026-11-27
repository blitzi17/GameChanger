BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Preserve gateway request identity when checkout
-- URL validation fails.
-- This function does not confirm payment or registration.

CREATE OR REPLACE FUNCTION
public.hitpay_preserve_gateway_evidence(
    p_transaction_id uuid,
    p_user_id uuid,
    p_gateway_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated integer;
BEGIN

    -- Validate the gateway request identifier.
    IF p_gateway_request_id IS NULL
       OR p_gateway_request_id !~
          '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
    THEN
        RAISE EXCEPTION
            'Invalid gateway request identifier.';
    END IF;

    -- Preserve the request ID without approving
    -- the checkout URL or confirming payment.
    UPDATE public.payment_transactions t
    SET
        gateway_request_id = p_gateway_request_id,
        checkout_state = 'REVIEW_REQUIRED',
        reconciliation_required = true,
        reconciliation_reason =
            'Gateway request received but checkout URL requires verification.',
        reconciliation_requested_at = now()
    WHERE t.transaction_id = p_transaction_id
      AND t.user_id = p_user_id
      AND t.payment_provider = 'HITPAY'
      AND t.is_sandbox = true
      AND t.transaction_status = 'PENDING_PAYMENT'
      AND t.checkout_state = 'CREATING'
      AND t.reconciliation_required = false
      AND t.gateway_request_id IS NULL
      AND t.gateway_checkout_url IS NULL
      AND t.gateway_verified_at IS NULL
      AND t.hitpay_reference_id IS NULL
      AND t.registration_id IS NULL;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    RETURN v_updated = 1;

END;
$$;


-- Restrict execution to the trusted backend.

REVOKE ALL ON FUNCTION
public.hitpay_preserve_gateway_evidence(uuid, uuid, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.hitpay_preserve_gateway_evidence(uuid, uuid, text)
TO service_role;

COMMIT;
