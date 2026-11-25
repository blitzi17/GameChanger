
-- ============================================================
-- GameChanger: UC-PAM-01 Process Payment
-- Administrator Payment Compatibility Tests
--
-- FT-49: Ordinary payment compatibility prechecks
-- FT-50: Unpaid registration compatibility readiness
--
-- Execute only inside the combined rollback transaction.
-- Existing ordinary payment records must not be modified.
-- ============================================================

DO $admin_compatibility_tests$

DECLARE

    v_session_id uuid :=
        'cd2f1fa3-c011-481f-b8fa-333354d14e27';

    v_ordinary_count bigint;
    v_paid_count bigint;
    v_pending_count bigint;
    v_unpaid_count bigint;

BEGIN

    -- ========================================================
    -- 1. Sandbox safety check
    -- ========================================================

    IF public.hitpay_is_sandbox_session(
        v_session_id
    ) IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'Safety check failed: sandbox session not identified.';

    END IF;


    -- ========================================================
    -- FT-49A: Ordinary payment record availability
    -- ========================================================

    SELECT COUNT(*)

    INTO v_ordinary_count

    FROM public.payment_transactions t

    WHERE t.payment_provider IS DISTINCT FROM 'HITPAY'

      AND t.is_sandbox IS FALSE

      AND NOT public.hitpay_is_sandbox_session(
          t.session_id
      );


    IF v_ordinary_count = 0 THEN

        RAISE NOTICE
            'FT-49A SKIPPED: no ordinary payment records.';

    ELSE

        RAISE NOTICE
            'FT-49A PRECHECK PASSED: % ordinary records available.',
            v_ordinary_count;

    END IF;


    -- ========================================================
    -- FT-49B: Ordinary payment reference readiness
    -- ========================================================

    IF v_ordinary_count > 0 THEN

        RAISE NOTICE
            'FT-49B: ordinary reference comparison requires admin RPC.';

    ELSE

        RAISE NOTICE
            'FT-49B SKIPPED: no ordinary payment fixture.';

    END IF;


    -- ========================================================
    -- FT-49C: Ordinary payment status readiness
    -- ========================================================

    SELECT COUNT(*)

    INTO v_paid_count

    FROM public.payment_transactions t

    WHERE t.payment_provider IS DISTINCT FROM 'HITPAY'

      AND t.is_sandbox IS FALSE

      AND NOT public.hitpay_is_sandbox_session(
          t.session_id
      )

      AND t.transaction_status = 'PAID';


    SELECT COUNT(*)

    INTO v_pending_count

    FROM public.payment_transactions t

    WHERE t.payment_provider IS DISTINCT FROM 'HITPAY'

      AND t.is_sandbox IS FALSE

      AND NOT public.hitpay_is_sandbox_session(
          t.session_id
      )

      AND t.transaction_status = 'PENDING_PAYMENT';


    RAISE NOTICE
        'FT-49C: ordinary paid records available: %.',
        v_paid_count;

    RAISE NOTICE
        'FT-49C: ordinary pending records available: %.',
        v_pending_count;


    -- ========================================================
    -- FT-49D: Sandbox classification protection
    -- ========================================================

    IF EXISTS (

        SELECT 1

        FROM public.payment_transactions t

        WHERE t.session_id = v_session_id

          AND (

              t.payment_provider
                  IS DISTINCT FROM 'HITPAY'

              OR t.is_sandbox
                  IS DISTINCT FROM true

          )

    ) THEN

        RAISE EXCEPTION
            'FT-49D FAILED: sandbox transaction misclassified.';

    END IF;


    RAISE NOTICE
        'FT-49D PRECHECK PASSED: sandbox records classified correctly.';


    -- ========================================================
    -- FT-50A: Ordinary unpaid registration availability
    -- ========================================================

    SELECT COUNT(*)

    INTO v_unpaid_count

    FROM public.session_registrations r

    JOIN public.training_sessions s

        ON s.session_id = r.session_id

    WHERE r.payment_status IN (
        'UNPAID',
        'PENDING_PAYMENT'
    )

      AND COALESCE(s.admission_fee, 0) > 0

      AND s.session_status <> 'Cancelled'

      AND NOT public.hitpay_is_sandbox_session(
          r.session_id
      )

      AND NOT EXISTS (

          SELECT 1

          FROM public.payment_transactions t

          WHERE t.session_id = r.session_id

            AND t.user_id = r.user_id

            AND t.transaction_status = 'PENDING_PAYMENT'

      );


    IF v_unpaid_count = 0 THEN

        RAISE NOTICE
            'FT-50A SKIPPED: no eligible unpaid registrations.';

        RAISE NOTICE
            'FT-50B SKIPPED: no unpaid amount fixture.';

        RAISE NOTICE
            'FT-50C SKIPPED: no unpaid receipt fixture.';

    ELSE

        RAISE NOTICE
            'FT-50A PRECHECK PASSED: % unpaid records available.',
            v_unpaid_count;

        RAISE NOTICE
            'FT-50B: unpaid amount comparison requires admin RPC.';

        RAISE NOTICE
            'FT-50C: unpaid receipt assertion requires admin RPC.';

    END IF;


    -- ========================================================

    -- HITPAY_ADMIN_VISIBILITY_TESTS_V1

    DECLARE
        v_admin record;
        v_result jsonb;
        v_dashboard jsonb;
        v_dashboard_seen integer;
        v_row jsonb;
        v_seen integer;
        v_tested integer := 0;

        v_previous_sub text :=
            current_setting('request.jwt.claim.sub', true);

        v_previous_claims text :=
            current_setting('request.jwt.claims', true);
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

            SELECT public.admin_dashboard()
            INTO v_dashboard;

            EXECUTE 'RESET ROLE';

            IF jsonb_typeof(v_result) IS DISTINCT FROM 'array' THEN
                RAISE EXCEPTION
                    'Unexpected administrator RPC response.';
            END IF;

            v_seen := 0;

            FOR v_row IN
                SELECT value
                FROM jsonb_array_elements(v_result)
                WHERE value->>'payment_provider' = 'HITPAY'
                  AND value->>'session_id' = v_session_id::text
            LOOP
                v_seen := v_seen + 1;

                IF (v_row->>'can_view_gateway_details')::boolean
                    IS DISTINCT FROM v_admin.is_super
                THEN
                    RAISE EXCEPTION
                        'Incorrect gateway visibility permission.';
                END IF;

                IF NOT v_admin.is_super AND (
                    v_row->>'hitpay_ref' IS NOT NULL
                    OR v_row->>'gateway_request_id' IS NOT NULL
                    OR v_row->>'gateway_verified_at' IS NOT NULL
                    OR v_row->>'reconciliation_reason' IS NOT NULL
                    OR v_row->>'reconciliation_requested_at' IS NOT NULL
                ) THEN
                    RAISE EXCEPTION
                        'FT-39 FAILED: restricted details exposed.';
                END IF;

                IF v_admin.is_super AND EXISTS (
                    SELECT 1
                    FROM public.payment_transactions t
                    WHERE t.transaction_id::text =
                        v_row->>'transaction_id'
                      AND (
                          t.gateway_request_id IS DISTINCT FROM
                              v_row->>'gateway_request_id'
                          OR t.hitpay_reference_id IS DISTINCT FROM
                              v_row->>'hitpay_ref'
                      )
                ) THEN
                    RAISE EXCEPTION
                        'FT-38 FAILED: gateway details mismatch.';
                END IF;

                IF v_row->>'gateway_payload' IS NOT NULL
                   OR v_row->>'hmac_signature' IS NOT NULL
                   OR v_row->>'gateway_checkout_url' IS NOT NULL
                THEN
                    RAISE EXCEPTION
                        'Sensitive gateway information exposed.';
                END IF;
            END LOOP;

            IF v_seen = 0 THEN
                RAISE EXCEPTION
                    'No sandbox payment fixture available.';
            END IF;

            -- FT-54: Dashboard gateway visibility.
            v_dashboard_seen := 0;

            IF jsonb_typeof(v_dashboard->'payments')
                IS DISTINCT FROM 'array'
            THEN
                RAISE EXCEPTION
                    'FT-54 FAILED: Invalid dashboard response.';
            END IF;

            FOR v_row IN
                SELECT value
                FROM jsonb_array_elements(v_dashboard->'payments')
                WHERE value->>'payment_provider' = 'HITPAY'
                  AND value->>'session_id' = v_session_id::text
            LOOP
                v_dashboard_seen := v_dashboard_seen + 1;

                IF NOT v_admin.is_super
                   AND v_row->>'hitpay_ref' IS NOT NULL
                THEN
                    RAISE EXCEPTION
                        'FT-54 FAILED: Dashboard gateway reference exposed.';
                END IF;

                IF v_admin.is_super AND NOT EXISTS (
                    SELECT 1
                    FROM public.payment_transactions t
                    WHERE t.transaction_id::text =
                        v_row->>'transaction_id'
                      AND t.hitpay_reference_id
                          IS NOT DISTINCT FROM v_row->>'hitpay_ref'
                ) THEN
                    RAISE EXCEPTION
                        'FT-54 FAILED: Dashboard reference mismatch.';
                END IF;

                IF v_row->>'gateway_payload' IS NOT NULL
                   OR v_row->>'hmac_signature' IS NOT NULL
                   OR v_row->>'gateway_checkout_url' IS NOT NULL
                THEN
                    RAISE EXCEPTION
                        'FT-54 FAILED: Sensitive gateway data exposed.';
                END IF;
            END LOOP;

            IF v_dashboard_seen = 0 THEN
                RAISE EXCEPTION
                    'FT-54 FAILED: Missing dashboard sandbox fixture.';
            END IF;

            RAISE NOTICE
                'FT-54 PASSED: Dashboard visibility, SU Admin = %.',
                v_admin.is_super;

            v_tested := v_tested + 1;

            IF v_admin.is_super THEN
                RAISE NOTICE 'FT-38 PASSED: SU Admin visibility.';
            ELSE
                RAISE NOTICE 'FT-39 PASSED: Admin visibility restricted.';
            END IF;
        END LOOP;

        IF v_tested <> 2 THEN
            RAISE EXCEPTION
                'Expected two administrator visibility tests.';
        END IF;

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
    END;

    -- Final compatibility readiness summary
    -- ========================================================

    RAISE NOTICE
        '============================================';

    RAISE NOTICE
        'ADMIN PAYMENT COMPATIBILITY PRECHECKS COMPLETED';

    RAISE NOTICE
        'Ordinary transactions: %',
        v_ordinary_count;

    RAISE NOTICE
        'Ordinary paid transactions: %',
        v_paid_count;

    RAISE NOTICE
        'Ordinary pending transactions: %',
        v_pending_count;

    RAISE NOTICE
        'Eligible unpaid registrations: %',
        v_unpaid_count;

    RAISE NOTICE
        'Authenticated administrator RPC comparisons: PENDING';

    RAISE NOTICE
        'No existing ordinary records modified.';

    RAISE NOTICE
        '============================================';

END;

$admin_compatibility_tests$;
