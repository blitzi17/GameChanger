
-- ============================================================
-- GameChanger: UC-PAM-01 Process Payment
-- HitPay Member Payment Records Tests
-- Run after existing functional tests.
-- ============================================================

DO $member_records_tests$

DECLARE

    v_user_id uuid :=
        'cb9ab5af-576f-48fd-b5c6-081874c2ea0e';

    v_session_id uuid :=
        'cd2f1fa3-c011-481f-b8fa-333354d14e27';

    v_unauthorized_id uuid :=
        '00000000-0000-4000-8000-000000000001';

    v_result jsonb;
    v_transaction jsonb;
    v_registration jsonb;
    v_transaction_id uuid;
    v_rejected boolean;
    v_expected_count bigint;
    v_actual_count bigint;

    v_previous_sub text :=
        current_setting('request.jwt.claim.sub', true);

    v_previous_claims text :=
        current_setting('request.jwt.claims', true);

BEGIN

    -- ========================================================
    -- Safety checks
    -- ========================================================

    IF NOT EXISTS (

        SELECT 1
        FROM public.users
        WHERE user_id = v_user_id
          AND role = 'MEMBER'
          AND account_status = 'Active'

    ) THEN

        RAISE EXCEPTION
            'Safety check failed: dummy member missing.';

    END IF;

    IF EXISTS (

        SELECT 1
        FROM public.users
        WHERE user_id = v_unauthorized_id

    ) THEN

        RAISE EXCEPTION
            'Safety check failed: unauthorized ID exists.';

    END IF;

    SELECT transaction_id

    INTO STRICT v_transaction_id

    FROM public.payment_transactions

    WHERE user_id = v_user_id
      AND session_id = v_session_id
      AND payment_provider = 'HITPAY'
      AND is_sandbox = true
      AND transaction_status = 'PAID';

    -- ========================================================
    -- FT-24: Unauthenticated access
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

        PERFORM public.member_payments();

    EXCEPTION

        WHEN insufficient_privilege THEN

            v_rejected := true;

    END;

    IF NOT v_rejected THEN

        RAISE EXCEPTION
            'FT-24 FAILED: unauthenticated access accepted.';

    END IF;

    RAISE NOTICE
        'FT-24 PASSED: unauthenticated access rejected.';

    -- ========================================================
    -- FT-25: Unauthorized account
    -- ========================================================

    PERFORM set_config(
        'request.jwt.claim.sub',
        v_unauthorized_id::text,
        true
    );

    PERFORM set_config(
        'request.jwt.claims',
        jsonb_build_object(
            'sub', v_unauthorized_id,
            'role', 'authenticated'
        )::text,
        true
    );

    v_rejected := false;

    BEGIN

        PERFORM public.member_payments();

    EXCEPTION

        WHEN insufficient_privilege THEN

            v_rejected := true;

    END;

    IF NOT v_rejected THEN

        RAISE EXCEPTION
            'FT-25 FAILED: unauthorized account accepted.';

    END IF;

    RAISE NOTICE
        'FT-25 PASSED: unauthorized account rejected.';

    -- ========================================================
    -- Restore designated sandbox member
    -- ========================================================

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

    v_result := public.member_payments();

    IF jsonb_typeof(v_result -> 'transactions')
        IS DISTINCT FROM 'array'

       OR jsonb_typeof(v_result -> 'registrations')
        IS DISTINCT FROM 'array'

    THEN

        RAISE EXCEPTION
            'Invalid member payment response structure.';

    END IF;

    -- ========================================================
    -- FT-27: Transaction ownership isolation
    -- ========================================================

    SELECT count(*)

    INTO v_expected_count

    FROM public.payment_transactions

    WHERE user_id = v_user_id;

    v_actual_count :=
        jsonb_array_length(v_result -> 'transactions');

    IF v_actual_count <> v_expected_count THEN

        RAISE EXCEPTION
            'FT-27 FAILED: unexpected transaction count.';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM jsonb_array_elements(
            v_result -> 'transactions'
        ) AS item(record)

        WHERE NOT EXISTS (

            SELECT 1

            FROM public.payment_transactions t

            WHERE t.transaction_id::text =
                  item.record ->> 'transaction_id'

              AND t.user_id = v_user_id

        )

    ) THEN

        RAISE EXCEPTION
            'FT-27 FAILED: foreign transaction returned.';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM jsonb_array_elements(
            v_result -> 'registrations'
        ) AS item(record)

        WHERE NOT EXISTS (

            SELECT 1

            FROM public.session_registrations r

            WHERE r.registration_id::text =
                  item.record ->> 'registration_id'

              AND r.user_id = v_user_id

        )

    ) THEN

        RAISE EXCEPTION
            'FT-27 FAILED: foreign registration returned.';

    END IF;

    RAISE NOTICE
        'FT-27 PASSED: member records ownership verified.';

    -- ========================================================
    -- FT-28: HitPay transaction metadata
    -- ========================================================

    SELECT item.record

    INTO STRICT v_transaction

    FROM jsonb_array_elements(
        v_result -> 'transactions'
    ) AS item(record)

    WHERE item.record ->> 'transaction_id' =
          v_transaction_id::text;

    IF v_transaction ->> 'payment_provider'
        IS DISTINCT FROM 'HITPAY'

       OR v_transaction -> 'is_sandbox'
        IS DISTINCT FROM 'true'::jsonb

       OR v_transaction ->> 'session_id'
        IS DISTINCT FROM v_session_id::text

       OR v_transaction ->> 'checkout_state'
        IS DISTINCT FROM 'CREATED'

       OR v_transaction ->> 'display_status'
        IS DISTINCT FROM 'PAID'

       OR v_transaction -> 'reconciliation_required'
        IS DISTINCT FROM 'false'::jsonb

       OR NULLIF(
            btrim(v_transaction ->> 'order_reference'),
            ''
          ) IS NULL

    THEN

        RAISE EXCEPTION
            'FT-28 FAILED: incorrect HitPay metadata.';

    END IF;

    RAISE NOTICE
        'FT-28 PASSED: HitPay metadata verified.';

    -- ========================================================
    -- FT-30: Verified payment receipt eligibility
    -- ========================================================

    IF v_transaction -> 'receipt_available'
        IS DISTINCT FROM 'true'::jsonb

       OR v_transaction ->> 'status'
        IS DISTINCT FROM 'PAID'

       OR NULLIF(
            v_transaction ->> 'registration_id',
            ''
          ) IS NULL

    THEN

        RAISE EXCEPTION
            'FT-30 FAILED: verified receipt unavailable.';

    END IF;

    SELECT item.record

    INTO STRICT v_registration

    FROM jsonb_array_elements(
        v_result -> 'registrations'
    ) AS item(record)

    WHERE item.record ->> 'registration_id' =
          v_transaction ->> 'registration_id';

    IF v_registration ->> 'payment_status'
        IS DISTINCT FROM 'PAID'

       OR v_registration ->> 'session_id'
        IS DISTINCT FROM v_session_id::text

    THEN

        RAISE EXCEPTION
            'FT-30 FAILED: receipt registration mismatch.';

    END IF;

    RAISE NOTICE
        'FT-30 PASSED: verified receipt eligibility.';

    -- ========================================================
    -- FT-32: Sensitive gateway information protection
    -- ========================================================

    IF EXISTS (

        SELECT 1

        FROM jsonb_array_elements(
            v_result -> 'transactions'
        ) AS item(record)

        WHERE item.record ?| ARRAY[

            'hmac_signature',
            'gateway_payload',
            'gateway_checkout_url',
            'gateway_request_id',
            'webhook_salt',
            'api_key',
            'service_role_key'

        ]

    ) THEN

        RAISE EXCEPTION
            'FT-32 FAILED: sensitive gateway field exposed.';

    END IF;

    RAISE NOTICE
        'FT-32 PASSED: sensitive gateway fields excluded.';

    -- ========================================================
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

    RAISE NOTICE
        'Member payment authorization and receipt tests completed.';

END;

$member_records_tests$;
