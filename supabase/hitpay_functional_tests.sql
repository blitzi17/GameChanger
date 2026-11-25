-- GameChanger UC-PAM-01
-- HitPay functional database tests
-- Synthetic data only.
-- Must run inside the combined rollback transaction.
-- Do not execute this file independently.

DO $tests$
DECLARE
    v_user_id uuid :=
        'cb9ab5af-576f-48fd-b5c6-081874c2ea0e';

    v_session_id uuid :=
        'cd2f1fa3-c011-481f-b8fa-333354d14e27';

    v_transaction_id uuid;
    v_order_reference text;

    v_eligibility jsonb;
    v_pending jsonb;
    v_duplicate jsonb;
    v_result jsonb;

    v_gateway_request_id text :=
        'TEST-REQUEST-' || gen_random_uuid()::text;

    v_gateway_reference text :=
        'TEST-PAYMENT-' || gen_random_uuid()::text;

    v_signature text := repeat('a', 64);

    v_payload jsonb :=
        '{"simulation": true, "status": "completed"}'::jsonb;

    v_count integer;
    v_blocked boolean;

BEGIN

    -- Safety checks.

    IF NOT public.hitpay_is_sandbox_allowed(
        v_user_id,
        v_session_id
    ) THEN
        RAISE EXCEPTION
            'Safety check failed: sandbox pair not allowed.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.session_registrations
        WHERE session_id = v_session_id
    ) OR EXISTS (
        SELECT 1
        FROM public.payment_transactions
        WHERE session_id = v_session_id
    ) THEN
        RAISE EXCEPTION
            'Safety check failed: sandbox records already exist.';
    END IF;


    -- FT-01: Eligible dummy member.

    PERFORM set_config(
        'request.jwt.claim.sub',
        v_user_id::text,
        true
    );

    PERFORM set_config(
        'request.jwt.claims',
        jsonb_build_object(
            'sub', v_user_id,
            'role', 'authenticated'
        )::text,
        true
    );

    v_eligibility :=
        public.hitpay_check_eligibility(v_session_id);

    IF (v_eligibility->>'eligible')
        IS DISTINCT FROM 'true'
    THEN
        RAISE EXCEPTION
            'FT-01 FAILED: member not eligible.';
    END IF;

    RAISE NOTICE
        'FT-01 PASSED: eligible dummy member.';


    -- FT-02: Unauthorized sandbox pair.

    IF public.hitpay_is_sandbox_allowed(
        gen_random_uuid(),
        v_session_id
    ) IS DISTINCT FROM false THEN

        RAISE EXCEPTION
            'FT-02 FAILED: unauthorized pair allowed.';

    END IF;

    RAISE NOTICE
        'FT-02 PASSED: unauthorized pair rejected.';


    -- FT-03: Create pending payment.

    v_pending :=
        public.hitpay_create_pending(v_session_id);

    v_transaction_id :=
        (v_pending->>'transaction_id')::uuid;

    v_order_reference :=
        v_pending->>'order_reference';

    IF v_transaction_id IS NULL
       OR v_order_reference IS NULL
       OR v_order_reference NOT LIKE 'GC-%'
       OR (v_pending->>'status')
          IS DISTINCT FROM 'PENDING_PAYMENT'
       OR (v_pending->>'amount')::numeric
          IS DISTINCT FROM 100.00
       OR (v_pending->>'currency')
          IS DISTINCT FROM 'PHP'
    THEN

        RAISE EXCEPTION
            'FT-03 FAILED: invalid pending payment.';

    END IF;

    RAISE NOTICE
        'FT-03 PASSED: pending payment created.';


    -- FT-04: No premature registration.

    SELECT count(*)
    INTO v_count
    FROM public.session_registrations
    WHERE user_id = v_user_id
      AND session_id = v_session_id;

    IF v_count <> 0 THEN

        RAISE EXCEPTION
            'FT-04 FAILED: premature registration.';

    END IF;

    RAISE NOTICE
        'FT-04 PASSED: no premature registration.';



    -- HITPAY_MEMBER_PENDING_TESTS_V1

    DECLARE
        v_history jsonb;
        v_record jsonb;
    BEGIN

        v_history := public.member_payments();

        IF jsonb_typeof(v_history -> 'transactions')
            IS DISTINCT FROM 'array'
        THEN
            RAISE EXCEPTION
                'FT-26 FAILED: invalid transaction response.';
        END IF;

        SELECT item.record
        INTO STRICT v_record
        FROM jsonb_array_elements(
            v_history -> 'transactions'
        ) AS item(record)
        WHERE item.record ->> 'transaction_id' =
              v_transaction_id::text;

        -- FT-26: Pending transaction visibility.

        IF v_record ->> 'status'
            IS DISTINCT FROM 'PENDING_PAYMENT'

           OR v_record ->> 'display_status'
            IS DISTINCT FROM 'PENDING_PAYMENT'

           OR v_record ->> 'order_reference'
            IS DISTINCT FROM v_order_reference

           OR v_record ->> 'payment_provider'
            IS DISTINCT FROM 'HITPAY'

           OR v_record -> 'is_sandbox'
            IS DISTINCT FROM 'true'::jsonb

           OR v_record -> 'registration_id'
            IS DISTINCT FROM 'null'::jsonb

           OR v_record ->> 'session_id'
            IS DISTINCT FROM v_session_id::text

        THEN

            RAISE EXCEPTION
                'FT-26 FAILED: incorrect pending payment record.';

        END IF;

        IF EXISTS (

            SELECT 1

            FROM jsonb_array_elements(
                v_history -> 'registrations'
            ) AS item(record)

            WHERE item.record ->> 'session_id' =
                  v_session_id::text

        ) THEN

            RAISE EXCEPTION
                'FT-26 FAILED: premature registration returned.';

        END IF;

        RAISE NOTICE
            'FT-26 PASSED: unregistered pending payment visible.';


        -- FT-29: Pending receipt protection.

        IF v_record -> 'receipt_available'
            IS DISTINCT FROM 'false'::jsonb

           OR v_record -> 'reconciliation_required'
            IS DISTINCT FROM 'false'::jsonb

           OR v_record ->> 'checkout_state'
            IS DISTINCT FROM 'NOT_STARTED'

        THEN

            RAISE EXCEPTION
                'FT-29 FAILED: invalid pending receipt eligibility.';

        END IF;

        RAISE NOTICE
            'FT-29 PASSED: pending receipt unavailable.';

    END;


    -- HITPAY_ADMIN_PENDING_TESTS_V1
    -- Administrator pending fixture prechecks.

    DECLARE
        v_admin_fixture public.payment_transactions%ROWTYPE;

    BEGIN

        SELECT *
        INTO STRICT v_admin_fixture
        FROM public.payment_transactions
        WHERE transaction_id = v_transaction_id
          AND user_id = v_user_id
          AND session_id = v_session_id;

        -- FT-41: Pending payment fixture.

        IF v_admin_fixture.transaction_status::text
            IS DISTINCT FROM 'PENDING_PAYMENT'

           OR v_admin_fixture.payment_provider
            IS DISTINCT FROM 'HITPAY'

           OR v_admin_fixture.order_reference_id
            IS DISTINCT FROM v_order_reference

           OR v_admin_fixture.amount
            IS DISTINCT FROM 100.00

           OR v_admin_fixture.currency::text
            IS DISTINCT FROM 'PHP'

        THEN

            RAISE EXCEPTION
                'FT-41 FAILED: invalid pending fixture.';

        END IF;

        RAISE NOTICE
            'FT-41 PRECHECK PASSED: pending fixture valid.';


        -- FT-44: Pending receipt fixture protection.

        IF v_admin_fixture.registration_id IS NOT NULL

           OR v_admin_fixture.gateway_verified_at IS NOT NULL

           OR v_admin_fixture.confirmed_at IS NOT NULL

           OR v_admin_fixture.hitpay_reference_id IS NOT NULL

           OR v_admin_fixture.checkout_state
            IS DISTINCT FROM 'NOT_STARTED'

        THEN

            RAISE EXCEPTION
                'FT-44 FAILED: premature payment evidence.';

        END IF;

        RAISE NOTICE
            'FT-44 PRECHECK PASSED: no completed payment evidence.';


        -- FT-47A: Pending sandbox identification.

        IF v_admin_fixture.is_sandbox IS DISTINCT FROM true

           OR public.hitpay_is_sandbox_session(
                v_session_id
           ) IS DISTINCT FROM true

        THEN

            RAISE EXCEPTION
                'FT-47A FAILED: sandbox identification missing.';

        END IF;

        RAISE NOTICE
            'FT-47A PRECHECK PASSED: pending sandbox fixture.';

    END;

    -- FT-05: Duplicate pending payment request.

    v_duplicate :=
        public.hitpay_create_pending(v_session_id);

    IF (v_duplicate->>'transaction_id')::uuid
        IS DISTINCT FROM v_transaction_id
    THEN

        RAISE EXCEPTION
            'FT-05 FAILED: duplicate transaction created.';

    END IF;

    SELECT count(*)
    INTO v_count
    FROM public.payment_transactions
    WHERE user_id = v_user_id
      AND session_id = v_session_id;

    IF v_count <> 1 THEN

        RAISE EXCEPTION
            'FT-05 FAILED: unexpected payment count.';

    END IF;

    RAISE NOTICE
        'FT-05 PASSED: pending transaction reused.';


    -- FT-06: Checkout claim protection.

    IF public.hitpay_claim_checkout(
        v_transaction_id,
        v_user_id
    ) IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'FT-06 FAILED: initial checkout claim rejected.';

    END IF;

    IF public.hitpay_claim_checkout(
        v_transaction_id,
        v_user_id
    ) IS DISTINCT FROM false THEN

        RAISE EXCEPTION
            'FT-06 FAILED: duplicate checkout claim allowed.';

    END IF;

    IF public.hitpay_save_checkout(
        v_transaction_id,
        v_user_id,
        v_gateway_request_id,
        'https://example.invalid/hitpay-test'
    ) IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'FT-06 FAILED: simulated checkout not saved.';

    END IF;

    RAISE NOTICE
        'FT-06 PASSED: duplicate checkout claim blocked.';


    -- FT-07: Reject mismatched payment amount.

    v_blocked := false;

    BEGIN

        PERFORM public.hitpay_finalize_payment(
            v_order_reference,
            v_gateway_request_id,
            v_gateway_reference,
            999.00,
            'PHP',
            'GCASH'::public.payment_channel_enum,
            v_signature,
            v_payload
        );

    EXCEPTION
        WHEN raise_exception THEN

            IF SQLERRM <> 'Payment information mismatch.' THEN
                RAISE;
            END IF;

            v_blocked := true;

    END;

    IF NOT v_blocked THEN

        RAISE EXCEPTION
            'FT-07 FAILED: mismatched amount accepted.';

    END IF;

    RAISE NOTICE
        'FT-07 PASSED: mismatched amount rejected.';


    -- FT-08: Simulate successful gateway finalization.
    -- This does NOT test actual webhook verification.

    v_result :=
        public.hitpay_finalize_payment(
            v_order_reference,
            v_gateway_request_id,
            v_gateway_reference,
            100.00,
            'PHP',
            'GCASH'::public.payment_channel_enum,
            v_signature,
            v_payload
        );

    IF (v_result->>'status')
        IS DISTINCT FROM 'PAID'
    THEN

        RAISE EXCEPTION
            'FT-08 FAILED: payment not finalized.';

    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.payment_transactions
        WHERE transaction_id = v_transaction_id
          AND transaction_status = 'PAID'
          AND gateway_verified_at IS NOT NULL
          AND is_sandbox = true
          AND reconciliation_required = false
    ) THEN

        RAISE EXCEPTION
            'FT-08 FAILED: invalid paid transaction.';

    END IF;

    RAISE NOTICE
        'FT-08 PASSED: simulated payment marked PAID.';


    -- FT-09: Successful registration.

    SELECT count(*)
    INTO v_count
    FROM public.session_registrations r
    JOIN public.payment_transactions p
        ON p.registration_id = r.registration_id
    WHERE r.user_id = v_user_id
      AND r.session_id = v_session_id
      AND r.payment_status = 'PAID'
      AND p.transaction_id = v_transaction_id;

    IF v_count <> 1 THEN

        RAISE EXCEPTION
            'FT-09 FAILED: invalid registration.';

    END IF;

    RAISE NOTICE
        'FT-09 PASSED: registration completed.';


    -- FT-10: Duplicate successful notification.

    v_result :=
        public.hitpay_finalize_payment(
            v_order_reference,
            v_gateway_request_id,
            v_gateway_reference,
            100.00,
            'PHP',
            'GCASH'::public.payment_channel_enum,
            v_signature,
            v_payload
        );

    IF (v_result->>'already_processed')
        IS DISTINCT FROM 'true'
    THEN

        RAISE EXCEPTION
            'FT-10 FAILED: duplicate notification not recognized.';

    END IF;

    SELECT count(*)
    INTO v_count
    FROM public.session_registrations
    WHERE user_id = v_user_id
      AND session_id = v_session_id;

    IF v_count <> 1 THEN

        RAISE EXCEPTION
            'FT-10 FAILED: duplicate registration.';

    END IF;

    RAISE NOTICE
        'FT-10 PASSED: duplicate notification handled.';



    -- HITPAY_ADMIN_PAID_TESTS_V1
    -- Administrator paid fixture prechecks.

    DECLARE

        v_admin_fixture public.payment_transactions%ROWTYPE;

        v_admin_registration
            public.session_registrations%ROWTYPE;

    BEGIN

        SELECT *
        INTO STRICT v_admin_fixture
        FROM public.payment_transactions
        WHERE transaction_id = v_transaction_id
          AND user_id = v_user_id
          AND session_id = v_session_id;

        -- FT-42: Verified paid fixture.

        IF v_admin_fixture.transaction_status::text
            IS DISTINCT FROM 'PAID'

           OR v_admin_fixture.payment_provider
            IS DISTINCT FROM 'HITPAY'

           OR v_admin_fixture.gateway_request_id
            IS DISTINCT FROM v_gateway_request_id

           OR v_admin_fixture.hitpay_reference_id
            IS DISTINCT FROM v_gateway_reference

           OR v_admin_fixture.gateway_verified_at IS NULL

           OR v_admin_fixture.confirmed_at IS NULL

           OR v_admin_fixture.amount
            IS DISTINCT FROM 100.00

           OR v_admin_fixture.currency::text
            IS DISTINCT FROM 'PHP'

           OR v_admin_fixture.payment_channel::text
            IS DISTINCT FROM 'GCASH'

           OR v_admin_fixture.reconciliation_required
            IS DISTINCT FROM false

        THEN

            RAISE EXCEPTION
                'FT-42 FAILED: invalid paid fixture.';

        END IF;

        RAISE NOTICE
            'FT-42 PRECHECK PASSED: simulated paid fixture valid.';


        -- FT-43: Exact registration relationship.

        SELECT *
        INTO STRICT v_admin_registration
        FROM public.session_registrations
        WHERE registration_id =
              v_admin_fixture.registration_id

          AND user_id = v_user_id
          AND session_id = v_session_id;

        IF v_admin_registration.payment_status::text
            IS DISTINCT FROM 'PAID'

        THEN

            RAISE EXCEPTION
                'FT-43 FAILED: registration mismatch.';

        END IF;

        RAISE NOTICE
            'FT-43 PRECHECK PASSED: exact registration linked.';


        -- FT-45: Receipt evidence readiness.

        IF v_admin_fixture.registration_id IS NULL

           OR v_admin_fixture.checkout_state
            IS DISTINCT FROM 'CREATED'

           OR v_admin_fixture.order_reference_id
            IS DISTINCT FROM v_order_reference

           OR v_admin_fixture.hmac_signature
            IS DISTINCT FROM v_signature

           OR v_admin_fixture.gateway_payload
            IS DISTINCT FROM v_payload

           OR jsonb_typeof(
                v_admin_fixture.gateway_payload
           ) IS DISTINCT FROM 'object'

           OR v_admin_fixture.reconciliation_required
            IS DISTINCT FROM false

           OR NOT EXISTS (
                SELECT 1
                FROM public.training_sessions s
                WHERE s.session_id = v_session_id
                  AND NULLIF(btrim(s.title), '') IS NOT NULL
           )

        THEN

            RAISE EXCEPTION
                'FT-45 FAILED: receipt fixture incomplete.';

        END IF;

        RAISE NOTICE
            'FT-45 PRECHECK PASSED: receipt evidence available.';


        -- FT-47B: Paid sandbox identification.

        IF v_admin_fixture.is_sandbox
            IS DISTINCT FROM true

           OR public.hitpay_is_sandbox_session(
                v_session_id
           ) IS DISTINCT FROM true

        THEN

            RAISE EXCEPTION
                'FT-47B FAILED: sandbox identification missing.';

        END IF;

        RAISE NOTICE
            'FT-47B PRECHECK PASSED: paid sandbox fixture.';

        RAISE NOTICE
            'Administrator fixture prechecks completed.';

        RAISE NOTICE
            'Authenticated administrator RPC assertions remain pending.';

    END;

    RAISE NOTICE
        'FT-01 through FT-10 completed successfully.';

END;
$tests$;