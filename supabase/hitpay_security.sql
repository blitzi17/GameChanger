
BEGIN;

-- Handle verified non-successful payment notifications.
CREATE OR REPLACE FUNCTION public.hitpay_update_status(
    p_order_reference text,
    p_gateway_request_id text,
    p_status text,
    p_signature text,
    p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_payment public.payment_transactions%ROWTYPE;
BEGIN

    -- 1. Validate supported payment outcomes.
    IF p_status IS NULL
       OR p_status NOT IN (
           'FAILED',
           'CANCELLED',
           'PENDING_PAYMENT'
       )
    THEN

        RAISE EXCEPTION
            'Invalid payment status.';

    END IF;


    -- 2. Require gateway notification information.
    IF NULLIF(TRIM(p_order_reference), '') IS NULL
       OR NULLIF(TRIM(p_gateway_request_id), '') IS NULL
       OR NULLIF(TRIM(p_signature), '') IS NULL
       OR p_payload IS NULL
       OR jsonb_typeof(p_payload) <> 'object'
    THEN

        RAISE EXCEPTION
            'Missing or invalid gateway information.';

    END IF;


    -- 3. Locate and lock the matching transaction.
    SELECT *
    INTO v_payment
    FROM public.payment_transactions
    WHERE order_reference_id = p_order_reference
      AND gateway_request_id = p_gateway_request_id
      AND payment_provider = 'HITPAY'
      AND is_sandbox = true
    FOR UPDATE;

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Payment transaction not found.';

    END IF;


    -- 4. Preserve successful payment records.
    IF v_payment.transaction_status = 'PAID' THEN

        RETURN jsonb_build_object(
            'transaction_id',
                v_payment.transaction_id,
            'order_reference',
                p_order_reference,
            'status', 'PAID',
            'updated', false,
            'reason',
                'Successful payment already finalized.'
        );

    END IF;


    -- 5. Preserve transactions requiring reconciliation.
    IF v_payment.reconciliation_required = true THEN

        RETURN jsonb_build_object(
            'transaction_id',
                v_payment.transaction_id,
            'order_reference',
                p_order_reference,
            'status', 'REVIEW_REQUIRED',
            'transaction_status',
                v_payment.transaction_status,
            'reconciliation_required', true,
            'updated', false,
            'reason',
                v_payment.reconciliation_reason
        );

    END IF;


    -- 6. Prevent non-successful notifications from
    -- overwriting recorded successful payment evidence.
    IF v_payment.hitpay_reference_id IS NOT NULL
       AND v_payment.gateway_verified_at IS NOT NULL
    THEN

        RETURN jsonb_build_object(
            'transaction_id',
                v_payment.transaction_id,
            'order_reference',
                p_order_reference,
            'status',
                v_payment.transaction_status,
            'updated', false,
            'reason',
                'Existing gateway evidence must be preserved.'
        );

    END IF;


    -- 7. Preserve existing terminal payment outcomes.
    IF v_payment.transaction_status
        IS DISTINCT FROM 'PENDING_PAYMENT'
    THEN

        RETURN jsonb_build_object(
            'transaction_id',
                v_payment.transaction_id,
            'order_reference',
                p_order_reference,
            'status',
                v_payment.transaction_status,
            'updated', false,
            'reason',
                'Payment status has already been resolved.'
        );

    END IF;


    -- 8. Ignore repeated pending notifications.
    -- Pending notifications must not complete registration.
    IF p_status = 'PENDING_PAYMENT' THEN

        RETURN jsonb_build_object(
            'transaction_id',
                v_payment.transaction_id,
            'order_reference',
                p_order_reference,
            'status', 'PENDING_PAYMENT',
            'updated', false,
            'registration_completed', false
        );

    END IF;


    -- 9. Record verified failed or cancelled outcomes.
    UPDATE public.payment_transactions
    SET
        transaction_status =
            p_status::public.transaction_status_enum,
        hmac_signature = p_signature,
        gateway_payload = p_payload,
        gateway_verified_at = now()
    WHERE transaction_id = v_payment.transaction_id
      AND transaction_status = 'PENDING_PAYMENT'
      AND reconciliation_required = false;


    -- 10. Return the recorded payment outcome.
    RETURN jsonb_build_object(
        'transaction_id',
            v_payment.transaction_id,
        'order_reference',
            p_order_reference,
        'status', p_status,
        'updated', true,
        'registration_completed', false,
        'reconciliation_required', false
    );

END;
$$;


-- Restrict execution to the trusted backend.
REVOKE ALL ON FUNCTION public.hitpay_update_status(
    text,
    text,
    text,
    text,
    jsonb
)
FROM PUBLIC, anon, authenticated;


GRANT EXECUTE ON FUNCTION public.hitpay_update_status(
    text,
    text,
    text,
    text,
    jsonb
)
TO service_role;

COMMIT;
