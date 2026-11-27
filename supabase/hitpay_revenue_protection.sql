
BEGIN;

DO $migration$
DECLARE
    v_definition text;
    v_original text;
    v_replacement text;
    v_expected integer;
    v_actual integer;
    v_index integer;

BEGIN

    -- 1. Retrieve the existing dashboard definition.
    SELECT pg_get_functiondef(
        'public.admin_dashboard()'::regprocedure
    )
    INTO v_definition;


    -- 2. Confirm that the function exists.
    IF v_definition IS NULL THEN

        RAISE EXCEPTION
            'Admin dashboard function not found.';

    END IF;


    -- 3. Apply sandbox exclusion filters.
    FOR v_index IN 1..6 LOOP

        CASE v_index

            -- Revenue per session.
            WHEN 1 THEN

                v_original :=
                    'where t.session_id = s.session_id and t.transaction_status = ''PAID''';

                v_replacement :=
                    v_original ||
                    ' and t.is_sandbox = false';

                v_expected := 1;


            -- Monthly revenue chart.
            WHEN 2 THEN

                v_original :=
                    'where t.transaction_status = ''PAID''';

                v_replacement :=
                    v_original ||
                    ' and t.is_sandbox = false';

                v_expected := 1;


            -- Total revenue and current month revenue.
            WHEN 3 THEN

                v_original :=
                    'from public.payment_transactions where transaction_status = ''PAID''';

                v_replacement :=
                    v_original ||
                    ' and is_sandbox = false';

                v_expected := 2;


            -- Pending payment count and pending amount.
            WHEN 4 THEN

                v_original :=
                    'from public.payment_transactions where transaction_status = ''PENDING_PAYMENT''';

                v_replacement :=
                    v_original ||
                    ' and is_sandbox = false';

                v_expected := 2;


            -- Total actual transaction count.
            WHEN 5 THEN

                v_original :=
                    '(select count(*) from public.payment_transactions)';

                v_replacement :=
                    '(select count(*) from public.payment_transactions where is_sandbox = false)';

                v_expected := 1;


            -- Actual waived payment count.
            WHEN 6 THEN

                v_original :=
                    'from public.payment_transactions where transaction_status = ''WAIVED''';

                v_replacement :=
                    v_original ||
                    ' and is_sandbox = false';

                v_expected := 1;

        END CASE;


        -- 4. Prevent duplicate filter application.
        IF strpos(
            v_definition,
            v_replacement
        ) > 0 THEN

            RAISE EXCEPTION
                'Sandbox filter already exists at migration step %.',
                v_index;

        END IF;


        -- 5. Count exact matching expressions.
        v_actual := (

            length(v_definition)

            - length(
                replace(
                    v_definition,
                    v_original,
                    ''
                )
            )

        ) / length(v_original);


        -- 6. Stop if the dashboard definition
        -- no longer matches the reviewed version.
        IF v_actual <> v_expected THEN

            RAISE EXCEPTION
                'Dashboard definition changed at step %. Expected % matches, found %.',
                v_index,
                v_expected,
                v_actual;

        END IF;


        -- 7. Apply the reviewed replacement.
        v_definition := replace(

            v_definition,

            v_original,

            v_replacement

        );

    END LOOP;


    -- 8. Preserve sandbox identification
    -- in the dashboard payment records.
    v_original :=
        '''amount'', t.amount, ''currency'', t.currency, ''channel'', t.payment_channel';


    v_replacement :=
        v_original ||

        ', ''is_sandbox'', t.is_sandbox' ||

        ', ''payment_provider'', t.payment_provider';


    -- 9. Prevent duplicate metadata fields.
    IF strpos(
        v_definition,
        v_replacement
    ) > 0 THEN

        RAISE EXCEPTION
            'Sandbox payment metadata already exists.';

    END IF;


    -- 10. Validate the payment record structure.
    v_actual := (

        length(v_definition)

        - length(
            replace(
                v_definition,
                v_original,
                ''
            )
        )

    ) / length(v_original);


    IF v_actual <> 1 THEN

        RAISE EXCEPTION
            'Dashboard payment record structure has changed.';

    END IF;


    -- 11. Add sandbox payment metadata.
    v_definition := replace(

        v_definition,

        v_original,

        v_replacement

    );


    -- Restrict HitPay gateway references to active SU Admins.
    v_original :=
        '''hitpay_ref'', t.hitpay_reference_id';

    v_replacement := $mask$
        'hitpay_ref',
        CASE
            WHEN t.payment_provider = 'HITPAY'
              OR t.is_sandbox = true
            THEN CASE
                WHEN COALESCE(public.is_super_admin(auth.uid()), false)
                 AND EXISTS (
                    SELECT 1
                    FROM public.profiles p
                    WHERE p.id = auth.uid()
                      AND p.role = 'admin'
                      AND p.status = 'Active'
                 )
                THEN t.hitpay_reference_id
                ELSE NULL
            END
            ELSE t.hitpay_reference_id
        END
    $mask$;

    v_actual := (
        length(v_definition)
        - length(replace(v_definition, v_original, ''))
    ) / length(v_original);

    IF v_actual <> 1 THEN
        RAISE EXCEPTION
            'Dashboard gateway reference structure has changed.';
    END IF;

    v_definition := replace(
        v_definition,
        v_original,
        v_replacement
    );

    -- 12. Apply the updated dashboard definition.
    EXECUTE v_definition;


    RAISE NOTICE
        'HitPay Sandbox revenue protection applied successfully.';

END;
$migration$;

COMMIT;
