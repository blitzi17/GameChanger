
/* ============================================================
   GameChanger — HR Calabarzon
   payment-return.js

   UC-PAM-01 — Process Payment
   HitPay Sandbox Payment Return Handler

   A browser redirect is NOT proof of successful payment.
============================================================ */

'use strict';

const GameChangerPaymentReturn = (() => {

    // ========================================================
    // 1. RETURN HANDLER STATE
    // ========================================================

    let pendingOrderReference = null;

    let processing = false;

    let generation = 0;


    // ========================================================
    // 2. VALIDATE ORDER REFERENCE
    // ========================================================

    function isValidOrderReference(value) {

        return typeof value === 'string' &&

            /^GC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                .test(value);

    }


    // ========================================================
    // 3. CAPTURE PAYMENT RETURN PARAMETERS
    // ========================================================

    function captureReturn() {

        const url = new URL(window.location.href);

        const returnValues =
            url.searchParams.getAll('payment_return');

        const orderValues =
            url.searchParams.getAll('order_reference');

        if (
            returnValues.length !== 1 ||
            returnValues[0] !== 'true'
        ) {

            return false;

        }

        if (
            orderValues.length !== 1 ||
            !isValidOrderReference(orderValues[0])
        ) {

            console.warn(
                '[HitPay Sandbox] Invalid payment return reference.'
            );

            return false;

        }

        pendingOrderReference = orderValues[0];

        return true;

    }


    // ========================================================
    // 4. REMOVE PAYMENT RETURN PARAMETERS
    // ========================================================

    function cleanPaymentReturnURL() {

        try {

            const url = new URL(
                window.location.href
            );

            url.searchParams.delete(
                'payment_return'
            );

            url.searchParams.delete(
                'order_reference'
            );

            // Preserve unrelated authentication parameters
            // and the existing URL fragment.

            window.history.replaceState(

                window.history.state,

                '',

                url.pathname +
                url.search +
                url.hash

            );

        } catch (error) {

            console.warn(
                '[HitPay Sandbox] Unable to clean payment return URL.'
            );

        }

    }


    // ========================================================
    // 5. CHECK FOR A PENDING RETURN
    // ========================================================

    function hasPendingReturn() {

        return isValidOrderReference(
            pendingOrderReference
        );

    }


    // ========================================================
    // 6. HANDLE AUTHENTICATED MEMBER RETURN
    // ========================================================

    async function handleAuthenticatedReturn() {

        if (
            processing ||
            !hasPendingReturn()
        ) {

            return false;

        }

        if (
            typeof GameChangerPaymentUI === 'undefined' ||
            typeof GameChangerPayment === 'undefined' ||
            typeof sb === 'undefined'
        ) {

            return false;

        }

        if (
            typeof currentRole === 'undefined' ||
            currentRole !== 'member' ||
            typeof loggedInUser === 'undefined' ||
            !loggedInUser
        ) {

            return false;

        }

        // Keep the captured order reference available.
        // Do not contact an unavailable backend.

        if (
            GameChangerPayment.CONFIG.paymentStatusEnabled !== true
        ) {
            return false;
        }

        const expectedUserId =
            typeof hitPayAuthenticatedUserId !== 'undefined'
                ? hitPayAuthenticatedUserId
                : null;

        if (!expectedUserId) {
            return false;
        }

        processing = true;

        const activeGeneration = generation;

        function isCurrentReturn() {

            return (
                activeGeneration === generation &&
                hitPayAuthenticatedUserId === expectedUserId &&
                currentRole === 'member' &&
                Boolean(loggedInUser)
            );

        }

        const orderReference =
            pendingOrderReference;

        try {

            // Confirm that an authenticated session exists.

            const { data, error } =
                await sb.auth.getSession();

            if (
                error ||
                !data?.session?.access_token ||
                data.session.user?.id !== expectedUserId
            ) {

                return false;

            }

            if (
                !isCurrentReturn()
            ) {

                return false;

            }

            // The payment controller requests the recorded
            // backend status using the authenticated session.
            //
            // The URL reference alone cannot confirm payment.

            const handled =
                await GameChangerPaymentUI.openStatus(
                    orderReference
                );

            if (
                !handled ||
                !isCurrentReturn()
            ) {

                return false;

            }

            pendingOrderReference = null;

            cleanPaymentReturnURL();

            return true;

        } catch (error) {

            console.error(
                '[HitPay Sandbox] Payment return handling failed.'
            );

            if (
                isCurrentReturn() &&
                typeof showToast === 'function'
            ) {

                showToast(

                    'Unable to check the payment status. ' +
                    'Please check your payment records.',

                    'error'

                );

            }

            return false;

        } finally {

            if (activeGeneration === generation) {

                processing = false;

            }

        }

    }


    // ========================================================
    // 7. CLEAR RETURN STATE
    // ========================================================

    function reset() {

        generation += 1;

        processing = false;

        pendingOrderReference = null;

        cleanPaymentReturnURL();

    }


    // ========================================================
    // 8. CAPTURE PARAMETERS IMMEDIATELY
    // ========================================================

    // This file must load before script.js so that
    // the existing authentication logic cannot remove
    // the payment return parameters before capture.

    captureReturn();


    // ========================================================
    // 9. PUBLIC INTERFACE
    // ========================================================

    return Object.freeze({

        hasPendingReturn,

        handleAuthenticatedReturn,

        reset

    });

})();
