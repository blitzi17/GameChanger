
/* ============================================================
   GameChanger — HR Calabarzon

   supabase/functions/_shared/hitpay-status.ts

   UC-PAM-01 — Payment Status Recovery
   Environment: HitPay Sandbox
============================================================ */

import { getHitPayConfig } from "./hitpay.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORDER_PATTERN =
  /^GC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export interface HitPayStatusInput {
  gatewayRequestId: string;
  orderReference: string;
  amount: number;
  currency: string;
}

export interface HitPayVerifiedStatus {
  gatewayRequestId: string;
  orderReference: string;
  amount: number;
  currency: string;
  status: string;
  payments: Record<string, unknown>[];
  paymentDetailsAvailable: boolean;
  successfulPaymentCount: number;
}

// HITPAY_GATEWAY_STATUS_LOOKUP_V1

export async function getVerifiedHitPayStatus(
  input: HitPayStatusInput
): Promise<HitPayVerifiedStatus> {

  // 1. Validate expected transaction information.

  if (
    !UUID_PATTERN.test(input.gatewayRequestId) ||
    !ORDER_PATTERN.test(input.orderReference) ||
    !Number.isFinite(input.amount) ||
    input.amount <= 0 ||
    input.currency !== "PHP"
  ) {
    throw new Error(
      "Invalid payment verification information."
    );
  }

  // 2. Retrieve existing sandbox configuration.

  const config = getHitPayConfig();

  // 3. Independently retrieve the gateway request.

  const response = await fetch(
    `${config.apiUrl}/v1/payment-requests/${
      encodeURIComponent(input.gatewayRequestId)
    }`,
    {
      method: "GET",
      headers: {
        "X-BUSINESS-API-KEY": config.apiKey,
        "Accept": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    }
  );

  if (!response.ok) {
    throw new Error(
      `Gateway verification unavailable (${response.status}).`
    );
  }

  // 4. Validate the gateway response.

  const gateway: unknown = await response.json();

  if (!isRecord(gateway)) {
    throw new Error(
      "Invalid gateway verification response."
    );
  }

  const amount = Number(gateway.amount);

  const currency = String(
    gateway.currency ?? ""
  ).toUpperCase();

  const status =
    typeof gateway.status === "string"
      ? gateway.status.trim().toLowerCase()
      : "";

  // 5. Match gateway information against our records.

  if (
    gateway.id !== input.gatewayRequestId ||
    gateway.reference_number !== input.orderReference ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount !== input.amount ||
    currency !== input.currency ||
    status === ""
  ) {
    throw new Error(
      "Gateway payment information mismatch."
    );
  }

  // 6. Inspect payment evidence.

  const paymentDetailsAvailable =
    Array.isArray(gateway.payments) &&
    gateway.payments.every(isRecord);

  const payments = paymentDetailsAvailable
    ? (gateway.payments as Record<string, unknown>[])
    : [];

  const successfulPaymentCount = payments.filter(
    (payment) =>
      typeof payment.status === "string" &&
      payment.status.trim().toLowerCase() === "succeeded"
  ).length;

  // 7. Return verified gateway information.
  // This helper does not authorize retries,
  // finalize payments or modify database records.

  return {
    gatewayRequestId: input.gatewayRequestId,
    orderReference: input.orderReference,
    amount,
    currency,
    status,
    payments,
    paymentDetailsAvailable,
    successfulPaymentCount,
  };
}


/**
 * HITPAY_SHARED_CONTINUATION_POLICY_V1
 *
 * HitPay engineering confirmed that a pending payment
 * request can resume through its existing checkout URL.
 *
 * Individual attempt statuses do not determine whether
 * the same payment request can be reopened.
 *
 * This policy never authorizes a replacement request
 * or marks a transaction as paid.
 */
export function canResumeHitPayCheckout(
  gateway: HitPayVerifiedStatus
): boolean {
  return (
    gateway.status === "pending" &&
    gateway.paymentDetailsAvailable === true &&
    gateway.successfulPaymentCount === 0
  );
}
