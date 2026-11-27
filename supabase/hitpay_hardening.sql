BEGIN;

-- Prevent duplicate pending HitPay transactions.
CREATE UNIQUE INDEX IF NOT EXISTS
    uq_hitpay_pending_transaction
ON public.payment_transactions (user_id, session_id)
WHERE payment_provider = 'HITPAY'
  AND transaction_status = 'PENDING_PAYMENT';

-- Prevent duplicate successful gateway references.
CREATE UNIQUE INDEX IF NOT EXISTS
    uq_hitpay_successful_reference
ON public.payment_transactions (hitpay_reference_id)
WHERE payment_provider = 'HITPAY'
  AND transaction_status = 'PAID'
  AND hitpay_reference_id IS NOT NULL;

-- Require verification details for successful HitPay payments.
ALTER TABLE public.payment_transactions
ADD CONSTRAINT hitpay_verified_payment_check
CHECK (
    payment_provider IS DISTINCT FROM 'HITPAY'
    OR transaction_status <> 'PAID'
    OR (
        gateway_verified_at IS NOT NULL
        AND registration_id IS NOT NULL
        AND gateway_request_id IS NOT NULL
        AND hitpay_reference_id IS NOT NULL
        AND hmac_signature IS NOT NULL
    )
);

-- Preserve Row Level Security.
ALTER TABLE public.payment_transactions
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.session_registrations
ENABLE ROW LEVEL SECURITY;

COMMIT;