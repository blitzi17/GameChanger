
/* ============================================================
   GameChanger — HR Calabarzon
   UC-PAM-01 — Process Payment

   HitPay Frontend Functional Tests

   Uses simulated authentication, DOM elements and API responses.

   No real network requests.
   No database changes.
   No checkout creation.
============================================================ */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const USER_A = '11111111-1111-4111-8111-111111111111';

const USER_B = '22222222-2222-4222-8222-222222222222';

const ORDER = 'GC-33333333-3333-4333-8333-333333333333';

const SESSION = 'cd2f1fa3-c011-481f-b8fa-333354d14e27';

const SOURCES = {};

for (const name of [
    'payment.js',
    'payment-ui.js',
    'payment-return.js'
]) {

    SOURCES[name] = fs.readFileSync(
        path.join(ROOT, name),
        'utf8'
    );

}

let passed = 0;
let failed = 0;


// ============================================================
// 1. SIMULATED PAYMENT RESPONSES
// ============================================================

function pendingResponse() {

    return {
        success: true,
        status: 'PENDING_PAYMENT',
        order_reference: ORDER,
        verified: false,
        registered: false,
        reconciliation_required: false,
        receipt: null,
        message: 'Payment is pending.'
    };

}


function paidResponse() {

    return {
        success: true,
        status: 'PAID',
        order_reference: ORDER,
        verified: true,
        gateway_payment_verified: true,
        registered: true,
        reconciliation_required: false,
        checkout_state: 'CREATED',
        message: 'Payment verified.',

        receipt: {
            transaction_id:
                '44444444-4444-4444-8444-444444444444',

            registration_id:
                '55555555-5555-4555-8555-555555555555',

            session_id: SESSION,

            order_reference: ORDER,

            transaction_reference: 'TEST-TRANSACTION-001',

            session_title: 'Sandbox Test Session',

            payment_method: 'GCASH',

            payment_date: '2026-11-24T08:00:00Z',

            payment_status: 'PAID',

            payment_provider: 'HitPay',

            amount: 100,

            currency: 'PHP',

            is_sandbox: true
        }
    };

}


// ============================================================
// 2. DEFERRED PROMISE HELPER
// ============================================================

function deferred() {

    let resolve;
    let reject;

    const promise = new Promise((res, rej) => {

        resolve = res;
        reject = rej;

    });

    return {
        promise,
        resolve,
        reject
    };

}


// ============================================================
// 3. SIMULATED BROWSER ENVIRONMENT
// ============================================================

function createEnvironment(options = {}) {

    const nodes = new Map();

    const modals = new Set();

    const notifications = [];

    let networkCalls = 0;

    let sessionUser = USER_A;

    let statusCalls = 0;

    const location = {

        href:
            options.url ||
            'https://example.invalid/'

    };


    function getElement(id) {

        if (!nodes.has(id)) {

            nodes.set(id, {

                textContent: '',

                hidden: false,

                disabled: false,

                className: '',

                listeners: [],

                addEventListener(event, handler) {

                    this.listeners.push({
                        event,
                        handler
                    });

                }

            });

        }

        return nodes.get(id);

    }


    const context = vm.createContext({

        console: {
            log() {},
            warn() {},
            error() {}
        },

        URL,

        AbortController,

        setTimeout,

        clearTimeout,

        Intl,

        currentRole: 'member',

        loggedInUser: {
            id: 'TEST-MEMBER'
        },

        hitPayAuthenticatedUserId: USER_A,

        SUPABASE_URL:
            'https://example.invalid',

        SUPABASE_ANON_KEY:
            'SIMULATED-KEY',

        document: {

            getElementById: getElement

        },

        window: {

            location,

            history: {

                state: null,

                replaceState(state, title, nextURL) {

                    location.href = new URL(
                        nextURL,
                        location.href
                    ).href;

                }

            }

        },

        sb: {

            auth: {

                async getSession() {

                    return {

                        data: {

                            session: sessionUser
                                ? {

                                    access_token:
                                        'SIMULATED-TOKEN',

                                    user: {
                                        id: sessionUser
                                    }

                                }
                                : null

                        },

                        error: null

                    };

                }

            }

        },

        md() {

            return {

                upcoming: [

                    {
                        session_id: SESSION,
                        title: 'Sandbox Test Session',
                        fee: 100,
                        is_registered: false
                    }

                ]

            };

        },

        openMo(id) {

            modals.add(id);

        },

        closeMo(id) {

            modals.delete(id);

        },

        showToast(message, type) {

            notifications.push({
                message,
                type
            });

        },

        async fetch(url, config) {

            networkCalls += 1;

            if (!options.fetchHandler) {

                throw new Error(
                    'Unexpected simulated API request.'
                );

            }

            return options.fetchHandler(
                url,
                config
            );

        }

    });


    // Load the payment API in the isolated VM.
    // Enable simulated status requests only inside this VM.
    // The actual payment.js file remains disabled.

    let apiSource = SOURCES['payment.js'];

    if (options.enableSimulatedStatus !== false) {

        const disabledFlag =
            'paymentStatusEnabled: false';

        assert.equal(
            apiSource.split(disabledFlag).length - 1,
            1,
            'Expected exactly one disabled status flag'
        );

        apiSource = apiSource.replace(
            disabledFlag,
            'paymentStatusEnabled: true'
        );

    }

    vm.runInContext(
        apiSource,
        context
    );

    const api = vm.runInContext(
        'GameChangerPayment',
        context
    );


    // Use a controlled status response for UI tests.

    if (options.statusHandler) {

        context.mockPaymentAPI = {

            ...api,

            async getPaymentStatus(order, requestOptions) {

                statusCalls += 1;

                return options.statusHandler(
                    order,
                    requestOptions
                );

            }

        };

        vm.runInContext(

            SOURCES['payment-ui.js'].replaceAll(
                'GameChangerPayment.',
                'mockPaymentAPI.'
            ),

            context

        );

    } else {

        vm.runInContext(
            SOURCES['payment-ui.js'],
            context
        );

    }


    vm.runInContext(
        SOURCES['payment-return.js'],
        context
    );


    const ui = vm.runInContext(
        'GameChangerPaymentUI',
        context
    );


    const paymentReturn = vm.runInContext(
        'GameChangerPaymentReturn',
        context
    );


    function switchUser(userId, role = 'member') {

        ui.reset();

        paymentReturn.reset();

        sessionUser = userId;

        context.hitPayAuthenticatedUserId =
            userId;

        context.currentRole = role;

        context.loggedInUser = userId
            ? { id: 'SIMULATED-MEMBER' }
            : null;

    }


    return {

        context,

        api,

        ui,

        paymentReturn,

        getElement,

        modals,

        notifications,

        location,

        switchUser,

        setSessionUser(userId) {

            sessionUser = userId;

        },

        getNetworkCalls() {

            return networkCalls;

        },

        getStatusCalls() {

            return statusCalls;

        }

    };

}


// ============================================================
// 4. SIMULATED HTTP RESPONSE
// ============================================================

function httpResponse(payload) {

    return {

        ok: true,

        status: 200,

        async json() {

            return payload;

        }

    };

}


// ============================================================
// 5. TEST EXECUTION HELPER
// ============================================================

async function test(id, description, callback) {

    try {

        await callback();

        passed += 1;

        console.log(
            `[PASS] ${id} — ${description}`
        );

    } catch (error) {

        failed += 1;

        console.error(
            `[FAIL] ${id} — ${description}`
        );

        console.error(
            `       ${error.message}`
        );

    }

}


// ============================================================
// 6. FUNCTIONAL TESTS
// ============================================================

async function runTests() {


    await test(
        'FE-01',
        'Checkout remains disabled',
        async () => {

            const env = createEnvironment();

            env.ui.initialize();

            assert.equal(
                env.ui.CONFIG.checkoutEnabled,
                false
            );

            assert.equal(
                env.getElement('hp-checkout-go').disabled,
                true
            );

            assert.equal(
                env.getNetworkCalls(),
                0
            );

        }
    );


    await test(
        'FE-02',
        'Duplicate initialization is prevented',
        async () => {

            const env = createEnvironment();

            env.ui.initialize();

            env.ui.initialize();

            assert.equal(
                env.getElement(
                    'hp-status-refresh'
                ).listeners.length,
                1
            );

            assert.equal(
                env.getElement(
                    'hp-view-receipt'
                ).listeners.length,
                1
            );

        }
    );


    await test(
        'FE-03',
        'Unauthenticated status request is blocked',
        async () => {

            const env = createEnvironment();

            env.ui.initialize();

            env.switchUser(null);

            assert.equal(
                await env.ui.openStatus(ORDER),
                false
            );

            assert.equal(
                env.getNetworkCalls(),
                0
            );

        }
    );


    await test(
        'FE-04',
        'Administrator status request is blocked',
        async () => {

            const env = createEnvironment();

            env.ui.initialize();

            env.switchUser(USER_A, 'admin');

            assert.equal(
                await env.ui.openStatus(ORDER),
                false
            );

            assert.equal(
                env.getNetworkCalls(),
                0
            );

        }
    );


    await test(
        'FE-05',
        'Invalid order reference is rejected',
        async () => {

            const env = createEnvironment();

            env.ui.initialize();

            assert.equal(
                await env.ui.openStatus('INVALID'),
                false
            );

            assert.equal(
                env.getNetworkCalls(),
                0
            );

        }
    );


    await test(
        'FE-06',
        'Pending payment does not expose a receipt',
        async () => {

            const env = createEnvironment({

                statusHandler: async () =>
                    pendingResponse()

            });

            env.ui.initialize();

            assert.equal(
                await env.ui.openStatus(ORDER),
                true
            );

            assert.equal(
                env.getElement(
                    'hp-view-receipt'
                ).hidden,
                true
            );

            assert.equal(
                env.getElement(
                    'hp-status-title'
                ).textContent,
                'Pending Payment'
            );

        }
    );


    await test(
        'FE-07',
        'Verified payment exposes sandbox receipt',
        async () => {

            const env = createEnvironment({

                fetchHandler: async () =>
                    httpResponse(paidResponse())

            });

            env.ui.initialize();

            assert.equal(
                await env.ui.openStatus(ORDER),
                true
            );

            assert.equal(
                env.getElement(
                    'hp-view-receipt'
                ).hidden,
                false
            );

            const listener = env.getElement(
                'hp-view-receipt'
            ).listeners[0];

            listener.handler();

            assert.equal(
                env.getElement(
                    'hp-receipt-transaction'
                ).textContent,
                'TEST-TRANSACTION-001'
            );

            assert.equal(
                env.modals.has('hp-receipt-mo'),
                true
            );

        }
    );


    await test(
        'FE-08',
        'Incomplete verification requires review',
        async () => {

            const response = paidResponse();

            response.gateway_payment_verified = false;

            const env = createEnvironment({

                fetchHandler: async () =>
                    httpResponse(response)

            });

            env.ui.initialize();

            assert.equal(
                await env.ui.openStatus(ORDER),
                false
            );

            assert.equal(
                env.getElement(
                    'hp-status-title'
                ).textContent,
                'Requires Review'
            );

            assert.equal(
                env.getElement(
                    'hp-view-receipt'
                ).hidden,
                true
            );

        }
    );


    await test(
        'FE-09',
        'Logout clears previously rendered receipt',
        async () => {

            const env = createEnvironment({

                statusHandler: async () =>
                    paidResponse()

            });

            env.ui.initialize();

            await env.ui.openStatus(ORDER);

            env.getElement(
                'hp-view-receipt'
            ).listeners[0].handler();

            env.switchUser(null);

            for (const id of [

                'hp-receipt-session',
                'hp-receipt-order',
                'hp-receipt-transaction',
                'hp-receipt-registration',
                'hp-receipt-method',
                'hp-receipt-date',
                'hp-receipt-provider',
                'hp-receipt-status',
                'hp-receipt-amount',
                'hp-order-reference',
                'hp-transaction-reference'

            ]) {

                assert.equal(
                    env.getElement(id).textContent,
                    '—'
                );

            }

            assert.equal(
                env.modals.size,
                0
            );

        }
    );


    await test(
        'FE-10',
        'Logout aborts active status request',
        async () => {

            const waiting = deferred();

            let requestSignal;

            const env = createEnvironment({

                statusHandler: (order, options) => {

                    requestSignal = options.signal;

                    return waiting.promise;

                }

            });

            env.ui.initialize();

            const request =
                env.ui.openStatus(ORDER);

            env.switchUser(null);

            assert.equal(
                requestSignal.aborted,
                true
            );

            waiting.resolve(paidResponse());

            assert.equal(
                await request,
                false
            );

        }
    );


    await test(
        'FE-11',
        'Old account response is discarded',
        async () => {

            const waiting = deferred();

            const env = createEnvironment({

                statusHandler: () =>
                    waiting.promise

            });

            env.ui.initialize();

            const oldRequest =
                env.ui.openStatus(ORDER);

            env.switchUser(USER_B);

            waiting.resolve(paidResponse());

            assert.equal(
                await oldRequest,
                false
            );

            assert.equal(
                env.getElement(
                    'hp-view-receipt'
                ).hidden,
                true
            );

            assert.equal(
                env.getElement(
                    'hp-transaction-reference'
                ).textContent,
                '—'
            );

        }
    );


    await test(
        'FE-12',
        'Old request cannot unlock newer request',
        async () => {

            const first = deferred();

            const second = deferred();

            let calls = 0;

            const env = createEnvironment({

                statusHandler: () => {

                    calls += 1;

                    return calls === 1
                        ? first.promise
                        : second.promise;

                }

            });

            env.ui.initialize();

            const oldRequest =
                env.ui.openStatus(ORDER);

            env.switchUser(USER_B);

            const newRequest =
                env.ui.openStatus(ORDER);

            first.resolve(paidResponse());

            await oldRequest;

            assert.equal(
                env.getElement(
                    'hp-status-refresh'
                ).disabled,
                true
            );

            second.resolve(pendingResponse());

            assert.equal(
                await newRequest,
                true
            );

            assert.equal(
                env.getElement(
                    'hp-status-refresh'
                ).disabled,
                false
            );

            assert.equal(
                env.getElement(
                    'hp-view-receipt'
                ).hidden,
                true
            );

        }
    );


    await test(
        'FE-13',
        'API rejects authenticated identity mismatch',
        async () => {

            const env = createEnvironment();

            env.setSessionUser(USER_B);

            await assert.rejects(

                env.api.getPaymentStatus(
                    ORDER,
                    {
                        expectedUserId: USER_A
                    }
                ),

                /authenticated account has changed/i

            );

            assert.equal(
                env.getNetworkCalls(),
                0
            );

        }
    );


    await test(
        'FE-14',
        'API rejects account change during request',
        async () => {

            let env;

            env = createEnvironment({

                fetchHandler: async () => {

                    env.setSessionUser(USER_B);

                    return httpResponse(
                        paidResponse()
                    );

                }

            });

            await assert.rejects(

                env.api.getPaymentStatus(
                    ORDER,
                    {
                        expectedUserId: USER_A
                    }
                ),

                /authenticated account has changed/i

            );

        }
    );


    await test(
        'FE-15',
        'Invalid payment return is rejected',
        async () => {

            const env = createEnvironment({

                url:
                    'https://example.invalid/' +
                    '?payment_return=true' +
                    '&order_reference=INVALID'

            });

            assert.equal(
                env.paymentReturn.hasPendingReturn(),
                false
            );

            assert.equal(
                await env.paymentReturn
                    .handleAuthenticatedReturn(),
                false
            );

        }
    );


    await test(
        'FE-16',
        'Authenticated payment return retrieves status',
        async () => {

            const env = createEnvironment({

                url:
                    'https://example.invalid/' +
                    '?payment_return=true' +
                    '&order_reference=' + ORDER,

                statusHandler: async () =>
                    pendingResponse()

            });

            env.ui.initialize();

            assert.equal(
                env.paymentReturn.hasPendingReturn(),
                true
            );

            assert.equal(
                await env.paymentReturn
                    .handleAuthenticatedReturn(),
                true
            );

            assert.equal(
                env.getStatusCalls(),
                1
            );

            assert.equal(
                env.paymentReturn.hasPendingReturn(),
                false
            );

        }
    );


    await test(
        'FE-17',
        'Logout invalidates active return processing',
        async () => {

            const waiting = deferred();

            const started = deferred();

            const env = createEnvironment({

                url:
                    'https://example.invalid/' +
                    '?payment_return=true' +
                    '&order_reference=' + ORDER,

                statusHandler: () => {

                    started.resolve();

                    return waiting.promise;

                }

            });

            env.ui.initialize();

            const processing =
                env.paymentReturn
                    .handleAuthenticatedReturn();

            await started.promise;

            env.switchUser(null);

            waiting.resolve(paidResponse());

            assert.equal(
                await processing,
                false
            );

            assert.equal(
                env.paymentReturn.hasPendingReturn(),
                false
            );

            assert.equal(
                env.getElement(
                    'hp-view-receipt'
                ).hidden,
                true
            );

        }
    );


    await test(
        'FE-18',
        'Unrelated URL parameters are preserved',
        async () => {

            const env = createEnvironment({

                url:
                    'https://example.invalid/' +
                    '?payment_return=true' +
                    '&order_reference=' + ORDER +
                    '&code=TEST-AUTH-CODE' +
                    '#test-fragment',

                statusHandler: async () =>
                    pendingResponse()

            });

            env.ui.initialize();

            await env.paymentReturn
                .handleAuthenticatedReturn();

            const url = new URL(
                env.location.href
            );

            assert.equal(
                url.searchParams.has('payment_return'),
                false
            );

            assert.equal(
                url.searchParams.has('order_reference'),
                false
            );

            assert.equal(
                url.searchParams.get('code'),
                'TEST-AUTH-CODE'
            );

            assert.equal(
                url.hash,
                '#test-fragment'
            );

        }
    );



    await test(
        'FE-19',
        'Production readiness flags remain disabled',
        async () => {

            const env = createEnvironment({
                enableSimulatedStatus: false
            });

            assert.equal(
                env.api.CONFIG.checkoutEnabled,
                false
            );

            assert.equal(
                env.api.CONFIG.paymentStatusEnabled,
                false
            );

            assert.equal(
                env.ui.CONFIG.checkoutEnabled,
                false
            );

            assert.equal(
                env.ui.CONFIG.paymentStatusEnabled,
                false
            );

            assert.equal(
                Object.isFrozen(env.api.CONFIG),
                true
            );

            assert.equal(
                env.getNetworkCalls(),
                0
            );

        }
    );


    await test(
        'FE-20',
        'Direct checkout API request is blocked',
        async () => {

            const env = createEnvironment({
                enableSimulatedStatus: false
            });

            await assert.rejects(
                () => env.api.createPayment(SESSION),
                error =>
                    error.status === 'SERVICE_NOT_READY'
            );

            assert.equal(
                env.getNetworkCalls(),
                0
            );

        }
    );


    await test(
        'FE-21',
        'Direct payment status API request is blocked',
        async () => {

            const env = createEnvironment({
                enableSimulatedStatus: false
            });

            await assert.rejects(
                () => env.api.getPaymentStatus(ORDER),
                error =>
                    error.status === 'SERVICE_NOT_READY'
            );

            assert.equal(
                env.getNetworkCalls(),
                0
            );

        }
    );


    await test(
        'FE-22',
        'Disabled status interface sends no request',
        async () => {

            const env = createEnvironment({
                enableSimulatedStatus: false
            });

            env.ui.initialize();

            assert.equal(
                await env.ui.openStatus(ORDER),
                false
            );

            assert.equal(
                env.getElement(
                    'hp-status-refresh'
                ).disabled,
                true
            );

            assert.equal(
                env.getElement(
                    'hp-view-receipt'
                ).hidden,
                true
            );

            assert.equal(
                env.modals.has('hp-status-mo'),
                false
            );

            assert.equal(
                env.getNetworkCalls(),
                0
            );

        }
    );


    await test(
        'FE-23',
        'Disabled automatic return preserves reference',
        async () => {

            const env = createEnvironment({

                enableSimulatedStatus: false,

                url:
                    'https://example.invalid/' +
                    '?payment_return=true' +
                    '&order_reference=' + ORDER

            });

            env.ui.initialize();

            assert.equal(
                env.paymentReturn.hasPendingReturn(),
                true
            );

            assert.equal(
                await env.paymentReturn
                    .handleAuthenticatedReturn(),
                false
            );

            assert.equal(
                env.paymentReturn.hasPendingReturn(),
                true
            );

            assert.equal(
                env.getNetworkCalls(),
                0
            );

            assert.equal(
                env.getStatusCalls(),
                0
            );

        }
    );


    await test(
        'FE-24',
        'Early status request initializes interface safely',
        async () => {

            const env = createEnvironment({

                statusHandler: async () =>
                    pendingResponse()

            });

            // Deliberately do not initialize first.

            assert.equal(
                await env.ui.openStatus(ORDER),
                true
            );

            env.ui.initialize();

            assert.equal(
                env.getElement(
                    'hp-order-reference'
                ).textContent,
                ORDER
            );

            assert.equal(
                env.getElement(
                    'hp-status-title'
                ).textContent,
                'Pending Payment'
            );

            assert.equal(
                env.modals.has('hp-status-mo'),
                true
            );

            assert.equal(
                env.getStatusCalls(),
                1
            );

        }
    );


    // ========================================================
    // 7. FINAL TEST SUMMARY
    // ========================================================


    // HITPAY_CHECKOUT_URL_PROTECTION_V1

    // These tests execute the actual frontend URL validator.
    // The approved hostname is synthetic and exists only
    // inside the isolated test environment.

    function checkoutURLValidator(enableSyntheticHost) {

        let source = SOURCES['payment.js'];

        if (enableSyntheticHost) {

            const anchor =
                'approvedCheckoutHostnames: Object.freeze(["securecheckout.sandbox.hit-pay.com"])';

            assert.equal(
                source.split(anchor).length - 1,
                1
            );

            source = source.replace(

                anchor,

                "approvedCheckoutHostnames: " +
                "Object.freeze(['checkout.example.test'])"

            );

        }

        const exportAnchor = '        createPayment,';

        assert.equal(
            source.split(exportAnchor).length - 1,
            1
        );

        source = source.replace(

            exportAnchor,

            '        validateCheckoutURL,\n' +
            exportAnchor

        );

        const isolated = vm.createContext({
            URL,
            console
        });

        vm.runInContext(source, isolated);

        return vm.runInContext(
            'GameChangerPayment.validateCheckoutURL',
            isolated
        );

    }


    await test(

        'FE-25',

        'Empty hostname allowlist rejects checkout',

        () => {

            const validate = checkoutURLValidator(false);

            assert.throws(

                () => validate(
                    'https://checkout.example.test/payment/123'
                ),

                /hostname is not approved/

            );

        }

    );


    await test(

        'FE-26',

        'Exact synthetic checkout hostname is accepted',

        () => {

            const validate = checkoutURLValidator(true);

            const url =
                'https://checkout.example.test/payment/123';

            assert.equal(validate(url), url);

        }

    );


    await test(

        'FE-27',

        'Unapproved external hostname is rejected',

        () => {

            const validate = checkoutURLValidator(true);

            assert.throws(

                () => validate(
                    'https://unapproved.example.test/payment/123'
                ),

                /hostname is not approved/

            );

        }

    );


    await test(

        'FE-28',

        'Deceptive hostname variations are rejected',

        () => {

            const validate = checkoutURLValidator(true);

            for (const url of [

                'https://checkout.example.test.invalid/payment',

                'https://fake.checkout.example.test/payment',

                'https://checkout.example.test./payment'

            ]) {

                assert.throws(() => validate(url));

            }

        }

    );


    await test(

        'FE-29',

        'Insecure protocols are rejected',

        () => {

            const validate = checkoutURLValidator(true);

            for (const url of [

                'http://checkout.example.test/payment',

                'javascript:void(0)',

                'data:text/plain,test'

            ]) {

                assert.throws(() => validate(url));

            }

        }

    );


    await test(

        'FE-30',

        'Embedded credentials are rejected',

        () => {

            const validate = checkoutURLValidator(true);

            for (const url of [

                'https://user@checkout.example.test/payment',

                'https://user:password@checkout.example.test/payment',

                'https://checkout.example.test@invalid.example.test/payment'

            ]) {

                assert.throws(() => validate(url));

            }

        }

    );


    await test(

        'FE-31',

        'Unexpected ports and fragments are rejected',

        () => {

            const validate = checkoutURLValidator(true);

            for (const url of [

                'https://checkout.example.test:8443/payment',

                'https://checkout.example.test/payment#fragment'

            ]) {

                assert.throws(() => validate(url));

            }

        }

    );


    await test(

        'FE-32',

        'Malformed and relative checkout URLs are rejected',

        () => {

            const validate = checkoutURLValidator(true);

            for (const url of [

                null,

                undefined,

                '',

                '/payment/123',

                '//checkout.example.test/payment',

                'not-a-url',

                ' https://checkout.example.test/payment',

                'https://checkout.example.test/payment\n',

                'https://checkout.example.test\\payment'

            ]) {

                assert.throws(() => validate(url));

            }

        }

    );


    await test(

        'FE-33',

        'Missing checkout path is rejected',

        () => {

            const validate = checkoutURLValidator(true);

            assert.throws(

                () => validate(
                    'https://checkout.example.test/'
                ),

                /checkout path is missing/

            );

        }

    );


    await test(

        'FE-34',

        'Valid checkout query parameters are preserved',

        () => {

            const validate = checkoutURLValidator(true);

            const url =
                'https://checkout.example.test/payment/123?token=test';

            assert.equal(validate(url), url);

        }

    );



    // HITPAY_STATUS_RECOVERY_TESTS_V1

    const recoveryURL =
        'https://example.invalid/' +
        '?payment_return=true' +
        '&order_reference=' + ORDER;


    await test(

        'FE-52',

        'Temporary failure preserves payment return reference',

        async () => {

            const env = createEnvironment({

                url: recoveryURL,

                statusHandler: async () => {

                    throw new Error(
                        'Simulated temporary network failure'
                    );

                }

            });

            env.ui.initialize();

            assert.equal(
                await env.paymentReturn
                    .handleAuthenticatedReturn(),
                false
            );

            assert.equal(
                env.paymentReturn.hasPendingReturn(),
                true
            );

            assert.equal(
                env.getStatusCalls(),
                1
            );

            assert.equal(
                env.getElement(
                    'hp-status-refresh'
                ).disabled,
                false
            );

        }

    );


    await test(

        'FE-53',

        'Successful retry retrieves recorded payment status',

        async () => {

            let attempts = 0;

            const env = createEnvironment({

                url: recoveryURL,

                statusHandler: async () => {

                    attempts++;

                    if (attempts === 1) {

                        throw new Error(
                            'Simulated temporary failure'
                        );

                    }

                    return pendingResponse();

                }

            });

            env.ui.initialize();

            assert.equal(
                await env.paymentReturn
                    .handleAuthenticatedReturn(),
                false
            );

            assert.equal(
                env.paymentReturn.hasPendingReturn(),
                true
            );

            assert.equal(
                await env.paymentReturn
                    .handleAuthenticatedReturn(),
                true
            );

            assert.equal(
                env.getStatusCalls(),
                2
            );

            assert.equal(
                env.paymentReturn.hasPendingReturn(),
                false
            );

            assert.equal(
                env.getElement(
                    'hp-status-message'
                ).textContent,
                pendingResponse().message +
                    ' Check Payment Status again for updates. ' +
                    'Do not start another payment.'
            );

            assert.equal(
                env.getElement(
                    'hp-view-receipt'
                ).hidden,
                true
            );

        }

    );


    await test(

        'FE-54',

        'Duplicate return processing sends one status request',

        async () => {

            const waiting = deferred();
            const started = deferred();

            const env = createEnvironment({

                url: recoveryURL,

                statusHandler: () => {

                    started.resolve();

                    return waiting.promise;

                }

            });

            env.ui.initialize();

            const first =
                env.paymentReturn
                    .handleAuthenticatedReturn();

            await started.promise;

            const duplicate =
                await env.paymentReturn
                    .handleAuthenticatedReturn();

            assert.equal(
                duplicate,
                false
            );

            assert.equal(
                env.getStatusCalls(),
                1
            );

            waiting.resolve(
                pendingResponse()
            );

            assert.equal(
                await first,
                true
            );

            assert.equal(
                env.getStatusCalls(),
                1
            );

        }

    );


    await test(

        'FE-55',

        'Failed status retrieval does not expose receipt',

        async () => {

            const env = createEnvironment({

                url: recoveryURL,

                statusHandler: async () => {

                    throw new Error(
                        'Simulated status service unavailable'
                    );

                }

            });

            env.ui.initialize();

            assert.equal(
                await env.paymentReturn
                    .handleAuthenticatedReturn(),
                false
            );

            assert.equal(
                env.getElement(
                    'hp-view-receipt'
                ).hidden,
                true
            );

            assert.equal(
                env.getElement(
                    'hp-view-receipt'
                ).disabled,
                true
            );

            assert.equal(
                env.getElement(
                    'hp-transaction-reference-box'
                ).hidden,
                true
            );

            assert.equal(
                env.getElement(
                    'hp-review-notice'
                ).hidden,
                false
            );

        }

    );


    await test(

        'FE-56',

        'Successful retry cleans only payment URL parameters',

        async () => {

            let attempts = 0;

            const env = createEnvironment({

                url:
                    recoveryURL +
                    '&code=TEST-AUTH-CODE' +
                    '#test-fragment',

                statusHandler: async () => {

                    attempts++;

                    if (attempts === 1) {

                        throw new Error(
                            'Simulated temporary failure'
                        );

                    }

                    return pendingResponse();

                }

            });

            env.ui.initialize();

            assert.equal(
                await env.paymentReturn
                    .handleAuthenticatedReturn(),
                false
            );

            assert.equal(
                env.paymentReturn.hasPendingReturn(),
                true
            );

            assert.equal(
                await env.paymentReturn
                    .handleAuthenticatedReturn(),
                true
            );

            const url = new URL(
                env.location.href
            );

            assert.equal(
                url.searchParams.has(
                    'payment_return'
                ),
                false
            );

            assert.equal(
                url.searchParams.has(
                    'order_reference'
                ),
                false
            );

            assert.equal(
                url.searchParams.get('code'),
                'TEST-AUTH-CODE'
            );

            assert.equal(
                url.hash,
                '#test-fragment'
            );

            assert.equal(
                env.paymentReturn.hasPendingReturn(),
                false
            );

        }

    );



    // HITPAY_STATUS_RECONCILIATION_TESTS_V1

    function assertReceiptHidden(env) {

        assert.equal(
            env.getElement('hp-view-receipt').hidden,
            true
        );

        assert.equal(
            env.getElement('hp-view-receipt').disabled,
            true
        );

        assert.equal(
            env.getElement(
                'hp-transaction-reference-box'
            ).hidden,
            true
        );

        assert.equal(
            env.getElement('hp-receipt-content').hidden,
            true
        );

    }


    const nonPaidScenarios = [

        {
            id: 'FE-57',
            status: 'FAILED',
            description: 'Failed payment hides receipt',
            guidance: 'before attempting another payment.',
            review: false
        },

        {
            id: 'FE-58',
            status: 'CANCELLED',
            description: 'Cancelled payment hides receipt',
            guidance: 'before attempting another payment.',
            review: false
        },

        {
            id: 'FE-59',
            status: 'REFUNDED',
            description: 'Refunded payment hides receipt',
            guidance: 'clarification about the recorded refund.',
            review: false
        },

        {
            id: 'FE-60',
            status: 'REVIEW_REQUIRED',
            description: 'Reconciliation-required payment hides receipt',
            guidance: 'Provide your Order Reference',
            review: true
        },

        {
            id: 'FE-61',
            status: 'CHECKOUT_UNCERTAIN',
            description: 'Uncertain checkout hides receipt',
            guidance: 'Do not start another payment.',
            review: true
        }

    ];


    for (const scenario of nonPaidScenarios) {

        await test(

            scenario.id,

            scenario.description,

            async () => {

                const response = {

                    ...pendingResponse(),

                    status: scenario.status,

                    message:
                        'Recorded status: ' +
                        scenario.status,

                    verified: false,

                    gateway_payment_verified: false,

                    registered: false,

                    reconciliation_required:
                        scenario.status ===
                        'REVIEW_REQUIRED',

                    // Unexpected receipt data must
                    // never be displayed for a
                    // non-paid payment status.

                    receipt: paidResponse().receipt

                };

                const env = createEnvironment({

                    statusHandler: async () => response

                });

                env.ui.initialize();

                assert.equal(
                    await env.ui.openStatus(ORDER),
                    true
                );

                assertReceiptHidden(env);

                assert.equal(
                    env.getElement(
                        'hp-status-title'
                    ).textContent,
                    env.api.getStatusLabel(
                        scenario.status
                    )
                );

                assert.ok(
                    env.getElement(
                        'hp-status-message'
                    ).textContent.includes(
                        scenario.guidance
                    )
                );

                assert.equal(
                    env.getElement(
                        'hp-review-notice'
                    ).hidden,
                    !scenario.review
                );

                // Direct invocation of the receipt
                // button handler must also be blocked.

                env.getElement(
                    'hp-view-receipt'
                ).listeners[0].handler();

                assert.equal(
                    env.modals.has('hp-receipt-mo'),
                    false
                );

            }

        );

    }


    // ========================================================
    // MALFORMED PAID RECEIPT RESPONSES
    // ========================================================

    const invalidReceiptScenarios = [

        {
            id: 'FE-62',
            description:
                'Incorrect payment provider rejects receipt',

            modify(receipt) {
                receipt.payment_provider = 'Unknown';
            }
        },

        {
            id: 'FE-63',
            description:
                'Non-sandbox receipt is rejected',

            modify(receipt) {
                receipt.is_sandbox = false;
            }
        },

        {
            id: 'FE-64',
            description:
                'Mismatched order reference rejects receipt',

            modify(receipt) {
                receipt.order_reference =
                    'GC-99999999-9999-4999-8999-999999999999';
            }
        },

        {
            id: 'FE-65',
            description:
                'Missing transaction reference rejects receipt',

            modify(receipt) {
                receipt.transaction_reference = '   ';
            }
        }

    ];


    for (const scenario of invalidReceiptScenarios) {

        await test(

            scenario.id,

            scenario.description,

            async () => {

                const response = paidResponse();

                scenario.modify(response.receipt);

                const env = createEnvironment({

                    // Test the UI protection directly,
                    // independently of API validation.

                    statusHandler: async () => response

                });

                env.ui.initialize();

                assert.equal(
                    await env.ui.openStatus(ORDER),
                    true
                );

                assertReceiptHidden(env);

                assert.equal(
                    env.getElement(
                        'hp-status-title'
                    ).textContent,
                    env.api.getStatusLabel(
                        'REVIEW_REQUIRED'
                    )
                );

                assert.equal(
                    env.getElement(
                        'hp-review-notice'
                    ).hidden,
                    false
                );

                env.getElement(
                    'hp-view-receipt'
                ).listeners[0].handler();

                assert.equal(
                    env.modals.has('hp-receipt-mo'),
                    false
                );

            }

        );

    }


    // ========================================================
    // PREVIOUS RECEIPT INVALIDATION
    // ========================================================

    await test(

        'FE-66',

        'Previously verified receipt is cleared after non-paid status',

        async () => {

            let response = paidResponse();

            const env = createEnvironment({

                statusHandler: async () => response

            });

            env.ui.initialize();

            assert.equal(
                await env.ui.openStatus(ORDER),
                true
            );

            assert.equal(
                env.getElement(
                    'hp-view-receipt'
                ).hidden,
                false
            );

            env.getElement(
                'hp-view-receipt'
            ).listeners[0].handler();

            assert.equal(
                env.modals.has('hp-receipt-mo'),
                true
            );

            assert.equal(
                env.getElement(
                    'hp-receipt-transaction'
                ).textContent,
                'TEST-TRANSACTION-001'
            );

            // Simulate a later status response
            // that no longer permits a receipt.

            response = {

                ...pendingResponse(),

                status: 'REVIEW_REQUIRED',

                reconciliation_required: true,

                message:
                    'Payment requires further verification.'

            };

            assert.equal(
                await env.ui.openStatus(ORDER),
                true
            );

            assertReceiptHidden(env);

            assert.notEqual(
                env.getElement(
                    'hp-receipt-transaction'
                ).textContent,
                'TEST-TRANSACTION-001'
            );

            assert.equal(
                env.modals.has('hp-receipt-mo'),
                false
            );

            assert.equal(
                env.getElement(
                    'hp-review-notice'
                ).hidden,
                false
            );

            env.getElement(
                'hp-view-receipt'
            ).listeners[0].handler();

            assert.equal(
                env.modals.has('hp-receipt-mo'),
                false
            );

        }

    );


    console.log();

    console.log('='.repeat(58));

    console.log(
        'HITPAY FRONTEND FUNCTIONAL TEST SUMMARY'
    );

    console.log('='.repeat(58));

    console.log(`Tests executed: ${passed + failed}`);

    console.log(`Tests passed:   ${passed}`);

    console.log(`Tests failed:   ${failed}`);

    console.log('Authentication: SIMULATED');

    console.log('Payment responses: SIMULATED');

    console.log('DOM environment: SIMULATED');

    console.log('Real network requests: NONE');

    console.log('Database changes: NONE');

    console.log('Checkout creation: NONE');

    console.log('Deployment: NOT PERFORMED');

    console.log('='.repeat(58));

    if (failed > 0) {

        process.exitCode = 1;

    }

}


runTests().catch(error => {

    console.error(error);

    process.exitCode = 1;

});

// HITPAY_STATUS_GUIDANCE_ASSERTION_V1
