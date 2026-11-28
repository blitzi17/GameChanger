/// <reference lib="deno.ns" />

import {
  getZoomAccessToken
} from "../functions/_shared/zoom-auth.ts";

const credentials = {
  accountId: "local-test-account",
  clientId: "local-test-client",
  clientSecret: "local-test-secret"
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

Deno.test("Zoom OAuth returns token and scopes", async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));

    assert(url.origin === "https://zoom.us");
    assert(url.pathname === "/oauth/token");

    assert(
      url.searchParams.get("grant_type") ===
      "account_credentials"
    );

    assert(
      url.searchParams.get("account_id") ===
      credentials.accountId
    );

    assert(init?.method === "POST");

    assert(
      new Headers(init?.headers).get("Authorization") ===
      "Basic " + btoa(
        `${credentials.clientId}:${credentials.clientSecret}`
      )
    );

    return new Response(JSON.stringify({
      access_token: "mock-access-token",
      scope: "scope-one scope-two"
    }), { status: 200 });
  };

  const result = await getZoomAccessToken(
    credentials,
    mockFetch
  );

  assert(result.accessToken === "mock-access-token");
  assert(result.scopes.length === 2);
});

Deno.test("Zoom OAuth rejects missing credentials", async () => {
  const mockFetch: typeof fetch = async () => {
    throw new Error("Unexpected network request");
  };

  await expectError(
    () => getZoomAccessToken({
      ...credentials,
      clientSecret: ""
    }, mockFetch),
    "ZOOM_NOT_CONFIGURED"
  );
});

Deno.test("Zoom OAuth handles rejected credentials", async () => {
  const mockFetch: typeof fetch = async () =>
    new Response("Unauthorized", { status: 401 });

  await expectError(
    () => getZoomAccessToken(credentials, mockFetch),
    "ZOOM_AUTH_FAILED"
  );
});

Deno.test("Zoom OAuth rejects missing access token", async () => {
  const mockFetch: typeof fetch = async () =>
    new Response(JSON.stringify({}), { status: 200 });

  await expectError(
    () => getZoomAccessToken(credentials, mockFetch),
    "ZOOM_INVALID_TOKEN"
  );
});

Deno.test("Zoom OAuth rejects malformed JSON", async () => {
  const mockFetch: typeof fetch = async () =>
    new Response("Invalid JSON", { status: 200 });

  await expectError(
    () => getZoomAccessToken(credentials, mockFetch),
    "ZOOM_INVALID_TOKEN"
  );
});