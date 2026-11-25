import { createAdminClient, createMemberClient } from "../_shared/supabase.ts";

import {
  assertHitPayCheckoutReady,
  createHitPayCheckout,
} from "../_shared/hitpay.ts";

const APP_URL = "https://game-changer-sigma.vercel.app";

const ALLOWED_ORIGINS = new Set([
  APP_URL,
  "https://game-changer-git-feature-proces-21fc05-karols-projects-95a784de.vercel.app",
]);

// Standard reconciliation response.

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

  function reconciliationResponse(
    orderReference?: string,
  ) {
    return jsonResponse(
      {
        success: false,
        status: "REVIEW_REQUIRED",
        reconciliation_required: true,
        order_reference: orderReference,
        error:
          "Your existing payment requires verification before another attempt.",
      },
      409,
    );
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed." },
      405,
    );
  }

  try {
    // 1. Authenticate member.
    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse(
        { error: "Authentication required." },
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
        { error: "Please sign in first." },
        401,
      );
    }

    // 2. Parse and validate session ID.
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return jsonResponse(
        { error: "Invalid request body." },
        400,
      );
    }

    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body)
    ) {
      return jsonResponse(
        { error: "Invalid request body." },
        400,
      );
    }

    const { session_id } = body as Record<string, unknown>;

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      typeof session_id !== "string" ||
      !uuidPattern.test(session_id)
    ) {
      return jsonResponse(
        { error: "Invalid session ID." },
        400,
      );
    }

    // HITPAY_SERVER_READINESS_V1

    // Check server readiness before sandbox authorization,
    // eligibility checks, pending transaction creation,
    // checkout claims or outbound gateway requests.

    try {
      assertHitPayCheckoutReady();
    } catch {
      return jsonResponse(
        {
          success: false,

          status: "SERVICE_NOT_READY",

          reconciliation_required: false,

          error:
            "HitPay Sandbox checkout is not enabled yet. No new payment has been initiated.",
        },
        503,
      );
    }

    // 3. Verify sandbox authorization.
    const {
      data: allowed,
      error: allowlistError,
    } = await admin.rpc(
      "hitpay_is_sandbox_allowed",
      {
        p_user_id: user.id,
        p_session_id: session_id,
      },
    );

    if (allowlistError) {
      throw new Error(
        "Sandbox authorization failed.",
      );
    }

    if (allowed !== true) {
      return jsonResponse(
        {
          error:
            "This member or session is not authorized for sandbox testing.",
        },
        403,
      );
    }

    // 4. Check existing reconciliation records.
    // Include all transaction statuses, not just pending.
    const {
      data: unresolvedPayments,
      error: unresolvedError,
    } = await admin
      .from("payment_transactions")
      .select(`
        transaction_id,
        order_reference_id,
        transaction_status,
        reconciliation_required,
        checkout_state
      `)
      .eq("user_id", user.id)
      .eq("session_id", session_id)
      .eq("payment_provider", "HITPAY")
      .eq("is_sandbox", true)
      .or(
        "reconciliation_required.eq.true,checkout_state.eq.REVIEW_REQUIRED",
      )
      .limit(1);

    if (unresolvedError) {
      throw new Error(
        "Existing payment verification failed.",
      );
    }

    if (
      unresolvedPayments &&
      unresolvedPayments.length > 0
    ) {
      return reconciliationResponse(
        unresolvedPayments[0].order_reference_id,
      );
    }

    // 5. Validate eligibility and prerequisites.
    const {
      data: eligibility,
      error: eligibilityError,
    } = await supabase.rpc(
      "hitpay_check_eligibility",
      {
        p_session_id: session_id,
      },
    );

    if (
      eligibilityError ||
      eligibility?.eligible !== true
    ) {
      return jsonResponse(
        {
          error: "Session payment eligibility failed.",
        },
        400,
      );
    }

    // 6. Create or retrieve pending transaction.
    const {
      data: payment,
      error: paymentError,
    } = await supabase.rpc(
      "hitpay_create_pending",
      {
        p_session_id: session_id,
      },
    );

    if (
      paymentError ||
      !payment ||
      typeof payment.transaction_id !== "string"
    ) {
      return jsonResponse(
        { error: "Unable to prepare payment." },
        400,
      );
    }

    // 7. Retrieve the stored transaction.
    const {
      data: transaction,
      error: transactionError,
    } = await admin
      .from("payment_transactions")
      .select(`
        transaction_id,
        order_reference_id,
        amount,
        currency,
        transaction_status,
        gateway_request_id,
        gateway_checkout_url,
        gateway_verified_at,
        hitpay_reference_id,
        checkout_state,
        reconciliation_required
      `)
      .eq("transaction_id", payment.transaction_id)
      .eq("user_id", user.id)
      .eq("session_id", session_id)
      .eq("payment_provider", "HITPAY")
      .eq("is_sandbox", true)
      .single();

    if (transactionError || !transaction) {
      return jsonResponse(
        {
          error: "Payment transaction unavailable.",
        },
        409,
      );
    }

    // 8. Prevent checkout for reconciliation records.
    if (
      transaction.reconciliation_required === true ||
      transaction.checkout_state === "REVIEW_REQUIRED"
    ) {
      return reconciliationResponse(
        transaction.order_reference_id,
      );
    }

    // 9. Prevent checkout for completed or
    // otherwise resolved transactions.
    if (
      transaction.transaction_status !==
        "PENDING_PAYMENT"
    ) {
      return jsonResponse(
        {
          success: false,
          status: transaction.transaction_status,
          order_reference: transaction.order_reference_id,
          error: "This payment is no longer pending.",
        },
        409,
      );
    }

    // 10. Prevent checkout reuse when gateway
    // verification evidence already exists.
    if (
      transaction.gateway_verified_at !== null ||
      transaction.hitpay_reference_id !== null
    ) {
      return reconciliationResponse(
        transaction.order_reference_id,
      );
    }

    // 11. Validate stored payment information.
    const amount = Number(transaction.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      transaction.currency !== "PHP" ||
      typeof transaction.order_reference_id !== "string" ||
      transaction.order_reference_id.trim() === ""
    ) {
      throw new Error(
        "Invalid stored payment information.",
      );
    }

    // 12. Handle an existing checkout.
    // Do not return an existing checkout URL without
    // independently confirming its gateway state.
    if (transaction.checkout_state === "CREATED") {
      return jsonResponse(
        {
          success: false,
          status: "PENDING_PAYMENT",
          checkout_state: "CREATED",
          transaction_id: transaction.transaction_id,
          order_reference: transaction.order_reference_id,
          error:
            "An existing checkout is awaiting payment verification. Check your payment status before another attempt.",
        },
        409,
      );
    }

    // 13. Handle checkout creation in progress.
    if (transaction.checkout_state === "CREATING") {
      return jsonResponse(
        {
          success: false,
          status: "PENDING_PAYMENT",
          checkout_state: "CREATING",
          order_reference: transaction.order_reference_id,
          error: "Checkout creation is already in progress.",
        },
        409,
      );
    }

    // 14. Reject inconsistent checkout information.
    if (
      transaction.checkout_state !== "NOT_STARTED" ||
      transaction.gateway_request_id !== null ||
      transaction.gateway_checkout_url !== null
    ) {
      return reconciliationResponse(
        transaction.order_reference_id,
      );
    }

    // 15. Atomically claim checkout creation.
    const {
      data: claimed,
      error: claimError,
    } = await admin.rpc(
      "hitpay_claim_checkout",
      {
        p_transaction_id: transaction.transaction_id,
        p_user_id: user.id,
      },
    );

    if (claimError) {
      throw new Error(
        "Checkout claim failed.",
      );
    }

    if (claimed !== true) {
      return jsonResponse(
        {
          success: false,
          error:
            "Checkout is already being processed or requires verification.",
        },
        409,
      );
    }

    try {
      // 16. Prepare trusted return URL.
      const redirectUrl = new URL(origin);

      redirectUrl.searchParams.set(
        "payment_return",
        "true",
      );

      redirectUrl.searchParams.set(
        "order_reference",
        transaction.order_reference_id,
      );

      // 17. Create HitPay Sandbox checkout.
      const checkout = await createHitPayCheckout({
        amount,
        currency: transaction.currency,
        orderReference: transaction.order_reference_id,
        sessionTitle: eligibility.session_title,
        redirectUrl: redirectUrl.toString(),
      });

      // 18. Save checkout using the protected RPC.
      const {
        data: saved,
        error: saveError,
      } = await admin.rpc(
        "hitpay_save_checkout",
        {
          p_transaction_id: transaction.transaction_id,
          p_user_id: user.id,
          p_gateway_request_id: checkout.gatewayRequestId,
          p_checkout_url: checkout.checkoutUrl,
        },
      );

      if (saveError || saved !== true) {
        throw new Error(
          "Unable to save checkout details.",
        );
      }

      // 19. Return the newly created checkout.
      return jsonResponse({
        success: true,
        status: "PENDING_PAYMENT",
        checkout_state: "CREATED",
        reconciliation_required: false,
        transaction_id: transaction.transaction_id,
        order_reference: transaction.order_reference_id,
        amount,
        currency: transaction.currency,
        checkout_url: checkout.checkoutUrl,
      });
    } catch (checkoutError) {
      // 20. Record uncertain checkout outcomes.
      const {
        data: reviewSaved,
        error: reviewError,
      } = await admin.rpc(
        "hitpay_checkout_review",
        {
          p_transaction_id: transaction.transaction_id,
          p_user_id: user.id,
        },
      );

      if (
        reviewError ||
        reviewSaved !== true
      ) {
        console.error(
          "Unable to confirm checkout review state:",
          transaction.transaction_id,
        );
      }

      console.error(
        "Checkout error:",
        checkoutError instanceof Error
          ? checkoutError.message
          : "Unknown error",
      );

      // Do not claim that reconciliation was saved
      // unless the database confirms it.
      return jsonResponse(
        {
          success: false,
          status: reviewSaved === true
            ? "REVIEW_REQUIRED"
            : "CHECKOUT_UNCERTAIN",
          reconciliation_required: reviewSaved === true ? true : null,
          order_reference: transaction.order_reference_id,
          error:
            "Checkout could not be completed. Do not start another payment until its status is verified.",
        },
        502,
      );
    }
  } catch (error) {
    console.error(
      "Create payment error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return jsonResponse(
      {
        success: false,
        error: "Payment checkout is currently unavailable.",
      },
      500,
    );
  }
});
