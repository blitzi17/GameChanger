
-- GameChanger UC-PAM-01
-- Additional alternative payment tests
-- FT-14 to FT-18
--
-- Synthetic sandbox data only.
-- Execute only inside the combined rollback transaction.
-- Do not execute this file independently.

DO $alternative_tests$

DECLARE

    v_user_id uuid :=
        'cb9ab5af-576f-48fd-b5c6-081874c2ea0e';

    v_session_id uuid :=
        'cd2f1fa3-c011-481f-b8fa-333354d14e27';

    v_transaction_id uuid;
    v_order_reference text;
    v_gateway_request_id text;
    v_gateway_reference text;

    v_pending jsonb;
    v_result jsonb;

    v_payment public.payment_transactions%ROWTYPE;

    v_before jsonb;
    v_after jsonb;

    v_signature text := repeat('a', 64);

    v_success_payload jsonb :=
        '{"simulation": true, "status": "completed"}'::jsonb;

    v_failed_payload jsonb :=
        '{"simulation": true, "status": "failed"}'::jsonb;

    v_cancelled_payload jsonb :=
        '{"simulation": true, "status": "cancelled"}'::jsonb;

    v_pending_payload jsonb :=
        '{"simulation": true, "status": "pending"}'::jsonb;

    v_count integer;

    v_test_status text;
    v_test_payload jsonb;
    v_test_id text;

BEGIN

    -- ========================================================
    -- 1. Safety checks
    -- ========================================================

    IF public.hitpay_is_sandbox_allowed(
        v_user_id,
        v_session_id
    ) IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'Safety check failed: sandbox pair not authorized.';

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
            'Safety check failed: existing sandbox records.';

    END IF;


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


    -- ========================================================
    -- FT-14 and FT-15
    -- Failed and cancelled payment handling
    -- ========================================================

    FOR v_test_status IN

        SELECT unnest(
            ARRAY['FAILED', 'CANCELLED']
        )

    LOOP

        IF v_test_status = 'FAILED' THEN

            v_test_id := 'FT-14';
            v_test_payload := v_failed_payload;

        ELSE

            v_test_id := 'FT-15';
            v_test_payload := v_cancelled_payload;

        END IF;


        -- Create a new pending transaction.

        v_pending :=
            public.hitpay_create_pending(v_session_id);

        v_transaction_id :=
            (v_pending->>'transaction_id')::uuid;

        v_order_reference :=
            v_pending->>'order_reference';

        v_gateway_request_id :=
            'TEST-REQUEST-' || gen_random_uuid()::text;


        IF v_transaction_id IS NULL
           OR v_order_reference IS NULL
           OR (v_pending->>'status')
              IS DISTINCT FROM 'PENDING_PAYMENT'
        THEN

            RAISE EXCEPTION
                '% FAILED: pending transaction invalid.',
                v_test_id;

        END IF;


        -- Claim the checkout.

        IF public.hitpay_claim_checkout(
            v_transaction_id,
            v_user_id
        ) IS DISTINCT FROM true THEN

            RAISE EXCEPTION
                '% FAILED: checkout claim unsuccessful.',
                v_test_id;

        END IF;


        -- Save synthetic checkout information.

        IF public.hitpay_save_checkout(
            v_transaction_id,
            v_user_id,
            v_gateway_request_id,
            'https://example.invalid/hitpay-test'
        ) IS DISTINCT FROM true THEN

            RAISE EXCEPTION
                '% FAILED: checkout save unsuccessful.',
                v_test_id;

        END IF;


        -- Simulate a verified unsuccessful notification.

        v_result :=
            public.hitpay_update_status(
                v_order_reference,
                v_gateway_request_id,
                v_test_status,
                v_signature,
                v_test_payload
            );


        IF (v_result->>'status')
               IS DISTINCT FROM v_test_status
           OR (v_result->>'updated')
               IS DISTINCT FROM 'true'
           OR (v_result->>'registration_completed')
               IS DISTINCT FROM 'false'
        THEN

            RAISE EXCEPTION
                '% FAILED: unexpected status response.',
                v_test_id;

        END IF;


        SELECT *
        INTO STRICT v_payment
        FROM public.payment_transactions
        WHERE transaction_id = v_transaction_id;


        IF v_payment.transaction_status::text
               IS DISTINCT FROM v_test_status
           OR v_payment.registration_id IS NOT NULL
           OR v_payment.gateway_verified_at IS NULL
           OR v_payment.hmac_signature
               IS DISTINCT FROM v_signature
           OR v_payment.gateway_payload
               IS DISTINCT FROM v_test_payload
           OR v_payment.reconciliation_required
               IS DISTINCT FROM false
        THEN

            RAISE EXCEPTION
                '% FAILED: invalid transaction state.',
                v_test_id;

        END IF;


        SELECT count(*)
        INTO v_count
        FROM public.session_registrations
        WHERE session_id = v_session_id;


        IF v_count <> 0 THEN

            RAISE EXCEPTION
                '% FAILED: registration created prematurely.',
                v_test_id;

        END IF;


        RAISE NOTICE
            '% PASSED: % recorded without registration.',
            v_test_id,
            v_test_status;

    END LOOP;


    -- ========================================================
    -- FT-16: Pending notification handling
    -- ========================================================

    v_pending :=
        public.hitpay_create_pending(v_session_id);

    v_transaction_id :=
        (v_pending->>'transaction_id')::uuid;

    v_order_reference :=
        v_pending->>'order_reference';

    v_gateway_request_id :=
        'TEST-REQUEST-' || gen_random_uuid()::text;


    IF public.hitpay_claim_checkout(
        v_transaction_id,
        v_user_id
    ) IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'FT-16 FAILED: checkout claim unsuccessful.';

    END IF;


    IF public.hitpay_save_checkout(
        v_transaction_id,
        v_user_id,
        v_gateway_request_id,
        'https://example.invalid/hitpay-test'
    ) IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'FT-16 FAILED: checkout save unsuccessful.';

    END IF;


    SELECT to_jsonb(p)
    INTO STRICT v_before
    FROM public.payment_transactions p
    WHERE transaction_id = v_transaction_id;


    v_result :=
        public.hitpay_update_status(
            v_order_reference,
            v_gateway_request_id,
            'PENDING_PAYMENT',
            v_signature,
            v_pending_payload
        );


    SELECT to_jsonb(p)
    INTO STRICT v_after
    FROM public.payment_transactions p
    WHERE transaction_id = v_transaction_id;


    IF (v_result->>'status')
           IS DISTINCT FROM 'PENDING_PAYMENT'
       OR (v_result->>'updated')
           IS DISTINCT FROM 'false'
       OR (v_result->>'registration_completed')
           IS DISTINCT FROM 'false'
       OR v_before IS DISTINCT FROM v_after
    THEN

        RAISE EXCEPTION
            'FT-16 FAILED: pending transaction changed.';

    END IF;


    SELECT count(*)
    INTO v_count
    FROM public.session_registrations
    WHERE session_id = v_session_id;


    IF v_count <> 0 THEN

        RAISE EXCEPTION
            'FT-16 FAILED: registration created prematurely.';

    END IF;


    RAISE NOTICE
        'FT-16 PASSED: pending notification preserved state.';


    -- ========================================================
    -- FT-17: Late failure after successful payment
    --
    -- Use a subtransaction to isolate this scenario.
    -- Successful test changes are reverted afterward.
    -- ========================================================

    BEGIN

        v_gateway_reference :=
            'TEST-PAYMENT-' || gen_random_uuid()::text;


        v_result :=
            public.hitpay_finalize_payment(
                v_order_reference,
                v_gateway_request_id,
                v_gateway_reference,
                100.00,
                'PHP',
                'GCASH'::public.payment_channel_enum,
                v_signature,
                v_success_payload
            );


        IF (v_result->>'status')
               IS DISTINCT FROM 'PAID'
           OR (v_result->>'registration_completed')
               IS DISTINCT FROM 'true'
        THEN

            RAISE EXCEPTION
                'FT-17 FAILED: initial finalization unsuccessful.';

        END IF;


        SELECT to_jsonb(p)
        INTO STRICT v_before
        FROM public.payment_transactions p
        WHERE transaction_id = v_transaction_id;


        -- Simulate a delayed failed notification.

        v_result :=
            public.hitpay_update_status(
                v_order_reference,
                v_gateway_request_id,
                'FAILED',
                v_signature,
                v_failed_payload
            );


        SELECT to_jsonb(p)
        INTO STRICT v_after
        FROM public.payment_transactions p
        WHERE transaction_id = v_transaction_id;


        IF (v_result->>'status')
               IS DISTINCT FROM 'PAID'
           OR (v_result->>'updated')
               IS DISTINCT FROM 'false'
           OR v_before IS DISTINCT FROM v_after
        THEN

            RAISE EXCEPTION
                'FT-17 FAILED: paid transaction was modified.';

        END IF;


        SELECT count(*)
        INTO v_count
        FROM public.session_registrations
        WHERE session_id = v_session_id
          AND user_id = v_user_id
          AND payment_status = 'PAID';


        IF v_count <> 1 THEN

            RAISE EXCEPTION
                'FT-17 FAILED: paid registration not preserved.';

        END IF;


        -- Deliberately revert only this subtransaction.

        RAISE EXCEPTION
            USING
                ERRCODE = 'P9001',
                MESSAGE = 'FT-17 intentional test rollback';

    EXCEPTION

        WHEN SQLSTATE 'P9001' THEN

            IF SQLERRM IS DISTINCT FROM
                'FT-17 intentional test rollback'
            THEN
                RAISE;
            END IF;

            RAISE NOTICE
                'FT-17 PASSED: paid state protected.';

    END;


    -- Verify that the FT-17 subtransaction was reverted.

    SELECT *
    INTO STRICT v_payment
    FROM public.payment_transactions
    WHERE transaction_id = v_transaction_id;


    IF v_payment.transaction_status::text
           IS DISTINCT FROM 'PENDING_PAYMENT'
       OR v_payment.registration_id IS NOT NULL
       OR v_payment.gateway_verified_at IS NOT NULL
    THEN

        RAISE EXCEPTION
            'FT-17 cleanup failed.';

    END IF;


    -- ========================================================
    -- FT-18: Late success after cancellation
    -- ========================================================

    v_result :=
        public.hitpay_update_status(
            v_order_reference,
            v_gateway_request_id,
            'CANCELLED',
            v_signature,
            v_cancelled_payload
        );


    IF (v_result->>'status')
           IS DISTINCT FROM 'CANCELLED'
       OR (v_result->>'updated')
           IS DISTINCT FROM 'true'
    THEN

        RAISE EXCEPTION
            'FT-18 FAILED: initial cancellation unsuccessful.';

    END IF;


    v_gateway_reference :=
        'TEST-PAYMENT-' || gen_random_uuid()::text;


    -- Simulate a delayed successful notification.

    v_result :=
        public.hitpay_finalize_payment(
            v_order_reference,
            v_gateway_request_id,
            v_gateway_reference,
            100.00,
            'PHP',
            'GCASH'::public.payment_channel_enum,
            v_signature,
            v_success_payload
        );


    IF (v_result->>'status')
           IS DISTINCT FROM 'REVIEW_REQUIRED'
       OR (v_result->>'reconciliation_required')
           IS DISTINCT FROM 'true'
       OR (v_result->>'gateway_payment_verified')
           IS DISTINCT FROM 'true'
       OR (v_result->>'registration_completed')
           IS DISTINCT FROM 'false'
    THEN

        RAISE EXCEPTION
            'FT-18 FAILED: reconciliation not requested.';

    END IF;


    SELECT *
    INTO STRICT v_payment
    FROM public.payment_transactions
    WHERE transaction_id = v_transaction_id;


    IF v_payment.transaction_status::text
           IS DISTINCT FROM 'CANCELLED'
       OR v_payment.reconciliation_required
           IS DISTINCT FROM true
       OR v_payment.reconciliation_reason IS NULL
       OR v_payment.reconciliation_requested_at IS NULL
       OR v_payment.gateway_verified_at IS NULL
       OR v_payment.hitpay_reference_id
           IS DISTINCT FROM v_gateway_reference
       OR v_payment.gateway_payload
           IS DISTINCT FROM v_success_payload
       OR v_payment.registration_id IS NOT NULL
    THEN

        RAISE EXCEPTION
            'FT-18 FAILED: invalid reconciliation record.';

    END IF;


    SELECT count(*)
    INTO v_count
    FROM public.session_registrations
    WHERE session_id = v_session_id;


    IF v_count <> 0 THEN

        RAISE EXCEPTION
            'FT-18 FAILED: unauthorized registration created.';

    END IF;


    RAISE NOTICE
        'FT-18 PASSED: late success requires reconciliation.';

    -- HITPAY_MEMBER_REVIEW_TESTS_V1

    DECLARE
        v_history jsonb;
        v_record jsonb;
    BEGIN

        v_history := public.member_payments();

        SELECT item.record
        INTO STRICT v_record
        FROM jsonb_array_elements(
            v_history -> 'transactions'
        ) AS item(record)
        WHERE item.record ->> 'transaction_id' =
              v_transaction_id::text;

        -- FT-31: Reconciliation display protection.

        IF v_record ->> 'status'
            IS DISTINCT FROM 'CANCELLED'

           OR v_record ->> 'display_status'
            IS DISTINCT FROM 'REVIEW_REQUIRED'

           OR v_record -> 'reconciliation_required'
            IS DISTINCT FROM 'true'::jsonb

           OR v_record -> 'receipt_available'
            IS DISTINCT FROM 'false'::jsonb

           OR v_record -> 'registration_id'
            IS DISTINCT FROM 'null'::jsonb

           OR v_record ->> 'order_reference'
            IS DISTINCT FROM v_order_reference

           OR v_record ->> 'payment_provider'
            IS DISTINCT FROM 'HITPAY'

           OR v_record -> 'is_sandbox'
            IS DISTINCT FROM 'true'::jsonb

        THEN

            RAISE EXCEPTION
                'FT-31 FAILED: invalid reconciliation display.';

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
                'FT-31 FAILED: unauthorized registration returned.';

        END IF;

        RAISE NOTICE
            'FT-31 PASSED: reconciliation display protected.';

    END;




    -- HITPAY_ADMIN_LATE_SUCCESS_TESTS_V1

    DECLARE

        v_admin_review
            public.payment_transactions%ROWTYPE;

    BEGIN

        SELECT *
        INTO STRICT v_admin_review
        FROM public.payment_transactions
        WHERE transaction_id = v_transaction_id
          AND user_id = v_user_id
          AND session_id = v_session_id;


        -- FT-46A: Late successful payment reconciliation.

        IF v_admin_review.payment_provider
            IS DISTINCT FROM 'HITPAY'

           OR v_admin_review.is_sandbox
            IS DISTINCT FROM true

           OR v_admin_review.transaction_status::text
            IS DISTINCT FROM 'CANCELLED'

           OR v_admin_review.reconciliation_required
            IS DISTINCT FROM true

           OR NULLIF(
                btrim(v_admin_review.reconciliation_reason),
                ''
           ) IS NULL

           OR v_admin_review.reconciliation_requested_at
                IS NULL

           OR v_admin_review.gateway_verified_at
                IS NULL

           OR v_admin_review.gateway_request_id
            IS DISTINCT FROM v_gateway_request_id

           OR v_admin_review.hitpay_reference_id
            IS DISTINCT FROM v_gateway_reference

           OR v_admin_review.order_reference_id
            IS DISTINCT FROM v_order_reference

           OR v_admin_review.hmac_signature
            IS DISTINCT FROM v_signature

           OR v_admin_review.gateway_payload
            IS DISTINCT FROM v_success_payload

           OR v_admin_review.registration_id
                IS NOT NULL

           OR v_admin_review.confirmed_at
                IS NOT NULL

        THEN

            RAISE EXCEPTION
                'FT-46A FAILED: invalid reconciliation fixture.';

        END IF;


        IF EXISTS (

            SELECT 1

            FROM public.session_registrations

            WHERE user_id = v_user_id
              AND session_id = v_session_id

        ) THEN

            RAISE EXCEPTION
                'FT-46A FAILED: premature registration.';

        END IF;


        RAISE NOTICE
            'FT-46A PRECHECK PASSED: late success review fixture.';

        RAISE NOTICE
            'FT-46A: registration and receipt must remain unavailable.';

        RAISE NOTICE
            'FT-46A: authenticated administrator display test pending.';

    END;

    -- ========================================================
    -- Final alternative test summary
    -- ========================================================

    RAISE NOTICE
        '============================================';

    RAISE NOTICE
        'ALTERNATIVE PAYMENT TESTS PASSED';

    RAISE NOTICE
        'FT-14: Failed payment handling';

    RAISE NOTICE
        'FT-15: Cancelled payment handling';

    RAISE NOTICE
        'FT-16: Pending notification handling';

    RAISE NOTICE
        'FT-17: Late failure protection';

    RAISE NOTICE
        'FT-18: Late success reconciliation';

    RAISE NOTICE
        '============================================';

END;

$alternative_tests$;
