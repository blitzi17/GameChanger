/// <reference lib="deno.ns" />

import { addZoomMeetingRegistrant } from "../functions/zoom/meeting-registrant.ts";

Deno.test("Zoom registrant API returns an individual joining link", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (_input, init) => {
      if (init?.method !== "POST") {
        throw new Error("Expected a POST request.");
      }

      const body = JSON.parse(String(init.body));

      if (
        body.email !== "member@example.com" ||
        body.first_name !== "Juan" ||
        body.last_name !== "Dela Cruz"
      ) {
        throw new Error("Incorrect Zoom registrant information.");
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            registrant_id: "mock-registrant-id",
            join_url: "https://zoom.us/j/mock-individual-link"
          }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" }
          }
        )
      );
    };

    const result = await addZoomMeetingRegistrant(
      "mock-access-token",
      "123456789",
      {
        email: "member@example.com",
        first_name: "Juan",
        last_name: "Dela Cruz"
      }
    );

    if (
      result.registrant_id !== "mock-registrant-id" ||
      result.join_url !== "https://zoom.us/j/mock-individual-link"
    ) {
      throw new Error("Incorrect Zoom registrant response.");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});


Deno.test("Rejects missing Zoom registrant information", async () => {
  const invalidMembers = [
    { email: "", first_name: "Juan", last_name: "Dela Cruz" },
    { email: "member@example.com", first_name: "", last_name: "Dela Cruz" },
    { email: "member@example.com", first_name: "Juan", last_name: "" }
  ];

  for (const member of invalidMembers) {
    let rejected = false;

    try {
      await addZoomMeetingRegistrant(
        "mock-access-token",
        "123456789",
        member
      );
    } catch (error) {
      rejected =
        error instanceof Error &&
        error.message === "Missing required Zoom registrant information.";
    }

    if (!rejected) {
      throw new Error("Missing registrant information was accepted.");
    }
  }
});

Deno.test("Handles Zoom registrant API failures", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ message: "Registration failed" }),
          { status: 403 }
        )
      );

    let rejected = false;

    try {
      await addZoomMeetingRegistrant(
        "mock-access-token",
        "123456789",
        {
          email: "member@example.com",
          first_name: "Juan",
          last_name: "Dela Cruz"
        }
      );
    } catch (error) {
      rejected =
        error instanceof Error &&
        error.message === "Zoom registrant request failed: HTTP 403";
    }

    if (!rejected) {
      throw new Error("Zoom API failure was not handled correctly.");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Rejects incomplete Zoom registration responses", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            registrant_id: "mock-registrant-id"
          }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" }
          }
        )
      );

    let rejected = false;

    try {
      await addZoomMeetingRegistrant(
        "mock-access-token",
        "123456789",
        {
          email: "member@example.com",
          first_name: "Juan",
          last_name: "Dela Cruz"
        }
      );
    } catch (error) {
      rejected =
        error instanceof Error &&
        error.message === "Zoom did not return complete registrant details.";
    }

    if (!rejected) {
      throw new Error("Incomplete Zoom response was accepted.");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
