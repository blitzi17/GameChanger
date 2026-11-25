
/* ============================================================
   GameChanger — HR Calabarzon
   payment.js

   Use Case: UC-PAM-01 — Process Payment
   Environment: HitPay Sandbox

   Responsibilities:
   - Authenticated payment API requests
   - Checkout response validation
   - Payment status retrieval
   - Verified receipt validation

   Payment verification and registration finalization
   are performed exclusively by the backend.
============================================================ */

'use strict';

const GameChangerPayment = (() => {

    // ========================================================
    // 1. PAYMENT CONFIGURATION
    // ========================================================

    const CONFIG = Object.freeze({
        provider: 'HitPay',
        environment: 'sandbox',
        currency: 'PHP',
        createPaymentFunction: 'create-payment',
        paymentStatusFunction: 'payment-status',
        // HITPAY_BACKEND_READINESS_V1
        checkoutEnabled: false,
        paymentStatusEnabled: false,

        // HITPAY_CHECKOUT_URL_PROTECTION_V1
        // Populate only after the exact sandbox checkout
        // hostname has been independently confirmed.
        approvedCheckoutHostnames: Object.freeze(["securecheckout.sandbox.hit-pay.com"]),
        requestTimeout: 30000
    });


    // ========================================================
    // 2. PAYMENT STATUS CONSTANTS
    // ========================================================

    const STATUS = Object.freeze({
        PENDING: 'PENDING_PAYMENT',
        PAID: 'PAID',
        FAILED: 'FAILED',
        CANCELLED: 'CANCELLED',
        REFUNDED: 'REFUNDED',
        REVIEW_REQUIRED: 'REVIEW_REQUIRED',
        CHECKOUT_UNCERTAIN: 'CHECKOUT_UNCERTAIN',
        SERVICE_NOT_READY: 'SERVICE_NOT_READY'
    });


    // ========================================================
    // 3. VALIDATION HELPERS
    // ========================================================

    function isObject(value) {

        return value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value);

    }


    function isNonEmptyString(value) {

        return typeof value === 'string' &&
            value.trim().length > 0;

    }


    function isUUID(value) {

        return typeof value === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                .test(value);

    }


    function isOrderReference(value) {

        return typeof value === 'string' &&
            /^GC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                .test(value);

    }


    function isValidAmount(value) {

        if (
            typeof value !== 'number' &&
            typeof value !== 'string'
        ) {
            return false;
        }

        if (
            typeof value === 'string' &&
            value.trim() === ''
        ) {
            return false;
        }

        const amount = Number(value);

        return Number.isFinite(amount) &&
            amount > 0;

    }


    // ========================================================
    // 4. PAYMENT ERROR HANDLING
    // ========================================================

    class PaymentError extends Error {

        constructor(message, details = {}) {

            super(message);

            this.name = 'PaymentError';

            this.status =
                details.status || null;

            this.httpStatus =
                details.httpStatus || null;

            this.orderReference =
                details.orderReference || null;

            this.reconciliationRequired =
                details.reconciliationRequired === true
                    ? true
                    : details.reconciliationRequired === false
                        ? false
                        : null;

        }

    }


    // ========================================================
    // 5. AUTHENTICATED SUPABASE SESSION
    // ========================================================

    async function getAuthenticatedSession() {

        if (typeof sb === 'undefined') {

            throw new PaymentError(
                'The payment service is not initialized.'
            );

        }

        const { data, error } =
            await sb.auth.getSession();

        if (
            error ||
            !data?.session?.access_token
        ) {

            throw new PaymentError(
                'Please sign in before continuing with payment.'
            );

        }

        return data.session;

    }


    // ========================================================
    // 6. EDGE FUNCTION REQUEST
    // ========================================================

    async function request(
        functionName,
        payload,
        options = {}
    ) {

        const allowedFunctions = [
            CONFIG.createPaymentFunction,
            CONFIG.paymentStatusFunction
        ];

        if (!allowedFunctions.includes(functionName)) {

            throw new PaymentError(
                'Invalid payment service request.'
            );

        }

        // Readiness is checked before authentication
        // and before any payment network request.

        if (
            functionName === CONFIG.createPaymentFunction &&
            CONFIG.checkoutEnabled !== true
        ) {
            throw new PaymentError(
                'HitPay Sandbox checkout is not enabled.',
                {
                    status: 'SERVICE_NOT_READY',
                    reconciliationRequired: false
                }
            );
        }

        if (
            functionName === CONFIG.paymentStatusFunction &&
            CONFIG.paymentStatusEnabled !== true
        ) {
            throw new PaymentError(
                'HitPay Sandbox payment status is not enabled.',
                {
                    status: 'SERVICE_NOT_READY',
                    reconciliationRequired: false
                }
            );
        }

        const session =
            await getAuthenticatedSession();

        if (
            options.expectedUserId &&
            session.user?.id !== options.expectedUserId
        ) {
            throw new PaymentError(
                'The authenticated account has changed.'
            );
        }

        if (options.signal?.aborted) {
            throw new PaymentError(
                'The payment request was cancelled.'
            );
        }

        const endpoint =
            `${SUPABASE_URL.replace(/\/+$/, '')}` +
            `/functions/v1/${functionName}`;

        const controller = new AbortController();

        const cancelRequest = () => controller.abort();

        if (options.signal) {
            options.signal.addEventListener(
                'abort',
                cancelRequest,
                { once: true }
            );

            if (options.signal.aborted) {
                controller.abort();
            }
        }

        const timeout = setTimeout(
            () => controller.abort(),
            CONFIG.requestTimeout
        );

        const creatingPayment =
            functionName === CONFIG.createPaymentFunction;

        try {

            const response = await fetch(endpoint, {

                method: 'POST',

                headers: {

                    'Content-Type': 'application/json',

                    'Accept': 'application/json',

                    'apikey': SUPABASE_ANON_KEY,

                    'Authorization':
                        `Bearer ${session.access_token}`

                },

                body: JSON.stringify(payload),

                signal: controller.signal,

                cache: 'no-store',

                redirect: 'error'

            });

            let result;

            try {

                result = await response.json();

            } catch {

                throw new PaymentError(

                    'The payment service returned an invalid response.',

                    {
                        httpStatus: response.status,

                        status: creatingPayment
                            ? STATUS.CHECKOUT_UNCERTAIN
                            : null
                    }

                );

            }

            if (!isObject(result)) {

                throw new PaymentError(

                    'Invalid payment service response.',

                    {
                        status: creatingPayment
                            ? STATUS.CHECKOUT_UNCERTAIN
                            : null
                    }

                );

            }

            if (!response.ok || result.success === false) {

                const message =
                    isNonEmptyString(result.message)
                        ? result.message
                        : isNonEmptyString(result.error)
                            ? result.error
                            : 'The payment request could not be completed.';

                throw new PaymentError(message, {

                    status: result.status ||
                        (
                            creatingPayment &&
                            (
                                response.status >= 500 ||
                                response.status === 409
                            )
                                ? STATUS.CHECKOUT_UNCERTAIN
                                : null
                        ),

                    httpStatus: response.status,

                    orderReference:
                        isOrderReference(result.order_reference)
                            ? result.order_reference
                            : null,

                    reconciliationRequired:
                        result.reconciliation_required

                });

            }

            if (options.signal?.aborted) {
                throw new PaymentError(
                    'The payment request was cancelled.'
                );
            }

            if (options.expectedUserId) {

                const activeSession =
                    await getAuthenticatedSession();

                if (
                    activeSession.user?.id !==
                        options.expectedUserId ||
                    options.signal?.aborted
                ) {
                    throw new PaymentError(
                        'The authenticated account has changed.'
                    );
                }

            }

            return result;

        } catch (error) {

            if (error instanceof PaymentError) {

                throw error;

            }

            if (error.name === 'AbortError') {

                throw new PaymentError(

                    creatingPayment
                        ? 'The checkout request timed out. Check your payment status before attempting another payment.'
                        : 'The payment status request timed out. Please check your status again.',

                    {
                        status: creatingPayment
                            ? STATUS.CHECKOUT_UNCERTAIN
                            : null
                    }

                );

            }

            throw new PaymentError(

                'Unable to reach the payment service. ' +
                'Check your connection and payment status.',

                {
                    status: creatingPayment
                        ? STATUS.CHECKOUT_UNCERTAIN
                        : null
                }

            );

        } finally {

            clearTimeout(timeout);

            options.signal?.removeEventListener(
                'abort',
                cancelRequest
            );

        }

    }


    // ========================================================
    // 7. CHECKOUT URL VALIDATION
    // ========================================================

    function validateCheckoutURL(value, orderReference) {

        function reject(message) {

            throw new PaymentError(message, {

                status: STATUS.CHECKOUT_UNCERTAIN,

                orderReference,

                reconciliationRequired: null

            });

        }

        if (
            !isNonEmptyString(value) ||
            value !== value.trim() ||
            /[\u0000-\u0020\u007f\\]/.test(value)
        ) {

            reject('Invalid checkout URL.');

        }

        let url;

        try {

            url = new URL(value);

        } catch {

            reject('Invalid checkout URL.');

        }

        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.port ||
            url.hash
        ) {

            reject('An insecure checkout URL was rejected.');

        }

        // An empty allowlist rejects every destination.
        // Do not use wildcard or suffix matching.

        if (
            !CONFIG.approvedCheckoutHostnames.includes(
                url.hostname
            )
        ) {

            reject('The checkout hostname is not approved.');

        }

        if (
            !url.pathname ||
            url.pathname === '/'
        ) {

            reject('The checkout path is missing.');

        }

        return url.href;

    }


    // ========================================================
    // 8. CREATE PAYMENT
    // ========================================================

    // HITPAY_CHECKOUT_API_INTEGRATION_V1

    async function createPayment(
        sessionId,
        options = {}
    ) {

        if (!isUUID(sessionId)) {

            throw new PaymentError(
                'Invalid session identifier.'
            );

        }

        // Preserve the existing readiness protection.

        if (CONFIG.checkoutEnabled !== true) {

            throw new PaymentError(

                'HitPay Sandbox checkout is not enabled.',

                {
                    status: 'SERVICE_NOT_READY',
                    reconciliationRequired: false
                }

            );

        }

        // Every enabled checkout request must belong
        // to a specific authenticated member.

        if (!isUUID(options.expectedUserId)) {

            throw new PaymentError(

                'A valid authenticated member is required.',

                {
                    reconciliationRequired: false
                }

            );

        }

        if (options.signal?.aborted) {

            throw new PaymentError(

                'The checkout request was cancelled.',

                {
                    reconciliationRequired: false
                }

            );

        }

        const result = await request(

            CONFIG.createPaymentFunction,

            {
                session_id: sessionId
            },

            {
                expectedUserId: options.expectedUserId,
                signal: options.signal
            }

        );


        const orderReference =
            result.order_reference;

        // Reconciliation must be checked first.

        if (
            result.status === STATUS.REVIEW_REQUIRED ||
            result.reconciliation_required === true
        ) {

            throw new PaymentError(

                'This payment requires reconciliation.',

                {
                    status: STATUS.REVIEW_REQUIRED,

                    orderReference,

                    reconciliationRequired: true
                }

            );

        }

        // Validate the actual checkout response.

        if (
            result.success !== true ||
            result.status !== STATUS.PENDING ||
            result.checkout_state !== 'CREATED' ||
            result.reconciliation_required !== false
        ) {

            throw new PaymentError(

                'The payment is not available for checkout.',

                {
                    status: result.status ||
                        STATUS.CHECKOUT_UNCERTAIN,

                    orderReference,

                    reconciliationRequired:
                        result.reconciliation_required
                }

            );

        }

        if (
            !isUUID(result.transaction_id) ||
            !isOrderReference(orderReference) ||
            !isValidAmount(result.amount) ||
            result.currency !== CONFIG.currency
        ) {

            throw new PaymentError(

                'The payment service returned invalid transaction information.',

                {
                    status: STATUS.CHECKOUT_UNCERTAIN,

                    orderReference
                }

            );

        }

        const checkoutURL = validateCheckoutURL(
            result.checkout_url,
            orderReference
        );

        return {

            status: STATUS.PENDING,

            transactionId:
                result.transaction_id,

            orderReference,

            checkoutState:
                result.checkout_state,

            checkoutURL,

            amount:
                Number(result.amount),

            currency:
                result.currency,

            provider:
                CONFIG.provider,

            environment:
                CONFIG.environment

        };

    }


    // ========================================================
    // 9. VERIFIED RECEIPT VALIDATION
    // ========================================================

    function validateReceipt(receipt, orderReference) {

        if (!isObject(receipt)) {

            return false;

        }

        return (

            isUUID(receipt.transaction_id) &&

            isUUID(receipt.registration_id) &&

            isUUID(receipt.session_id) &&

            receipt.order_reference === orderReference &&

            isNonEmptyString(
                receipt.transaction_reference
            ) &&

            isNonEmptyString(
                receipt.session_title
            ) &&

            isNonEmptyString(
                receipt.payment_method
            ) &&

            isNonEmptyString(
                receipt.payment_date
            ) &&

            Number.isFinite(
                Date.parse(receipt.payment_date)
            ) &&

            isValidAmount(receipt.amount) &&

            receipt.currency === CONFIG.currency &&

            // These field names match payment-status/index.ts.

            receipt.payment_status === STATUS.PAID &&

            receipt.payment_provider === CONFIG.provider &&

            receipt.is_sandbox === true

        );

    }


    // ========================================================
    // 10. RETRIEVE PAYMENT STATUS
    // ========================================================

    async function getPaymentStatus(
        orderReference,
        options = {}
    ) {

        if (!isOrderReference(orderReference)) {

            throw new PaymentError(
                'Invalid payment order reference.'
            );

        }

        const result = await request(

            CONFIG.paymentStatusFunction,

            {
                order_reference: orderReference
            },

            options

        );

        if (result.success !== true) {

            throw new PaymentError(
                'Unable to verify payment status.'
            );

        }

        // Confirm that the response belongs to
        // the requested payment order.

        if (result.order_reference !== orderReference) {

            throw new PaymentError(

                'The returned payment reference does not match.',

                {
                    status: STATUS.REVIEW_REQUIRED,

                    orderReference
                }

            );

        }

        const allowedStatuses =
            Object.values(STATUS).filter(
                status => status !== STATUS.SERVICE_NOT_READY
            );

        if (!allowedStatuses.includes(result.status)) {

            throw new PaymentError(
                'An unknown payment status was received.'
            );

        }

        // A reconciliation record must never be
        // presented as a completed registration.

        if (
            result.status === STATUS.REVIEW_REQUIRED ||
            result.reconciliation_required === true
        ) {

            return {

                ...result,

                status: STATUS.REVIEW_REQUIRED,

                verified: false,

                registered: false,

                receipt: null

            };

        }

        // PAID alone is insufficient.
        // The backend must confirm gateway verification,
        // registration and valid receipt information.

        if (result.status === STATUS.PAID) {

            const valid =

                result.verified === true &&

                result.gateway_payment_verified === true &&

                result.registered === true &&

                result.reconciliation_required === false &&

                result.checkout_state === 'CREATED' &&

                validateReceipt(
                    result.receipt,
                    orderReference
                );

            if (!valid) {

                throw new PaymentError(

                    'The payment confirmation is incomplete. ' +
                    'Please contact an administrator.',

                    {
                        status: STATUS.REVIEW_REQUIRED,

                        orderReference

                    }

                );

            }

            return result;

        }

        // Non-successful payment statuses must not
        // expose a successful receipt or registration.

        return {

            ...result,

            verified: false,

            registered: false,

            receipt: null

        };

    }


    // ========================================================
    // 11. PAYMENT DISPLAY HELPERS
    // ========================================================

    function formatAmount(amount) {

        if (
            amount === null ||
            amount === undefined ||
            amount === '' ||
            !Number.isFinite(Number(amount))
        ) {

            return '—';

        }

        return new Intl.NumberFormat('en-PH', {

            style: 'currency',

            currency: CONFIG.currency

        }).format(Number(amount));

    }


    function getStatusLabel(status) {

        const labels = {

            PENDING_PAYMENT: 'Pending Payment',

            PAID: 'Paid',

            FAILED: 'Failed',

            CANCELLED: 'Cancelled',

            REFUNDED: 'Refunded',

            REVIEW_REQUIRED: 'Requires Review',

            CHECKOUT_UNCERTAIN: 'Checkout Uncertain',
            SERVICE_NOT_READY: 'Service Not Ready'

        };

        return Object.hasOwn(labels, status)
            ? labels[status]
            : 'Unknown Status';

    }


    // ========================================================
    // 12. PUBLIC PAYMENT INTERFACE
    // ========================================================

    return Object.freeze({

        CONFIG,

        STATUS,

        PaymentError,

        createPayment,

        getPaymentStatus,

        formatAmount,

        getStatusLabel,

        isOrderReference

    });

})();
