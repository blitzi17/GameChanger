import {
  reusableZoomRegistrantLink,
  type StoredZoomRegistrant,
  type ZoomRegistrantIdentity
} from "../zoom/registrant-record.ts";

import type {
  ZoomRegistrantResult
} from "../zoom/meeting-registrant.ts";

export type MemberIdentity = ZoomRegistrantIdentity & {
  first_name: string;
  last_name: string;
};

export type RegistrationDependencies = {
  findRegistrant(
    registrationId: string
  ): Promise<StoredZoomRegistrant | null>;

  claimRegistration(
    identity: MemberIdentity
  ): Promise<string | null>;

  createRegistrant(
    identity: MemberIdentity
  ): Promise<ZoomRegistrantResult>;

  completeRegistration(
    registrationId: string,
    claimToken: string,
    registrant: ZoomRegistrantResult
  ): Promise<boolean>;

  markReview(
    registrationId: string,
    claimToken: string
  ): Promise<boolean>;
};

export type RegistrationResult = {
  status: "existing" | "created";
};

export async function ensureZoomRegistration(
  identity: MemberIdentity,
  dependencies: RegistrationDependencies
): Promise<RegistrationResult> {

  const existing = await dependencies.findRegistrant(
    identity.registration_id
  );

  if (existing) {
    if (!reusableZoomRegistrantLink(existing, identity)) {
      throw new Error("REGISTRATION_REVIEW_REQUIRED");
    }

    return { status: "existing" };
  }

  const claimToken =
    await dependencies.claimRegistration(identity);

  if (!claimToken) {
    const latest = await dependencies.findRegistrant(
      identity.registration_id
    );

    if (latest &&
        reusableZoomRegistrantLink(latest, identity)) {
      return { status: "existing" };
    }

    throw new Error("REGISTRATION_UNAVAILABLE");
  }

  try {
    const registrant =
      await dependencies.createRegistrant(identity);

    const candidate: StoredZoomRegistrant = {
      registration_id: identity.registration_id,
      zoom_meeting_id: identity.zoom_meeting_id,
      registered_email: identity.email,
      zoom_registrant_id: registrant.registrant_id,
      zoom_join_url: registrant.join_url
    };

    if (!reusableZoomRegistrantLink(candidate, identity)) {
      throw new Error("INVALID_ZOOM_REGISTRANT");
    }

    const completed =
      await dependencies.completeRegistration(
        identity.registration_id,
        claimToken,
        registrant
      );

    if (!completed) {
      throw new Error("REGISTRATION_COMPLETION_FAILED");
    }

    return { status: "created" };

  } catch {
    try {
      await dependencies.markReview(
        identity.registration_id,
        claimToken
      );
    } catch {
      // Preserve the existing claim if review marking fails.
      // Never automatically create another Zoom registrant.
    }

    throw new Error("REGISTRATION_REVIEW_REQUIRED");
  }
}