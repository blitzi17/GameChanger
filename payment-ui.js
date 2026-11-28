
/* ============================================================
   GameChanger — HR Calabarzon
   payment-ui.js

   UC-PAM-01 — Process Payment
   HitPay Sandbox Interface Controller
============================================================ */

'use strict';

const GameChangerPaymentUI = (() => {

    // ========================================================
    // 1. SANDBOX CONFIGURATION
    // ========================================================

    const CONFIG = Object.freeze({


        get checkoutEnabled() {
            return GameChangerPayment.CONFIG.checkoutEnabled === true;
        },

        get paymentStatusEnabled() {
            return GameChangerPayment.CONFIG.paymentStatusEnabled === true;
        }

    });


    // ========================================================
    // 2. INTERFACE STATE
    // ========================================================

    let selectedSession = null;

    let currentOrderReference = null;

    let currentReceipt = null;

    let statusRequestInProgress = false;

    // HITPAY_FRONTEND_SECURITY_V1

    let requestGeneration = 0;

    let activeStatusController = null;

    let paymentOwnerId = null;

    let initialized = false;

    // HITPAY_CHECKOUT_CONTROLLER_V1

    let activeCheckoutController = null;

    let checkoutRequestInProgress = false;

    // Preserve unresolved attempts across interface resets
    // within the current browser page.

    // HITPAY_DUPLICATE_PROTECTION_V1

    const checkoutAttempts = new Map();

    const CHECKOUT_STORAGE_PREFIX =
        'gamechanger.hitpay.sandbox.attempt.v1:';


    function getCheckoutStorageKey(attemptKey) {

        return CHECKOUT_STORAGE_PREFIX + attemptKey;

    }


    function getCheckoutAttempt(attemptKey) {

        const memoryAttempt =
            checkoutAttempts.get(attemptKey);

        if (memoryAttempt) {
            return memoryAttempt;
        }

        try {

            const stored = window.localStorage.getItem(
                getCheckoutStorageKey(attemptKey)
            );

            if (stored === null) {
                return null;
            }

            const parsed = JSON.parse(stored);

            if (
                !parsed ||
                typeof parsed !== 'object' ||
                ![
                    'PENDING_PAYMENT',
                    'CHECKOUT_UNCERTAIN',
                    'REVIEW_REQUIRED'
                ].includes(parsed.status)
            ) {

                return {
                    status: 'CHECKOUT_UNCERTAIN',
                    orderReference: null
                };

            }

            return {

                status: parsed.status,

                orderReference:
                    GameChangerPayment.isOrderReference(
                        parsed.orderReference
                    )
                        ? parsed.orderReference
                        : null

            };

        } catch {

            // Storage failure must not silently
            // permit another checkout.

            return {
                status: 'CHECKOUT_UNCERTAIN',
                orderReference: null
            };

        }

    }


    function saveCheckoutAttempt(attemptKey, attempt) {

        const record = {

            status: attempt.status,

            orderReference:
                GameChangerPayment.isOrderReference(
                    attempt.orderReference
                )
                    ? attempt.orderReference
                    : null

        };

        checkoutAttempts.set(attemptKey, record);

        try {

            window.localStorage.setItem(

                getCheckoutStorageKey(attemptKey),

                JSON.stringify(record)

            );

            return true;

        } catch {

            return false;

        }

    }


    function clearCheckoutAttempt(attemptKey) {

        try {

            window.localStorage.removeItem(
                getCheckoutStorageKey(attemptKey)
            );

            checkoutAttempts.delete(attemptKey);

            return true;

        } catch {

            return false;

        }

    }


    function checkoutAttemptKey(userId, sessionId) {

        return `${userId}:${sessionId}`;

    }


    function checkoutIsReady() {

        return (
            CONFIG.checkoutEnabled &&
            CONFIG.paymentStatusEnabled &&
            GameChangerPayment.CONFIG
                .approvedCheckoutHostnames.length > 0
        );

    }


    function getActiveMemberId() {

        if (
            typeof currentRole === 'undefined' ||
            currentRole !== 'member' ||
            typeof loggedInUser === 'undefined' ||
            !loggedInUser ||
            typeof hitPayAuthenticatedUserId === 'undefined'
        ) {
            return null;
        }

        return hitPayAuthenticatedUserId || null;

    }


    function ownsPaymentInterface() {

        const userId = getActiveMemberId();

        return Boolean(
            userId &&
            paymentOwnerId &&
            userId === paymentOwnerId
        );

    }


    function clearReceiptFields() {

        currentReceipt = null;

        const fields = [
            'hp-receipt-session',
            'hp-receipt-order',
            'hp-receipt-transaction',
            'hp-receipt-registration',
            'hp-receipt-method',
            'hp-receipt-date',
            'hp-receipt-provider',
            'hp-receipt-status',
            'hp-receipt-amount',
            'hp-transaction-reference'
        ];

        fields.forEach(id => setValue(id, null));

        setHidden('hp-receipt-content', true);
        setHidden('hp-transaction-reference-box', true);
        setHidden('hp-view-receipt', true);
        setDisabled('hp-view-receipt', true);

    }


    // ========================================================
    // 3. DOM HELPERS
    // ========================================================

    function element(id) {

        const node = document.getElementById(id);

        if (!node) {

            throw new Error(
                `Payment interface element missing: ${id}`
            );

        }

        return node;

    }


    function setValue(id, value) {

        element(id).textContent =
            value === null || value === undefined
                ? '—'
                : String(value);

    }


    function setHidden(id, hidden) {

        element(id).hidden = hidden;

    }


    function setDisabled(id, disabled) {

        element(id).disabled = disabled;

    }


    // ========================================================
    // 4. SANDBOX SESSION IDENTIFICATION
    // ========================================================

    function isSandboxSession(sessionId) {

        const session = getSession(sessionId);
        const fee = Number(session?.fee);

        return !!session &&
            Number.isFinite(fee) &&
            fee > 0;

    }

    function canPayForSession(session) {

        if (!session) return false;

        if (!session.is_registered) return true;

        return [
            'UNPAID',
            'PENDING_PAYMENT'
        ].includes(session.payment_status);

    }


    function getSession(sessionId) {

        const sessions = md().upcoming || [];

        return sessions.find(
            session => session.session_id === sessionId
        ) || null;

    }


    // ========================================================
    // 5. CHECKOUT MESSAGE
    // ========================================================

    function showCheckoutMessage(message) {

        setValue(
            'hp-checkout-message',
            message
        );

        setHidden(
            'hp-checkout-message',
            !message
        );

    }


    // ========================================================
    // 6. OPEN CHECKOUT INTERFACE
    // ========================================================

    function openCheckout(sessionId) {

        if (!getActiveMemberId()) {

            showToast(
                'Please sign in as a member.',
                'error'
            );

            return false;

        }

        if (!isSandboxSession(sessionId)) {

            showToast(
                'This session is not configured for HitPay Sandbox.',
                'error'
            );

            return false;

        }

        const session = getSession(sessionId);

        if (!session) {

            showToast(
                'The selected session is unavailable.',
                'error'
            );

            return false;

        }

        const amount = Number(session.fee);

        if (!Number.isFinite(amount) || amount <= 0) {

            showToast(
                'Invalid session admission fee.',
                'error'
            );

            return false;

        }

        if (!canPayForSession(session)) {

            showToast(
                'This registration is not eligible for another payment.',
                'info'
            );

            return false;

        }

        initialize();

        if (checkoutRequestInProgress) {

            showToast(
                'A checkout request is already in progress.',
                'info'
            );

            return false;

        }

        reset();

        paymentOwnerId = getActiveMemberId();

        if (!paymentOwnerId) {
            return false;
        }

        setCheckoutButtonLabel(
            'Continue to HitPay'
        );

        selectedSession = Object.freeze({

            session_id: session.session_id,

            title: String(session.title || ''),

            fee: amount

        });

        setValue(
            'hp-session-title',
            session.title
        );

        setValue(
            'hp-session-amount',
            GameChangerPayment.formatAmount(amount)
        );

        const attemptKey = checkoutAttemptKey(
            paymentOwnerId,
            sessionId
        );

        // HITPAY_INDEPENDENT_STATUS_RECOVERY_V1
        // Existing payment recovery must remain available
        // independently of new checkout creation.

        const previousAttempt =
            CONFIG.paymentStatusEnabled
                ? getCheckoutAttempt(attemptKey)
                : checkoutAttempts.get(attemptKey);

        const ready =
            checkoutIsReady() && !previousAttempt;

        setDisabled('hp-checkout-go', !ready);

        if (previousAttempt) {

            showCheckoutRecovery(
                previousAttempt
            );

        } else if (!ready) {

            showCheckoutMessage(
                'Sandbox checkout is not enabled yet. ' +
                'No payment has been initiated.'
            );

        } else {

            showCheckoutMessage(
                'You will be redirected to HitPay Sandbox. ' +
                'Do not use real payment details.'
            );

        }

        openMo('hp-checkout-mo');

        return true;

    }




    // HITPAY_CHECKOUT_RECOVERY_V1

    function setCheckoutButtonLabel(label) {

        setValue('hp-checkout-go', label);

    }


    function showCheckoutRecovery(attempt) {

        setDisabled('hp-checkout-go', true);

        setCheckoutButtonLabel('Continue to HitPay');

        const orderReference =
            GameChangerPayment.isOrderReference(
                attempt?.orderReference
            )
                ? attempt.orderReference
                : null;

        const requiresReview =
            attempt?.status === 'REVIEW_REQUIRED';

        if (!orderReference) {

            showCheckoutMessage(
                'An earlier checkout could not be confirmed. ' +
                'Do not initiate another payment. ' +
                'Contact an administrator for assistance.'
            );

            return;

        }

        const message = requiresReview

            ? 'This payment requires administrator review. '

            : 'An earlier payment requires confirmation. ';

        showCheckoutMessage(
            message +
            'Order reference: ' +
            orderReference +
            '. Do not initiate another payment.'
        );

        if (CONFIG.paymentStatusEnabled) {

            setCheckoutButtonLabel(
                'Check Payment Status'
            );

            setDisabled(
                'hp-checkout-go',
                false
            );

        }

    }


    async function handleCheckoutButton() {

        if (
            !ownsPaymentInterface() ||
            !selectedSession ||
            checkoutRequestInProgress ||
            statusRequestInProgress
        ) {

            return false;

        }

        const userId = paymentOwnerId;

        const sessionId =
            selectedSession.session_id;

        if (!isSandboxSession(sessionId)) {

            return false;

        }

        const attemptKey = checkoutAttemptKey(
            userId,
            sessionId
        );

        const attempt = CONFIG.paymentStatusEnabled

            ? getCheckoutAttempt(attemptKey)

            : checkoutAttempts.get(attemptKey);

        if (attempt) {

            if (
                !CONFIG.paymentStatusEnabled ||
                !GameChangerPayment.isOrderReference(
                    attempt.orderReference
                )
            ) {

                showCheckoutRecovery(attempt);

                return false;

            }

            // Retrieve authoritative recorded status.
            // Never create another payment during recovery.

            setDisabled('hp-checkout-go', true);

            return await openStatus(
                attempt.orderReference
            );

        }

        return await continueToHitPay();

    }


    // ========================================================
    // CHECKOUT REQUEST CONTROLLER
    // ========================================================

    async function continueToHitPay() {

        if (
            !checkoutIsReady() ||
            checkoutRequestInProgress ||
            !ownsPaymentInterface() ||
            !selectedSession
        ) {
            return false;
        }

        const sessionId = selectedSession.session_id;

        const userId = paymentOwnerId;

        const session = getSession(sessionId);

        if (
            !isSandboxSession(sessionId) ||
            !session ||
            !canPayForSession(session)
        ) {

            showCheckoutMessage(
                'The selected session is no longer available.'
            );

            setDisabled('hp-checkout-go', true);

            return false;

        }

        const expectedAmount = Number(session.fee);

        if (
            !Number.isFinite(expectedAmount) ||
            expectedAmount <= 0 ||
            expectedAmount !== Number(selectedSession.fee)
        ) {

            showCheckoutMessage(
                'The admission fee has changed. ' +
                'Please reopen the session.'
            );

            setDisabled('hp-checkout-go', true);

            return false;

        }

        const attemptKey = checkoutAttemptKey(
            userId,
            sessionId
        );

        const existingAttempt =
            getCheckoutAttempt(attemptKey);

        if (existingAttempt) {

            showCheckoutRecovery(
                existingAttempt
            );

            return false;

        }

        const generation = ++requestGeneration;

        const controller = new AbortController();

        activeCheckoutController = controller;

        checkoutRequestInProgress = true;

        const attemptSaved = saveCheckoutAttempt(
            attemptKey,
            {
                status: 'CHECKOUT_UNCERTAIN',
                orderReference: null
            }
        );

        if (!attemptSaved) {

            activeCheckoutController = null;

            checkoutRequestInProgress = false;

            controller.abort();

            setDisabled('hp-checkout-go', true);

            showCheckoutMessage(
                'Checkout protection is unavailable. ' +
                'No payment request was sent.'
            );

            return false;

        }


        function isCurrentRequest() {

            return (
                generation === requestGeneration &&
                activeCheckoutController === controller &&
                !controller.signal.aborted &&
                paymentOwnerId === userId &&
                getActiveMemberId() === userId &&
                selectedSession?.session_id === sessionId
            );

        }


        try {

            setDisabled('hp-checkout-go', true);

            showCheckoutMessage(
                'Preparing your sandbox checkout...'
            );

            const result =
                await GameChangerPayment.createPayment(
                    sessionId,
                    {
                        expectedUserId: userId,
                        signal: controller.signal
                    }
                );

            if (!isCurrentRequest()) {
                return false;
            }

            const orderReference =
                GameChangerPayment.isOrderReference(
                    result.orderReference
                )
                    ? result.orderReference
                    : null;

            if (!saveCheckoutAttempt(attemptKey, {
                status: 'CHECKOUT_UNCERTAIN',
                orderReference
            })) {

                throw new GameChangerPayment.PaymentError(
                    'Checkout protection could not be saved.',
                    {
                        status: 'CHECKOUT_UNCERTAIN',
                        orderReference
                    }
                );

            }

            if (
                result.status !== 'PENDING_PAYMENT' ||
                result.checkoutState !== 'CREATED' ||
                result.provider !== 'HitPay' ||
                result.environment !== 'sandbox' ||
                result.currency !== 'PHP' ||
                result.amount !== expectedAmount ||
                !orderReference
            ) {

                throw new GameChangerPayment.PaymentError(
                    'Checkout confirmation is incomplete.',
                    {
                        status: 'CHECKOUT_UNCERTAIN',
                        orderReference
                    }
                );

            }

            // Defense in depth: validate the destination
            // again immediately before browser navigation.

            const destination = new URL(result.checkoutURL);

            if (
                destination.protocol !== 'https:' ||
                destination.username ||
                destination.password ||
                destination.port ||
                destination.hash ||
                destination.pathname === '/' ||
                !GameChangerPayment.CONFIG
                    .approvedCheckoutHostnames.includes(
                        destination.hostname
                    )
            ) {

                throw new GameChangerPayment.PaymentError(
                    'The checkout destination is not approved.',
                    {
                        status: 'CHECKOUT_UNCERTAIN',
                        orderReference
                    }
                );

            }

            // Confirm that the authenticated account has
            // not changed since the API response arrived.

            const { data, error } =
                await sb.auth.getSession();

            if (!isCurrentRequest()) {
                return false;
            }

            if (
                error ||
                data?.session?.user?.id !== userId ||
                !checkoutIsReady()
            ) {

                throw new GameChangerPayment.PaymentError(
                    'Checkout could not be safely continued.',
                    {
                        status: 'CHECKOUT_UNCERTAIN',
                        orderReference
                    }
                );

            }

            if (!saveCheckoutAttempt(attemptKey, {
                status: 'PENDING_PAYMENT',
                orderReference
            })) {

                throw new GameChangerPayment.PaymentError(
                    'Unable to preserve checkout state.',
                    {
                        status: 'CHECKOUT_UNCERTAIN',
                        orderReference
                    }
                );

            }

            showCheckoutMessage(
                'Redirecting to HitPay Sandbox...'
            );

            window.location.assign(destination.href);

            return true;

        } catch (error) {

            if (!isCurrentRequest()) {
                return false;
            }

            const previous =
                getCheckoutAttempt(attemptKey);

            const orderReference =
                GameChangerPayment.isOrderReference(
                    error?.orderReference
                )
                    ? error.orderReference
                    : previous?.orderReference || null;

            // Only a confirmed readiness rejection can
            // safely remove this local attempt lock.

            if (
                error?.status === 'SERVICE_NOT_READY' &&
                error?.reconciliationRequired === false &&
                !orderReference
            ) {

                clearCheckoutAttempt(attemptKey);

                showCheckoutMessage(
                    'Sandbox checkout is unavailable. ' +
                    'No new payment was initiated.'
                );

                return false;

            }

            saveCheckoutAttempt(attemptKey, {

                status:
                    error?.status === 'REVIEW_REQUIRED'
                        ? 'REVIEW_REQUIRED'
                        : 'CHECKOUT_UNCERTAIN',

                orderReference

            });

            showCheckoutRecovery({

                status:
                    error?.status === 'REVIEW_REQUIRED'
                        ? 'REVIEW_REQUIRED'
                        : 'CHECKOUT_UNCERTAIN',

                orderReference

            });

            return false;

        } finally {

            if (isCurrentRequest()) {

                activeCheckoutController = null;

                checkoutRequestInProgress = false;

                const unresolved =
                    getCheckoutAttempt(attemptKey);

                if (
                    unresolved &&
                    unresolved.status !== 'PENDING_PAYMENT'
                ) {

                    showCheckoutRecovery(unresolved);

                } else {

                    setDisabled(
                        'hp-checkout-go',
                        true
                    );

                }

            }

        }

    }


    // ========================================================
    // 7. PAYMENT STATUS DISPLAY
    // ========================================================

    // HITPAY_CONTINUATION_CONTROLLER_V1

    function hideContinuation() {
        setHidden('hp-status-continue', true);
        setDisabled('hp-status-continue', true);
    }

    async function resumeExistingPayment() {

        if (
            !checkoutIsReady() ||
            !ownsPaymentInterface() ||
            checkoutRequestInProgress ||
            statusRequestInProgress ||
            !GameChangerPayment.isOrderReference(
                currentOrderReference
            ) ||
            element('hp-status-continue').hidden ||
            element('hp-status-continue').disabled
        ) {
            return false;
        }

        const orderReference = currentOrderReference;
        const userId = paymentOwnerId;
        const generation = ++requestGeneration;
        const controller = new AbortController();

        activeCheckoutController = controller;
        checkoutRequestInProgress = true;

        function isCurrentRequest() {
            return (
                generation === requestGeneration &&
                activeCheckoutController === controller &&
                !controller.signal.aborted &&
                currentOrderReference === orderReference &&
                paymentOwnerId === userId &&
                getActiveMemberId() === userId
            );
        }

        hideContinuation();
        setDisabled('hp-status-refresh', true);

        try {

            setValue(
                'hp-status-message',
                'Verifying your existing checkout...'
            );

            const status =
                await GameChangerPayment.getPaymentStatus(
                    orderReference,
                    {
                        expectedUserId: userId,
                        signal: controller.signal
                    }
                );

            if (!isCurrentRequest()) {
                return false;
            }

            if (
                status.can_continue_payment !== true ||
                status.status !== 'PENDING_PAYMENT' ||
                status.order_reference !== orderReference
            ) {
                renderStatus(status);
                return false;
            }

            const sessionId = status.session_id;

            const attemptKey = checkoutAttemptKey(
                userId,
                sessionId
            );

            const existingAttempt =
                getCheckoutAttempt(attemptKey);

            if (
                existingAttempt &&
                (
                    existingAttempt.orderReference !==
                        orderReference ||
                    existingAttempt.status === 'REVIEW_REQUIRED'
                )
            ) {
                throw new Error(
                    'An unresolved checkout requires verification.'
                );
            }

            if (!saveCheckoutAttempt(attemptKey, {
                status: 'PENDING_PAYMENT',
                orderReference
            })) {
                throw new Error(
                    'Checkout protection is unavailable.'
                );
            }

            const result =
                await GameChangerPayment.createPayment(
                    sessionId,
                    {
                        expectedUserId: userId,
                        resumeOrderReference: orderReference,
                        signal: controller.signal
                    }
                );

            if (!isCurrentRequest()) {
                return false;
            }

            if (
                result.resumed !== true ||
                result.orderReference !== orderReference ||
                result.transactionId !== status.transaction_id ||
                result.status !== 'PENDING_PAYMENT' ||
                result.checkoutState !== 'CREATED' ||
                result.provider !== 'HitPay' ||
                result.environment !== 'sandbox' ||
                result.currency !== 'PHP' ||
                result.amount !== Number(status.amount)
            ) {
                throw new Error(
                    'The original checkout could not be confirmed.'
                );
            }

            const destination = new URL(result.checkoutURL);

            if (
                destination.protocol !== 'https:' ||
                destination.username ||
                destination.password ||
                destination.port ||
                destination.hash ||
                destination.pathname === '/' ||
                !GameChangerPayment.CONFIG
                    .approvedCheckoutHostnames.includes(
                        destination.hostname
                    )
            ) {
                throw new Error(
                    'The checkout destination is not approved.'
                );
            }

            const { data, error } =
                await sb.auth.getSession();

            if (!isCurrentRequest()) {
                return false;
            }

            if (
                error ||
                data?.session?.user?.id !== userId ||
                !checkoutIsReady()
            ) {
                throw new Error(
                    'Checkout could not be safely continued.'
                );
            }

            if (!saveCheckoutAttempt(attemptKey, {
                status: 'PENDING_PAYMENT',
                orderReference
            })) {
                throw new Error(
                    'Unable to preserve checkout protection.'
                );
            }

            setValue(
                'hp-status-message',
                'Returning to your existing HitPay checkout...'
            );

            window.location.assign(destination.href);

            return true;

        } catch (error) {

            if (!isCurrentRequest()) {
                return false;
            }

            renderStatus({
                status: error?.status === 'REVIEW_REQUIRED'
                    ? 'REVIEW_REQUIRED'
                    : 'CHECKOUT_UNCERTAIN',
                message:
                    'Unable to continue the existing checkout. ' +
                    'Check Payment Status again.',
                verified: false,
                registered: false,
                can_continue_payment: false,
                receipt: null
            });

            return false;

        } finally {

            if (isCurrentRequest()) {
                activeCheckoutController = null;
                checkoutRequestInProgress = false;
                setDisabled('hp-status-refresh', false);
            }

        }

    }

    function renderStatus(result) {

        if (!ownsPaymentInterface()) {
            return;
        }

        // HITPAY_RECEIPT_VISIBILITY_PROTECTION_V1

        const validPaid =
            result.status === 'PAID' &&
            result.verified === true &&
            result.gateway_payment_verified === true &&
            result.registered === true &&
            result.reconciliation_required === false &&
            result.receipt &&
            result.receipt.payment_status === 'PAID' &&
            result.receipt.payment_provider === 'HitPay' &&
            result.receipt.is_sandbox === true &&
            result.receipt.order_reference ===
                currentOrderReference &&
            typeof result.receipt.transaction_reference ===
                'string' &&
            result.receipt.transaction_reference.trim() !== '';

        if (result.status === 'PAID' && !validPaid) {

            result = {
                status: 'REVIEW_REQUIRED',
                message: 'Payment confirmation is incomplete.',
                verified: false,
                registered: false,
                receipt: null
            };

        }

        const status = result.status;

        hideContinuation();

        const canContinue =
            checkoutIsReady() &&
            status === 'PENDING_PAYMENT' &&
            result.can_continue_payment === true &&
            result.order_reference === currentOrderReference &&
            result.reconciliation_required === false &&
            result.verified === false &&
            result.registered === false;

        if (canContinue) {
            setHidden('hp-status-continue', false);
            setDisabled('hp-status-continue', false);
        }

        const statusBox = element('hp-status-box');

        clearReceiptFields();

        setHidden(
            'hp-transaction-reference-box',
            true
        );

        setHidden(
            'hp-view-receipt',
            true
        );

        setDisabled(
            'hp-view-receipt',
            true
        );

        setHidden(
            'hp-review-notice',
            true
        );

        const appearances = {

            PENDING_PAYMENT: {
                css: 'hp-status-pending',
                icon: '⏳'
            },

            PAID: {
                css: 'hp-status-paid',
                icon: '✓'
            },

            FAILED: {
                css: 'hp-status-failed',
                icon: '✕'
            },

            CANCELLED: {
                css: 'hp-status-cancelled',
                icon: '✕'
            },

            REFUNDED: {
                css: 'hp-status-neutral',
                icon: '↩'
            },

            REVIEW_REQUIRED: {
                css: 'hp-status-review',
                icon: '!'
            },

            CHECKOUT_UNCERTAIN: {
                css: 'hp-status-review',
                icon: '!'
            }

        };

        const appearance =
            Object.hasOwn(appearances, status)
                ? appearances[status]
                : {
                    css: 'hp-status-neutral',
                    icon: '?'
                };

        statusBox.className =
            `hp-status ${appearance.css}`;

        setValue(
            'hp-status-icon',
            appearance.icon
        );

        setValue(
            'hp-status-title',
            GameChangerPayment.getStatusLabel(status)
        );

        // HITPAY_STATUS_ACTION_GUIDANCE_V1

        const actionGuidance = {

            PENDING_PAYMENT:
                canContinue
                    ? 'Select Continue Payment to reopen your existing checkout.'
                    : 'Check Payment Status again for updates. ' +
                      'Do not start another payment.',

            PAID:
                'Your verified payment receipt is available.',

            FAILED:
                'Contact the GameChanger administrator ' +
                'before attempting another payment.',

            CANCELLED:
                'Contact the GameChanger administrator ' +
                'before attempting another payment.',

            REFUNDED:
                'Contact the GameChanger administrator ' +
                'for clarification about the recorded refund.',

            REVIEW_REQUIRED:
                'Provide your Order Reference to the ' +
                'GameChanger administrator if unresolved.',

            CHECKOUT_UNCERTAIN:
                'Check your existing payment status. ' +
                'Do not start another payment.'

        };

        const statusMessage =
            result.message ||
            'Payment status is currently unavailable.';

        const guidance =
            Object.hasOwn(actionGuidance, status)
                ? actionGuidance[status]
                : 'Contact the GameChanger administrator.';

        setValue(
            'hp-status-message',
            statusMessage + ' ' + guidance
        );

        if (
            status === 'REVIEW_REQUIRED' ||
            status === 'CHECKOUT_UNCERTAIN' ||
            result.reconciliation_required === true
        ) {

            setHidden(
                'hp-review-notice',
                false
            );

        }

        // A receipt is displayed only after the
        // payment module validates the backend response.

        if (validPaid) {

            currentReceipt = result.receipt;

            setValue(
                'hp-transaction-reference',
                currentReceipt.transaction_reference
            );

            setHidden(
                'hp-transaction-reference-box',
                false
            );

            setHidden(
                'hp-view-receipt',
                false
            );

            setDisabled(
                'hp-view-receipt',
                false
            );

        }

    }


    // ========================================================
    // 8. REFRESH PAYMENT STATUS
    // ========================================================


    async function refreshStatus() {

        if (!CONFIG.paymentStatusEnabled) {

            setDisabled('hp-status-refresh', true);

            return false;

        }

        if (
            statusRequestInProgress ||
            checkoutRequestInProgress ||
            !ownsPaymentInterface() ||
            !GameChangerPayment.isOrderReference(
                currentOrderReference
            )
        ) {
            return false;
        }

        const requestedOrder = currentOrderReference;

        const requestedUser = paymentOwnerId;

        const generation = ++requestGeneration;

        const controller = new AbortController();

        activeStatusController = controller;

        statusRequestInProgress = true;

        function isCurrentRequest() {

            return (
                generation === requestGeneration &&
                activeStatusController === controller &&
                !controller.signal.aborted &&
                currentOrderReference === requestedOrder &&
                paymentOwnerId === requestedUser &&
                getActiveMemberId() === requestedUser
            );

        }

        try {

            clearReceiptFields();

            hideContinuation();

            setDisabled('hp-status-refresh', true);

            element('hp-status-box').className =
                'hp-status hp-status-neutral';

            setValue('hp-status-icon', '…');

            setValue('hp-status-title', 'Checking Status');

            setValue(
                'hp-status-message',
                'Checking recorded payment status...'
            );

            setHidden('hp-review-notice', true);

            const result =
                await GameChangerPayment.getPaymentStatus(
                    requestedOrder,
                    {
                        expectedUserId: requestedUser,
                        signal: controller.signal
                    }
                );

            if (!isCurrentRequest()) {
                return false;
            }

            renderStatus(result);

            // Dashboard refresh is intentionally deferred.
            // Existing dashboard loaders require separate
            // account-switching protection.

            return true;

        } catch (error) {

            if (!isCurrentRequest()) {
                return false;
            }

            renderStatus({
                status:
                    error.status === 'REVIEW_REQUIRED'
                        ? 'REVIEW_REQUIRED'
                        : 'CHECKOUT_UNCERTAIN',

                message:
                    error.message ||
                    'Unable to verify payment status.',

                verified: false,
                registered: false,
                receipt: null
            });

            return false;

        } finally {

            if (isCurrentRequest()) {

                activeStatusController = null;

                statusRequestInProgress = false;

                setDisabled(
                    'hp-status-refresh',
                    false
                );

            }

        }

    }


    // ========================================================
    // 9. OPEN PAYMENT STATUS
    // ========================================================


    async function openStatus(orderReference) {

        if (!CONFIG.paymentStatusEnabled) {

            showToast(
                'HitPay Sandbox payment status is not enabled yet.',
                'info'
            );

            return false;

        }

        const userId = getActiveMemberId();

        if (!userId) {
            return false;
        }

        if (
            !GameChangerPayment.isOrderReference(
                orderReference
            )
        ) {

            showToast(
                'Invalid payment order reference.',
                'error'
            );

            return false;

        }

        initialize();

        if (
            statusRequestInProgress ||
            checkoutRequestInProgress
        ) {
            return false;
        }

        reset();

        paymentOwnerId = userId;

        currentOrderReference = orderReference;

        setValue(
            'hp-order-reference',
            orderReference
        );

        openMo('hp-status-mo');

        return await refreshStatus();

    }


    // ========================================================
    // 10. VERIFIED RECEIPT DISPLAY
    // ========================================================

    function openReceipt() {

        if (
            !ownsPaymentInterface() ||
            !currentReceipt ||
            currentReceipt.payment_status !== 'PAID' ||
            currentReceipt.payment_provider !== 'HitPay' ||
            currentReceipt.is_sandbox !== true ||
            currentReceipt.order_reference !==
                currentOrderReference
        ) {

            showToast(
                'A verified sandbox receipt is unavailable.',
                'error'
            );

            return;

        }

        const receipt = currentReceipt;

        setValue(
            'hp-receipt-session',
            receipt.session_title
        );

        setValue(
            'hp-receipt-order',
            receipt.order_reference
        );

        setValue(
            'hp-receipt-transaction',
            receipt.transaction_reference
        );

        setValue(
            'hp-receipt-registration',
            receipt.registration_id
        );

        setValue(
            'hp-receipt-method',
            receipt.payment_method
        );

        setValue(
            'hp-receipt-date',
            new Date(
                receipt.payment_date
            ).toLocaleString('en-PH', {
                timeZone: 'Asia/Manila'
            })
        );

        setValue(
            'hp-receipt-provider',
            receipt.payment_provider
        );

        setValue(
            'hp-receipt-status',
            receipt.payment_status
        );

        setValue(
            'hp-receipt-amount',
            GameChangerPayment.formatAmount(
                receipt.amount
            )
        );

        setHidden(
            'hp-receipt-content',
            false
        );

        closeMo('hp-status-mo');

        openMo('hp-receipt-mo');

    }


    // ========================================================
    // 11. RESET PAYMENT INTERFACE
    // ========================================================


    function reset() {

        hideContinuation();

        requestGeneration += 1;

        const previousCheckoutController =
            activeCheckoutController;

        activeCheckoutController = null;

        checkoutRequestInProgress = false;

        if (previousCheckoutController) {
            previousCheckoutController.abort();
        }

        // Unresolved checkout attempts remain locked.
        // Aborting a browser request does not prove that
        // the backend cancelled its transaction.

        const previousController =
            activeStatusController;

        activeStatusController = null;

        statusRequestInProgress = false;

        paymentOwnerId = null;

        selectedSession = null;

        currentOrderReference = null;

        currentReceipt = null;

        if (previousController) {
            previousController.abort();
        }

        clearReceiptFields();

        [
            'hp-order-reference',
            'hp-session-title',
            'hp-session-amount',
            'hp-checkout-message',
            'hp-status-icon',
            'hp-status-title',
            'hp-status-message'
        ].forEach(id => setValue(id, null));

        element('hp-status-box').className =
            'hp-status hp-status-neutral';

        setHidden('hp-review-notice', true);

        setHidden('hp-checkout-message', true);

        setDisabled('hp-status-refresh', true);

        setDisabled('hp-checkout-go', true);

        setCheckoutButtonLabel(
            'Continue to HitPay'
        );

        closeMo('hp-checkout-mo');

        closeMo('hp-status-mo');

        closeMo('hp-receipt-mo');

    }


    // ========================================================
    // 12. INITIALIZE INTERFACE HANDLERS
    // ========================================================

    function initialize() {

        if (initialized) {
            return;
        }

        reset();

        setDisabled(
            'hp-checkout-go',
            true
        );

        element(
            'hp-checkout-go'
        ).addEventListener(
            'click',
            handleCheckoutButton
        );

        element(
            'hp-status-refresh'
        ).addEventListener(
            'click',
            refreshStatus
        );

        element(
            'hp-status-continue'
        ).addEventListener(
            'click',
            resumeExistingPayment
        );

        element(
            'hp-view-receipt'
        ).addEventListener(
            'click',
            openReceipt
        );

        initialized = true;

    }


    // ========================================================
    // 13. PUBLIC INTERFACE
    // ========================================================

    return Object.freeze({

        CONFIG,

        initialize,

        isSandboxSession,

        openCheckout,

        openStatus,

        reset

    });

})();
