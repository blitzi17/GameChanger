/// <reference lib="deno.ns" />

import {
  handleMemberAction,
  type MemberActionDependencies
} from "../functions/member-zoom/member-actions.ts";

import type {
  MemberIdentity
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
    authorize: 0,
    find: 0,
    claim: 0,
    create: 0
  };

  const windows: boolean[] = [];

  const dependencies: MemberActionDependencies = {
    authorize: async (_sessionId, requireJoinWindow) => {
      calls.authorize++;
      windows.push(requireJoinWindow);
      return identity;
    },

    registration: {
      findRegistrant: async () => {
        calls.find++;
        return stored;
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

      completeRegistration: async () => true,
      markReview: async () => true
    }
  };

  return { dependencies, calls, windows };
}

Deno.test("Register action never exposes joining URL", async () => {
  const { dependencies, windows } = setup();

  const result = await handleMemberAction(
    "register", "local-session", dependencies
  );

  assert(result.status === "existing");
  assert(!("join_url" in result));
  assert(windows.length === 1);
  assert(windows[0] === false);
});

Deno.test("Join action returns the authorized individual link", async () => {
  const { dependencies, windows, calls } = setup();

  const result = await handleMemberAction(
    "join", "local-session", dependencies
  );

  assert(result.status === "ready");
  assert("join_url" in result);
  assert(result.join_url === stored.zoom_join_url);
  assert(windows.length === 2);
  assert(windows.every(value => value === true));
  assert(calls.create === 0);
});

Deno.test("Early joining is rejected before registrant lookup", async () => {
  const { dependencies, calls } = setup();

  dependencies.authorize = async () => {
    throw new Error("JOIN_TOO_EARLY");
  };

  await expectError(
    () => handleMemberAction(
      "join", "local-session", dependencies
    ),
    "JOIN_TOO_EARLY"
  );

  assert(calls.find === 0);
  assert(calls.claim === 0);
  assert(calls.create === 0);
});

Deno.test("Unauthorized registration cannot access stored records", async () => {
  const { dependencies, calls } = setup();

  dependencies.authorize = async () => {
    throw new Error("ZOOM_ACCESS_DENIED");
  };

  await expectError(
    () => handleMemberAction(
      "register", "local-session", dependencies
    ),
    "ZOOM_ACCESS_DENIED"
  );

  assert(calls.find === 0);
  assert(calls.claim === 0);
  assert(calls.create === 0);
});

Deno.test("Revoked access during joining prevents link disclosure", async () => {
  const { dependencies } = setup();

  let checks = 0;

  dependencies.authorize = async () => {
    checks++;

    if (checks === 2) {
      throw new Error("ZOOM_ACCESS_DENIED");
    }

    return identity;
  };

  await expectError(
    () => handleMemberAction(
      "join", "local-session", dependencies
    ),
    "ZOOM_ACCESS_DENIED"
  );

  assert(checks === 2);
});

Deno.test("Changed member email prevents link disclosure", async () => {
  const { dependencies } = setup();

  let checks = 0;

  dependencies.authorize = async () => {
    checks++;

    return checks === 1
      ? identity
      : { ...identity, email: "changed@example.com" };
  };

  await expectError(
    () => handleMemberAction(
      "join", "local-session", dependencies
    ),
    "REGISTRATION_IDENTITY_CHANGED"
  );
});

Deno.test("Replaced meeting prevents link disclosure", async () => {
  const { dependencies } = setup();

  let checks = 0;

  dependencies.authorize = async () => {
    checks++;

    return checks === 1
      ? identity
      : { ...identity, zoom_meeting_id: "90000000002" };
  };

  await expectError(
    () => handleMemberAction(
      "join", "local-session", dependencies
    ),
    "REGISTRATION_IDENTITY_CHANGED"
  );
});

Deno.test("Changed registration prevents link disclosure", async () => {
  const { dependencies } = setup();

  let checks = 0;

  dependencies.authorize = async () => {
    checks++;

    return checks === 1
      ? identity
      : { ...identity, registration_id: "another-registration" };
  };

  await expectError(
    () => handleMemberAction(
      "join", "local-session", dependencies
    ),
    "REGISTRATION_IDENTITY_CHANGED"
  );
});

Deno.test("Missing final registrant blocks joining", async () => {
  const { dependencies } = setup();

  let reads = 0;

  dependencies.registration.findRegistrant = async () => {
    reads++;
    return reads === 1 ? stored : null;
  };

  await expectError(
    () => handleMemberAction(
      "join", "local-session", dependencies
    ),
    "REGISTRATION_REVIEW_REQUIRED"
  );
});

Deno.test("Another member's final stored link is rejected", async () => {
  const { dependencies } = setup();

  let reads = 0;

  dependencies.registration.findRegistrant = async () => {
    reads++;

    return reads === 1
      ? stored
      : {
          ...stored,
          registered_email: "another@example.com"
        };
  };

  await expectError(
    () => handleMemberAction(
      "join", "local-session", dependencies
    ),
    "REGISTRATION_REVIEW_REQUIRED"
  );
});