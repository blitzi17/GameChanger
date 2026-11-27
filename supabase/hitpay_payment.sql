
-- GameChanger: UC-PAM-01 Process Payment
-- Phase 1: Prepare payment transaction schema

BEGIN;

-- Allow pending payments before registration.
ALTER TABLE public.payment_transactions
    ALTER COLUMN registration_id DROP NOT NULL;

-- Do not assume GCash before payment method selection.
ALTER TABLE public.payment_transactions
    ALTER COLUMN payment_channel DROP NOT NULL,
    ALTER COLUMN payment_channel DROP DEFAULT;

-- Additional HitPay information.
ALTER TABLE public.payment_transactions
    ADD COLUMN IF NOT EXISTS payment_provider text,
    ADD COLUMN IF NOT EXISTS gateway_request_id text,
    ADD COLUMN IF NOT EXISTS gateway_checkout_url text,
    ADD COLUMN IF NOT EXISTS gateway_payload jsonb,
    ADD COLUMN IF NOT EXISTS gateway_verified_at timestamptz,
    ADD COLUMN IF NOT EXISTS is_sandbox boolean
        NOT NULL DEFAULT false;

-- Prevent duplicate gateway request IDs.
CREATE UNIQUE INDEX IF NOT EXISTS
    uq_payment_gateway_request
ON public.payment_transactions (gateway_request_id)
WHERE gateway_request_id IS NOT NULL;

COMMIT;
