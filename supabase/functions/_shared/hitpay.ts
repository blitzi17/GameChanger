
/* ============================================================
   GameChanger — HR Calabarzon

   supabase/functions/_shared/hitpay.ts

   UC-PAM-01 — Process Payment
   Environment: HitPay Sandbox
============================================================ */

import { getEnv } from "./supabase.ts";


// ============================================================
// 1. SANDBOX CONFIGURATION
// ============================================================

const SANDBOX_URL = "https://api.sandbox.hit-pay.com";


// HITPAY_CHECKOUT_URL_PROTECTION_V1

// Populate only after the exact sandbox checkout hostname
// has been independently confirmed.

const APPROVED_CHECKOUT_HOSTNAMES:
  readonly string[] = Object.freeze(["securecheckout.sandbox.hit-pay.com"]);



// ============================================================
// 2. RETRIEVE HITPAY CONFIGURATION
// ============================================================

export function getHitPayConfig() {

  const apiUrl = getEnv("HITPAY_API_URL")
    .replace(/\/+$/, "");

  if (apiUrl !== SANDBOX_URL) {

    throw new Error(
      "Only HitPay Sandbox is allowed."
    );

  }

  return {

    apiUrl,

    apiKey: getEnv("HITPAY_API_KEY"),

    webhookSalt: getEnv("HITPAY_WEBHOOK_SALT"),

  };

}



// ============================================================
// 3. CHECKOUT URL VALIDATION
// ============================================================

export function validateHitPayCheckoutURL(
  value: unknown
): string {

  // Reject missing, malformed or unsafe URL characters.
  // Character-code validation avoids the Deno
  // no-control-regex lint warning.

  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    Array.from(value).some((character) => {

      const code = character.charCodeAt(0);

      return (
        code <= 32 ||
        code === 127 ||
        character === "\\"
      );

    })
  ) {

    throw new Error(
      "Invalid checkout URL."
    );

  }


  let url: URL;

  try {

    url = new URL(value);

  } catch {

    throw new Error(
      "Invalid checkout URL."
    );

  }


  // Require HTTPS and reject embedded credentials,
  // non-default ports and URL fragments.

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {

    throw new Error(
      "Insecure checkout URL."
    );

  }


  // Exact hostname matching only.
  // An empty allowlist rejects every destination.

  if (
    !APPROVED_CHECKOUT_HOSTNAMES.includes(
      url.hostname
    )
  ) {

    throw new Error(
      "Checkout hostname is not approved."
    );

  }


  // Require a non-root checkout path.

  if (
    !url.pathname ||
    url.pathname === "/"
  ) {

    throw new Error(
      "Checkout path is missing."
    );

  }


  return url.href;

}



// ============================================================
// 4. BACKEND CHECKOUT READINESS
// ============================================================

// HITPAY_SERVER_READINESS_V1

// Backend checkout remains disabled independently
// of the frontend readiness configuration.

const CHECKOUT_SERVICE_ENABLED: boolean = true;


export function assertHitPayCheckoutReady(): void {

  if (CHECKOUT_SERVICE_ENABLED !== true) {

    throw new Error(
      "HitPay Sandbox checkout is disabled."
    );

  }


  if (APPROVED_CHECKOUT_HOSTNAMES.length === 0) {

    throw new Error(
      "Sandbox checkout hostname is not configured."
    );

  }


  const config = getHitPayConfig();


  if (
    !config.apiKey.trim() ||
    !config.webhookSalt.trim()
  ) {

    throw new Error(
      "HitPay Sandbox configuration is incomplete."
    );

  }

}



// ============================================================
// 5. CREATE HOSTED CHECKOUT
// ============================================================

export async function createHitPayCheckout(input: {

  amount: number;

  currency: string;

  orderReference: string;

  sessionTitle: string;

  redirectUrl: string;

}) {

  // Defense in depth: verify readiness again before
  // preparing an outbound gateway request.

  assertHitPayCheckoutReady();


  const config = getHitPayConfig();


  // ==========================================================
  // 5.1 VALIDATE PAYMENT AMOUNT
  // ==========================================================

  if (
    !Number.isFinite(input.amount) ||
    input.amount <= 0
  ) {

    throw new Error(
      "Invalid payment amount."
    );

  }


  // ==========================================================
  // 5.2 VALIDATE CURRENCY
  // ==========================================================

  // GameChanger uses Philippine pesos.

  if (input.currency !== "PHP") {

    throw new Error(
      "Unsupported currency."
    );

  }


  // ==========================================================
  // 5.3 PREPARE PAYMENT REQUEST
  // ==========================================================

  const body = new URLSearchParams();

  // Sandbox-supported payment method.
  body.append("payment_methods[]", "card");


  body.set(
    "amount",
    input.amount.toFixed(2)
  );


  body.set(
    "currency",
    input.currency
  );


  body.set(
    "reference_number",
    input.orderReference
  );


  body.set(
    "purpose",
    input.sessionTitle.slice(0, 255)
  );


  body.set(
    "redirect_url",
    input.redirectUrl
  );


  body.set(
    "allow_repeated_payments",
    "false"
  );



  // ==========================================================
  // 5.4 SEND REQUEST TO HITPAY SANDBOX
  // ==========================================================

  const response = await fetch(

    `${config.apiUrl}/v1/payment-requests`,

    {

      method: "POST",

      headers: {

        "X-BUSINESS-API-KEY": config.apiKey,

        "X-Requested-With": "XMLHttpRequest",

        "Content-Type":
          "application/x-www-form-urlencoded",

        "Accept": "application/json",

      },

      body,

      // Reject unexpected gateway API redirects.

      redirect: "error",

      signal: AbortSignal.timeout(15000),

    }

  );



  // ==========================================================
  // 5.5 HANDLE GATEWAY ERRORS
  // ==========================================================

  if (!response.ok) {

    console.error(
      "HitPay request status:",
      response.status
    );

    throw new Error(
      "HitPay sandbox checkout is unavailable."
    );

  }



  // ==========================================================
  // 5.6 PARSE GATEWAY RESPONSE
  // ==========================================================

  const data = await response.json();


  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    typeof data.id !== "string" ||
    typeof data.url !== "string"
  ) {

    throw new Error(
      "Invalid gateway response."
    );

  }



  // ==========================================================
  // 5.7 VALIDATE GATEWAY REQUEST ID
  // ==========================================================

  if (data.id.trim() === "") {

    throw new Error(
      "Invalid gateway request ID."
    );

  }



  // ==========================================================
  // 5.8 VALIDATE HOSTED CHECKOUT URL
  // ==========================================================

  const checkoutUrl =
    validateHitPayCheckoutURL(data.url);



  // ==========================================================
  // 5.9 RETURN VALIDATED CHECKOUT INFORMATION
  // ==========================================================

  return {

    gatewayRequestId: data.id,

    checkoutUrl,

    status: data.status,

  };

}
