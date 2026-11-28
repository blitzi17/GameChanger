/// <reference lib="deno.ns" />
import { handleZoomRequest } from "../functions/zoom/index.ts";

function equal(actual: unknown, expected: unknown, label = "value") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}
const adminId = "10000000-0000-0000-0000-000000000001";
const sessionId = "20000000-0000-0000-0000-000000000001";
const meetingId = "90000000001";
const joinUrl = `https://zoom.us/j/${meetingId}`;
const env = {
  SUPABASE_URL: "https://mock-supabase.invalid",
  SUPABASE_ANON_KEY: "mock-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "mock-service-key",
  ZOOM_ACCOUNT_ID: "mock-account",
  ZOOM_CLIENT_ID: "mock-client",
  ZOOM_CLIENT_SECRET: "mock-secret",
  ZOOM_AUTHENTICATION_PROFILE_ID: "mock-profile",
};
type Options = {
  noAuth?: boolean;
  invalidAuth?: boolean;
  member?: boolean;
  inactive?: boolean;
  status?: string;
  existing?: boolean;
  lifecycle?: string;
  mismatch?: boolean;
  legacy?: boolean;
  patch404?: boolean;
  createFailure?: boolean;
  storageFailure?: boolean;
  retirementFailure?: boolean;
  deleteFailure?: boolean;
  cleanupFailure?: boolean;
  claimDenied?: boolean;
  claimError?: boolean;
  futureEnd?: boolean;
  reportPages?: { data: unknown; status?: number }[];
  importFailure?: boolean;
};
async function scenario(action: string, opts: Options = {}) {
  const saved = Object.entries(env).map(([k]) => [k, Deno.env.get(k)] as const);
  const calls: { key: string; body: any; auth: string | null }[] = [];
  const unexpected: string[] = [];
  let pageIndex = 0;
  const pageTokens: (string | null)[] = [];
  const existing = opts.existing || opts.legacy || !!opts.lifecycle;
  const session = {
    session_id: sessionId,
    title: "Mock session",
    description: "",
    start: "2030-01-01T08:00:00Z",
    end: opts.futureEnd
      ? "2099-01-01T09:00:00Z"
      : "2020-01-01T09:00:00Z",
    duration: 60,
    status: opts.status ?? "Upcoming",
    zoom_meeting_id: existing ? meetingId : null,
    zoom_join_url: existing ? joinUrl : null,
    zoom_auto_created: !!existing,
  };
  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const mock: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    const body = req.body ? await req.json() : null;
    calls.push({ key, body, auth: req.headers.get("Authorization") });
    if (url.hostname === "mock-supabase.invalid") {
      switch (key) {
        case "GET /auth/v1/user":
          return opts.invalidAuth
            ? reply({ message: "Invalid token" }, 401)
            : reply({
              id: adminId,
              aud: "authenticated",
              role: "authenticated",
              email: "admin@example.com",
              app_metadata: {},
              user_metadata: {},
            });
        case "GET /rest/v1/profiles":
          return reply([{
            role: opts.member ? "member" : "admin",
            status: opts.inactive ? "Inactive" : "Active",
          }]);
        case "GET /rest/v1/users":
          return reply([{
            role: opts.member ? "MEMBER" : "HR_ADMIN",
            account_status: opts.inactive ? "Inactive" : "Active",
          }]);
        case "POST /rest/v1/rpc/admin_session_for_zoom":
          return reply(session);
        case "GET /rest/v1/zoom_verified_meetings":
          return reply(
            existing && !opts.legacy
              ? [{
                zoom_meeting_id: opts.mismatch ? "999" : meetingId,
                lifecycle_status: opts.lifecycle ?? "ACTIVE",
              }]
              : [],
          );
        case "POST /rest/v1/rpc/zoom_claim_meeting_creation":
          return opts.claimError
            ? reply({ message: "Claim error", code: "P0001" }, 400)
            : reply(opts.claimDenied ? null : claimToken);
        case "POST /rest/v1/rpc/zoom_complete_meeting_creation":
          return reply(!opts.storageFailure);
        case "POST /rest/v1/rpc/zoom_mark_meeting_creation_review":
          return reply(true);
        case "POST /rest/v1/rpc/zoom_retire_verified_meeting":
          return reply(!opts.retirementFailure);
        case "POST /rest/v1/rpc/zoom_import_verified_attendance":
          return opts.importFailure
            ? reply({ message: "Mock import failure", code: "P0001" }, 400)
            : reply(body.p_rows.length);
        case "POST /rest/v1/rpc/admin_set_zoom_meeting":
          return opts.cleanupFailure
            ? reply({ message: "Mock cleanup failure", code: "P0001" }, 400)
            : new Response(null, { status: 204 });
      }
    } else if (url.hostname === "zoom.us" && key === "POST /oauth/token") {
      return reply({
        access_token: "mock-access-token",
        scope: "meeting:write:admin",
      });
    } else if (url.hostname === "api.zoom.us") {
      if (key === `GET /v2/report/meetings/${meetingId}/participants`) {
        pageTokens.push(url.searchParams.get("next_page_token"));
        const page = opts.reportPages?.[pageIndex++];
        if (page) return reply(page.data, page.status ?? 200);
        throw new Error("Unexpected report page");
      }
      if (key === `GET /v2/meetings/${meetingId}`) {
        return reply({ id: meetingId, join_url: joinUrl });
      }

      if (key === "POST /v2/users/me/meetings") {
        return opts.createFailure
          ? reply({ message: "Mock creation failure" }, 500)
          : reply(
            { id: meetingId, join_url: joinUrl, password: "mock-pass" },
            201,
          );
      }
      if (key === `PATCH /v2/meetings/${meetingId}`) {
        return opts.patch404
          ? reply({ code: 3001, message: "Meeting missing" }, 404)
          : new Response(null, { status: 204 });
      }
      if (key === `DELETE /v2/meetings/${meetingId}`) {
        return opts.deleteFailure
          ? reply({ message: "Mock deletion failure" }, 500)
          : new Response(null, { status: 204 });
      }
    }
    unexpected.push(`${url.hostname} ${key}`);
    throw new Error("Unexpected mock request");
  };
  try {
    for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
    const headers = new Headers({ "Content-Type": "application/json" });
    if (!opts.noAuth) headers.set("Authorization", "Bearer mock-user-token");
    const res = await handleZoomRequest(
      new Request("https://local.invalid/zoom", {
        method: "POST",
        headers,
        body: JSON.stringify({ action, session_id: sessionId }),
      }),
      mock,
    );
    const body = await res.json();
    equal(unexpected, [], "unexpected HTTP requests");
    equal(res.headers.get("Cache-Control"), "no-store", "cache control");
    return { status: res.status, body, calls, pageTokens };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}
const oauth = "POST /oauth/token";
const create = "POST /v2/users/me/meetings";
const remove = `DELETE /v2/meetings/${meetingId}`;
const patch = `PATCH /v2/meetings/${meetingId}`;
const claimToken = "40000000-0000-0000-0000-000000000001";
const claim = "POST /rest/v1/rpc/zoom_claim_meeting_creation";
const store = "POST /rest/v1/rpc/zoom_complete_meeting_creation";
const review = "POST /rest/v1/rpc/zoom_mark_meeting_creation_review";
const directStore = "POST /rest/v1/rpc/zoom_store_verified_meeting";
const retire = "POST /rest/v1/rpc/zoom_retire_verified_meeting";
const cleanup = "POST /rest/v1/rpc/admin_set_zoom_meeting";
const cases: {
  name: string;
  action: string;
  opts: Options;
  status: number;
  result: string;
  required?: string[];
  forbidden?: string[];
}[] = [
  {
    name: "missing authentication",
    action: "status",
    opts: { noAuth: true },
    status: 401,
    result: "Not signed in.",
    forbidden: [oauth],
  },
  {
    name: "invalid authentication",
    action: "status",
    opts: { invalidAuth: true },
    status: 401,
    result: "unauthorized",
    forbidden: [oauth],
  },
  {
    name: "member cannot check status",
    action: "status",
    opts: { member: true },
    status: 403,
    result: "forbidden",
    forbidden: [oauth],
  },
  {
    name: "inactive admin denied",
    action: "upsert_meeting",
    opts: { inactive: true },
    status: 403,
    result: "forbidden",
    forbidden: [oauth, create],
  },
  {
    name: "new verified meeting",
    action: "upsert_meeting",
    opts: {},
    status: 200,
    result: "created",
    required: [oauth, claim, create, store],
    forbidden: [review],
  },
  {
    name: "creation failure never stores",
    action: "upsert_meeting",
    opts: { createFailure: true },
    status: 409,
    result: "meeting_creation_review_required",
    required: [claim, create, review],
    forbidden: [store],
  },
  {
    name: "storage failure requires review",
    action: "upsert_meeting",
    opts: { storageFailure: true },
    status: 409,
    result: "meeting_creation_review_required",
    required: [claim, create, store, review],
  },
  {
    name: "duplicate claim blocks external creation",
    action: "upsert_meeting",
    opts: { claimDenied: true },
    status: 409,
    result: "meeting_creation_unavailable",
    required: [claim],
    forbidden: [create, store, review],
  },
  {
    name: "claim RPC failure blocks external creation",
    action: "upsert_meeting",
    opts: { claimError: true },
    status: 409,
    result: "meeting_creation_unavailable",
    required: [claim],
    forbidden: [create, store, review],
  },
  {
    name: "missing verified meeting not recreated",
    action: "upsert_meeting",
    opts: { existing: true, patch404: true },
    status: 409,
    result: "meeting_replacement_review_required",
    required: [patch],
    forbidden: [create, store],
  },
  {
    name: "retired meeting update denied",
    action: "upsert_meeting",
    opts: { lifecycle: "RETIRED" },
    status: 409,
    result: "meeting_lifecycle_review_required",
    forbidden: [oauth, patch],
  },
  {
    name: "review meeting host access denied",
    action: "host_link",
    opts: { lifecycle: "REVIEW_REQUIRED" },
    status: 409,
    result: "meeting_lifecycle_review_required",
    forbidden: [oauth],
  },
  {
    name: "meeting identity mismatch denied",
    action: "upsert_meeting",
    opts: { existing: true, mismatch: true },
    status: 409,
    result: "meeting_identity_review_required",
    forbidden: [oauth, patch],
  },
  {
    name: "upcoming meeting deletion denied",
    action: "delete_meeting",
    opts: { existing: true },
    status: 409,
    result: "session_must_be_cancelled",
    forbidden: [oauth, remove, retire],
  },
  {
    name: "cancelled verified meeting retired",
    action: "delete_meeting",
    opts: { existing: true, status: "Cancelled" },
    status: 200,
    result: "deleted",
    required: [remove, retire],
    forbidden: [cleanup],
  },
  {
    name: "external deletion failure never retires",
    action: "delete_meeting",
    opts: { existing: true, status: "Cancelled", deleteFailure: true },
    status: 502,
    result: "Mock deletion failure",
    required: [remove],
    forbidden: [retire, cleanup],
  },
  {
    name: "retirement failure requires review",
    action: "delete_meeting",
    opts: { existing: true, status: "Cancelled", retirementFailure: true },
    status: 409,
    result: "meeting_retirement_review_required",
    required: [remove, retire],
    forbidden: [cleanup],
  },
  {
    name: "already retired skips Zoom",
    action: "delete_meeting",
    opts: { lifecycle: "RETIRED", status: "Cancelled" },
    status: 200,
    result: "deleted",
    forbidden: [oauth, remove, retire, cleanup],
  },
  {
    name: "legacy deletion retains cleanup",
    action: "delete_meeting",
    opts: { legacy: true, status: "Cancelled" },
    status: 200,
    result: "deleted",
    required: [remove, cleanup],
    forbidden: [retire],
  },
  {
    name: "legacy cleanup failure requires review",
    action: "delete_meeting",
    opts: { legacy: true, status: "Cancelled", cleanupFailure: true },
    status: 409,
    result: "meeting_cleanup_review_required",
    required: [remove, cleanup],
    forbidden: [retire],
  },
];
for (const c of cases) {
  Deno.test(`admin integration: ${c.name}`, async () => {
    const r = await scenario(c.action, c.opts);
    equal(r.status, c.status, "HTTP status");
    equal(r.body.error ?? r.body.status, c.result, "response result");
    const keys = r.calls.map((x) => x.key);
    let last = -1;
    for (const key of c.required ?? []) {
      const i = keys.indexOf(key);
      if (i <= last) throw new Error(`Missing or out-of-order request: ${key}`);
      last = i;
    }
    for (const key of c.forbidden ?? []) {
      equal(keys.includes(key), false, `forbidden request ${key}`);
    }
    equal(keys.includes(directStore), false, "direct storage bypass");
    if (keys.includes(claim)) {
      const rpc = r.calls.find((x) => x.key === claim)!;
      equal(rpc.auth, "Bearer mock-service-key");
      equal(rpc.body.p_admin_id, adminId);
      equal(rpc.body.p_session, sessionId);
      equal(rpc.body.p_expected_meeting_id, null);
    }
    if (keys.includes(review)) {
      const rpc = r.calls.find((x) => x.key === review)!;
      equal(rpc.auth, "Bearer mock-service-key");
      equal(rpc.body.p_session, sessionId);
      equal(rpc.body.p_claim_token, claimToken);
      equal(
        rpc.body.p_external_meeting_id,
        c.opts.createFailure ? null : meetingId,
      );
    }
    if (keys.includes(store)) {
      const rpc = r.calls.find((x) => x.key === store)!;
      equal(rpc.auth, "Bearer mock-service-key", "storage authorization");
      equal(rpc.body.p_admin_id, adminId);
      equal(rpc.body.p_session, sessionId);
      equal(rpc.body.p_claim_token, claimToken);
      equal(rpc.body.p_meeting_id, meetingId);
      equal(rpc.body.p_join_url, joinUrl);
      equal(rpc.body.p_authentication_profile_id, "mock-profile");
      const settings = r.calls.find((x) => x.key === create)!.body.settings;
      equal(settings.meeting_authentication, true);
      equal(settings.authentication_option, "mock-profile");
      equal(settings.approval_type, 0);
    }
    if (keys.includes(retire)) {
      const rpc = r.calls.find((x) => x.key === retire)!;
      equal(rpc.auth, "Bearer mock-service-key", "retirement authorization");
      equal(rpc.body.p_admin_id, adminId);
      equal(rpc.body.p_expected_meeting_id, meetingId);
      equal(rpc.body.p_session, sessionId);
    }
  });
}


// Attendance-specific integration tests. All network calls use the existing mock.
const report = `GET /v2/report/meetings/${meetingId}/participants`;
const importRpc = "POST /rest/v1/rpc/zoom_import_verified_attendance";
const oldImportRpc = "POST /rest/v1/rpc/admin_import_zoom_attendance";
const ended: Options = { existing: true, status: "Completed" };
const participant = {
  user_email: " Member.A@example.com ", name: "Participant",
  join_time: "2020-01-01T08:00:00Z", leave_time: "2020-01-01T09:00:00Z",
  duration: 2880,
  status: "in_meeting",
};
const page = (participants: unknown[], next_page_token = "") =>
  ({ data: { participants, next_page_token } });

const attendanceCases: {
  id: string; name: string; opts: Options; status: number; result: string;
  pages: number; imports: number; tokens?: (string | null)[]; seconds?: number[];
}[] = [
  { id: "01", name: "non-admin denied", opts: { ...ended, member: true }, status: 403, result: "forbidden", pages: 0, imports: 0 },
  { id: "02", name: "future session denied", opts: { ...ended, status: "Upcoming", futureEnd: true }, status: 409, result: "session_not_ready_for_attendance", pages: 0, imports: 0 },
  { id: "03", name: "cancelled session denied", opts: { ...ended, status: "Cancelled" }, status: 409, result: "session_not_ready_for_attendance", pages: 0, imports: 0 },
  { id: "04", name: "meeting under review denied", opts: { ...ended, lifecycle: "REVIEW_REQUIRED" }, status: 409, result: "meeting_lifecycle_review_required", pages: 0, imports: 0 },
  { id: "05", name: "missing meeting", opts: { status: "Completed" }, status: 200, result: "no_meeting", pages: 0, imports: 0 },
  { id: "06", name: "unavailable report", opts: { ...ended, reportPages: [{ data: { message: "Report missing" }, status: 404 }] }, status: 200, result: "no_report", pages: 1, imports: 0 },
  { id: "07", name: "secure import", opts: { ...ended, reportPages: [page([participant])] }, status: 200, result: "imported", pages: 1, imports: 1, seconds: [2880] },
  { id: "08", name: "pagination and encoded token", opts: { ...ended, reportPages: [page([participant], "next+&=/ token"), page([participant, { ...participant, user_email: "other@example.com", duration: 600 }])] }, status: 200, result: "imported", pages: 2, imports: 1, tokens: [null, "next+&=/ token"], seconds: [2880, 600] },
  { id: "09", name: "repeated token rejected", opts: { ...ended, reportPages: [page([participant], "loop"), page([participant], "loop")] }, status: 502, result: "attendance_report_pagination_loop", pages: 2, imports: 0 },
  { id: "10", name: "malformed participant rejected", opts: { ...ended, reportPages: [page([participant, { ...participant, duration: -1 }])] }, status: 502, result: "invalid_attendance_report", pages: 1, imports: 0 },
  { id: "11", name: "import failure requires review", opts: { ...ended, reportPages: [page([participant])], importFailure: true }, status: 409, result: "attendance_import_review_required", pages: 1, imports: 1 },
  { id: "12", name: "exact seconds and missing emails preserved", opts: { ...ended, reportPages: [page([{ ...participant, duration: 2879 }, { ...participant, user_email: "", duration: 120 }])] }, status: 200, result: "imported", pages: 1, imports: 1, seconds: [2879, 120] },
];
for (const c of attendanceCases) {
  Deno.test(`EDGE-ATT-${c.id}: ${c.name}`, async () => {
    const r = await scenario("sync_attendance", c.opts);
    equal(r.status, c.status, "HTTP status");
    equal(r.body.error ?? r.body.status, c.result, "response result");
    const reports = r.calls.filter(x => x.key === report);
    const imports = r.calls.filter(x => x.key === importRpc);
    equal(reports.length, c.pages, "report requests");
    equal(imports.length, c.imports, "import requests");
    equal(r.calls.some(x => x.key === oldImportRpc), false, "legacy RPC");
    if (c.pages === 0) equal(r.calls.some(x => x.key === oauth), false, "no OAuth before rejection");
    if (c.tokens) equal(r.pageTokens, c.tokens, "decoded pagination tokens");
    if (imports.length) {
      const rpc = imports[0];
      equal(rpc.auth, "Bearer mock-service-key", "service authorization");
      equal(rpc.body.p_admin_id, adminId);
      equal(rpc.body.p_session, sessionId);
      equal(rpc.body.p_expected_meeting_id, meetingId);
      equal(rpc.body.p_rows[0].email, "member.a@example.com");
      equal(r.calls.indexOf(rpc) > r.calls.indexOf(reports[reports.length - 1]), true, "import after all pages");
      if (c.seconds) {
        equal(rpc.body.p_rows.map((x: { seconds: number }) => x.seconds), c.seconds);
        equal(r.body.imported, c.seconds.length);
      }
      if (c.id === "12") {
        equal(rpc.body.p_rows[0].minutes, 47);
        equal(rpc.body.p_rows[1].email, "");
      }
    }
  });
}
// Waiting room Edge Function integration tests.

Deno.test("EDGE-WAIT-01: only admitted duration imported", async () => {
  const waiting = {
    ...participant,
    status: "in_waiting_room",
    duration: 600,
  };

  const admitted = {
    ...participant,
    status: "in_meeting",
    duration: 2400,
  };

  const r = await scenario("sync_attendance", {
    ...ended,
    reportPages: [page([waiting, admitted])],
  });

  equal(r.status, 200);
  equal(r.body.status, "imported");

  const imports = r.calls.filter(x => x.key === importRpc);

  equal(imports.length, 1);
  equal(imports[0].body.p_rows.length, 1);
  equal(imports[0].body.p_rows[0].seconds, 2400);
});

Deno.test("EDGE-WAIT-02: waiting room only never imports", async () => {
  const r = await scenario("sync_attendance", {
    ...ended,
    reportPages: [
      page([{ ...participant, status: "in_waiting_room" }]),
    ],
  });

  equal(r.status, 200);
  equal(r.body.status, "no_report");
  equal(r.body.imported, 0);
  equal(r.calls.some(x => x.key === importRpc), false);
});

Deno.test("EDGE-WAIT-03: missing status prevents import", async () => {
  const r = await scenario("sync_attendance", {
    ...ended,
    reportPages: [
      page([{ ...participant, status: undefined }]),
    ],
  });

  equal(r.status, 502);
  equal(r.body.error, "invalid_attendance_report");
  equal(r.calls.some(x => x.key === importRpc), false);
});

Deno.test("EDGE-WAIT-04: unknown status prevents partial import", async () => {
  const r = await scenario("sync_attendance", {
    ...ended,
    reportPages: [
      page([participant], "next-page"),
      page([{ ...participant, status: "unknown_status" }]),
    ],
  });

  equal(r.status, 502);
  equal(r.body.error, "invalid_attendance_report");
  equal(r.calls.some(x => x.key === importRpc), false);
});

Deno.test("unsupported action rejected before external requests", async () => {
  const r = await scenario("recover_meeting");
  equal(r.status, 400);
  equal(r.body.error, "Unknown action.");
  equal(r.calls.some(x => x.key === oauth || x.key.startsWith("GET /v2/") || x.key.startsWith("POST /v2/")), false);
  equal(r.calls.some(x => x.key.includes("/rpc/")), false);
});
