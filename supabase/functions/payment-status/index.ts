import { createAdminClient, createMemberClient } from "../_shared/supabase.ts";

const APP_URL = "https://game-changer-sigma.vercel.app";

const ALLOWED_ORIGINS = new Set([
  APP_URL,
  "https://game-changer-git-feature-proces-21fc05-karols-projects-95a784de.vercel.app",
]);

function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

function isValidDate(value: unknown): boolean {
  return (
    isNonEmptyString(value) &&
    Number.isFinite(Date.parse(value))
  );
}

// HITPAY_STATUS_RESPONSE_PROTECTION_V1

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") ?? "";

  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response(
      JSON.stringify({ error: "Origin not allowed." }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Vary": "Origin",
        },
      },
    );
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  function jsonResponse(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      {
        success: false,
        error: "Method not allowed.",
      },
      405,
    );
  }

  try {
    // ======================================================
    // 1. AUTHENTICATE THE USER
    // ======================================================

    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required.",
        },
        401,
      );
    }

    const supabase = createMemberClient(req);
    const admin = createAdminClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return jsonResponse(
        {
          success: false,
          error: "Please sign in first.",
        },
        401,
      );
    }

    // ======================================================
    // 2. VERIFY ACTIVE MEMBER AUTHORIZATION
    // ======================================================

    const {
      data: member,
      error: memberError,
    } = await admin
      .from("users")
      .select("user_id, role, account_status")
      .eq("user_id", user.id)
      .maybeSingle();

    if (memberError) {
      throw new Error(
        "Member authorization lookup failed.",
      );
    }

    if (
      !member ||
      member.role !== "MEMBER" ||
      member.account_status !== "Active"
    ) {
      return jsonResponse(
        {
          success: false,
          error: "An active member account is required.",
        },
        403,
      );
    }

    // ======================================================
    // 3. VALIDATE REQUEST BODY
    // ======================================================

    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return jsonResponse(
        {
          success: false,
          error: "Invalid request body.",
        },
        400,
      );
    }

    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body)
    ) {
      return jsonResponse(
        {
          success: false,
          error: "Invalid request body.",
        },
        400,
      );
    }

    const { order_reference } = body as Record<string, unknown>;

    const orderPattern =
      /^GC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      typeof order_reference !== "string" ||
      !orderPattern.test(order_reference)
    ) {
      return jsonResponse(
        {
          success: false,
          error: "Invalid order reference.",
        },
        400,
      );
    }

    // ======================================================
    // 4. RETRIEVE OWNED HITPAY SANDBOX TRANSACTION
    // ======================================================

    const {
      data: payment,
      error: paymentError,
    } = await admin
      .from("payment_transactions")
      .select(`
        transaction_id,
        registration_id,
        session_id,
        order_reference_id,
        hitpay_reference_id,
        payment_channel,
        amount,
        currency,
        transaction_status,
        transaction_timestamp,
        confirmed_at,
        gateway_verified_at,
        gateway_request_id,
        hmac_signature,
        checkout_state,
        checkout_claimed_at,
        reconciliation_required,
        reconciliation_requested_at,
        is_sandbox
      `)
      .eq("order_reference_id", order_reference)
      .eq("user_id", user.id)
      .eq("payment_provider", "HITPAY")
      .eq("is_sandbox", true)
      .maybeSingle();

    if (paymentError) {
      throw new Error("Payment lookup failed.");
    }

    if (!payment) {
      return jsonResponse(
        {
          success: false,
          error: "Payment record not found.",
        },
        404,
      );
    }

    // ======================================================
    // 5. VALIDATE RECORDED GATEWAY EVIDENCE
    // ======================================================

    const hasSuccessfulGatewayEvidence =
      isValidDate(payment.gateway_verified_at) &&
      isNonEmptyString(payment.gateway_request_id) &&
      isNonEmptyString(payment.hitpay_reference_id) &&
      isNonEmptyString(payment.payment_channel) &&
      isNonEmptyString(payment.hmac_signature) &&
      /^[0-9a-f]{64}$/i.test(payment.hmac_signature);

    const validAmount = Number.isFinite(Number(payment.amount)) &&
      Number(payment.amount) > 0 &&
      payment.currency === "PHP";

    // Common response fields.
    const baseResponse = {
      success: true,
      transaction_id: payment.transaction_id,
      order_reference: payment.order_reference_id,
      checkout_state: payment.checkout_state,
      amount: payment.amount,
      currency: payment.currency,
    };

    // Centralized non-successful response.
    const nonSuccessfulResponse = (
      status: string,
      message: string,
      reconciliationRequired = false,
      gatewayPaymentVerified = false,
    ) => {
      return jsonResponse({
        ...baseResponse,
        status,
        verified: false,
        gateway_payment_verified: gatewayPaymentVerified,
        registered: false,
        reconciliation_required: reconciliationRequired,
        message,
        receipt: null,
      });
    };

    // ======================================================
    // 6. PRIORITIZE RECONCILIATION
    // ======================================================

    if (
      payment.reconciliation_required === true ||
      payment.checkout_state === "REVIEW_REQUIRED"
    ) {
      return jsonResponse({
        ...baseResponse,
        status: "REVIEW_REQUIRED",
        verified: false,
        gateway_payment_verified: hasSuccessfulGatewayEvidence,
        registered: false,
        reconciliation_required: true,
        reconciliation_requested_at: payment.reconciliation_requested_at,
        message: hasSuccessfulGatewayEvidence
          ? "Your gateway payment has been recorded, but your registration requires further verification. Do not start another payment."
          : "Your checkout requires verification. Do not start another payment until the existing transaction is resolved.",
        receipt: null,
      });
    }

    // ======================================================
    // 7. HANDLE RECORDED REFUNDED PAYMENTS
    // ======================================================

    // Refund status must be handled before checking
    // successful historical payment evidence.
    //
    // This does not initiate or verify a new refund.

    if (payment.transaction_status === "REFUNDED") {
      return nonSuccessfulResponse(
        "REFUNDED",
        "This payment is recorded as refunded. Contact an administrator for registration or refund concerns.",
      );
    }

    // ======================================================
    // 8. CHECK FULLY FINALIZED PAYMENT
    // ======================================================

    const isVerifiedPaid = payment.transaction_status === "PAID" &&
      hasSuccessfulGatewayEvidence &&
      isNonEmptyString(payment.registration_id) &&
      isValidDate(payment.confirmed_at) &&
      payment.reconciliation_required === false &&
      payment.checkout_state === "CREATED" &&
      validAmount;

    if (isVerifiedPaid) {
      // ====================================================
      // 9. VERIFY MATCHING PAID REGISTRATION
      // ====================================================

      const {
        data: registration,
        error: registrationError,
      } = await admin
        .from("session_registrations")
        .select(`
          registration_id,
          session_id,
          user_id,
          payment_status
        `)
        .eq(
          "registration_id",
          payment.registration_id,
        )
        .eq("user_id", user.id)
        .eq("session_id", payment.session_id)
        .maybeSingle();

      if (registrationError) {
        throw new Error(
          "Registration lookup failed.",
        );
      }

      if (
        !registration ||
        registration.payment_status !== "PAID"
      ) {
        return nonSuccessfulResponse(
          "REVIEW_REQUIRED",
          "Your payment was recorded, but your registration requires verification.",
          true,
          true,
        );
      }

      // ====================================================
      // 10. RETRIEVE SESSION DETAILS
      // ====================================================

      const {
        data: session,
        error: sessionError,
      } = await admin
        .from("training_sessions")
        .select("title")
        .eq("session_id", payment.session_id)
        .maybeSingle();

      if (sessionError) {
        throw new Error("Session lookup failed.");
      }

      if (
        !session ||
        !isNonEmptyString(session.title)
      ) {
        return nonSuccessfulResponse(
          "REVIEW_REQUIRED",
          "Payment receipt information is incomplete. Please contact an administrator.",
          true,
          true,
        );
      }

      // ====================================================
      // 11. RETURN VERIFIED PAYMENT RECEIPT
      // ====================================================

      return jsonResponse({
        ...baseResponse,
        status: "PAID",
        verified: true,
        gateway_payment_verified: true,
        registered: true,
        reconciliation_required: false,
        message: "Sandbox payment successful. Your registration is confirmed.",

        receipt: {
          transaction_id: payment.transaction_id,

          order_reference: payment.order_reference_id,

          transaction_reference: payment.hitpay_reference_id,

          registration_id: payment.registration_id,

          session_id: payment.session_id,

          session_title: session.title,

          payment_method: payment.payment_channel,

          amount: payment.amount,

          currency: payment.currency,

          payment_date: payment.confirmed_at,

          payment_status: "PAID",

          payment_provider: "HitPay",

          is_sandbox: true,
        },
      });
    }

    // ======================================================
    // 12. HANDLE INCONSISTENT PAID RECORDS
    // ======================================================

    if (payment.transaction_status === "PAID") {
      return nonSuccessfulResponse(
        "REVIEW_REQUIRED",
        "Payment verification is incomplete. Please contact the administrator.",
        true,
        hasSuccessfulGatewayEvidence,
      );
    }

    // ======================================================
    // 13. HANDLE UNFINALIZED SUCCESSFUL PAYMENT
    // ======================================================

    if (hasSuccessfulGatewayEvidence) {
      return nonSuccessfulResponse(
        "REVIEW_REQUIRED",
        "Your gateway payment has been recorded, but registration is not yet confirmed.",
        true,
        true,
      );
    }

    // ======================================================
    // 14. HANDLE CHECKOUT CREATION IN PROGRESS
    // ======================================================

    if (
      payment.transaction_status === "PENDING_PAYMENT" &&
      payment.checkout_state === "CREATING"
    ) {
      return nonSuccessfulResponse(
        "PENDING_PAYMENT",
        "Your checkout is being prepared. Please check your payment status again.",
      );
    }

    // ======================================================
    // 15. HANDLE REMAINING PAYMENT STATUSES
    // ======================================================

    switch (payment.transaction_status) {
      case "PENDING_PAYMENT":
        return nonSuccessfulResponse(
          "PENDING_PAYMENT",
          "Your payment is awaiting verification.",
        );

      case "FAILED":
        return nonSuccessfulResponse(
          "FAILED",
          "Your payment was unsuccessful. Do not initiate another payment until the existing transaction is resolved.",
        );

      case "CANCELLED":
        return nonSuccessfulResponse(
          "CANCELLED",
          "Your payment is recorded as cancelled or expired. Do not initiate another payment until the existing transaction is resolved.",
        );

      default:
        return nonSuccessfulResponse(
          "REVIEW_REQUIRED",
          "Your payment requires further review.",
          true,
        );
    }
  } catch (error) {
    console.error(
      "Payment status error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return jsonResponse(
      {
        success: false,
        error: "Unable to retrieve payment status.",
      },
      500,
    );
  }
});
