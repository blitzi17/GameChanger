-- GameChanger / Zoom identity verification
-- REVIEW CANDIDATE: local clean-install validation only. Not approved for production.

-- GameChanger Zoom Verified Registration
-- Verified meeting and participant registration tables

-- 1. Store sessions configured for verified Zoom joining.

CREATE TABLE public.zoom_verified_meetings (
    session_id UUID PRIMARY KEY
        REFERENCES public.training_sessions(session_id)
        ON DELETE CASCADE,

    zoom_meeting_id TEXT NOT NULL,

    authentication_profile_id TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_verified_zoom_meeting
        UNIQUE (zoom_meeting_id),

    CONSTRAINT chk_verified_meeting_id
        CHECK (length(btrim(zoom_meeting_id)) > 0),

    CONSTRAINT chk_authentication_profile
        CHECK (length(btrim(authentication_profile_id)) > 0)
);

-- 2. Store individual Zoom registration records.

CREATE TABLE public.zoom_registrants (
    registration_id UUID PRIMARY KEY
        REFERENCES public.session_registrations(registration_id)
        ON DELETE CASCADE,

    zoom_meeting_id TEXT NOT NULL,

    zoom_registrant_id TEXT NOT NULL,

    registered_email TEXT NOT NULL,

    zoom_join_url TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_zoom_meeting_registrant
        UNIQUE (zoom_meeting_id, zoom_registrant_id),

    CONSTRAINT chk_zoom_registrant_id
        CHECK (length(btrim(zoom_registrant_id)) > 0),

    CONSTRAINT chk_zoom_registered_email
        CHECK (length(btrim(registered_email)) > 0),

    CONSTRAINT chk_zoom_registrant_join_url
        CHECK (
            zoom_join_url ~* '^https://[^[:space:]]+$'
        )
);

-- 3. Restrict access to sensitive Zoom records.

ALTER TABLE public.zoom_verified_meetings
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.zoom_registrants
    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.zoom_verified_meetings
    FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.zoom_registrants
    FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.zoom_verified_meetings
    TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.zoom_registrants
    TO service_role;

-- Remove unnecessary service-role privileges.

REVOKE TRUNCATE, REFERENCES, TRIGGER
ON TABLE
    public.zoom_registrants,
    public.zoom_verified_meetings
FROM service_role;

-- Track individual Zoom registration operations.

CREATE TABLE public.zoom_registration_claims (
    registration_id uuid PRIMARY KEY
        REFERENCES public.session_registrations(registration_id)
        ON DELETE CASCADE,

    zoom_meeting_id text NOT NULL,

    registered_email text NOT NULL,

    claim_token uuid NOT NULL DEFAULT gen_random_uuid(),

    claim_status text NOT NULL DEFAULT 'CREATING',

    created_at timestamptz NOT NULL DEFAULT now(),

    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_zoom_registration_claim_token
        UNIQUE (claim_token),

    CONSTRAINT chk_zoom_claim_meeting
        CHECK (length(btrim(zoom_meeting_id)) > 0),

    CONSTRAINT chk_zoom_claim_email
        CHECK (length(btrim(registered_email)) > 0),

    CONSTRAINT chk_zoom_claim_status
        CHECK (
            claim_status IN (
                'CREATING',
                'COMPLETED',
                'REVIEW_REQUIRED'
            )
        )
);

ALTER TABLE public.zoom_registration_claims
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
    public.zoom_registration_claims
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
    public.zoom_registration_claims
TO service_role;

CREATE TABLE public.zoom_meeting_creation_claims (
    session_id UUID PRIMARY KEY
        REFERENCES public.training_sessions(session_id)
        ON DELETE CASCADE,

    claimed_by UUID NOT NULL
        REFERENCES public.users(user_id),

    expected_meeting_id TEXT,

    claim_token UUID NOT NULL UNIQUE
        DEFAULT gen_random_uuid(),

    claim_status TEXT NOT NULL DEFAULT 'CREATING'
        CHECK (
            claim_status IN (
                'CREATING',
                'COMPLETED',
                'REVIEW_REQUIRED'
            )
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.zoom_meeting_creation_claims
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.zoom_meeting_creation_claims
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON public.zoom_meeting_creation_claims
TO service_role;

ALTER TABLE public.zoom_verified_meetings
ADD COLUMN lifecycle_status text
NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE public.zoom_verified_meetings
ADD COLUMN retired_at timestamptz;

ALTER TABLE public.zoom_verified_meetings
ADD CONSTRAINT chk_zoom_meeting_lifecycle_status
CHECK (
    lifecycle_status IN (
        'ACTIVE',
        'REVIEW_REQUIRED',
        'RETIRED'
    )
);

ALTER TABLE public.zoom_verified_meetings
ADD CONSTRAINT chk_zoom_meeting_retired_at
CHECK (
    (lifecycle_status = 'RETIRED' AND retired_at IS NOT NULL)
    OR
    (lifecycle_status <> 'RETIRED' AND retired_at IS NULL)
);

ALTER TABLE public.zoom_meeting_creation_claims
ADD COLUMN external_meeting_id TEXT;

REVOKE ALL ON TABLE public.zoom_verified_meetings, public.zoom_registrants FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zoom_verified_meetings, public.zoom_registrants TO service_role;
