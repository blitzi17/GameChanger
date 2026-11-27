
BEGIN;

-- ============================================================
-- HITPAY MEMBER PAYMENT RECORDS
-- Migration 14
-- ============================================================

CREATE OR REPLACE FUNCTION public.member_payments()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$

DECLARE

    v_uid uuid := auth.uid();

BEGIN

    -- ========================================================
    -- 1. AUTHENTICATION
    -- ========================================================

    IF v_uid IS NULL THEN

        RAISE EXCEPTION 'Not signed in'
            USING ERRCODE = '42501';

    END IF;


    -- ========================================================
    -- 2. ACTIVE MEMBER VALIDATION
    -- ========================================================

    IF NOT EXISTS (

        SELECT 1
        FROM public.users u
        WHERE u.user_id = v_uid
          AND u.role = 'MEMBER'
          AND u.account_status = 'Active'

    ) THEN

        RAISE EXCEPTION 'Active member access required'
            USING ERRCODE = '42501';

    END IF;


    -- ========================================================
    -- 3. MEMBER PAYMENT RESPONSE
    -- ========================================================

    RETURN jsonb_build_object(

        'transactions',

        COALESCE(

            (

                SELECT jsonb_agg(

                    jsonb_build_object(

                        -- Existing response fields

                        'transaction_id',
                            t.transaction_id,

                        'session_id',
                            t.session_id,

                        'session',
                            s.title,

                        'session_start',
                            s.scheduled_start,

                        'amount',
                            t.amount,

                        'currency',
                            t.currency,

                        'channel',
                            t.payment_channel,

                        'status',
                            t.transaction_status,

                        'date',
                            COALESCE(
                                t.confirmed_at,
                                t.transaction_timestamp
                            ),

                        'reference',
                            COALESCE(
                                t.payer_reference,
                                t.hitpay_reference_id,
                                t.order_reference_id
                            ),

                        'rejection_reason',
                            t.rejection_reason,

                        'waiver_reason',
                            t.waiver_reason,


                        -- HitPay response fields

                        'registration_id',
                            t.registration_id,

                        'payment_provider',
                            t.payment_provider,

                        'is_sandbox',
                            t.is_sandbox,

                        'order_reference',
                            t.order_reference_id,

                        'checkout_state',
                            CASE

                                WHEN t.payment_provider = 'HITPAY'
                                THEN t.checkout_state

                                ELSE NULL

                            END,

                        'reconciliation_required',
                            CASE

                                WHEN t.payment_provider = 'HITPAY'
                                THEN t.reconciliation_required

                                ELSE false

                            END,


                        -- Display status does not modify
                        -- the stored transaction status.

                        'display_status',
                            CASE

                                WHEN t.payment_provider = 'HITPAY'
                                 AND (
                                    t.reconciliation_required = true
                                    OR t.checkout_state = 'REVIEW_REQUIRED'
                                 )

                                THEN 'REVIEW_REQUIRED'

                                ELSE t.transaction_status::text

                            END,


                        -- Receipt eligibility is only a hint.
                        -- The payment-status Edge Function
                        -- must verify eligibility again.

                        'receipt_available',

                            CASE

                                WHEN t.payment_provider = 'HITPAY'
                                 AND t.is_sandbox = true
                                 AND t.transaction_status = 'PAID'
                                 AND t.checkout_state = 'CREATED'
                                 AND t.reconciliation_required = false
                                 AND t.gateway_verified_at IS NOT NULL
                                 AND t.confirmed_at IS NOT NULL
                                 AND t.registration_id IS NOT NULL
                                 AND t.payment_channel IS NOT NULL
                                 AND t.amount > 0
                                 AND t.currency = 'PHP'

                                 AND NULLIF(
                                     btrim(t.gateway_request_id),
                                     ''
                                 ) IS NOT NULL

                                 AND NULLIF(
                                     btrim(t.hitpay_reference_id),
                                     ''
                                 ) IS NOT NULL

                                 AND t.hmac_signature
                                     ~ '^[0-9A-Fa-f]{64}$'

                                 AND EXISTS (

                                     SELECT 1

                                     FROM public.session_registrations r

                                     WHERE r.registration_id =
                                           t.registration_id

                                       AND r.user_id = v_uid

                                       AND r.session_id =
                                           t.session_id

                                       AND r.payment_status = 'PAID'

                                 )

                                THEN true

                                ELSE false

                            END

                    )

                    ORDER BY
                        t.transaction_timestamp DESC

                )

                FROM public.payment_transactions t

                LEFT JOIN public.training_sessions s
                    ON s.session_id = t.session_id

                WHERE t.user_id = v_uid

            ),

            '[]'::jsonb

        ),


        -- ====================================================
        -- 4. EXISTING MEMBER REGISTRATIONS
        -- ====================================================

        'registrations',

        COALESCE(

            (

                SELECT jsonb_agg(

                    jsonb_build_object(

                        'registration_id',
                            r.registration_id,

                        'session_id',
                            s.session_id,

                        'session',
                            s.title,

                        'start',
                            s.scheduled_start,

                        'fee',
                            s.admission_fee,

                        'payment_status',
                            r.payment_status,

                        'session_status',
                            s.session_status,

                        'zoom_access_released',
                            r.zoom_access_released,

                        'registered_at',
                            r.registration_timestamp,


                        -- Preserve existing rejection
                        -- information for ordinary payments.

                        'rejected_reason',

                            (

                                SELECT t.rejection_reason

                                FROM public.payment_transactions t

                                WHERE t.user_id = v_uid

                                  AND t.session_id = s.session_id

                                  AND t.transaction_status = 'FAILED'

                                  AND t.payment_provider
                                      IS DISTINCT FROM 'HITPAY'

                                ORDER BY
                                    t.transaction_timestamp DESC

                                LIMIT 1

                            ),


                        -- Preserve existing manual
                        -- payment reference information.

                        'pending_reference',

                            (

                                SELECT t.payer_reference

                                FROM public.payment_transactions t

                                WHERE t.user_id = v_uid

                                  AND t.session_id = s.session_id

                                  AND t.transaction_status =
                                      'PENDING_PAYMENT'

                                  AND t.payment_provider
                                      IS DISTINCT FROM 'HITPAY'

                                ORDER BY
                                    t.transaction_timestamp DESC

                                LIMIT 1

                            )

                    )

                    ORDER BY
                        s.scheduled_start DESC

                )

                FROM public.session_registrations r

                JOIN public.training_sessions s
                    ON s.session_id = r.session_id

                WHERE r.user_id = v_uid

            ),

            '[]'::jsonb

        )

    );

END;

$function$;


-- ============================================================
-- 5. FUNCTION ACCESS PROTECTION
-- ============================================================

REVOKE ALL
ON FUNCTION public.member_payments()
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.member_payments()
TO authenticated, service_role;


COMMIT;
