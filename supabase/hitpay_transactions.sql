
BEGIN;

CREATE OR REPLACE FUNCTION public.hitpay_create_pending(
    p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id uuid := auth.uid();

    v_eligibility jsonb;

    v_transaction public.payment_transactions%ROWTYPE;

    v_order_reference text;

    v_amount numeric;

BEGIN

    -- 1. Require member authentication.
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION
            'Authentication required.';
    END IF;


    -- 2. Validate the session identifier.
    IF p_session_id IS NULL THEN
        RAISE EXCEPTION
            'Session ID is required.';
    END IF;


    -- 3. Serialize payment creation for this session.
    PERFORM 1
    FROM public.training_sessions
    WHERE session_id = p_session_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Session not found.';
    END IF;


    -- 4. Enforce sandbox authorization.
    IF public.hitpay_is_sandbox_allowed(
        v_user_id,
        p_session_id
    ) IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'Sandbox payment is not authorized.';

    END IF;


    -- 5. Check unresolved reconciliation records
    -- across all transaction statuses.
    PERFORM 1
    FROM public.payment_transactions
    WHERE user_id = v_user_id
      AND session_id = p_session_id
      AND payment_provider = 'HITPAY'
      AND is_sandbox = true
      AND (
          reconciliation_required = true
          OR checkout_state = 'REVIEW_REQUIRED'
      )
    LIMIT 1;

    IF FOUND THEN

        RAISE EXCEPTION
            'An existing payment requires reconciliation.';

    END IF;


    -- 6. Prevent duplicate payment for a session
    -- with an existing paid HitPay transaction.
    PERFORM 1
    FROM public.payment_transactions
    WHERE user_id = v_user_id
      AND session_id = p_session_id
      AND payment_provider = 'HITPAY'
      AND is_sandbox = true
      AND transaction_status = 'PAID'
    LIMIT 1;

    IF FOUND THEN

        RAISE EXCEPTION
            'A paid transaction already exists for this session.';

    END IF;


    -- 7. Prevent new payments when successful
    -- gateway evidence has already been recorded.
    PERFORM 1
    FROM public.payment_transactions
    WHERE user_id = v_user_id
      AND session_id = p_session_id
      AND payment_provider = 'HITPAY'
      AND is_sandbox = true
      AND hitpay_reference_id IS NOT NULL
    LIMIT 1;

    IF FOUND THEN

        RAISE EXCEPTION
            'An existing gateway payment requires verification.';

    END IF;


    -- 8. Validate member and session eligibility.
    v_eligibility :=
        public.hitpay_check_eligibility(
            p_session_id
        );

    IF (
        v_eligibility->>'eligible'
    ) IS DISTINCT FROM 'true' THEN

        RAISE EXCEPTION
            'Session payment eligibility failed.';

    END IF;


    -- 9. Validate the trusted admission fee.
    v_amount :=
        (v_eligibility->>'amount')::numeric;

    IF v_amount IS NULL
       OR v_amount <= 0
       OR v_amount::text IN (
           'NaN',
           'Infinity',
           '-Infinity'
       )
    THEN

        RAISE EXCEPTION
            'Invalid session admission fee.';

    END IF;


    -- 10. Retrieve an existing pending transaction.
    SELECT *
    INTO v_transaction
    FROM public.payment_transactions
    WHERE user_id = v_user_id
      AND session_id = p_session_id
      AND payment_provider = 'HITPAY'
      AND is_sandbox = true
      AND transaction_status = 'PENDING_PAYMENT'
    ORDER BY transaction_timestamp DESC
    LIMIT 1
    FOR UPDATE;


    IF FOUND THEN

        -- 11. Reject unresolved pending payments.
        IF v_transaction.reconciliation_required
                IS DISTINCT FROM false

           OR v_transaction.checkout_state =
                'REVIEW_REQUIRED'

           OR v_transaction.gateway_verified_at
                IS NOT NULL

           OR v_transaction.hitpay_reference_id
                IS NOT NULL
        THEN

            RAISE EXCEPTION
                'Existing payment requires verification.';

        END IF;


        -- 12. Prevent reuse if the amount or
        -- currency no longer matches.
        IF v_transaction.amount
                IS DISTINCT FROM v_amount

           OR v_transaction.currency
                IS DISTINCT FROM 'PHP'
        THEN

            RAISE EXCEPTION
                'Existing payment information requires review.';

        END IF;


        -- 13. Return the existing pending record.
        -- Do not expose the checkout URL through
        -- the member-accessible RPC.
        RETURN jsonb_build_object(

            'transaction_id',
                v_transaction.transaction_id,

            'order_reference',
                v_transaction.order_reference_id,

            'amount',
                v_transaction.amount,

            'currency',
                v_transaction.currency,

            'status',
                v_transaction.transaction_status,

            'checkout_state',
                v_transaction.checkout_state,

            'reconciliation_required',
                v_transaction.reconciliation_required

        );

    END IF;


    -- 14. Generate a unique order reference.
    v_order_reference :=
        'GC-' || gen_random_uuid()::text;


    -- 15. Create pending payment without registration.
    INSERT INTO public.payment_transactions (

        registration_id,

        user_id,

        session_id,

        order_reference_id,

        payment_channel,

        amount,

        currency,

        transaction_status,

        payment_provider,

        is_sandbox,

        checkout_state,

        reconciliation_required

    )
    VALUES (

        NULL,

        v_user_id,

        p_session_id,

        v_order_reference,

        NULL,

        v_amount,

        'PHP',

        'PENDING_PAYMENT',

        'HITPAY',

        true,

        'NOT_STARTED',

        false

    )
    RETURNING *
    INTO v_transaction;


    -- 16. Return the newly created transaction.
    RETURN jsonb_build_object(

        'transaction_id',
            v_transaction.transaction_id,

        'order_reference',
            v_transaction.order_reference_id,

        'amount',
            v_transaction.amount,

        'currency',
            v_transaction.currency,

        'status',
            v_transaction.transaction_status,

        'checkout_state',
            v_transaction.checkout_state,

        'reconciliation_required',
            v_transaction.reconciliation_required

    );

END;
$$;


-- 17. Restrict function execution.
REVOKE ALL ON FUNCTION
    public.hitpay_create_pending(uuid)
FROM PUBLIC, anon;


GRANT EXECUTE ON FUNCTION
    public.hitpay_create_pending(uuid)
TO authenticated;


COMMIT;
