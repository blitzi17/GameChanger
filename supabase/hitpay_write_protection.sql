
BEGIN;


-- Protect HitPay records without replacing
-- existing legacy payment functions.

CREATE OR REPLACE FUNCTION
public.hitpay_protect_verified_status()

RETURNS trigger

LANGUAGE plpgsql

SECURITY INVOKER

SET search_path = public, pg_temp

AS $$
BEGIN

    -- 1. Protect HitPay transaction records
    -- from deletion.
    IF TG_OP = 'DELETE' THEN

        IF OLD.payment_provider = 'HITPAY' THEN

            RAISE EXCEPTION
                'HitPay transaction records must be retained.';

        END IF;

        RETURN OLD;

    END IF;


    -- 2. Protect existing HitPay provider identity.
    IF TG_OP = 'UPDATE' THEN

        IF OLD.payment_provider = 'HITPAY'
           AND NEW.payment_provider
               IS DISTINCT FROM 'HITPAY'
        THEN

            RAISE EXCEPTION
                'HitPay payment provider cannot be changed.';

        END IF;


        -- Prevent conversion of legacy transactions
        -- into HitPay transactions.
        IF OLD.payment_provider
                IS DISTINCT FROM 'HITPAY'

           AND NEW.payment_provider = 'HITPAY'
        THEN

            RAISE EXCEPTION
                'Legacy transactions cannot become HitPay transactions.';

        END IF;

    END IF;


    -- 3. Leave ordinary payment records unchanged.
    IF NEW.payment_provider
        IS DISTINCT FROM 'HITPAY'
    THEN

        RETURN NEW;

    END IF;


    -- 4. Require sandbox isolation.
    IF NEW.is_sandbox IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'Only HitPay Sandbox transactions are permitted.';

    END IF;


    -- 5. New HitPay records must start pending.
    IF TG_OP = 'INSERT' THEN

        IF NEW.transaction_status
                IS DISTINCT FROM 'PENDING_PAYMENT'

           OR NEW.checkout_state
                IS DISTINCT FROM 'NOT_STARTED'

           OR NEW.reconciliation_required
                IS DISTINCT FROM false

           OR NEW.gateway_verified_at IS NOT NULL

           OR NEW.gateway_request_id IS NOT NULL

           OR NEW.gateway_checkout_url IS NOT NULL

           OR NEW.hitpay_reference_id IS NOT NULL

           OR NEW.hmac_signature IS NOT NULL

           OR NEW.gateway_payload IS NOT NULL

           OR NEW.confirmed_at IS NOT NULL

           OR NEW.registration_id IS NOT NULL

           OR NEW.payment_channel IS NOT NULL

        THEN

            RAISE EXCEPTION
                'New HitPay transactions must start pending without gateway evidence.';

        END IF;

    END IF;


    -- 6. Prevent changes to trusted payment identity.
    IF TG_OP = 'UPDATE' THEN

        IF NEW.transaction_id
                IS DISTINCT FROM OLD.transaction_id

           OR NEW.user_id
                IS DISTINCT FROM OLD.user_id

           OR NEW.session_id
                IS DISTINCT FROM OLD.session_id

           OR NEW.order_reference_id
                IS DISTINCT FROM OLD.order_reference_id

           OR NEW.amount
                IS DISTINCT FROM OLD.amount

           OR NEW.currency
                IS DISTINCT FROM OLD.currency

           OR NEW.is_sandbox
                IS DISTINCT FROM OLD.is_sandbox

        THEN

            RAISE EXCEPTION
                'HitPay transaction identity cannot be modified.';

        END IF;


        -- 7. Prevent replacement of an existing
        -- gateway request identifier.
        IF OLD.gateway_request_id IS NOT NULL

           AND NEW.gateway_request_id
               IS DISTINCT FROM OLD.gateway_request_id

        THEN

            RAISE EXCEPTION
                'HitPay gateway request ID cannot be modified.';

        END IF;


        -- 8. Prevent legacy manual payment fields
        -- from being applied to HitPay transactions.
        IF NEW.payer_reference
                IS DISTINCT FROM OLD.payer_reference

           OR NEW.rejection_reason
                IS DISTINCT FROM OLD.rejection_reason

           OR NEW.reviewed_by
                IS DISTINCT FROM OLD.reviewed_by

           OR NEW.reviewed_at
                IS DISTINCT FROM OLD.reviewed_at

        THEN

            RAISE EXCEPTION
                'Manual payment review is not permitted for HitPay transactions.';

        END IF;

    END IF;


    -- 9. Require complete evidence before
    -- accepting a Paid transaction.
    IF NEW.transaction_status = 'PAID' THEN

        IF NEW.gateway_verified_at IS NULL

           OR NEW.gateway_request_id IS NULL

           OR NEW.hitpay_reference_id IS NULL

           OR NEW.hmac_signature IS NULL

           OR NEW.gateway_payload IS NULL

           OR NEW.registration_id IS NULL

           OR NEW.payment_channel IS NULL

           OR NEW.confirmed_at IS NULL

           OR NEW.reconciliation_required
                IS DISTINCT FROM false

           OR NEW.checkout_state
                IS DISTINCT FROM 'CREATED'

        THEN

            RAISE EXCEPTION
                'Complete gateway verification evidence is required.';

        END IF;


        -- Require a correctly formatted HMAC signature.
        IF NEW.hmac_signature
            !~ '^[a-fA-F0-9]{64}$'
        THEN

            RAISE EXCEPTION
                'Invalid gateway signature format.';

        END IF;


        -- Require structured gateway evidence.
        IF jsonb_typeof(NEW.gateway_payload)
            IS DISTINCT FROM 'object'
        THEN

            RAISE EXCEPTION
                'Invalid gateway evidence format.';

        END IF;

    END IF;


    -- 10. Protect previously finalized payments.
    IF TG_OP = 'UPDATE' THEN

        IF OLD.transaction_status = 'PAID' THEN

            IF NEW IS DISTINCT FROM OLD THEN

                RAISE EXCEPTION
                    'Finalized HitPay payments cannot be modified.';

            END IF;

        END IF;

    END IF;


    RETURN NEW;

END;
$$;


-- 11. Restrict direct execution of the new
-- protection function.
REVOKE ALL ON FUNCTION
public.hitpay_protect_verified_status()

FROM PUBLIC, anon, authenticated;


-- 12. Replace only our HitPay protection trigger.
DROP TRIGGER IF EXISTS trg_hitpay_verified_status

ON public.payment_transactions;


CREATE TRIGGER trg_hitpay_verified_status

BEFORE INSERT OR UPDATE OR DELETE

ON public.payment_transactions

FOR EACH ROW

EXECUTE FUNCTION
public.hitpay_protect_verified_status();


COMMIT;
