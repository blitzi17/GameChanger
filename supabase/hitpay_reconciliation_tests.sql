
-- GameChanger UC-PAM-01
-- Additional reconciliation and security tests
-- FT-19 to FT-22
--
-- Synthetic sandbox records only.
-- Execute after hitpay_alternative_tests.sql
-- inside the combined rollback transaction.
-- Do not execute independently.

DO $reconciliation_tests$

DECLARE

    v_user_id uuid :=
        'cb9ab5af-576f-48fd-b5c6-081874c2ea0e';

    v_session_id uuid :=
        'cd2f1fa3-c011-481f-b8fa-333354d14e27';

    v_unauthorized_user uuid :=
        gen_random_uuid();

    v_transaction_id uuid;

    v_pending jsonb;

    v_payment public.payment_transactions%ROWTYPE;

    v_before jsonb;

    v_after jsonb;

    v_rejected boolean;

    v_count integer;

    v_original_count integer;

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

    ) THEN

        RAISE EXCEPTION
            'Safety check failed: unexpected registration.';

    END IF;


    -- Require the reconciliation record created by FT-18.

    SELECT count(*)

    INTO v_count

    FROM public.payment_transactions

    WHERE user_id = v_user_id

      AND session_id = v_session_id

      AND payment_provider = 'HITPAY'

      AND is_sandbox = true

      AND reconciliation_required = true;


    IF v_count <> 1 THEN

        RAISE EXCEPTION
            'Safety check failed: FT-18 record not found.';

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
    -- FT-20: Existing reconciliation blocks new payments
    --
    -- Execute this first because FT-18 has already created
    -- an unresolved reconciliation record.
    -- ========================================================

    SELECT count(*)

    INTO v_original_count

    FROM public.payment_transactions

    WHERE session_id = v_session_id;


    v_rejected := false;


    BEGIN

        PERFORM public.hitpay_create_pending(
            v_session_id
        );

    EXCEPTION

        WHEN raise_exception THEN

            IF SQLERRM IS DISTINCT FROM
                'An existing payment requires reconciliation.'
            THEN

                RAISE;

            END IF;

            v_rejected := true;

    END;


    IF v_rejected IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'FT-20 FAILED: new payment was not rejected.';

    END IF;


    SELECT count(*)

    INTO v_count

    FROM public.payment_transactions

    WHERE session_id = v_session_id;


    IF v_count <> v_original_count THEN

        RAISE EXCEPTION
            'FT-20 FAILED: unexpected transaction created.';

    END IF;


    RAISE NOTICE
        'FT-20 PASSED: unresolved reconciliation blocks payment.';


    -- ========================================================
    -- FT-19: Interrupted checkout creation
    --
    -- The existing FT-18 record prevents another payment.
    -- Therefore, test the checkout review transition using
    -- an isolated synthetic transaction.
    -- ========================================================

    BEGIN

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

            v_session_id,

            'GC-' || gen_random_uuid()::text,

            NULL,

            100.00,

            'PHP',

            'PENDING_PAYMENT',

            'HITPAY',

            true,

            'NOT_STARTED',

            false

        )

        RETURNING transaction_id

        INTO v_transaction_id;


        -- Simulate checkout creation beginning.

        IF public.hitpay_claim_checkout(
            v_transaction_id,
            v_user_id
        ) IS DISTINCT FROM true THEN

            RAISE EXCEPTION
                'FT-19 FAILED: checkout claim unsuccessful.';

        END IF;


        SELECT *

        INTO STRICT v_payment

        FROM public.payment_transactions

        WHERE transaction_id = v_transaction_id;


        IF v_payment.checkout_state
               IS DISTINCT FROM 'CREATING'

           OR v_payment.checkout_claimed_at IS NULL

           OR v_payment.gateway_request_id IS NOT NULL

        THEN

            RAISE EXCEPTION
                'FT-19 FAILED: invalid checkout claim state.';

        END IF;


        -- Simulate an interrupted checkout request.

        IF public.hitpay_checkout_review(
            v_transaction_id,
            v_user_id
        ) IS DISTINCT FROM true THEN

            RAISE EXCEPTION
                'FT-19 FAILED: checkout review unsuccessful.';

        END IF;


        SELECT *

        INTO STRICT v_payment

        FROM public.payment_transactions

        WHERE transaction_id = v_transaction_id;


        IF v_payment.checkout_state
               IS DISTINCT FROM 'REVIEW_REQUIRED'

           OR v_payment.reconciliation_required
               IS DISTINCT FROM true

           OR v_payment.reconciliation_reason IS NULL

           OR v_payment.reconciliation_requested_at IS NULL

           OR v_payment.transaction_status::text
               IS DISTINCT FROM 'PENDING_PAYMENT'

           OR v_payment.registration_id IS NOT NULL

           OR v_payment.gateway_verified_at IS NOT NULL

        THEN

            RAISE EXCEPTION
                'FT-19 FAILED: invalid checkout review state.';

        END IF;



        -- HITPAY_ADMIN_CHECKOUT_REVIEW_TESTS_V1

        DECLARE

            v_admin_checkout
                public.payment_transactions%ROWTYPE;

        BEGIN

            SELECT *
            INTO STRICT v_admin_checkout
            FROM public.payment_transactions
            WHERE transaction_id = v_transaction_id
              AND user_id = v_user_id
              AND session_id = v_session_id;


            -- FT-46B: Interrupted checkout reconciliation.

            IF v_admin_checkout.payment_provider
                IS DISTINCT FROM 'HITPAY'

               OR v_admin_checkout.is_sandbox
                IS DISTINCT FROM true

               OR v_admin_checkout.transaction_status::text
                IS DISTINCT FROM 'PENDING_PAYMENT'

               OR v_admin_checkout.checkout_state
                IS DISTINCT FROM 'REVIEW_REQUIRED'

               OR v_admin_checkout.reconciliation_required
                IS DISTINCT FROM true

               OR NULLIF(
                    btrim(
                        v_admin_checkout.reconciliation_reason
                    ),
                    ''
               ) IS NULL

               OR v_admin_checkout.reconciliation_requested_at
                    IS NULL

               OR v_admin_checkout.checkout_claimed_at
                    IS NULL

               OR v_admin_checkout.gateway_request_id
                    IS NOT NULL

               OR v_admin_checkout.gateway_verified_at
                    IS NOT NULL

               OR v_admin_checkout.hitpay_reference_id
                    IS NOT NULL

               OR v_admin_checkout.hmac_signature
                    IS NOT NULL

               OR v_admin_checkout.gateway_payload
                    IS NOT NULL

               OR v_admin_checkout.registration_id
                    IS NOT NULL

               OR v_admin_checkout.confirmed_at
                    IS NOT NULL

            THEN

                RAISE EXCEPTION
                    'FT-46B FAILED: invalid checkout review fixture.';

            END IF;


            IF EXISTS (

                SELECT 1

                FROM public.session_registrations

                WHERE user_id = v_user_id
                  AND session_id = v_session_id

            ) THEN

                RAISE EXCEPTION
                    'FT-46B FAILED: premature registration.';

            END IF;


            RAISE NOTICE
                'FT-46B PRECHECK PASSED: interrupted checkout fixture.';

            RAISE NOTICE
                'FT-46B: no successful payment evidence recorded.';

            RAISE NOTICE
                'FT-46B: authenticated administrator display test pending.';

        END;

        -- Verify another checkout cannot be claimed.

        IF public.hitpay_claim_checkout(
            v_transaction_id,
            v_user_id
        ) IS DISTINCT FROM false THEN

            RAISE EXCEPTION
                'FT-19 FAILED: duplicate checkout claim allowed.';

        END IF;


        -- Verify checkout state cannot be reset.

        v_rejected := false;


        BEGIN

            UPDATE public.payment_transactions

            SET checkout_state = 'NOT_STARTED'

            WHERE transaction_id = v_transaction_id;

        EXCEPTION

            WHEN raise_exception THEN

                v_rejected := true;

        END;


        IF v_rejected IS DISTINCT FROM true THEN

            RAISE EXCEPTION
                'FT-19 FAILED: reviewed checkout was reset.';

        END IF;


        SELECT *

        INTO STRICT v_payment

        FROM public.payment_transactions

        WHERE transaction_id = v_transaction_id;


        IF v_payment.checkout_state
               IS DISTINCT FROM 'REVIEW_REQUIRED'

           OR v_payment.reconciliation_required
               IS DISTINCT FROM true

        THEN

            RAISE EXCEPTION
                'FT-19 FAILED: reconciliation state changed.';

        END IF;


        -- Revert the isolated FT-19 transaction.

        RAISE EXCEPTION

            USING

                ERRCODE = 'P9002',

                MESSAGE = 'FT-19 intentional test rollback';


    EXCEPTION

        WHEN SQLSTATE 'P9002' THEN

            IF SQLERRM IS DISTINCT FROM
                'FT-19 intentional test rollback'
            THEN

                RAISE;

            END IF;


            RAISE NOTICE
                'FT-19 PASSED: interrupted checkout protected.';

    END;


    -- Confirm the isolated transaction was reverted.

    SELECT count(*)

    INTO v_count

    FROM public.payment_transactions

    WHERE session_id = v_session_id;


    IF v_count <> v_original_count THEN

        RAISE EXCEPTION
            'FT-19 cleanup failed.';

    END IF;


    -- ========================================================
    -- FT-20B: Verified reconciliation evidence protection
    -- ========================================================

    SELECT transaction_id

    INTO STRICT v_transaction_id

    FROM public.payment_transactions

    WHERE user_id = v_user_id

      AND session_id = v_session_id

      AND payment_provider = 'HITPAY'

      AND is_sandbox = true

      AND reconciliation_required = true

      AND gateway_verified_at IS NOT NULL;


    SELECT to_jsonb(p)

    INTO STRICT v_before

    FROM public.payment_transactions p

    WHERE transaction_id = v_transaction_id;


    v_rejected := false;


    BEGIN

        UPDATE public.payment_transactions

        SET reconciliation_required = false

        WHERE transaction_id = v_transaction_id;

    EXCEPTION

        WHEN raise_exception THEN

            v_rejected := true;

    END;


    IF v_rejected IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'FT-20B FAILED: reconciliation flag was cleared.';

    END IF;


    SELECT to_jsonb(p)

    INTO STRICT v_after

    FROM public.payment_transactions p

    WHERE transaction_id = v_transaction_id;


    IF v_before IS DISTINCT FROM v_after THEN

        RAISE EXCEPTION
            'FT-20B FAILED: reconciliation record changed.';

    END IF;


    RAISE NOTICE
        'FT-20B PASSED: verified reconciliation preserved.';


    -- ========================================================
    -- FT-21: Unauthorized sandbox identity
    -- ========================================================

    IF public.hitpay_is_sandbox_allowed(
        v_unauthorized_user,
        v_session_id
    ) IS DISTINCT FROM false THEN

        RAISE EXCEPTION
            'FT-21 FAILED: unauthorized identity allowlisted.';

    END IF;


    -- Simulate an identity outside the sandbox allowlist.

    PERFORM set_config(
        'request.jwt.claim.sub',
        v_unauthorized_user::text,
        true
    );


    PERFORM set_config(
        'request.jwt.claims',
        jsonb_build_object(
            'sub', v_unauthorized_user,
            'role', 'authenticated'
        )::text,
        true
    );


    v_rejected := false;


    BEGIN

        PERFORM public.hitpay_create_pending(
            v_session_id
        );

    EXCEPTION

        WHEN raise_exception THEN

            IF SQLERRM IS DISTINCT FROM
                'Sandbox payment is not authorized.'
            THEN

                RAISE;

            END IF;

            v_rejected := true;

    END;


    IF v_rejected IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'FT-21 FAILED: unauthorized payment accepted.';

    END IF;


    SELECT count(*)

    INTO v_count

    FROM public.payment_transactions

    WHERE session_id = v_session_id;


    IF v_count <> v_original_count THEN

        RAISE EXCEPTION
            'FT-21 FAILED: unauthorized transaction created.';

    END IF;


    -- Restore the authorized synthetic identity.

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


    RAISE NOTICE
        'FT-21 PASSED: unauthorized identity rejected.';


    -- ========================================================
    -- FT-22: Legacy manual payment protection
    -- ========================================================

    v_rejected := false;


    BEGIN

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

            is_sandbox

        )

        VALUES (

            NULL,

            v_user_id,

            v_session_id,

            'GC-' || gen_random_uuid()::text,

            'MANUAL_BANK',

            100.00,

            'PHP',

            'PENDING_PAYMENT',

            NULL,

            false

        );


    EXCEPTION

        WHEN raise_exception THEN

            IF SQLERRM IS DISTINCT FROM
                'This session requires HitPay Sandbox payment.'
            THEN

                RAISE;

            END IF;

            v_rejected := true;

    END;


    IF v_rejected IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'FT-22 FAILED: legacy payment was accepted.';

    END IF;


    SELECT count(*)

    INTO v_count

    FROM public.payment_transactions

    WHERE session_id = v_session_id;


    IF v_count <> v_original_count THEN

        RAISE EXCEPTION
            'FT-22 FAILED: unexpected legacy transaction.';

    END IF;


    RAISE NOTICE
        'FT-22 PASSED: legacy payment rejected.';


    -- ========================================================

    -- HITPAY_AUDIT_TESTS_V1

    -- FT-51: Verify audit history exists.
    SELECT count(*)
    INTO v_count
    FROM public.hitpay_audit_records
    WHERE transaction_id = v_transaction_id;

    IF v_count < 2 THEN
        RAISE EXCEPTION
            'FT-51 FAILED: incomplete audit history.';
    END IF;

    -- FT-52: Verify reconciliation evidence is retained.
    IF NOT EXISTS (
        SELECT 1
        FROM public.hitpay_audit_records
        WHERE transaction_id = v_transaction_id
          AND reconciliation_required = true
          AND gateway_payload IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'FT-52 FAILED: audit evidence missing.';
    END IF;

    -- FT-53: Verify audit table permissions.
    IF EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
            'anon', 'authenticated', 'service_role'
        ]) AS r(role_name)
        CROSS JOIN unnest(ARRAY[
            'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'
        ]) AS p(privilege_name)
        WHERE has_table_privilege(
            r.role_name,
            'public.hitpay_audit_records',
            p.privilege_name
        )
    ) THEN
        RAISE EXCEPTION
            'FT-53 FAILED: audit modification permitted.';
    END IF;

    IF has_table_privilege(
        'anon', 'public.hitpay_audit_records', 'SELECT'
    ) OR has_table_privilege(
        'authenticated', 'public.hitpay_audit_records', 'SELECT'
    ) OR NOT has_table_privilege(
        'service_role', 'public.hitpay_audit_records', 'SELECT'
    ) THEN
        RAISE EXCEPTION
            'FT-53 FAILED: incorrect audit read permissions.';
    END IF;

    RAISE NOTICE 'FT-51 to FT-53 PASSED: audit protection.';

    -- Final integrity checks
    -- ========================================================

    SELECT count(*)

    INTO v_count

    FROM public.session_registrations

    WHERE session_id = v_session_id;


    IF v_count <> 0 THEN

        RAISE EXCEPTION
            'Final integrity check failed: unexpected registration.';

    END IF;


    SELECT count(*)

    INTO v_count

    FROM public.payment_transactions

    WHERE session_id = v_session_id

      AND payment_provider = 'HITPAY'

      AND is_sandbox = true

      AND reconciliation_required = true;


    IF v_count <> 1 THEN

        RAISE EXCEPTION
            'Final integrity check failed: reconciliation count.';

    END IF;


    RAISE NOTICE
        '============================================';

    RAISE NOTICE
        'RECONCILIATION AND SECURITY TESTS PASSED';

    RAISE NOTICE
        'FT-19: Interrupted checkout protection';

    RAISE NOTICE
        'FT-20: Reconciliation protection';

    RAISE NOTICE
        'FT-21: Unauthorized identity rejection';

    RAISE NOTICE
        'FT-22: Legacy payment protection';

    RAISE NOTICE
        '============================================';

END;

$reconciliation_tests$;
