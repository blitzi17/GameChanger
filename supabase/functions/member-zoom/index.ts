/// <reference lib="deno.ns" />

import {
  createClient
} from "https://esm.sh/@supabase/supabase-js@2";

import {
  handleMemberAction
} from "./member-actions.ts";

import type {
  MemberIdentity
} from "./registration-service.ts";

import {
  createRegistrationDependencies
} from "./registration-dependencies.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validIdentity(
  data: unknown
): data is MemberIdentity {
  if (!data || typeof data !== "object") {
    return false;
  }

  const value = data as Record<string, unknown>;

  return [
    "registration_id",
    "zoom_meeting_id",
    "email",
    "first_name",
    "last_name"
  ].every(
    key =>
      typeof value[key] === "string" &&
      (value[key] as string).trim().length > 0
  );
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const authorization =
      req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return json({ error: "Not signed in." }, 401);
    }

    const accessToken = authorization.slice(7).trim();

    if (!accessToken) {
      return json({ error: "Not signed in." }, 401);
    }

    const supabaseUrl =
      Deno.env.get("SUPABASE_URL");

    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY");

    const serviceKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json({
        error: "Server configuration error."
      }, 503);
    }

    const member = createClient(
      supabaseUrl,
      anonKey,
      {
        global: {
          headers: {
            Authorization: authorization
          }
        },
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    const {
      data: { user },
      error: authError
    } = await member.auth.getUser(accessToken);

    if (authError || !user) {
      return json({
        error: "Invalid authentication."
      }, 401);
    }

    const body = await req.json().catch(() => null);

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      return json({
        error: "Invalid request body."
      }, 400);
    }

    const { action, session_id } = body;

    if (
      !["register", "join"].includes(action) ||
      typeof session_id !== "string" ||
      !UUID_PATTERN.test(session_id)
    ) {
      return json({
        error: "Invalid request."
      }, 400);
    }

    // The service-role client is server-side only.
    // Do not attach the caller's Authorization header.

    const admin = createClient(
      supabaseUrl,
      serviceKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    const registration =
      createRegistrationDependencies(admin, {
        accountId:
          Deno.env.get("ZOOM_ACCOUNT_ID") ?? "",
        clientId:
          Deno.env.get("ZOOM_CLIENT_ID") ?? "",
        clientSecret:
          Deno.env.get("ZOOM_CLIENT_SECRET") ?? ""
      });

    const result = await handleMemberAction(
      action,
      session_id,
      {
        registration,

        async authorize(sessionId, requireJoinWindow) {
          const rpcName = requireJoinWindow
            ? "member_verified_zoom_join_eligibility"
            : "member_verified_zoom_eligibility";

          // Authorization always uses the member client.

          const { data, error } = await member.rpc(
            rpcName,
            { p_session: sessionId }
          );

          if (error) {
            if (
              error.code === "P0001" &&
              error.message.startsWith(
                "Joining opens 15 minutes"
              )
            ) {
              throw new Error("JOIN_TOO_EARLY");
            }

            if (error.code === "P0001") {
              throw new Error("ZOOM_ACCESS_DENIED");
            }

            throw new Error("AUTHORIZATION_CHECK_FAILED");
          }

          if (!validIdentity(data)) {
            throw new Error("INVALID_ELIGIBILITY");
          }

          // Require the confirmed authentication email
          // to agree with the member's database email.

          if (
            !user.email_confirmed_at ||
            !user.email ||
            user.email.trim().toLowerCase() !==
              data.email.trim().toLowerCase()
          ) {
            throw new Error("MEMBER_EMAIL_MISMATCH");
          }

          return data;
        }
      }
    );

    return json(result);

  } catch (error) {
    const code =
      error instanceof Error ? error.message : "";

    switch (code) {
      case "JOIN_TOO_EARLY":
        return json({
          error: "Joining opens 15 minutes before the scheduled start.",
          code: "join_too_early"
        }, 403);

      case "ZOOM_ACCESS_DENIED":
      case "MEMBER_EMAIL_MISMATCH":
      case "REGISTRATION_IDENTITY_CHANGED":
        return json({
          error: "Verified Zoom access is not authorized.",
          code: "access_denied"
        }, 403);

      case "REGISTRATION_UNAVAILABLE":
        return json({
          error: "Zoom registration is currently unavailable.",
          code: "registration_unavailable"
        }, 409);

      case "REGISTRATION_REVIEW_REQUIRED":
        return json({
          error: "Zoom registration requires review. Please contact the administrator.",
          code: "review_required"
        }, 409);

      default:
        return json({
          error: "Unable to process the Zoom request.",
          code: "zoom_request_failed"
        }, 500);
    }
  }
});