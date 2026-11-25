
-- ============================================================
-- GameChanger: UC-PAM-01 Process Payment
-- HitPay Administrator Authorization Tests
--
-- Execute only inside the combined rollback transaction.
-- No administrator accounts are created or modified.
--
-- FT-34: Unauthenticated access
-- FT-35: Ordinary member restriction
-- FT-36: Active SU Admin authorization
-- FT-37: Active regular Admin authorization
-- FT-40: RPC execution permissions
--
-- FT-38 and FT-39 require synthetic payment fixtures
-- and are covered separately.
-- ============================================================

DO $admin_authorization_tests$

DECLARE

    v_member_id uuid :=
        'cb9ab5af-576f-48fd-b5c6-081874c2ea0e';

    v_super_admin_count integer;
    v_regular_admin_count integer;

    v_rejected boolean;

    v_previous_sub text :=
        current_setting('request.jwt.claim.sub', true);

    v_previous_claims text :=
        current_setting('request.jwt.claims', true);

BEGIN

    -- ========================================================
    -- Safety check: designated ordinary member
    -- ========================================================

    IF NOT EXISTS (
        SELECT 1
        FROM public.users
        WHERE user_id = v_member_id
          AND role = 'MEMBER'
          AND account_status = 'Active'
    ) THEN

        RAISE EXCEPTION
            'Safety check failed: dummy member missing.';

    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.profiles
        WHERE id = v_member_id
          AND role = 'member'
    ) THEN

        RAISE EXCEPTION
            'Safety check failed: ordinary member profile missing.';

    END IF;


    -- ========================================================
    -- Safety check: existing administrator roles
    -- ========================================================

    SELECT COUNT(*)
    INTO v_super_admin_count
    FROM public.profiles p
    WHERE p.role = 'admin'
      AND p.status = 'Active'
      AND public.is_super_admin(p.id);

    SELECT COUNT(*)
    INTO v_regular_admin_count
    FROM public.profiles p
    WHERE p.role = 'admin'
      AND p.status = 'Active'
      AND NOT public.is_super_admin(p.id);

    IF v_super_admin_count <> 1 THEN

        RAISE EXCEPTION
            'Safety check failed: expected one active SU Admin.';

    END IF;

    IF v_regular_admin_count <> 1 THEN

        RAISE EXCEPTION
            'Safety check failed: expected one active regular Admin.';

    END IF;

    RAISE NOTICE
        'Administrator role readiness verified.';


    -- ========================================================
    -- FT-34: Unauthenticated access restriction
    -- ========================================================

    PERFORM set_config(
        'request.jwt.claim.sub',
        '',
        true
    );

    PERFORM set_config(
        'request.jwt.claims',
        '{}',
        true
    );

    v_rejected := false;

    BEGIN

        PERFORM public.admin_payments();

    EXCEPTION

        WHEN insufficient_privilege THEN

            v_rejected := true;

    END;

    IF NOT v_rejected THEN

        RAISE EXCEPTION
            'FT-34 FAILED: unauthenticated access accepted.';

    END IF;

    RAISE NOTICE
        'FT-34 PASSED: unauthenticated access rejected.';


    -- ========================================================
    -- FT-35: Ordinary member restriction
    -- ========================================================

    PERFORM set_config(
        'request.jwt.claim.sub',
        v_member_id::text,
        true
    );

    PERFORM set_config(
        'request.jwt.claims',
        jsonb_build_object(
            'sub', v_member_id,
            'role', 'authenticated'
        )::text,
        true
    );

    v_rejected := false;

    BEGIN

        PERFORM public.admin_payments();

    EXCEPTION

        WHEN insufficient_privilege THEN

            v_rejected := true;

        WHEN raise_exception THEN

            IF SQLERRM IS DISTINCT FROM 'Admins only' THEN
                RAISE;
            END IF;

            v_rejected := true;

    END;

    IF NOT v_rejected THEN

        RAISE EXCEPTION
            'FT-35 FAILED: ordinary member access accepted.';

    END IF;

    RAISE NOTICE
        'FT-35 PASSED: ordinary member access rejected.';


    -- ========================================================
    -- FT-36: Active SU Admin role readiness
    -- ========================================================

    IF v_super_admin_count <> 1 THEN

        RAISE EXCEPTION
            'FT-36 FAILED: SU Admin role unavailable.';

    END IF;

    RAISE NOTICE
        'FT-36 PRECHECK PASSED: active SU Admin exists.';

    RAISE NOTICE
        'FT-36 RPC access test pending authenticated SU Admin session.';


    -- ========================================================
    -- FT-37: Active regular Admin role readiness
    -- ========================================================

    IF v_regular_admin_count <> 1 THEN

        RAISE EXCEPTION
            'FT-37 FAILED: regular Admin role unavailable.';

    END IF;

    RAISE NOTICE
        'FT-37 PRECHECK PASSED: active regular Admin exists.';

    RAISE NOTICE
        'FT-37 RPC access test pending authenticated Admin session.';


    -- ========================================================
    -- FT-40: Administrator RPC execution permissions
    -- ========================================================

    IF has_function_privilege(
        'anon',
        'public.admin_payments()',
        'EXECUTE'
    ) THEN

        RAISE EXCEPTION
            'FT-40 FAILED: anonymous execution permitted.';

    END IF;

    IF NOT has_function_privilege(
        'authenticated',
        'public.admin_payments()',
        'EXECUTE'
    ) THEN

        RAISE EXCEPTION
            'FT-40 FAILED: authenticated RPC permission missing.';

    END IF;

    IF NOT has_function_privilege(
        'service_role',
        'public.admin_payments()',
        'EXECUTE'
    ) THEN

        RAISE EXCEPTION
            'FT-40 FAILED: service role permission missing.';

    END IF;

    IF has_function_privilege(
        'anon',
        'public.hitpay_require_payment_admin()',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.hitpay_require_payment_admin()',
        'EXECUTE'
    ) THEN

        RAISE EXCEPTION
            'FT-40 FAILED: internal helper exposed.';

    END IF;

    IF NOT has_function_privilege(
        'service_role',
        'public.hitpay_require_payment_admin()',
        'EXECUTE'
    ) THEN

        RAISE EXCEPTION
            'FT-40 FAILED: internal service permission missing.';

    END IF;

    RAISE NOTICE
        'FT-40 PASSED: RPC permissions verified.';


    -- ========================================================

    -- HITPAY_AUTHENTICATED_ROLE_TESTS_V1

    DECLARE
        v_admin record;
        v_result jsonb;
        v_tested integer := 0;
    BEGIN
        FOR v_admin IN
            SELECT
                p.id,
                public.is_super_admin(p.id) AS is_super
            FROM public.profiles p
            WHERE p.role = 'admin'
              AND p.status = 'Active'
        LOOP
            PERFORM set_config(
                'request.jwt.claim.sub',
                v_admin.id::text,
                true
            );

            PERFORM set_config(
                'request.jwt.claims',
                jsonb_build_object(
                    'sub', v_admin.id,
                    'role', 'authenticated'
                )::text,
                true
            );

            EXECUTE 'SET LOCAL ROLE authenticated';

            SELECT to_jsonb(public.admin_payments())
            INTO v_result;

            EXECUTE 'RESET ROLE';

            IF v_result IS NULL THEN
                RAISE EXCEPTION
                    'Administrator RPC returned no result.';
            END IF;

            v_tested := v_tested + 1;

            IF v_admin.is_super THEN
                RAISE NOTICE 'FT-36 PASSED: SU Admin RPC access.';
            ELSE
                RAISE NOTICE 'FT-37 PASSED: regular Admin RPC access.';
            END IF;
        END LOOP;

        IF v_tested <> 2 THEN
            RAISE EXCEPTION
                'Expected two administrator role tests.';
        END IF;
    END;

    -- Restore previous authentication context
    -- ========================================================

    PERFORM set_config(
        'request.jwt.claim.sub',
        COALESCE(v_previous_sub, ''),
        true
    );

    PERFORM set_config(
        'request.jwt.claims',
        COALESCE(v_previous_claims, ''),
        true
    );


    -- ========================================================
    -- Final authorization test summary
    -- ========================================================

    RAISE NOTICE
        'FT-34, FT-35 and FT-40 completed.';

    RAISE NOTICE
        'FT-36 and FT-37 role readiness verified.';

    RAISE NOTICE
        'FT-36 and FT-37 completed; FT-38 and FT-39 remain pending.';

    RAISE NOTICE
        'No administrator accounts created or modified.';

END;

$admin_authorization_tests$;
