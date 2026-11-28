/// <reference lib="deno.ns" />

import {
  ensureZoomRegistration,
  type RegistrationDependencies,
  type MemberIdentity
} from "../functions/member-zoom/registration-service.ts";

import type {
  StoredZoomRegistrant
} from "../functions/zoom/registrant-record.ts";

const identity: MemberIdentity = {
  registration_id: "local-registration-001",
  zoom_meeting_id: "90000000001",
  email: "member.a@example.com",
  first_name: "Member",
  last_name: "Alpha"
};

const stored: StoredZoomRegistrant = {
  registration_id: identity.registration_id,
  zoom_meeting_id: identity.zoom_meeting_id,
  registered_email: identity.email,
  zoom_registrant_id: "local-registrant-001",
  zoom_join_url: "https://zoom.us/j/90000000001?tk=test"
};

function assert(condition: unknown): asserts condition {
  if (!condition) {
    throw new Error("Assertion failed");
  }
}

async function expectError(
  operation: () => Promise<unknown>,
  expected: string
) {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message === expected);
    return;
  }

  throw new Error("Expected operation to fail");
}

function setup() {
  const calls = {
    find: 0,
    claim: 0,
    create: 0,
    complete: 0,
    review: 0
  };

  const dependencies: RegistrationDependencies = {
    findRegistrant: async () => {
      calls.find++;
      return null;
    },

    claimRegistration: async () => {
      calls.claim++;
      return "local-claim-token";
    },

    createRegistrant: async () => {
      calls.create++;

      return {
        registrant_id: stored.zoom_registrant_id,
        join_url: stored.zoom_join_url
      };
    },

    completeRegistration: async () => {
      calls.complete++;
      return true;
    },

    markReview: async () => {
      calls.review++;
      return true;
    }
  };

  return { dependencies, calls };
}

Deno.test("Reuses a valid existing registrant", async () => {
  const { dependencies, calls } = setup();

  dependencies.findRegistrant = async () => stored;

  const result = await ensureZoomRegistration(
    identity, dependencies
  );

  assert(result.status === "existing");
  assert(calls.claim === 0);
  assert(calls.create === 0);
});

Deno.test("Creates and completes a new registrant", async () => {
  const { dependencies, calls } = setup();

  const result = await ensureZoomRegistration(
    identity, dependencies
  );

  assert(result.status === "created");
  assert(calls.claim === 1);
  assert(calls.create === 1);
  assert(calls.complete === 1);
  assert(calls.review === 0);
  assert(!("join_url" in result));
});

Deno.test("Rejects a stored registrant with mismatched email", async () => {
  const { dependencies, calls } = setup();

  dependencies.findRegistrant = async () => ({
    ...stored,
    registered_email: "another@example.com"
  });

  await expectError(
    () => ensureZoomRegistration(identity, dependencies),
    "REGISTRATION_REVIEW_REQUIRED"
  );

  assert(calls.claim === 0);
  assert(calls.create === 0);
});

Deno.test("Blocks creation when another request owns the claim", async () => {
  const { dependencies, calls } = setup();

  dependencies.claimRegistration = async () => null;

  await expectError(
    () => ensureZoomRegistration(identity, dependencies),
    "REGISTRATION_UNAVAILABLE"
  );

  assert(calls.create === 0);
});

Deno.test("Reuses a registrant completed by another request", async () => {
  const { dependencies, calls } = setup();

  let reads = 0;

  dependencies.findRegistrant = async () => {
    reads++;
    return reads === 1 ? null : stored;
  };

  dependencies.claimRegistration = async () => null;

  const result = await ensureZoomRegistration(
    identity, dependencies
  );

  assert(result.status === "existing");
  assert(calls.create === 0);
});

Deno.test("Marks Zoom API failure for review", async () => {
  const { dependencies, calls } = setup();

  dependencies.createRegistrant = async () => {
    throw new Error("Mock network failure");
  };

  await expectError(
    () => ensureZoomRegistration(identity, dependencies),
    "REGISTRATION_REVIEW_REQUIRED"
  );

  assert(calls.review === 1);
  assert(calls.complete === 0);
});

Deno.test("Rejects invalid Zoom joining URLs", async () => {
  const { dependencies, calls } = setup();

  dependencies.createRegistrant = async () => ({
    registrant_id: "local-registrant",
    join_url: "https://example.com/not-zoom"
  });

  await expectError(
    () => ensureZoomRegistration(identity, dependencies),
    "REGISTRATION_REVIEW_REQUIRED"
  );

  assert(calls.complete === 0);
  assert(calls.review === 1);
});

Deno.test("Marks failed database completion for review", async () => {
  const { dependencies, calls } = setup();

  dependencies.completeRegistration = async () => false;

  await expectError(
    () => ensureZoomRegistration(identity, dependencies),
    "REGISTRATION_REVIEW_REQUIRED"
  );

  assert(calls.review === 1);
});

Deno.test("Does not retry creation when review marking fails", async () => {
  const { dependencies } = setup();

  let attempts = 0;

  dependencies.createRegistrant = async () => {
    attempts++;
    throw new Error("Mock API failure");
  };

  dependencies.markReview = async () => {
    throw new Error("Mock database failure");
  };

  await expectError(
    () => ensureZoomRegistration(identity, dependencies),
    "REGISTRATION_REVIEW_REQUIRED"
  );

  assert(attempts === 1);
});