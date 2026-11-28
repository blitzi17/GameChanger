/// <reference lib="deno.ns" />

import {
  buildExistingMeetingUpdatePayload,
  buildNewMeetingPayload,
} from "./meeting-payload.ts";

// ════════════════════════════════════════════════════════════════════
//  GameChanger — "zoom" Edge Function  (Supabase → Edge Functions)
//
//  Keeps the Zoom keys on the server. The website calls it with:
//    { action: "upsert_meeting",  session_id }  create / update the Zoom meeting
//    { action: "delete_meeting",  session_id }  when a session is cancelled
//    { action: "sync_attendance", session_id }  pull the participant report
//    { action: "host_link", session_id }        link that starts the meeting as host
//    { action: "status" }                       is Zoom connected? (setup check)
//    add  force: true  to upsert_meeting to replace an old hand-pasted link
//
//  Only signed-in admins can use it: every database call below runs with
//  the caller's own login, and the SQL functions (12_session_fixes.sql)
//  refuse anyone who is not an admin.
//
//  Secrets to set (Edge Functions → Secrets):
//    ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
//  (SUPABASE_URL and SUPABASE_ANON_KEY are provided automatically.)
// ════════════════════════════════════════════════════════════════════
import { buildAttendanceRows } from "./attendance-report.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

// What each feature needs. Zoom has two naming styles (new "granular" and old "classic");
// either one is enough.
const NEEDS: Record<string, { label: string; add: string; any: string[] }> = {
  create: {
    label: "create meetings",
    add: "meeting:write:meeting:admin",
    any: [
      "meeting:write:meeting:admin",
      "meeting:write:meeting",
      "meeting:write:admin",
      "meeting:write",
    ],
  },
  update: {
    label: "update meetings",
    add: "meeting:update:meeting:admin",
    any: [
      "meeting:update:meeting:admin",
      "meeting:update:meeting",
      "meeting:write:admin",
      "meeting:write",
    ],
  },
  remove: {
    label: "delete meetings",
    add: "meeting:delete:meeting:admin",
    any: [
      "meeting:delete:meeting:admin",
      "meeting:delete:meeting",
      "meeting:write:admin",
      "meeting:write",
    ],
  },
  read: {
    label: "view meetings (Start button)",
    add: "meeting:read:meeting:admin",
    any: [
      "meeting:read:meeting:admin",
      "meeting:read:meeting",
      "meeting:read:admin",
      "meeting:read",
    ],
  },
  report: {
    label: "attendance report",
    add: "report:read:list_meeting_participants:admin",
    any: ["report:read:list_meeting_participants:admin", "report:read:admin"],
  },
};
let lastScopes = "";

async function zoomToken(
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const id = Deno.env.get("ZOOM_ACCOUNT_ID"),
    cid = Deno.env.get("ZOOM_CLIENT_ID"),
    sec = Deno.env.get("ZOOM_CLIENT_SECRET");
  if (!id || !cid || !sec) throw new Error("ZOOM_NOT_CONFIGURED");
  const res = await fetcher(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${
      encodeURIComponent(id)
    }`,
    {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${cid}:${sec}`) },
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      "Zoom rejected the credentials: " +
        (data.reason || data.error || res.status),
    );
  }
  lastScopes = String(data.scope || "");
  return data.access_token;
}
function missingScopes() {
  const have = new Set(lastScopes.split(/\s+/).filter(Boolean));
  return Object.entries(NEEDS).filter(([, n]) =>
    !n.any.some((x) => have.has(x))
  )
    .map(([key, n]) => ({ key, label: n.label, add: n.add }));
}

async function zoom(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  fetcher: typeof fetch = fetch,
) {
  const res = await fetcher("https://api.zoom.us/v2" + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data.message || `Zoom error ${res.status}`) as
      & Error
      & { status?: number; code?: number };
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

// Zoom wants local time + a timezone
function manilaLocal(iso: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${
    p.hour === "24" ? "00" : p.hour
  }:${p.minute}:${p.second}`;
}

export async function handleZoomRequest(
  req: Request,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Not signed in." }, 401);
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: { headers: { Authorization: auth }, fetch: fetcher },
      },
    );
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!serviceKey) {
      return json({ error: "server_not_configured" }, 500);
    }

    const adminDb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceKey,
      {
        global: { fetch: fetcher },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );

    const {
      data: { user: authenticatedUser },
      error: authenticationError,
    } = await sb.auth.getUser();

    if (authenticationError || !authenticatedUser) {
      return json({ error: "unauthorized" }, 401);
    }
    const { data: adminProfile, error: profileError } = await adminDb
      .from("profiles")
      .select("role, status")
      .eq("id", authenticatedUser.id)
      .maybeSingle();

    const { data: adminAccount, error: accountError } = await adminDb
      .from("users")
      .select("role, account_status")
      .eq("user_id", authenticatedUser.id)
      .maybeSingle();

    if (profileError || accountError) {
      return json(
        { error: "administrator_lookup_failed" },
        500,
      );
    }

    if (
      adminProfile?.role !== "admin" ||
      adminProfile?.status !== "Active" ||
      adminAccount?.role !== "HR_ADMIN" ||
      adminAccount?.account_status !== "Active"
    ) {
      return json({ error: "forbidden" }, 403);
    }
    const { action, session_id, force } = await req.json();
    if (!["status", "upsert_meeting", "delete_meeting", "sync_attendance", "host_link"].includes(action)) {
      return json({ error: "Unknown action." }, 400);
    }

    // ── setup check: are the secrets there and does Zoom accept them? ──
    if (action === "status") {
      const { data: u } = await sb.auth.getUser();
      if (!u?.user) return json({ error: "Not signed in." }, 401);
      await zoomToken(fetcher);
      const missing = missingScopes();
      return json({
        status: "connected",
        missing,
        can_create: !missing.some((m) => m.key === "create"),
      });
    }

    if (!session_id) return json({ error: "session_id is required." }, 400);

    // admin check + session details (raises for non-admins)
    const { data: s, error: sErr } = await sb.rpc("admin_session_for_zoom", {
      p_session: session_id,
    });
    if (sErr) {
      const missing = /function .* does not exist|Could not find the function/i
        .test(sErr.message);
      return json({
        error: missing
          ? "The database is missing the Zoom functions — run supabase/12_session_fixes.sql in the SQL Editor."
          : sErr.message,
        code: missing ? "sql_missing" : "forbidden",
      }, 403);
    }
    if (!s) return json({ error: "Session not found." }, 404);

    const { data: verifiedMeeting, error: verifiedError } = await adminDb
      .from("zoom_verified_meetings")
      .select("zoom_meeting_id, lifecycle_status")
      .eq("session_id", session_id)
      .maybeSingle();

    if (verifiedError) {
      return json({ error: "meeting_lookup_failed" }, 500);
    }

    if (
      verifiedMeeting &&
      (
        String(s.zoom_meeting_id) !==
          verifiedMeeting.zoom_meeting_id ||
        s.zoom_auto_created !== true
      )
    ) {
      return json(
        { error: "meeting_identity_review_required" },
        409,
      );
    }

    if (
      verifiedMeeting &&
      verifiedMeeting.lifecycle_status !== "ACTIVE" &&
      (action === "upsert_meeting" || action === "host_link")
    ) {
      return json(
        { error: "meeting_lifecycle_review_required" },
        409,
      );
    }

    if (
      action === "upsert_meeting" &&
      !["Draft", "Upcoming", "Live"].includes(s.status)
    ) {
      return json({ error: "session_not_available" }, 409);
    }
    if (action === "delete_meeting") {
      if (s.status !== "Cancelled") {
        return json(
          { error: "session_must_be_cancelled" },
          409,
        );
      }

      if (!s.zoom_auto_created || !s.zoom_meeting_id) {
        return json({ status: "nothing" });
      }

      if (verifiedMeeting?.lifecycle_status === "RETIRED") {
        return json({ status: "deleted" });
      }
    }

    if (action === "sync_attendance") {
      if (!s.zoom_meeting_id) {
        return json({ status: "no_meeting", imported: 0 });
      }
      if (!/^\d+$/.test(String(s.zoom_meeting_id))) {
        return json({ error: "meeting_identity_review_required" }, 409);
      }
      const end = typeof s.end === "string" ? Date.parse(s.end) : NaN;
      if (!["Upcoming", "Live", "Completed"].includes(s.status) ||
          !Number.isFinite(end) || end > Date.now()) {
        return json({ error: "session_not_ready_for_attendance" }, 409);
      }
      if (verifiedMeeting && verifiedMeeting.lifecycle_status !== "ACTIVE") {
        return json({ error: "meeting_lifecycle_review_required" }, 409);
      }
    }

    const token = await zoomToken(fetcher);

    // ── create or update the meeting ──
    if (action === "upsert_meeting") {
      if (s.zoom_join_url && !s.zoom_auto_created && !force) {
        return json({ status: "manual", join_url: s.zoom_join_url }); // an admin pasted a link — leave it alone
      }
      if (!s.start) {
        return json({
          error: "Set the session date and time first.",
          code: "no_date",
        }, 400);
      }
      const payload = {
        topic: s.title,
        type: 2,
        start_time: manilaLocal(s.start),
        timezone: "Asia/Manila",
        duration: s.duration,
        agenda: (s.description || "").slice(0, 2000),
        settings: {
          join_before_host: false,
          waiting_room: true,
          mute_upon_entry: true,
          approval_type: 2,
        },
      };

      if (s.zoom_auto_created && s.zoom_meeting_id) {
        try {
          const updatePayload = buildExistingMeetingUpdatePayload(payload);

          await zoom(
            token,
            "PATCH",
            `/meetings/${s.zoom_meeting_id}`,
            updatePayload,
            fetcher,
          );

          return json({ status: "updated", join_url: s.zoom_join_url });
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;

          if (verifiedMeeting) {
            return json(
              { error: "meeting_replacement_review_required" },
              409,
            );
          }
        }
      }

      const authenticationProfileId = Deno.env.get(
        "ZOOM_AUTHENTICATION_PROFILE_ID",
      );

      const newMeetingPayload = buildNewMeetingPayload(
        payload,
        authenticationProfileId ?? "",
      );

      const { data: claimToken, error: claimError } = await adminDb.rpc(
        "zoom_claim_meeting_creation",
        {
          p_admin_id: authenticatedUser.id,
          p_session: session_id,
          p_expected_meeting_id: s.zoom_meeting_id == null
            ? null
            : String(s.zoom_meeting_id),
        },
      );
      if (claimError || typeof claimToken !== "string" || !claimToken) {
        return json({ error: "meeting_creation_unavailable" }, 409);
      }

      let externalMeetingId: string | null = null;
      try {
        const m = await zoom(
          token,
          "POST",
          "/users/me/meetings",
          newMeetingPayload,
          fetcher,
        );
        if (typeof m.id === "number" || typeof m.id === "string") {
          const id = String(m.id);
          if (/^\d+$/.test(id)) externalMeetingId = id;
        }
        if (!externalMeetingId || typeof m.join_url !== "string") {
          throw new Error("Invalid meeting response");
        }
        const { data: completed, error: completionError } = await adminDb.rpc(
          "zoom_complete_meeting_creation",
          {
            p_admin_id: authenticatedUser.id,
            p_session: session_id,
            p_claim_token: claimToken,
            p_meeting_id: externalMeetingId,
            p_join_url: m.join_url,
            p_passcode: m.password ?? null,
            p_authentication_profile_id: authenticationProfileId?.trim() ?? "",
          },
        );
        if (completionError || completed !== true) {
          throw new Error("Meeting completion failed");
        }
        return json({ status: "created", join_url: m.join_url });
      } catch (_error) {
        // Never retry the external POST automatically. A timeout may hide success.
        try {
          await adminDb.rpc("zoom_mark_meeting_creation_review", {
            p_session: session_id,
            p_claim_token: claimToken,
            p_external_meeting_id: externalMeetingId,
          });
        } catch (_reviewError) {
          // The durable claim still blocks another creation attempt.
        }
        return json({ error: "meeting_creation_review_required" }, 409);
      }
    }

    // ── host link: lets the admin start the meeting as host with one click ──
    if (action === "host_link") {
      if (!s.zoom_join_url) {
        return json({
          error: "This session has no Zoom meeting yet. Click Generate first.",
          code: "no_meeting",
        }, 400);
      }
      if (!s.zoom_auto_created || !s.zoom_meeting_id) {
        return json({ status: "join", url: s.zoom_join_url });
      }
      try {
        const m = await zoom(
          token,
          "GET",
          `/meetings/${s.zoom_meeting_id}`,
          undefined,
          fetcher,
        );
        return json({ status: "host", url: m.start_url || s.zoom_join_url });
      } catch (_e) {
        return json({ status: "join", url: s.zoom_join_url }); // no "view meeting" permission → normal join link
      }
    }

    // ── delete the meeting (session cancelled) ──
    if (action === "delete_meeting") {
      if (s.status !== "Cancelled") {
        return json(
          { error: "session_must_be_cancelled" },
          409,
        );
      }

      if (!s.zoom_auto_created || !s.zoom_meeting_id) {
        return json({ status: "nothing" });
      }

      if (verifiedMeeting?.lifecycle_status === "RETIRED") {
        return json({ status: "deleted" });
      }

      try {
        await zoom(
          token,
          "DELETE",
          `/meetings/${s.zoom_meeting_id}`,
          undefined,
          fetcher,
        );
      } catch (e) {
        const failure = e as { status?: number; code?: number };
        if (
          failure.status !== 404 ||
          (verifiedMeeting && failure.code !== 3001)
        ) {
          throw e;
        }
      }

      if (verifiedMeeting) {
        const { data: retired, error: retirementError } = await adminDb.rpc(
          "zoom_retire_verified_meeting",
          {
            p_admin_id: authenticatedUser.id,
            p_session: session_id,
            p_expected_meeting_id: String(s.zoom_meeting_id),
          },
        );

        if (retirementError || retired !== true) {
          return json(
            { error: "meeting_retirement_review_required" },
            409,
          );
        }

        return json({ status: "deleted" });
      }

      // Preserve existing legacy meeting cleanup.
      const { error: cleanupError } = await sb.rpc("admin_set_zoom_meeting", {
        p_session: session_id,
        p_join_url: null,
        p_meeting_id: null,
        p_passcode: null,
      });

      if (cleanupError) {
        return json(
          { error: "meeting_cleanup_review_required" },
          409,
        );
      }

      return json({ status: "deleted" });
    }

    // Pull all report pages before importing any attendance evidence.
    if (action === "sync_attendance") {
      const participants: unknown[] = [];
      const seenTokens = new Set<string>();
      let next = "";
      try {
        do {
          if (seenTokens.size >= 100) {
            return json({ error: "attendance_report_page_limit" }, 502);
          }
          const page = await zoom(
            token, "GET",
            `/report/meetings/${encodeURIComponent(String(s.zoom_meeting_id))}/participants?page_size=300${
              next ? `&next_page_token=${encodeURIComponent(next)}` : ""
            }`,
            undefined, fetcher,
          );
          if (!Array.isArray(page.participants) ||
              (page.next_page_token != null && typeof page.next_page_token !== "string")) {
            return json({ error: "invalid_attendance_report" }, 502);
          }
          participants.push(...page.participants);
          next = page.next_page_token ?? "";
          if (next && seenTokens.has(next)) {
            return json({ error: "attendance_report_pagination_loop" }, 502);
          }
          if (next) seenTokens.add(next);
        } while (next);
      } catch (e) {
        if ((e as { status?: number }).status === 404 && seenTokens.size === 0) {
          return json({ status: "no_report", imported: 0 });
        }
        throw e;
      }
      let rows;
      try {
        rows = buildAttendanceRows(participants);
      } catch (_error) {
        return json({ error: "invalid_attendance_report" }, 502);
      }
      if (!rows.length) return json({ status: "no_report", imported: 0 });
      const { data: n, error } = await adminDb.rpc("zoom_import_verified_attendance", {
        p_admin_id: authenticatedUser.id,
        p_session: session_id,
        p_expected_meeting_id: String(s.zoom_meeting_id),
        p_rows: rows,
      });
      if (error) return json({ error: "attendance_import_review_required" }, 409);
      if (typeof n !== "number" || n !== rows.length) {
        return json({ error: "attendance_import_review_required" }, 502);
      }
      return json({ status: "imported", imported: n });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (msg === "ZOOM_NOT_CONFIGURED") {
      return json({
        error:
          "The Zoom secrets are missing: add ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET in Supabase → Edge Functions → Secrets.",
        code: "secrets_missing",
      }, 503);
    }
    if (msg.startsWith("Zoom rejected the credentials")) {
      return json({
        error: msg +
          " — check the three Zoom secrets and that the Zoom app is Activated.",
        code: "bad_credentials",
      }, 502);
    }
    if (/scope|4711|does not contain scopes/i.test(msg)) {
      return json({
        error: "The Zoom app is missing a permission (scope): " + msg +
          " — add the meeting scopes listed in ZOOM_SETUP.md.",
        code: "missing_scope",
      }, 502);
    }
    return json({ error: msg, code: "zoom_error" }, 502);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleZoomRequest(req));
}
