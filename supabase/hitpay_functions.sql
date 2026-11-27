
BEGIN;

CREATE OR REPLACE FUNCTION public.hitpay_check_eligibility(
    p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_session public.training_sessions%ROWTYPE;
    v_prerequisite uuid;
BEGIN
    -- 1. Validate authenticated member.
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Please sign in first.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.users
        WHERE user_id = v_user_id
          AND role = 'MEMBER'
          AND account_status = 'Active'
    ) THEN
        RAISE EXCEPTION 'Invalid member account.';
    END IF;

    -- 2. Retrieve the selected session.
    SELECT *
    INTO v_session
    FROM public.training_sessions
    WHERE session_id = p_session_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found.';
    END IF;

    -- 3. Check session availability.
    IF v_session.session_status NOT IN ('Upcoming', 'Live')
       OR v_session.scheduled_end <= now() THEN
        RAISE EXCEPTION 'Session is unavailable.';
    END IF;

    -- 4. Validate admission fee.
    IF v_session.admission_fee <= 0 THEN
        RAISE EXCEPTION 'This session does not require payment.';
    END IF;

    -- 5. Check Career Path prerequisite.
    SELECT prerequisite_node_id
    INTO v_prerequisite
    FROM public.career_nodes
    WHERE node_id = v_session.node_id;

    IF v_prerequisite IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM public.member_skill_progress
           WHERE user_id = v_user_id
             AND node_id = v_prerequisite
             AND status = 'COMPLETED'
       ) THEN
        RAISE EXCEPTION 'Complete the required prerequisite first.';
    END IF;

    -- 6. Prevent duplicate paid registration.
    IF EXISTS (
        SELECT 1
        FROM public.session_registrations
        WHERE session_id = p_session_id
          AND user_id = v_user_id
          AND payment_status IN ('PAID', 'WAIVED', 'FREE')
    ) THEN
        RAISE EXCEPTION 'You are already registered.';
    END IF;

    -- 7. Check available capacity.
    IF (
        SELECT count(*)
        FROM public.session_registrations
        WHERE session_id = p_session_id
          AND payment_status IN ('PAID', 'WAIVED', 'FREE')
    ) >= v_session.capacity THEN
        RAISE EXCEPTION 'This session is full.';
    END IF;

    -- 8. Return verified payment information.
    RETURN jsonb_build_object(
        'eligible', true,
        'user_id', v_user_id,
        'session_id', v_session.session_id,
        'session_title', v_session.title,
        'amount', v_session.admission_fee,
        'currency', 'PHP'
    );
END;
$$;

-- Restrict function access.
REVOKE ALL ON FUNCTION
    public.hitpay_check_eligibility(uuid)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
    public.hitpay_check_eligibility(uuid)
TO authenticated;

COMMIT;
