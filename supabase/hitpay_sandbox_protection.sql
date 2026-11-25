
BEGIN;

-- 1. Create the restricted sandbox allowlist.
CREATE TABLE IF NOT EXISTS public.hitpay_sandbox_allowlist (
    user_id uuid NOT NULL
        REFERENCES public.users(user_id),

    session_id uuid NOT NULL
        REFERENCES public.training_sessions(session_id),

    enabled boolean NOT NULL DEFAULT true,

    created_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, session_id)
);


-- 2. Restrict allowlist access.
ALTER TABLE public.hitpay_sandbox_allowlist
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.hitpay_sandbox_allowlist
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.hitpay_sandbox_allowlist
TO service_role;


-- 3. Authorize the designated test member and session.
INSERT INTO public.hitpay_sandbox_allowlist (
    user_id,
    session_id,
    enabled
)
VALUES (
    'cb9ab5af-576f-48fd-b5c6-081874c2ea0e',
    'cd2f1fa3-c011-481f-b8fa-333354d14e27',
    true
)
ON CONFLICT (user_id, session_id)
DO NOTHING;


-- 4. Check sandbox authorization.
CREATE OR REPLACE FUNCTION
public.hitpay_is_sandbox_allowed(
    p_user_id uuid,
    p_session_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.hitpay_sandbox_allowlist a
        WHERE a.user_id = p_user_id
          AND a.session_id = p_session_id
          AND a.enabled = true
    );
$$;

REVOKE ALL ON FUNCTION
public.hitpay_is_sandbox_allowed(uuid, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.hitpay_is_sandbox_allowed(uuid, uuid)
TO service_role;


-- 5. Identify designated sandbox sessions.
-- Disabled authorization does not remove sandbox identity.
CREATE OR REPLACE FUNCTION
public.hitpay_is_sandbox_session(
    p_session_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.hitpay_sandbox_allowlist a
        WHERE a.session_id = p_session_id
    );
$$;

REVOKE ALL ON FUNCTION
public.hitpay_is_sandbox_session(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.hitpay_is_sandbox_session(uuid)
TO service_role;


-- 6. Enforce sandbox transaction isolation.
CREATE OR REPLACE FUNCTION
public.hitpay_enforce_sandbox_isolation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN

    IF TG_OP = 'UPDATE' THEN

        -- Prevent ordinary payments from being converted
        -- into HitPay transactions.
        IF OLD.payment_provider IS DISTINCT FROM 'HITPAY'
           AND NEW.payment_provider = 'HITPAY'
        THEN
            RAISE EXCEPTION
                'Existing payments cannot be converted into HitPay payments.';
        END IF;


        -- Protect existing HitPay transaction identity.
        IF OLD.payment_provider = 'HITPAY' THEN

            IF NEW.payment_provider
                IS DISTINCT FROM OLD.payment_provider
            OR NEW.is_sandbox
                IS DISTINCT FROM OLD.is_sandbox
            OR NEW.user_id
                IS DISTINCT FROM OLD.user_id
            OR NEW.session_id
                IS DISTINCT FROM OLD.session_id
            THEN
                RAISE EXCEPTION
                    'HitPay transaction identity cannot be changed.';
            END IF;

        END IF;

    END IF;


    -- Leave unrelated payments unchanged.
    IF NEW.payment_provider IS DISTINCT FROM 'HITPAY' THEN
        RETURN NEW;
    END IF;


    -- Only sandbox payments are supported.
    IF NEW.is_sandbox IS DISTINCT FROM true THEN

        RAISE EXCEPTION
            'Only HitPay Sandbox transactions are allowed.';

    END IF;


    -- Require active authorization for new payments.
    IF TG_OP = 'INSERT' THEN

        IF NOT public.hitpay_is_sandbox_allowed(
            NEW.user_id,
            NEW.session_id
        ) THEN

            RAISE EXCEPTION
                'Member or session is not authorized for sandbox testing.';

        END IF;

    END IF;


    -- Existing transactions may receive verified outcomes
    -- even when new checkout authorization is disabled.
    -- Other payment security restrictions still apply.

    RETURN NEW;

END;
$$;


REVOKE ALL ON FUNCTION
public.hitpay_enforce_sandbox_isolation()
FROM PUBLIC, anon, authenticated;


-- 7. Attach the isolation trigger.
DROP TRIGGER IF EXISTS trg_hitpay_sandbox_isolation
ON public.payment_transactions;

CREATE TRIGGER trg_hitpay_sandbox_isolation
BEFORE INSERT OR UPDATE
ON public.payment_transactions
FOR EACH ROW
EXECUTE FUNCTION
public.hitpay_enforce_sandbox_isolation();

COMMIT;
