
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const SESSION = 'cd2f1fa3-c011-481f-b8fa-333354d14e27';

const ORDER = 'GC-33333333-3333-4333-8333-333333333333';

const TRANSACTION = '44444444-4444-4444-8444-444444444444';

const HOST = 'checkout.example.test';

const CHECKOUT_URL = `https://${HOST}/sandbox/test`;

const STORAGE_KEY =
    `gamechanger.hitpay.sandbox.attempt.v1:${USER_A}:${SESSION}`;

const API_SOURCE = fs.readFileSync(
    path.join(ROOT, 'payment.js'),
    'utf8'
);

const UI_SOURCE = fs.readFileSync(
    path.join(ROOT, 'payment-ui.js'),
    'utf8'
);

let passed = 0;
let failed = 0;


// ============================================================
// 1. SAFETY CHECKS
// ============================================================

for (const required of [
    'checkoutEnabled: false',
    'paymentStatusEnabled: false',
    'approvedCheckoutHostnames: Object.freeze(["securecheckout.sandbox.hit-pay.com"])'
]) {

    assert.ok(
        API_SOURCE.includes(required),
        `Missing production readiness protection: ${required}`
    );

}

for (const required of [
    'HITPAY_CHECKOUT_CONTROLLER_V1',
    'HITPAY_DUPLICATE_PROTECTION_V1',
    'HITPAY_CHECKOUT_RECOVERY_V1'
]) {

    assert.ok(
        UI_SOURCE.includes(required),
        `Missing controller implementation: ${required}`
    );

}


// ============================================================
// 2. SIMULATED RESPONSES
// ============================================================

function checkoutResponse(overrides = {}) {

    return {

        success: true,

        status: 'PENDING_PAYMENT',

        checkout_state: 'CREATED',

        reconciliation_required: false,

        transaction_id: TRANSACTION,

        order_reference: ORDER,

        amount: 100,

        currency: 'PHP',

        checkout_url: CHECKOUT_URL,

        ...overrides

    };

}


function statusResponse(status = 'PENDING_PAYMENT') {

    return {

        success: true,

        status,

        order_reference: ORDER,

        verified: false,

        registered: false,

        reconciliation_required:
            status === 'REVIEW_REQUIRED',

        receipt: null,

        message: `Simulated status: ${status}`

    };

}


function response(body, status = 200) {

    return {

        ok: status >= 200 && status < 300,

        status,

        async json() {

            return body;

        }

    };

}


function deferred() {

    let resolve;
    let reject;

    const promise = new Promise((res, rej) => {

        resolve = res;
        reject = rej;

    });

    return { promise, resolve, reject };

}


function existingAttempt(
    status = 'CHECKOUT_UNCERTAIN',
    orderReference = ORDER
) {

    return new Map([

        [
            STORAGE_KEY,

            JSON.stringify({
                status,
                orderReference
            })
        ]

    ]);

}


// ============================================================
// 3. SIMULATED BROWSER ENVIRONMENT
// ============================================================

function createEnvironment(options = {}) {

    const storage = options.storage || new Map();

    const elements = new Map();

    const modals = new Set();

    const notifications = [];

    const redirects = [];

    const requests = [];

    const session = {

        session_id: SESSION,

        title: 'Sandbox Test Session',

        fee: 100,

        is_registered: false

    };

    let userId = USER_A;

    let storageFailure =
        options.storageFailure || false;


    function getElement(id) {

        if (!elements.has(id)) {

            elements.set(id, {

                id,

                textContent: '',

                hidden: false,

                disabled: false,

                className: '',

                listeners: new Map(),

                addEventListener(event, handler) {

                    if (!this.listeners.has(event)) {

                        this.listeners.set(event, []);

                    }

                    this.listeners.get(event).push(handler);

                }

            });

        }

        return elements.get(id);

    }


    const context = vm.createContext({

        console,

        URL,

        URLSearchParams,

        AbortController,

        setTimeout,

        clearTimeout,

        SUPABASE_URL: 'https://supabase.example.test',

        SUPABASE_ANON_KEY: 'SIMULATED_ANON_KEY',

        currentRole: 'member',

        loggedInUser: { uid: USER_A },

        hitPayAuthenticatedUserId: USER_A,

        document: {

            getElementById: getElement

        },

        window: {

            location: {

                assign(destination) {

                    redirects.push(destination);

                }

            },

            localStorage: {

                getItem(key) {

                    if (storageFailure) {

                        throw new Error(
                            'Simulated storage failure'
                        );

                    }

                    return storage.has(key)
                        ? storage.get(key)
                        : null;

                },

                setItem(key, value) {

                    if (storageFailure) {

                        throw new Error(
                            'Simulated storage failure'
                        );

                    }

                    storage.set(key, String(value));

                },

                removeItem(key) {

                    if (storageFailure) {

                        throw new Error(
                            'Simulated storage failure'
                        );

                    }

                    storage.delete(key);

                }

            }

        },

        sb: {

            auth: {

                async getSession() {

                    return {

                        data: {

                            session: userId
                                ? {
                                    user: { id: userId },
                                    access_token: 'SIMULATED_TOKEN'
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

                upcoming: [session]

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

        async fetch(url, requestOptions) {

            const endpoint =
                new URL(url).pathname.split('/').pop();

            assert.ok(

                [
                    'create-payment',
                    'payment-status'
                ].includes(endpoint),

                'Unexpected network endpoint'

            );

            const request = {

                endpoint,

                body: JSON.parse(requestOptions.body),

                signal: requestOptions.signal

            };

            requests.push(request);

            if (endpoint === 'create-payment') {

                if (options.checkoutHandler) {

                    return await options.checkoutHandler(
                        request
                    );

                }

                return response(checkoutResponse());

            }

            if (options.statusHandler) {

                return await options.statusHandler(
                    request
                );

            }

            return response(statusResponse());

        }

    });


    // Enable checkout ONLY inside the isolated VM.
    // Never modify the actual application source files.

    let simulatedAPI = API_SOURCE;

    if (options.enabled !== false) {

        simulatedAPI = simulatedAPI

            .replace(
                'checkoutEnabled: false',
                options.statusOnly === true
                    ? 'checkoutEnabled: false'
                    : 'checkoutEnabled: true'
            )

            .replace(
                'paymentStatusEnabled: false',
                'paymentStatusEnabled: true'
            )

            .replace(
                'approvedCheckoutHostnames: Object.freeze(["securecheckout.sandbox.hit-pay.com"])',
                `approvedCheckoutHostnames: Object.freeze(['${HOST}'])`
            );

    }


    vm.runInContext(

        simulatedAPI,

        context,

        { filename: 'payment.js' }

    );


    vm.runInContext(

        UI_SOURCE,

        context,

        { filename: 'payment-ui.js' }

    );


    const ui = vm.runInContext(
        'GameChangerPaymentUI',
        context
    );

    ui.initialize();


    async function clickCheckout(force = false) {

        const button = getElement('hp-checkout-go');

        if (button.disabled && !force) {

            return false;

        }

        const handlers =
            button.listeners.get('click') || [];

        assert.equal(

            handlers.length,

            1,

            'Checkout button must have one handler'

        );

        return await handlers[0]();

    }


    function switchUser(nextUser) {

        userId = nextUser;

        context.hitPayAuthenticatedUserId = nextUser;

        context.loggedInUser = nextUser
            ? { uid: nextUser }
            : null;

        context.currentRole = nextUser
            ? 'member'
            : null;

        ui.reset();

    }


    function createRequests() {

        return requests.filter(

            request =>
                request.endpoint === 'create-payment'

        );

    }


    function statusRequests() {

        return requests.filter(

            request =>
                request.endpoint === 'payment-status'

        );

    }


    function storedAttempt() {

        const value = storage.get(STORAGE_KEY);

        return value ? JSON.parse(value) : null;

    }


    return {

        ui,

        session,

        storage,

        modals,

        notifications,

        redirects,

        requests,

        getElement,

        clickCheckout,

        switchUser,

        createRequests,

        statusRequests,

        storedAttempt,

        failStorage() {

            storageFailure = true;

        }

    };

}


// ============================================================
// 4. TEST RUNNER
// ============================================================

async function test(id, description, callback) {

    try {

        await callback();

        passed += 1;

        console.log(`[PASS] ${id} — ${description}`);

    } catch (error) {

        failed += 1;

        console.error(`[FAIL] ${id} — ${description}`);

        console.error(error.stack || error);

    }

}


// ============================================================
// 5. CHECKOUT REGRESSION TESTS
// ============================================================

async function main() {


    await test(

        'FE-35',

        'Disabled checkout sends no request',

        async () => {

            const env = createEnvironment({
                enabled: false
            });

            assert.equal(
                env.ui.openCheckout(SESSION),
                true
            );

            assert.equal(
                env.getElement('hp-checkout-go').disabled,
                true
            );

            await env.clickCheckout(true);

            assert.equal(env.requests.length, 0);

            assert.equal(env.redirects.length, 0);

        }

    );


    await test(

        'FE-36',

        'Valid checkout permits simulated redirect',

        async () => {

            const env = createEnvironment();

            env.ui.openCheckout(SESSION);

            assert.equal(
                env.getElement('hp-checkout-go').disabled,
                false
            );

            assert.equal(
                await env.clickCheckout(),
                true
            );

            assert.equal(env.createRequests().length, 1);

            assert.equal(
                env.createRequests()[0].body.session_id,
                SESSION
            );

            assert.deepEqual(
                env.redirects,
                [CHECKOUT_URL]
            );

            assert.equal(
                env.storedAttempt().status,
                'PENDING_PAYMENT'
            );

            assert.equal(
                env.storedAttempt().orderReference,
                ORDER
            );

        }

    );


    await test(

        'FE-37',

        'Rapid double-click prevents duplicate requests',

        async () => {

            const gate = deferred();

            const started = deferred();

            const env = createEnvironment({

                checkoutHandler() {

                    started.resolve();

                    return gate.promise;

                }

            });

            env.ui.openCheckout(SESSION);

            const first = env.clickCheckout();

            await started.promise;

            const second = await env.clickCheckout(true);

            assert.equal(second, false);

            assert.equal(env.createRequests().length, 1);

            gate.resolve(response(checkoutResponse()));

            await first;

            assert.equal(env.redirects.length, 1);

        }

    );


    await test(

        'FE-38',

        'Changed admission fee prevents checkout',

        async () => {

            const env = createEnvironment();

            env.ui.openCheckout(SESSION);

            env.session.fee = 150;

            await env.clickCheckout();

            assert.equal(env.createRequests().length, 0);

            assert.equal(env.redirects.length, 0);

            assert.match(

                env.getElement('hp-checkout-message')
                    .textContent,

                /admission fee has changed/i

            );

        }

    );


    await test(

        'FE-39',

        'Mismatched backend amount prevents redirect',

        async () => {

            const env = createEnvironment({

                checkoutHandler() {

                    return response(

                        checkoutResponse({
                            amount: 150
                        })

                    );

                }

            });

            env.ui.openCheckout(SESSION);

            await env.clickCheckout();

            assert.equal(env.createRequests().length, 1);

            assert.equal(env.redirects.length, 0);

            assert.equal(

                env.storedAttempt().status,

                'CHECKOUT_UNCERTAIN'

            );

            assert.equal(

                env.storedAttempt().orderReference,

                ORDER

            );

        }

    );


    await test(

        'FE-40',

        'Unapproved checkout destination is rejected',

        async () => {

            const env = createEnvironment({

                checkoutHandler() {

                    return response(

                        checkoutResponse({

                            checkout_url:
                                'https://unapproved.example.test/pay'

                        })

                    );

                }

            });

            env.ui.openCheckout(SESSION);

            await env.clickCheckout();

            assert.equal(env.redirects.length, 0);

            assert.equal(

                env.storedAttempt().status,

                'CHECKOUT_UNCERTAIN'

            );

        }

    );


    await test(

        'FE-41',

        'Logout aborts active checkout',

        async () => {

            const gate = deferred();

            const started = deferred();

            const env = createEnvironment({

                checkoutHandler(request) {

                    started.resolve(request);

                    return gate.promise;

                }

            });

            env.ui.openCheckout(SESSION);

            const pending = env.clickCheckout();

            const request = await started.promise;

            env.switchUser(null);

            assert.equal(request.signal.aborted, true);

            gate.resolve(response(checkoutResponse()));

            await pending;

            assert.equal(env.redirects.length, 0);

            assert.ok(env.storedAttempt());

            assert.equal(env.modals.size, 0);

        }

    );


    await test(

        'FE-42',

        'Account switching prevents stale redirect',

        async () => {

            const gate = deferred();

            const started = deferred();

            const env = createEnvironment({

                checkoutHandler() {

                    started.resolve();

                    return gate.promise;

                }

            });

            env.ui.openCheckout(SESSION);

            const pending = env.clickCheckout();

            await started.promise;

            env.switchUser(USER_B);

            env.ui.openCheckout(SESSION);

            gate.resolve(response(checkoutResponse()));

            await pending;

            assert.equal(env.redirects.length, 0);

            assert.equal(

                env.getElement('hp-checkout-go').disabled,

                false

            );

            assert.ok(env.storedAttempt());

        }

    );


    await test(

        'FE-43',

        'Simulated timeout preserves payment lock',

        async () => {

            const env = createEnvironment({

                checkoutHandler() {

                    const error = new Error(
                        'Simulated timeout'
                    );

                    error.name = 'AbortError';

                    throw error;

                }

            });

            env.ui.openCheckout(SESSION);

            await env.clickCheckout();

            assert.equal(env.redirects.length, 0);

            assert.equal(

                env.storedAttempt().status,

                'CHECKOUT_UNCERTAIN'

            );

            env.ui.openCheckout(SESSION);

            await env.clickCheckout(true);

            assert.equal(env.createRequests().length, 1);

        }

    );


    await test(

        'FE-44',

        'New page preserves unresolved attempt',

        async () => {

            const firstPage = createEnvironment();

            firstPage.ui.openCheckout(SESSION);

            await firstPage.clickCheckout();

            const secondPage = createEnvironment({

                storage: firstPage.storage

            });

            secondPage.ui.openCheckout(SESSION);

            assert.equal(

                secondPage.getElement('hp-checkout-go')
                    .textContent,

                'Check Payment Status'

            );

            assert.equal(

                secondPage.createRequests().length,

                0

            );

        }

    );


    await test(

        'FE-45',

        'Browser storage failure blocks checkout',

        async () => {

            const env = createEnvironment({

                storageFailure: true

            });

            env.ui.openCheckout(SESSION);

            await env.clickCheckout(true);

            assert.equal(env.createRequests().length, 0);

            assert.equal(env.redirects.length, 0);

            assert.equal(

                env.getElement('hp-checkout-go').disabled,

                true

            );

        }

    );


    await test(

        'FE-46',

        'Existing payment opens status recovery',

        async () => {

            const env = createEnvironment({

                storage: existingAttempt()

            });

            env.ui.openCheckout(SESSION);

            assert.equal(

                env.getElement('hp-checkout-go').textContent,

                'Check Payment Status'

            );

            await env.clickCheckout();

            assert.ok(env.modals.has('hp-status-mo'));

            assert.equal(env.statusRequests().length, 1);

            assert.equal(

                env.statusRequests()[0].body.order_reference,

                ORDER

            );

        }

    );


    await test(

        'FE-47',

        'Recovery sends no new payment request',

        async () => {

            const env = createEnvironment({

                storage: existingAttempt(
                    'PENDING_PAYMENT'
                )

            });

            env.ui.openCheckout(SESSION);

            await env.clickCheckout();

            assert.equal(env.createRequests().length, 0);

            assert.equal(env.statusRequests().length, 1);

            assert.equal(env.redirects.length, 0);

        }

    );


    await test(

        'FE-48',

        'Missing order reference requires assistance',

        async () => {

            const env = createEnvironment({

                storage: existingAttempt(

                    'CHECKOUT_UNCERTAIN',

                    null

                )

            });

            env.ui.openCheckout(SESSION);

            assert.equal(

                env.getElement('hp-checkout-go').disabled,

                true

            );

            assert.match(

                env.getElement('hp-checkout-message')
                    .textContent,

                /administrator/i

            );

            await env.clickCheckout(true);

            assert.equal(env.requests.length, 0);

        }

    );


    await test(

        'FE-49',

        'Reconciliation preserves payment lock',

        async () => {

            const env = createEnvironment({

                checkoutHandler() {

                    return response({

                        success: false,

                        status: 'REVIEW_REQUIRED',

                        order_reference: ORDER,

                        reconciliation_required: true,

                        error: 'Simulated reconciliation'

                    }, 409);

                }

            });

            env.ui.openCheckout(SESSION);

            await env.clickCheckout();

            assert.equal(

                env.storedAttempt().status,

                'REVIEW_REQUIRED'

            );

            assert.equal(

                env.storedAttempt().orderReference,

                ORDER

            );

            assert.equal(env.redirects.length, 0);

            assert.equal(

                env.getElement('hp-checkout-go').textContent,

                'Check Payment Status'

            );

        }

    );


    await test(

        'FE-50',

        'Failed or cancelled status does not authorize retry',

        async () => {

            for (const status of [
                'FAILED',
                'CANCELLED'
            ]) {

                const env = createEnvironment({

                    storage: existingAttempt(),

                    statusHandler() {

                        return response(
                            statusResponse(status)
                        );

                    }

                });

                env.ui.openCheckout(SESSION);

                await env.clickCheckout();

                assert.ok(env.storedAttempt());

                assert.equal(

                    env.getElement('hp-view-receipt').hidden,

                    true

                );

                env.ui.openCheckout(SESSION);

                await env.clickCheckout();

                assert.equal(

                    env.createRequests().length,

                    0

                );

                assert.equal(

                    env.statusRequests().length,

                    2

                );

                assert.equal(env.redirects.length, 0);

            }

        }

    );



    // HITPAY_STATUS_RECOVERY_TESTS_V1

    await test(

        'FE-51',

        'Status-only recovery works with checkout disabled',

        async () => {

            const env = createEnvironment({

                statusOnly: true,

                storage: existingAttempt(
                    'PENDING_PAYMENT'
                )

            });

            assert.equal(
                env.ui.CONFIG.checkoutEnabled,
                false
            );

            assert.equal(
                env.ui.CONFIG.paymentStatusEnabled,
                true
            );

            assert.equal(
                env.ui.openCheckout(SESSION),
                true
            );

            assert.equal(
                env.getElement(
                    'hp-checkout-go'
                ).textContent,
                'Check Payment Status'
            );

            assert.equal(
                env.getElement(
                    'hp-checkout-go'
                ).disabled,
                false
            );

            await env.clickCheckout();

            assert.equal(
                env.createRequests().length,
                0
            );

            assert.equal(
                env.statusRequests().length,
                1
            );

            assert.equal(
                env.statusRequests()[0]
                    .body.order_reference,
                ORDER
            );

            assert.ok(
                env.modals.has('hp-status-mo')
            );

            assert.equal(
                env.redirects.length,
                0
            );

        }

    );


    // ========================================================
    // 6. CONFIRM ACTUAL FILES REMAIN UNCHANGED
    // ========================================================

    assert.equal(

        fs.readFileSync(
            path.join(ROOT, 'payment.js'),
            'utf8'
        ),

        API_SOURCE

    );

    assert.equal(

        fs.readFileSync(
            path.join(ROOT, 'payment-ui.js'),
            'utf8'
        ),

        UI_SOURCE

    );


    // ========================================================
    // 7. FINAL SUMMARY
    // ========================================================

    console.log();

    console.log('='.repeat(60));

    console.log('HITPAY CHECKOUT REGRESSION TEST SUMMARY');

    console.log('='.repeat(60));

    console.log(`Tests executed: ${passed + failed}`);

    console.log(`Tests passed:   ${passed}`);

    console.log(`Tests failed:   ${failed}`);

    console.log('Authentication: SIMULATED');

    console.log('Payment responses: SIMULATED');

    console.log('Browser storage: SIMULATED');

    console.log('Browser navigation: SIMULATED');

    console.log('Checkout readiness: VM ONLY');

    console.log('Application source changes: NONE');

    console.log('Real network requests: NONE');

    console.log('Database changes: NONE');

    console.log('Real payments: NONE');

    console.log('Deployment: NOT PERFORMED');

    console.log('='.repeat(60));

    process.exitCode = failed > 0 ? 1 : 0;

}


main().catch(error => {

    console.error(error);

    process.exitCode = 1;

});
