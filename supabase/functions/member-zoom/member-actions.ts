import {
  ensureZoomRegistration,
  type MemberIdentity,
  type RegistrationDependencies
} from "./registration-service.ts";

import {
  reusableZoomRegistrantLink
} from "../zoom/registrant-record.ts";

export type MemberAction = "register" | "join";

export type MemberActionDependencies = {
  authorize(
    sessionId: string,
    requireJoinWindow: boolean
  ): Promise<MemberIdentity>;

  registration: RegistrationDependencies;
};

export async function handleMemberAction(
  action: MemberAction,
  sessionId: string,
  dependencies: MemberActionDependencies
) {
  const requireJoinWindow = action === "join";

  // Always authorize before accessing registrant records
  // or making any Zoom API requests.

  const identity = await dependencies.authorize(
    sessionId,
    requireJoinWindow
  );

  const registration = await ensureZoomRegistration(
    identity,
    dependencies.registration
  );

  // Registration alone must never reveal the joining URL.

  if (action === "register") {
    return {
      status: registration.status,
      registered: true
    };
  }

  // Recheck full joining authorization after registration.
  // The session or member eligibility may have changed.

  const latestIdentity = await dependencies.authorize(
    sessionId,
    true
  );

  if (
    latestIdentity.registration_id !==
      identity.registration_id ||

    latestIdentity.zoom_meeting_id !==
      identity.zoom_meeting_id ||

    latestIdentity.email.trim().toLowerCase() !==
      identity.email.trim().toLowerCase()
  ) {
    throw new Error("REGISTRATION_IDENTITY_CHANGED");
  }

  const stored =
    await dependencies.registration.findRegistrant(
      latestIdentity.registration_id
    );

  const joinUrl = reusableZoomRegistrantLink(
    stored,
    latestIdentity
  );

  if (!joinUrl) {
    throw new Error("REGISTRATION_REVIEW_REQUIRED");
  }

  return {
    status: "ready",
    join_url: joinUrl
  };
}