/// <reference lib="deno.ns" />

import {
  validateZoomRegistrationEligibility,
  type ZoomRegistrationEligibility
} from "../functions/zoom/registration-eligibility.ts";

const valid: ZoomRegistrationEligibility = {
  payment_status: "PAID",
  zoom_access_released: true,
  registration_id: "registration-1",
  registration_session_id: "session-1",
  requested_session_id: "session-1",
  registered_email: "member@example.com",
  account_status: "Active",
  role: "MEMBER",
  session_status: "Upcoming"
};

function expectAllowed(
  changes: Partial<ZoomRegistrationEligibility> = {}
) {
  validateZoomRegistrationEligibility({
    ...valid,
    ...changes
  });
}

function expectRejected(
  changes: Partial<ZoomRegistrationEligibility>
) {
  let rejected = false;

  try {
    expectAllowed(changes);
  } catch {
    rejected = true;
  }

  if (!rejected) {
    throw new Error(
      `Expected eligibility rejection: ${JSON.stringify(changes)}`
    );
  }
}

Deno.test("Allows eligible paid, free and waived registrations", () => {
  for (const status of ["PAID", "FREE", "WAIVED"]) {
    expectAllowed({ payment_status: status });
  }
});

Deno.test("Rejects unpaid or pending registrations", () => {
  for (const status of ["UNPAID", "PENDING_PAYMENT"]) {
    expectRejected({ payment_status: status });
  }
});

Deno.test("Rejects registrations without released Zoom access", () => {
  expectRejected({ zoom_access_released: false });
});

Deno.test("Rejects registration belonging to another session", () => {
  expectRejected({
    registration_session_id: "different-session"
  });
});

Deno.test("Rejects inactive or non-member accounts", () => {
  expectRejected({ account_status: "Inactive" });
  expectRejected({ role: "HR_ADMIN" });
  expectRejected({ account_status: "Suspended" });
});

Deno.test("Rejects missing member identity", () => {
  expectRejected({ registration_id: "" });
  expectRejected({ registered_email: " " });
});

Deno.test("Rejects cancelled, draft and completed sessions", () => {
  for (const status of ["Cancelled", "Draft", "Completed"]) {
    expectRejected({ session_status: status });
  }
});
