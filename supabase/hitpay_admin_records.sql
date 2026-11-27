
-- ==========================================================
-- GAMECHANGER — HITPAY ADMINISTRATOR PAYMENT RECORDS
-- Migration 15
-- Scope: UC-PAM Process Payment / View Payment Records
-- Environment: HitPay Sandbox
-- ==========================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';


-- ==========================================================
-- 1. ADMINISTRATOR PAYMENT AUTHORIZATION
-- ==========================================================

CREATE OR REPLACE FUNCTION
public.hitpay_require_payment_admin()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN

    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    -- Preserve existing administrator authorization.
    PERFORM public.gc_require_admin();

    -- Additional payment-specific account protection.
    IF NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = auth.uid()
          AND p.role = 'admin'
          AND p.status = 'Active'
    ) THEN
        RAISE EXCEPTION
            'Active administrator account required'
            USING ERRCODE = '42501';
    END IF;

END;
$function$;

REVOKE ALL ON FUNCTION
    public.hitpay_require_payment_admin()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.hitpay_require_payment_admin()
TO service_role;


-- ==========================================================
-- 2. ADMINISTRATOR PAYMENT RECORDS
-- ==========================================================

CREATE OR REPLACE FUNCTION public.admin_payments()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE

    -- HITPAY_SU_ADMIN_AUTHORIZATION_V1
    v_is_super_admin boolean := false;

BEGIN

    PERFORM public.hitpay_require_payment_admin();

    v_is_super_admin := COALESCE(
        public.is_super_admin(auth.uid()),
        false
    );

    RETURN COALESCE(
        (
            SELECT jsonb_agg(
                x ORDER BY (x ->> 'sort_key') DESC
            )
            FROM (

                -- ==========================================
                -- A. EXISTING PAYMENT TRANSACTIONS
                -- ==========================================

                SELECT jsonb_build_object(

                    -- Existing identifiers
                    'transaction_id', t.transaction_id,
                    'registration_id', r.registration_id,
                    'user_id', t.user_id,

                    -- Existing member information
                    'member',
                        trim(
                            u.first_name || ' ' ||
                            u.last_name
                        ),
                    'email', u.email,

                    -- Existing session information
                    'session', s.title,
                    'session_id', t.session_id,
                    'session_start', s.scheduled_start,
                    'session_status', s.session_status,

                    -- Existing payment information
                    'amount', t.amount,
                    'currency', t.currency,
                    'channel', t.payment_channel,
                    'status', t.transaction_status,
                    'reg_payment_status', r.payment_status,

                    -- Existing timestamps
                    'date',
                        COALESCE(
                            t.confirmed_at,
                            t.transaction_timestamp
                        ),
                    'submitted_at',
                        t.transaction_timestamp,
                    'confirmed_at', t.confirmed_at,

                    -- Existing payment references
                    'reference', t.payer_reference,
                    'order_ref', t.order_reference_id,
                    'hitpay_ref',
                        CASE
                            WHEN t.payment_provider = 'HITPAY'
                            THEN CASE
                                WHEN v_is_super_admin
                                THEN t.hitpay_reference_id
                                ELSE NULL
                            END
                            ELSE t.hitpay_reference_id
                        END,

                    -- Existing manual review information
                    'rejection_reason', t.rejection_reason,
                    'reviewed_by', (
                        SELECT trim(
                            a.first_name || ' ' ||
                            a.last_name
                        )
                        FROM public.users a
                        WHERE a.user_id = t.reviewed_by
                    ),

                    'sort_key', t.transaction_timestamp,

                    -- ======================================
                    -- HITPAY PROVIDER METADATA
                    -- ======================================

                    'payment_provider',
                        t.payment_provider,

                    'can_view_gateway_details',
                        v_is_super_admin
                        AND COALESCE(
                            t.payment_provider = 'HITPAY',
                            false
                        ),

                    'is_sandbox',
                        COALESCE(t.is_sandbox, false)
                        OR public.hitpay_is_sandbox_session(
                            t.session_id
                        ),

                    'checkout_state',
                        CASE
                            WHEN t.payment_provider = 'HITPAY'
                            THEN t.checkout_state
                            ELSE NULL
                        END,

                    'gateway_request_id',
                        CASE
                            WHEN t.payment_provider = 'HITPAY'
                             AND v_is_super_admin
                            THEN t.gateway_request_id
                            ELSE NULL
                        END,

                    'gateway_verified_at',
                        CASE
                            WHEN t.payment_provider = 'HITPAY'
                             AND v_is_super_admin
                            THEN t.gateway_verified_at
                            ELSE NULL
                        END,

                    -- ======================================
                    -- VERIFIED PAYMENT INFORMATION
                    -- ======================================

                    'gateway_payment_verified',
                        evidence.payment_verified,

                    'registration_completed',
                        CASE
                            WHEN t.payment_provider = 'HITPAY'
                            THEN
                                evidence.payment_verified
                                AND t.transaction_status::text
                                    = 'PAID'
                                AND t.reconciliation_required
                                    IS FALSE
                                AND t.checkout_state = 'CREATED'
                                AND t.confirmed_at IS NOT NULL
                                AND r.registration_id IS NOT NULL
                                AND r.payment_status::text
                                    = 'PAID'
                            ELSE false
                        END,

                    -- ======================================
                    -- RECONCILIATION INFORMATION
                    -- ======================================

                    'reconciliation_required',
                        review.requires_review,

                    'reconciliation_reason',
                        CASE
                            WHEN review.requires_review
                             AND v_is_super_admin
                            THEN COALESCE(
                                NULLIF(
                                    btrim(t.reconciliation_reason),
                                    ''
                                ),
                                'Payment record requires verification review.'
                            )
                            ELSE NULL
                        END,

                    'reconciliation_requested_at',
                        CASE
                            WHEN t.payment_provider = 'HITPAY'
                             AND v_is_super_admin
                            THEN t.reconciliation_requested_at
                            ELSE NULL
                        END,

                    'display_status',
                        CASE
                            WHEN review.requires_review
                            THEN 'REVIEW_REQUIRED'
                            ELSE t.transaction_status::text
                        END,

                    -- ======================================
                    -- RECEIPT ELIGIBILITY
                    -- ======================================

                    'receipt_available',
                        CASE
                            WHEN t.payment_provider = 'HITPAY'
                             AND t.is_sandbox IS TRUE
                             AND t.transaction_status::text
                                 = 'PAID'
                             AND evidence.payment_verified
                             AND t.checkout_state = 'CREATED'
                             AND t.confirmed_at IS NOT NULL
                             AND NOT review.requires_review
                             AND r.registration_id IS NOT NULL
                             AND r.payment_status::text = 'PAID'
                             AND NULLIF(btrim(s.title), '')
                                 IS NOT NULL
                            THEN true
                            ELSE false
                        END

                ) AS x

                FROM public.payment_transactions t

                LEFT JOIN public.users u
                    ON u.user_id = t.user_id

                LEFT JOIN public.training_sessions s
                    ON s.session_id = t.session_id

                -- Preserve the original relationship for
                -- ordinary payment records.
                --
                -- HitPay must use its exact registration ID.

                LEFT JOIN public.session_registrations r
                    ON r.session_id = t.session_id
                   AND r.user_id = t.user_id
                   AND (
                       t.payment_provider
                           IS DISTINCT FROM 'HITPAY'
                       OR r.registration_id = t.registration_id
                   )

                -- ==========================================
                -- RECORDED GATEWAY EVIDENCE
                -- ==========================================

                CROSS JOIN LATERAL (
                    SELECT COALESCE(
                        t.payment_provider = 'HITPAY'
                        AND t.is_sandbox IS TRUE
                        AND t.gateway_verified_at IS NOT NULL
                        AND NULLIF(
                            btrim(t.gateway_request_id), ''
                        ) IS NOT NULL
                        AND NULLIF(
                            btrim(t.hitpay_reference_id), ''
                        ) IS NOT NULL
                        AND NULLIF(
                            btrim(t.order_reference_id), ''
                        ) IS NOT NULL
                        AND t.payment_channel IS NOT NULL
                        AND t.hmac_signature
                            ~ '^[0-9a-fA-F]{64}$'
                        AND jsonb_typeof(t.gateway_payload)
                            = 'object'
                        AND t.amount > 0
                        AND t.amount::text NOT IN (
                            'NaN',
                            'Infinity',
                            '-Infinity'
                        )
                        AND t.currency::text = 'PHP',
                        false
                    ) AS payment_verified
                ) evidence

                -- ==========================================
                -- FAIL-CLOSED DISPLAY STATUS
                -- ==========================================

                CROSS JOIN LATERAL (
                    SELECT COALESCE(
                        t.payment_provider = 'HITPAY'
                        AND (
                            t.reconciliation_required IS TRUE

                            OR t.checkout_state
                                = 'REVIEW_REQUIRED'

                            OR (
                                t.transaction_status::text
                                    = 'PAID'
                                AND (
                                    NOT evidence.payment_verified
                                    OR t.checkout_state
                                        IS DISTINCT FROM 'CREATED'
                                    OR t.confirmed_at IS NULL
                                    OR r.registration_id IS NULL
                                    OR r.payment_status::text
                                        IS DISTINCT FROM 'PAID'
                                )
                            )
                        ),
                        false
                    ) AS requires_review
                ) review


                UNION ALL


                -- ==========================================
                -- B. EXISTING UNPAID REGISTRATIONS
                -- ==========================================

                SELECT jsonb_build_object(

                    'transaction_id', NULL,
                    'registration_id', r.registration_id,
                    'user_id', r.user_id,

                    'member',
                        trim(
                            u.first_name || ' ' ||
                            u.last_name
                        ),
                    'email', u.email,

                    'session', s.title,
                    'session_id', s.session_id,
                    'session_start', s.scheduled_start,
                    'session_status', s.session_status,

                    'amount', s.admission_fee,
                    'currency', 'PHP',
                    'channel', NULL,

                    'status', 'UNPAID',
                    'reg_payment_status', r.payment_status,

                    'date', r.registration_timestamp,
                    'submitted_at', NULL,
                    'confirmed_at', NULL,

                    'reference', NULL,
                    'order_ref', NULL,
                    'hitpay_ref', NULL,
                    'rejection_reason', NULL,
                    'reviewed_by', NULL,

                    'sort_key', r.registration_timestamp,

                    -- Additional fields for compatibility
                    'payment_provider', NULL,
                    'can_view_gateway_details', false,

                    'is_sandbox',
                        public.hitpay_is_sandbox_session(
                            r.session_id
                        ),

                    'checkout_state', NULL,
                    'gateway_request_id', NULL,
                    'gateway_verified_at', NULL,
                    'gateway_payment_verified', false,
                    'registration_completed', false,
                    'reconciliation_required', false,
                    'reconciliation_reason', NULL,
                    'reconciliation_requested_at', NULL,
                    'display_status', 'UNPAID',
                    'receipt_available', false

                ) AS x

                FROM public.session_registrations r

                JOIN public.training_sessions s
                    ON s.session_id = r.session_id

                LEFT JOIN public.users u
                    ON u.user_id = r.user_id

                WHERE r.payment_status IN (
                    'UNPAID',
                    'PENDING_PAYMENT'
                )

                AND COALESCE(s.admission_fee, 0) > 0

                AND s.session_status <> 'Cancelled'

                AND NOT EXISTS (
                    SELECT 1
                    FROM public.payment_transactions t
                    WHERE t.session_id = r.session_id
                      AND t.user_id = r.user_id
                      AND t.transaction_status
                          = 'PENDING_PAYMENT'
                )

            ) q
        ),
        '[]'::jsonb
    );

END;
$function$;


-- ==========================================================
-- 3. ADMINISTRATOR PAYMENT RECORD PERMISSIONS
-- ==========================================================

REVOKE ALL ON FUNCTION public.admin_payments()
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_payments()
TO authenticated, service_role;


-- ==========================================================
-- 4. MIGRATION COMPLETE
-- ==========================================================

COMMIT;
