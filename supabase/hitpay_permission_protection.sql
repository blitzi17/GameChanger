
BEGIN;

-- Remove unnecessary TRUNCATE privileges
-- from ordinary client roles.

REVOKE TRUNCATE
ON TABLE public.payment_transactions
FROM PUBLIC, anon, authenticated;


REVOKE TRUNCATE
ON TABLE public.session_registrations
FROM PUBLIC, anon, authenticated;

COMMIT;
