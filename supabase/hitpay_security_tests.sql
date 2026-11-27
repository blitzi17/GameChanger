-- GameChanger UC-PAM-01
-- HitPay security and revenue functional tests
-- Execute after FT-01 through FT-10.
-- Must remain inside the rollback transaction.

DO $security_tests$
DECLARE
    v_user_id uuid :=
        'cb9ab5af-576f-48fd-b5c6-081874c2ea0e';

    v_session_id uuid :=
        'cd2f1fa3-c011-481f-b8fa-333354d14e27';

    v_transaction_id uuid;

    v_blocked boolean;

    v_sandbox_revenue numeric;
    v_actual_revenue numeric;
    v_unfiltered_revenue numeric;

    v_dashboard_definition text;

BEGIN

    -- Safety check: FT-08 must have succeeded.

    SELECT transaction_id
    INTO STRICT v_transaction_id
    FROM public.payment_transactions
    WHERE user_id = v_user_id
      AND session_id = v_session_id
      AND payment_provider = 'HITPAY'
      AND is_sandbox = true
      AND transaction_status = 'PAID';


    -- FT-11A: Authenticated members must not
    -- execute trusted backend payment functions.

    IF has_function_privilege(
        'authenticated',
        'public.hitpay_finalize_payment(
            text,
            text,
            text,
            numeric,
            text,
            public.payment_channel_enum,
            text,
            jsonb
        )',
        'EXECUTE'
    ) THEN

        RAISE EXCEPTION
            'FT-11A FAILED: authenticated role can finalize payments.';

    END IF;

    IF has_function_privilege(
        'anon',
        'public.hitpay_finalize_payment(
            text,
            text,
            text,
            numeric,
            text,
            public.payment_channel_enum,
            text,
            jsonb
        )',
        'EXECUTE'
    ) THEN

        RAISE EXCEPTION
            'FT-11A FAILED: anonymous role can finalize payments.';

    END IF;

    RAISE NOTICE
        'FT-11A PASSED: finalization permissions restricted.';


    -- FT-11B: Verified payment amount
    -- must not be manually modified.

    v_blocked := false;

    BEGIN

        UPDATE public.payment_transactions
        SET amount = amount + 1
        WHERE transaction_id = v_transaction_id;

    EXCEPTION
        WHEN raise_exception THEN
            v_blocked := true;

    END;

    IF NOT v_blocked THEN

        RAISE EXCEPTION
            'FT-11B FAILED: verified amount modification allowed.';

    END IF;

    RAISE NOTICE
        'FT-11B PASSED: verified amount protected.';


    -- FT-11C: Verified payment status
    -- must not be manually changed.

    v_blocked := false;

    BEGIN

        UPDATE public.payment_transactions
        SET transaction_status = 'FAILED'
        WHERE transaction_id = v_transaction_id;

    EXCEPTION
        WHEN raise_exception THEN
            v_blocked := true;

    END;

    IF NOT v_blocked THEN

        RAISE EXCEPTION
            'FT-11C FAILED: verified status modification allowed.';

    END IF;

    RAISE NOTICE
        'FT-11C PASSED: verified status protected.';


    -- FT-11D: HitPay transaction deletion
    -- must be blocked.

    v_blocked := false;

    BEGIN

        DELETE FROM public.payment_transactions
        WHERE transaction_id = v_transaction_id;

    EXCEPTION
        WHEN raise_exception THEN
            v_blocked := true;

    END;

    IF NOT v_blocked THEN

        RAISE EXCEPTION
            'FT-11D FAILED: verified transaction deletion allowed.';

    END IF;

    RAISE NOTICE
        'FT-11D PASSED: verified transaction retained.';


    -- FT-11E: Ordinary roles must not
    -- have TRUNCATE permissions.

    IF has_table_privilege(
        'anon',
        'public.payment_transactions',
        'TRUNCATE'
    ) OR has_table_privilege(
        'authenticated',
        'public.payment_transactions',
        'TRUNCATE'
    ) OR has_table_privilege(
        'anon',
        'public.session_registrations',
        'TRUNCATE'
    ) OR has_table_privilege(
        'authenticated',
        'public.session_registrations',
        'TRUNCATE'
    ) THEN

        RAISE EXCEPTION
            'FT-11E FAILED: unsafe TRUNCATE permission remains.';

    END IF;

    RAISE NOTICE
        'FT-11E PASSED: TRUNCATE permissions restricted.';


    -- FT-12A: Verify sandbox revenue calculation.

    SELECT COALESCE(SUM(amount), 0)
    INTO v_sandbox_revenue
    FROM public.payment_transactions
    WHERE transaction_status = 'PAID'
      AND is_sandbox = true;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_actual_revenue
    FROM public.payment_transactions
    WHERE transaction_status = 'PAID'
      AND is_sandbox = false;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_unfiltered_revenue
    FROM public.payment_transactions
    WHERE transaction_status = 'PAID';

    IF v_sandbox_revenue <> 100.00 THEN

        RAISE EXCEPTION
            'FT-12A FAILED: unexpected sandbox revenue.';

    END IF;

    IF v_unfiltered_revenue - v_actual_revenue
        IS DISTINCT FROM v_sandbox_revenue
    THEN

        RAISE EXCEPTION
            'FT-12A FAILED: sandbox revenue not separated.';

    END IF;

    RAISE NOTICE
        'FT-12A PASSED: simulated revenue separated.';


    -- FT-12B: Verify dashboard revenue filters.

    SELECT pg_get_functiondef(
        'public.admin_dashboard()'::regprocedure
    )
    INTO v_dashboard_definition;

    IF position(
        'where transaction_status = ''PAID'' and is_sandbox = false'
        IN v_dashboard_definition
    ) = 0 THEN

        RAISE EXCEPTION
            'FT-12B FAILED: dashboard revenue filter missing.';

    END IF;

    IF position(
        't.transaction_status = ''PAID'' and t.is_sandbox = false'
        IN v_dashboard_definition
    ) = 0 THEN

        RAISE EXCEPTION
            'FT-12B FAILED: session revenue filter missing.';

    END IF;

    RAISE NOTICE
        'FT-12B PASSED: dashboard revenue filters present.';


    -- Final integrity check.

    IF NOT EXISTS (
        SELECT 1
        FROM public.payment_transactions
        WHERE transaction_id = v_transaction_id
          AND transaction_status = 'PAID'
          AND amount = 100.00
          AND is_sandbox = true
          AND gateway_verified_at IS NOT NULL
    ) THEN

        RAISE EXCEPTION
            'Final integrity check failed.';

    END IF;

    RAISE NOTICE
        'FT-11 and FT-12 completed successfully.';

END;
$security_tests$;