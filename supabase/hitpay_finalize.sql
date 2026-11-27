
BEGIN;

-- 1. Add payment reconciliation columns.
ALTER TABLE public.payment_transactions
ADD COLUMN IF NOT EXISTS reconciliation_required
    boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS reconciliation_reason text,
ADD COLUMN IF NOT EXISTS reconciliation_requested_at
    timestamptz;


-- 2. Finalize verified HitPay Sandbox payments.
CREATE OR REPLACE FUNCTION public.hitpay_finalize_payment(
    p_order_reference text,
    p_gateway_request_id text,
    p_hitpay_reference text,
    p_amount numeric,
    p_currency text,
    p_payment_channel public.payment_channel_enum,
    p_signature text,
    p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_payment public.payment_transactions%ROWTYPE;
    v_session public.training_sessions%ROWTYPE;
    v_registration_id uuid;
    v_session_id uuid;
    v_prerequisite uuid;
    v_registered_count integer;
    v_review_reason text;
BEGIN

    -- 3. Locate the payment transaction.
    SELECT session_id
    INTO v_session_id
    FROM public.payment_transactions
    WHERE order_reference_id = p_order_reference
      AND payment_provider = 'HITPAY'
      AND is_sandbox = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Payment transaction not found.';
    END IF;


    -- 4. Lock the session.
    SELECT *
    INTO v_session
    FROM public.training_sessions
    WHERE session_id = v_session_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Session not found.';
    END IF;


    -- 5. Lock the payment transaction.
    SELECT *
    INTO v_payment
    FROM public.payment_transactions
    WHERE order_reference_id = p_order_reference
      AND payment_provider = 'HITPAY'
      AND is_sandbox = true
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Payment transaction not found.';
    END IF;


    -- 6. Validate gateway information.
    IF NULLIF(TRIM(p_order_reference), '') IS NULL
       OR NULLIF(TRIM(p_gateway_request_id), '') IS NULL
       OR v_payment.gateway_request_id
          IS DISTINCT FROM p_gateway_request_id
       OR p_amount IS DISTINCT FROM v_payment.amount
       OR p_currency IS DISTINCT FROM v_payment.currency
       OR NULLIF(TRIM(p_hitpay_reference), '') IS NULL
       OR NULLIF(TRIM(p_signature), '') IS NULL
       OR p_payment_channel IS NULL
       OR p_payload IS NULL
       OR jsonb_typeof(p_payload) <> 'object'
    THEN

        RAISE EXCEPTION
            'Payment information mismatch.';

    END IF;


    -- 7. Handle repeated successful notifications.
    IF v_payment.transaction_status = 'PAID' THEN

        IF v_payment.gateway_verified_at IS NOT NULL
           AND v_payment.hitpay_reference_id =
               p_hitpay_reference
           AND v_payment.payment_channel =
               p_payment_channel
           AND v_payment.registration_id IS NOT NULL
        THEN

            RETURN jsonb_build_object(
                'status', 'PAID',
                'transaction_id',
                    v_payment.transaction_id,
                'registration_id',
                    v_payment.registration_id,
                'already_processed', true,
                'registration_completed', true
            );

        END IF;

        RAISE EXCEPTION
            'Conflicting successful payment information.';

    END IF;


    -- 8. Preserve previously recorded successful
    -- payment evidence under reconciliation.
    IF v_payment.reconciliation_required = true
       AND v_payment.gateway_verified_at IS NOT NULL
    THEN

        IF v_payment.hitpay_reference_id =
               p_hitpay_reference
           AND v_payment.payment_channel =
               p_payment_channel
        THEN

            RETURN jsonb_build_object(
                'status', 'REVIEW_REQUIRED',
                'transaction_id',
                    v_payment.transaction_id,
                'order_reference',
                    p_order_reference,
                'reconciliation_required', true,
                'already_processed', true,
                'registration_completed', false,
                'reason',
                    v_payment.reconciliation_reason
            );

        END IF;

        RAISE EXCEPTION
            'Conflicting gateway evidence requires review.';

    END IF;


    -- 9. Identify conditions requiring reconciliation.
    IF v_payment.reconciliation_required = true THEN

        v_review_reason := COALESCE(
            v_payment.reconciliation_reason,
            'Payment already requires reconciliation.'
        );

    ELSIF v_payment.transaction_status
        IS DISTINCT FROM 'PENDING_PAYMENT'
    THEN

        v_review_reason :=
            'Successful payment received after local status changed.';

    ELSIF NOT public.hitpay_is_sandbox_allowed(
        v_payment.user_id,
        v_payment.session_id
    ) THEN

        v_review_reason :=
            'Sandbox authorization is no longer active.';

    ELSIF v_session.session_status IS NULL
       OR v_session.session_status NOT IN (
           'Upcoming',
           'Live'
       )
       OR v_session.scheduled_end IS NULL
       OR v_session.scheduled_end <= now()
    THEN

        v_review_reason :=
            'Session is no longer available.';

    ELSIF NOT EXISTS (
        SELECT 1
        FROM public.users
        WHERE user_id = v_payment.user_id
          AND role = 'MEMBER'
          AND account_status = 'Active'
    ) THEN

        v_review_reason :=
            'Member account is no longer eligible.';

    END IF;


    -- 10. Recheck the admission fee.
    IF v_review_reason IS NULL
       AND v_session.admission_fee
           IS DISTINCT FROM v_payment.amount
    THEN

        v_review_reason :=
            'Session admission fee has changed.';

    END IF;


    -- 11. Recheck Career Path prerequisites.
    IF v_review_reason IS NULL THEN

        SELECT prerequisite_node_id
        INTO v_prerequisite
        FROM public.career_nodes
        WHERE node_id = v_session.node_id;

        IF v_prerequisite IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
               FROM public.member_skill_progress
               WHERE user_id = v_payment.user_id
                 AND node_id = v_prerequisite
                 AND status = 'COMPLETED'
           )
        THEN

            v_review_reason :=
                'Career Path prerequisite is no longer satisfied.';

        END IF;

    END IF;


    -- 12. Check existing registration.
    SELECT registration_id
    INTO v_registration_id
    FROM public.session_registrations
    WHERE session_id = v_payment.session_id
      AND user_id = v_payment.user_id
    FOR UPDATE;

    IF v_review_reason IS NULL
       AND EXISTS (
           SELECT 1
           FROM public.session_registrations
           WHERE registration_id = v_registration_id
             AND payment_status IN (
                 'PAID',
                 'FREE',
                 'WAIVED'
             )
       )
    THEN

        v_review_reason :=
            'Member already has a completed registration.';

    END IF;


    -- 13. Recheck available session capacity.
    SELECT count(*)
    INTO v_registered_count
    FROM public.session_registrations
    WHERE session_id = v_payment.session_id
      AND payment_status IN (
          'PAID',
          'FREE',
          'WAIVED'
      );

    IF v_review_reason IS NULL
       AND (
           v_session.capacity IS NULL
           OR v_registered_count >= v_session.capacity
       )
    THEN

        v_review_reason :=
            'Session capacity is unavailable.';

    END IF;


    -- 14. Preserve verified successful payment evidence
    -- without completing an ineligible registration.
    IF v_review_reason IS NOT NULL THEN

        UPDATE public.payment_transactions
        SET
            hitpay_reference_id = p_hitpay_reference,
            payment_channel = p_payment_channel,
            hmac_signature = p_signature,
            gateway_payload = p_payload,
            gateway_verified_at = now(),
            reconciliation_required = true,
            reconciliation_reason = v_review_reason,
            reconciliation_requested_at = COALESCE(
                reconciliation_requested_at,
                now()
            )
        WHERE transaction_id = v_payment.transaction_id;

        RETURN jsonb_build_object(
            'status', 'REVIEW_REQUIRED',
            'transaction_id',
                v_payment.transaction_id,
            'order_reference',
                p_order_reference,
            'hitpay_reference',
                p_hitpay_reference,
            'gateway_payment_verified', true,
            'registration_completed', false,
            'reconciliation_required', true,
            'reason', v_review_reason
        );

    END IF;


    -- 15. Create registration after verified payment.
    IF v_registration_id IS NULL THEN

        INSERT INTO public.session_registrations (
            session_id,
            user_id,
            payment_status,
            attendance_status,
            zoom_access_released
        )
        VALUES (
            v_payment.session_id,
            v_payment.user_id,
            'PAID',
            'REGISTERED',
            false
        )
        RETURNING registration_id
        INTO v_registration_id;

    END IF;


    -- 16. Finalize payment.
    UPDATE public.payment_transactions
    SET
        registration_id = v_registration_id,
        hitpay_reference_id = p_hitpay_reference,
        payment_channel = p_payment_channel,
        transaction_status = 'PAID',
        hmac_signature = p_signature,
        gateway_payload = p_payload,
        gateway_verified_at = now(),
        confirmed_at = now(),
        reconciliation_required = false,
        reconciliation_reason = NULL,
        reconciliation_requested_at = NULL
    WHERE transaction_id = v_payment.transaction_id;


    -- 17. Synchronize registration payment status.
    UPDATE public.session_registrations
    SET payment_status = 'PAID'
    WHERE registration_id = v_registration_id;


    -- 18. Return receipt information.
    RETURN jsonb_build_object(
        'status', 'PAID',
        'transaction_id',
            v_payment.transaction_id,
        'registration_id',
            v_registration_id,
        'order_reference',
            p_order_reference,
        'hitpay_reference',
            p_hitpay_reference,
        'amount', v_payment.amount,
        'currency', v_payment.currency,
        'payment_channel', p_payment_channel,
        'confirmed_at', now(),
        'registration_completed', true,
        'reconciliation_required', false
    );

END;
$$;


-- 19. Restrict execution to the trusted backend.
REVOKE ALL ON FUNCTION public.hitpay_finalize_payment(
    text,
    text,
    text,
    numeric,
    text,
    public.payment_channel_enum,
    text,
    jsonb
)
FROM PUBLIC, anon, authenticated;


GRANT EXECUTE ON FUNCTION public.hitpay_finalize_payment(
    text,
    text,
    text,
    numeric,
    text,
    public.payment_channel_enum,
    text,
    jsonb
)
TO service_role;

COMMIT;
