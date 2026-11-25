
import {
  createAdminClient,
} from "../_shared/supabase.ts";

import {
  getHitPayConfig,
} from "../_shared/hitpay.ts";


function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}


// Verify the original webhook body.
async function verifySignature(
  body: ArrayBuffer,
  signature: string,
  salt: string
): Promise<boolean> {

  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(salt),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["verify"]
  );

  const signatureBytes = Uint8Array.from(
    signature.match(/.{2}/g)!,
    (value) => parseInt(value, 16)
  );

  return await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    body
  );
}


// Convert gateway methods to database values.
function mapPaymentChannel(method: string) {
  switch (method.toLowerCase()) {

    case "gcash":
      return "GCASH";

    case "maya":
    case "paymaya":
      return "MAYA";

    case "card":
    case "card_cybersource":
      return "CARD";

    default:
      return null;
  }
}


// Validate database response objects.
function isRecord(
  value: unknown
): value is Record<string, unknown> {

  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}


Deno.serve(async (req: Request) => {

  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed." },
      405
    );
  }

  try {

    const config = getHitPayConfig();


    // 1. Retrieve webhook signature.
    const signature =
      req.headers.get("Hitpay-Signature");

    if (!signature) {
      return jsonResponse(
        { error: "Missing signature." },
        401
      );
    }


    // 2. Read the original request body.
    const rawBody = await req.arrayBuffer();


    // 3. Verify webhook authenticity.
    const valid = await verifySignature(
      rawBody,
      signature,
      config.webhookSalt
    );

    if (!valid) {
      return jsonResponse(
        { error: "Invalid signature." },
        401
      );
    }


    // 4. Process payment request events only.
    const eventObject = req.headers.get(
      "Hitpay-Event-Object"
    );

    if (eventObject !== "payment_request") {
      return jsonResponse({
        received: true,
        ignored: true,
      });
    }


    // 5. Parse and validate webhook payload.
    let payload: unknown;

    try {

      payload = JSON.parse(
        new TextDecoder().decode(rawBody)
      );

    } catch {

      return jsonResponse(
        { error: "Invalid webhook payload." },
        400
      );

    }

    if (!isRecord(payload)) {
      return jsonResponse(
        { error: "Invalid webhook payload." },
        400
      );
    }

    const gatewayRequestId = payload.id;
    const orderReference = payload.reference_number;

    if (
      typeof gatewayRequestId !== "string" ||
      gatewayRequestId.trim() === "" ||
      typeof orderReference !== "string" ||
      orderReference.trim() === ""
    ) {

      return jsonResponse(
        { error: "Invalid payment information." },
        400
      );

    }

    const admin = createAdminClient();


    // 6. Find the corresponding sandbox transaction.
    const {
      data: transaction,
      error: lookupError,
    } = await admin
      .from("payment_transactions")
      .select(
        `
        transaction_id,
        amount,
        currency,
        transaction_status,
        reconciliation_required,
        gateway_verified_at
        `
      )
      .eq("order_reference_id", orderReference)
      .eq("gateway_request_id", gatewayRequestId)
      .eq("payment_provider", "HITPAY")
      .eq("is_sandbox", true)
      .maybeSingle();

    if (lookupError) {
      throw new Error(
        "Transaction lookup failed."
      );
    }

    if (!transaction) {
      return jsonResponse(
        { error: "Transaction not found." },
        404
      );
    }


    // 7. Independently verify gateway payment status.
    const gatewayResponse = await fetch(
      `${config.apiUrl}/v1/payment-requests/${encodeURIComponent(gatewayRequestId)}`,
      {
        headers: {
          "X-BUSINESS-API-KEY": config.apiKey,
          "Accept": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!gatewayResponse.ok) {
      throw new Error(
        "Gateway verification unavailable."
      );
    }

    const verified = await gatewayResponse.json();

    if (!isRecord(verified)) {
      throw new Error(
        "Invalid gateway verification response."
      );
    }

    const amount = Number(verified.amount);

    const currency = String(
      verified.currency ?? ""
    ).toUpperCase();

    const status = String(
      verified.status ?? ""
    ).toLowerCase();


    // 8. Validate verified payment information.
    if (
      verified.id !== gatewayRequestId ||
      verified.reference_number !== orderReference ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount !== Number(transaction.amount) ||
      currency !==
        String(transaction.currency).toUpperCase()
    ) {

      return jsonResponse(
        { error: "Payment information mismatch." },
        409
      );

    }


    // 9. Process verified successful payments.
    if (status === "completed") {

      const successfulPayments =
        Array.isArray(verified.payments)
          ? verified.payments.filter(
              (payment: unknown) =>
                isRecord(payment) &&
                payment.status === "succeeded"
            )
          : [];


      // Do not automatically select between
      // multiple successful gateway payments.
      if (successfulPayments.length !== 1) {

        return jsonResponse(
          {
            error:
              "Successful payment details require review.",
          },
          409
        );

      }

      const successfulPayment =
        successfulPayments[0];

      if (
        !isRecord(successfulPayment) ||
        typeof successfulPayment.id !== "string" ||
        successfulPayment.id.trim() === ""
      ) {

        return jsonResponse(
          {
            error:
              "Successful payment reference missing.",
          },
          409
        );

      }

      const paymentChannel = mapPaymentChannel(
        String(
          successfulPayment.payment_type ??
          verified.payment_type ??
          ""
        )
      );

      if (
        !paymentChannel ||
        Number(successfulPayment.amount) !== amount ||
        String(successfulPayment.currency ?? "")
          .toUpperCase() !== currency
      ) {

        return jsonResponse(
          {
            error:
              "Payment details require review.",
          },
          409
        );

      }


      // 10. Call the trusted finalization function.
      const { data, error } = await admin.rpc(
        "hitpay_finalize_payment",
        {
          p_order_reference: orderReference,
          p_gateway_request_id: gatewayRequestId,
          p_hitpay_reference: successfulPayment.id,
          p_amount: amount,
          p_currency: currency,
          p_payment_channel: paymentChannel,
          p_signature: signature,
          p_payload: {
            request_id: gatewayRequestId,
            payment_id: successfulPayment.id,
            reference_number: orderReference,
            amount,
            currency,
            status,
            payment_channel: paymentChannel,
          },
        }
      );

      if (error) {
        throw new Error(
          "Payment finalization failed."
        );
      }

      if (!isRecord(data)) {
        throw new Error(
          "Invalid finalization response."
        );
      }


      // 11. Respect the actual database outcome.
      if (data.status === "REVIEW_REQUIRED") {

        console.warn(
          "Sandbox payment requires reconciliation:",
          transaction.transaction_id
        );

        return jsonResponse({
          received: true,
          status: "REVIEW_REQUIRED",
          reconciliation_required: true,
          registration_completed: false,
          already_processed:
            data.already_processed === true,
        });

      }


      // 12. Confirm successful registration.
      if (
        data.status === "PAID" &&
        data.registration_completed === true &&
        typeof data.registration_id === "string" &&
        data.registration_id.trim() !== ""
      ) {

        return jsonResponse({
          received: true,
          status: "PAID",
          registration_completed: true,
          reconciliation_required: false,
          already_processed:
            data.already_processed === true,
        });

      }

      throw new Error(
        "Unexpected payment finalization outcome."
      );

    }


    // 13. Handle verified non-successful outcomes.
    const statusMap: Record<string, string> = {
      failed: "FAILED",
      canceled: "CANCELLED",
      cancelled: "CANCELLED",
      expired: "CANCELLED",
      pending: "PENDING_PAYMENT",
    };

    const mappedStatus =
      Object.hasOwn(statusMap, status)
        ? statusMap[status]
        : undefined;

    if (!mappedStatus) {

      return jsonResponse(
        { error: "Unrecognized gateway status." },
        409
      );

    }


    // 14. Process the verified payment status.
    const { data, error } = await admin.rpc(
      "hitpay_update_status",
      {
        p_order_reference: orderReference,
        p_gateway_request_id: gatewayRequestId,
        p_status: mappedStatus,
        p_signature: signature,
        p_payload: {
          request_id: gatewayRequestId,
          reference_number: orderReference,
          amount,
          currency,
          status,
        },
      }
    );

    if (error) {
      throw new Error(
        "Payment status update failed."
      );
    }

    if (
      !isRecord(data) ||
      typeof data.status !== "string"
    ) {

      throw new Error(
        "Invalid payment status response."
      );

    }


    // 15. Return the actual recorded database status.
    return jsonResponse({
      received: true,
      status: data.status,
      updated: data.updated === true,
      reconciliation_required:
        data.status === "REVIEW_REQUIRED" ||
        data.reconciliation_required === true,
    });


  } catch (error) {

    console.error(
      "Webhook processing error:",
      error instanceof Error
        ? error.message
        : "Unknown error"
    );

    return jsonResponse(
      { error: "Webhook processing failed." },
      500
    );

  }

});
