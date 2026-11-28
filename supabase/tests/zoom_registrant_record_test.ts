/// <reference lib="deno.ns" />

import {
  reusableZoomRegistrantLink,
  type StoredZoomRegistrant,
  type ZoomRegistrantIdentity
} from "../functions/zoom/registrant-record.ts";

const record: StoredZoomRegistrant = {
  registration_id: "registration-1",
  zoom_meeting_id: "123456789",
  zoom_registrant_id: "zoom-registrant-1",
  registered_email: "member@example.com",
  zoom_join_url: "https://zoom.us/w/123456789?tk=example"
};

const identity: ZoomRegistrantIdentity = {
  registration_id: "registration-1",
  zoom_meeting_id: "123456789",
  email: "member@example.com"
};

Deno.test("Reuses a matching individual Zoom link", () => {
  const result = reusableZoomRegistrantLink(record, identity);

  if (result !== record.zoom_join_url) {
    throw new Error("Valid individual link was rejected.");
  }
});

Deno.test("Rejects another member's registration", () => {
  const result = reusableZoomRegistrantLink(record, {
    ...identity,
    registration_id: "registration-2"
  });

  if (result !== null) {
    throw new Error("Another registration was accepted.");
  }
});

Deno.test("Rejects links from a replaced meeting", () => {
  const result = reusableZoomRegistrantLink(record, {
    ...identity,
    zoom_meeting_id: "987654321"
  });

  if (result !== null) {
    throw new Error("Outdated meeting link was accepted.");
  }
});

Deno.test("Rejects a different email address", () => {
  const result = reusableZoomRegistrantLink(record, {
    ...identity,
    email: "someoneelse@example.com"
  });

  if (result !== null) {
    throw new Error("Email mismatch was accepted.");
  }
});

Deno.test("Matches email addresses case-insensitively", () => {
  const result = reusableZoomRegistrantLink(record, {
    ...identity,
    email: "MEMBER@EXAMPLE.COM"
  });

  if (result !== record.zoom_join_url) {
    throw new Error("Matching email was rejected.");
  }
});

Deno.test("Rejects invalid and non-Zoom URLs", () => {
  const invalidUrls = [
    "javascript:alert(1)",
    "http://zoom.us/j/123456789",
    "https://example.com/j/123456789",
    "https://zoom.us.evil.com/j/123456789",
    "not-a-url"
  ];

  for (const zoom_join_url of invalidUrls) {
    const result = reusableZoomRegistrantLink(
      { ...record, zoom_join_url },
      identity
    );

    if (result !== null) {
      throw new Error(`Unsafe URL was accepted: ${zoom_join_url}`);
    }
  }
});

Deno.test("Rejects missing registration data", () => {
  const incomplete: StoredZoomRegistrant = {
    ...record,
    zoom_registrant_id: ""
  };

  if (
    reusableZoomRegistrantLink(incomplete, identity) !== null ||
    reusableZoomRegistrantLink(null, identity) !== null
  ) {
    throw new Error("Incomplete registration was accepted.");
  }
});


Deno.test("Rejects Zoom URLs containing embedded credentials", () => {
  const result = reusableZoomRegistrantLink(
    {
      ...record,
      zoom_join_url: "https://someone:password@zoom.us/j/123456789"
    },
    identity
  );

  if (result !== null) {
    throw new Error(
      "Zoom URL containing embedded credentials was accepted."
    );
  }
});
