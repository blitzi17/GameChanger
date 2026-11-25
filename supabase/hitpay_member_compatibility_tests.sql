
-- ============================================================
-- GameChanger: UC-PAM-01 Process Payment
-- FT-33: Member Payment Response Compatibility
--
-- Read-only assertions using the designated sandbox member.
-- Execute only inside the combined rollback transaction.
-- ============================================================

DO $member_compatibility_tests$

DECLARE

    v_user_id uuid :=
        'cb9ab5af-576f-48fd-b5c6-081874c2ea0e';

    v_session_id uuid :=
        'cd2f1fa3-c011-481f-b8fa-333354d14e27';

    v_result jsonb;

    v_transaction_keys text[] := ARRAY[
        'transaction_id',
        'session_id',
        'session',
        'session_start',
        'amount',
        'currency',
        'channel',
        'status',
        'date',
        'reference',
        'rejection_reason',
        'waiver_reason'
    ];

    v_registration_keys text[] := ARRAY[
        'registration_id',
        'session_id',
        'session',
        'start',
        'fee',
        'payment_status',
        'session_status',
        'zoom_access_released',
        'registered_at',
        'rejected_reason',
        'pending_reference'
    ];

    v_previous_sub text :=
        current_setting('request.jwt.claim.sub', true);

    v_previous_claims text :=
        current_setting('request.jwt.claims', true);

BEGIN

    -- ========================================================
    -- 1. Sandbox safety checks
    -- ========================================================

    IF public.hitpay_is_sandbox_allowed(
        v_user_id,
        v_session_id
    ) IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'FT-33 FAILED: sandbox pair not authorized.';

    END IF;


    -- ========================================================
    -- 2. Authenticate designated sandbox member
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


    -- ========================================================
    -- 3. Preserve original response structure
    -- ========================================================

    IF jsonb_typeof(v_result)
        IS DISTINCT FROM 'object'

       OR jsonb_typeof(v_result -> 'transactions')
        IS DISTINCT FROM 'array'

       OR jsonb_typeof(v_result -> 'registrations')
        IS DISTINCT FROM 'array'

    THEN

        RAISE EXCEPTION
            'FT-33 FAILED: original response structure changed.';

    END IF;


    -- Ensure assertions are not passing on empty arrays.

    IF jsonb_array_length(
        v_result -> 'transactions'
    ) = 0

       OR jsonb_array_length(
           v_result -> 'registrations'
       ) = 0

    THEN

        RAISE EXCEPTION
            'FT-33 FAILED: required test records missing.';

    END IF;


    -- ========================================================
    -- 4. Preserve existing transaction fields
    -- ========================================================

    IF EXISTS (

        SELECT 1

        FROM jsonb_array_elements(
            v_result -> 'transactions'
        ) AS item(record)

        WHERE NOT (
            item.record ?& v_transaction_keys
        )

    ) THEN

        RAISE EXCEPTION
            'FT-33 FAILED: original transaction fields missing.';

    END IF;


    -- ========================================================
    -- 5. Preserve existing registration fields
    -- ========================================================

    IF EXISTS (

        SELECT 1

        FROM jsonb_array_elements(
            v_result -> 'registrations'
        ) AS item(record)

        WHERE NOT (
            item.record ?& v_registration_keys
        )

    ) THEN

        RAISE EXCEPTION
            'FT-33 FAILED: original registration fields missing.';

    END IF;


    -- ========================================================
    -- 6. Validate existing transaction field values
    -- ========================================================

    IF EXISTS (

        SELECT 1

        FROM jsonb_array_elements(
            v_result -> 'transactions'
        ) AS item(record)

        JOIN public.payment_transactions t

          ON t.transaction_id::text =
             item.record ->> 'transaction_id'

        WHERE t.user_id = v_user_id

          AND (

              item.record -> 'amount'
                  IS DISTINCT FROM to_jsonb(t.amount)

              OR item.record ->> 'currency'
                  IS DISTINCT FROM t.currency::text

              OR item.record ->> 'status'
                  IS DISTINCT FROM t.transaction_status::text

              OR item.record ->> 'channel'
                  IS DISTINCT FROM t.payment_channel::text

              OR item.record ->> 'reference'
                  IS DISTINCT FROM COALESCE(
                      t.payer_reference,
                      t.hitpay_reference_id,
                      t.order_reference_id
                  )

          )

    ) THEN

        RAISE EXCEPTION
            'FT-33 FAILED: original transaction values changed.';

    END IF;


    -- ========================================================
    -- 7. Ordinary payment metadata compatibility
    --
    -- This section checks ordinary transactions only if
    -- the designated dummy member already has any.
    -- No ordinary payment records are created.
    -- ========================================================

    IF EXISTS (

        SELECT 1

        FROM public.payment_transactions

        WHERE user_id = v_user_id

          AND payment_provider IS DISTINCT FROM 'HITPAY'

    ) THEN

        IF EXISTS (

            SELECT 1

            FROM jsonb_array_elements(
                v_result -> 'transactions'
            ) AS item(record)

            WHERE (
                item.record ->> 'payment_provider'
            ) IS DISTINCT FROM 'HITPAY'

              AND (

                  item.record -> 'receipt_available'
                      IS DISTINCT FROM 'false'::jsonb

                  OR item.record -> 'reconciliation_required'
                      IS DISTINCT FROM 'false'::jsonb

                  OR item.record ->> 'display_status'
                      IS DISTINCT FROM
                          item.record ->> 'status'

              )

        ) THEN

            RAISE EXCEPTION
                'FT-33 FAILED: ordinary payment metadata changed.';

        END IF;

        RAISE NOTICE
            'FT-33: Ordinary payment records checked.';

    ELSE

        RAISE NOTICE
            'FT-33: Ordinary payment data check SKIPPED; no fixture.';

    END IF;


    -- ========================================================
    -- 8. Restore authentication context
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
        'FT-33 PASSED: original response contract preserved.';

END;

$member_compatibility_tests$;
