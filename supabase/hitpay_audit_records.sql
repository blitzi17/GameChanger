BEGIN;

CREATE TABLE IF NOT EXISTS public.hitpay_audit_records (
    audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id uuid NOT NULL,
    order_reference text NOT NULL,
    previous_status text,
    current_status text NOT NULL,
    gateway_request_id text,
    hitpay_reference_id text,
    gateway_payload jsonb,
    reconciliation_required boolean NOT NULL,
    reconciliation_reason text,
    recorded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.hitpay_audit_records
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.hitpay_audit_records
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.hitpay_audit_records
TO service_role;

CREATE OR REPLACE FUNCTION public.hitpay_record_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_previous_status text;
BEGIN
    IF NEW.payment_provider IS DISTINCT FROM 'HITPAY'
       OR NEW.is_sandbox IS DISTINCT FROM true
    THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        v_previous_status := OLD.transaction_status::text;

        IF NEW IS NOT DISTINCT FROM OLD THEN
            RETURN NEW;
        END IF;
    END IF;

    INSERT INTO public.hitpay_audit_records (
        transaction_id,
        order_reference,
        previous_status,
        current_status,
        gateway_request_id,
        hitpay_reference_id,
        gateway_payload,
        reconciliation_required,
        reconciliation_reason
    )
    VALUES (
        NEW.transaction_id,
        NEW.order_reference_id,
        v_previous_status,
        NEW.transaction_status::text,
        NEW.gateway_request_id,
        NEW.hitpay_reference_id,
        NEW.gateway_payload,
        NEW.reconciliation_required,
        NEW.reconciliation_reason
    );

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.hitpay_record_audit()
FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_hitpay_audit_records
ON public.payment_transactions;

CREATE TRIGGER trg_hitpay_audit_records
AFTER INSERT OR UPDATE
ON public.payment_transactions
FOR EACH ROW
EXECUTE FUNCTION public.hitpay_record_audit();

COMMIT;