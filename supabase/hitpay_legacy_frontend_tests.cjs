
'use strict';

// ==========================================================
// GAMECHANGER — HITPAY LEGACY FRONTEND REGRESSION TESTS
// ==========================================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const SCRIPT = fs.readFileSync(
    path.join(ROOT, 'script.js'),
    'utf8'
);

const HTML = fs.readFileSync(
    path.join(ROOT, 'index.html'),
    'utf8'
);

const SANDBOX =
    'cd2f1fa3-c011-481f-b8fa-333354d14e27';

const ORDINARY =
    '11111111-1111-4111-8111-111111111111';

const REGISTRATION =
    '22222222-2222-4222-8222-222222222222';

let passed = 0;
let failed = 0;


// ==========================================================
// 1. EXTRACT ACTUAL APPLICATION CODE
// ==========================================================

function extract(start, end) {

    const first = SCRIPT.indexOf(start);

    assert.notEqual(
        first,
        -1,
        'Missing source anchor: ' + start
    );

    const last = SCRIPT.indexOf(
        end,
        first + start.length
    );

    assert.notEqual(
        last,
        -1,
        'Missing source anchor: ' + end
    );

    return SCRIPT.slice(first, last);

}


const PAYMENT_SOURCE = extract(
    'const PAYMENT_LABEL = {',
    '// FORM VALIDATION'
).replace(
    /\/\/ ═+[ \t]*\r?\n$/,
    ''
);

const ADMIN_OWNERSHIP_SOURCE = extract(
    'function ownsAdminPaymentRecords() {',
    'var adminPayments = null;'
);

const MEMBER_SOURCE = extract(
    'async function submitMemberPayment() {',
    'function memberDues() {'
);

const JOIN_SOURCE = extract(
    'function openJoinModal(sessionId) {',
    'async function handleJoinSession(sessionId, btn) {'
);


// ==========================================================
// 2. SYNTHETIC PAYMENT RECORDS
// ==========================================================

function ordinaryPayment(overrides = {}) {

    return {

        key: '33333333-3333-4333-8333-333333333333',

        transaction_id: '33333333-3333-4333-8333-333333333333',

        registration_id: REGISTRATION,

        session_id: ORDINARY,

        session_status: 'Upcoming',

        payment_provider: 'MANUAL',

        is_sandbox: false,

        status: 'PENDING_PAYMENT',

        reg_payment_status: 'PENDING_PAYMENT',

        member: 'Synthetic Member',

        session: 'Ordinary Training Session',

        amount: 100,

        currency: 'PHP',

        channel: 'GCASH',

        reference: 'TEST-123456',

        date: '2026-12-05T06:00:00Z',

        ...overrides

    };

}


function sandboxPayment(overrides = {}) {

    return ordinaryPayment({

        key: '44444444-4444-4444-8444-444444444444',

        transaction_id: '44444444-4444-4444-8444-444444444444',

        session_id: SANDBOX,

        payment_provider: 'HITPAY',

        is_sandbox: true,

        session: 'Synthetic HitPay Session',

        ...overrides

    });

}


// ==========================================================
// 3. ISOLATED TEST ENVIRONMENT
// ==========================================================

function createEnvironment(options = {}) {

    const elements = new Map();

    const modals = new Set();

    const calls = [];

    const notifications = [];

    const records = options.records || [];

    const sessions = options.sessions || [];


    function element(id) {

        if (!elements.has(id)) {

            elements.set(id, {

                id,

                value: '',

                textContent: '',

                innerHTML: '',

                className: '',

                disabled: false,

                style: {}

            });

        }

        return elements.get(id);

    }


    const context = vm.createContext({

        console,

        currentRole: options.role || 'admin',

        loggedInUser:
            options.authenticated === false
                ? null
                : {
                    id: 'synthetic-user',
                    uid: 'synthetic-user'
                },

        adminPaymentOwner:
            options.authenticated === false
                ? null
                : 'synthetic-user',

        adminData: {},

        adminPayments: records,

        payingSessionId: null,

        document: {

            getElementById: element

        },

        ad: () => ({
            payments: records
        }),

        md: () => ({
            upcoming: sessions
        }),

        esc: value => String(value ?? ''),

        fmtMoney: value =>
            'PHP ' + Number(value || 0).toFixed(2),

        fmtInt: value => String(value),

        fmtDate: value => String(value || ''),

        fmtDateShort: value => String(value || ''),

        fmtTime: () => '10:00 AM',

        initialsOf: () => 'SM',

        emptyRow: () => '',

        setText: (id, value) => {

            element(id).textContent = String(value);

        },

        setHtml: (id, value) => {

            element(id).innerHTML = String(value);

        },

        setFieldError: () => {},

        showToast: (message, type) => {

            notifications.push({
                message,
                type
            });

        },

        openMo: id => modals.add(id),

        closeMo: id => modals.delete(id),

        openSessionView: () => {},

        friendlyAuthError: error => error.message,

        loadAdminData: async () => {},

        loadMemberPayments: async () => {},

        loadMemberData: async () => {},

        // No real Supabase connection.
        // Every RPC is recorded locally.

        rpc: async (name, args) => {

            calls.push({

                name,

                args: JSON.parse(
                    JSON.stringify(args)
                )

            });

            return {};

        }

    });


    vm.runInContext(
        ADMIN_OWNERSHIP_SOURCE,
        context
    );

    vm.runInContext(
        PAYMENT_SOURCE,
        context
    );

    vm.runInContext(
        MEMBER_SOURCE,
        context
    );

    vm.runInContext(
        JOIN_SOURCE,
        context
    );


    return {

        context,

        calls,

        modals,

        notifications,

        element,

        run: code =>
            vm.runInContext(code, context),

        setPayment: payment => {

            context.testPayment = payment;

        },

        setRecords: payments => {

            context.adminPayments = payments;

        },

        setPayingSession: sessionId => {

            context.payingSessionId = sessionId;

        },

        setReview: (payment, mode) => {

            context.testPayment = payment;

            context.testMode = mode;

            vm.runInContext(

                'reviewingPayment = {' +
                'p: testPayment, mode: testMode' +
                '}',

                context

            );

        }

    };

}


// ==========================================================
// 4. TEST RUNNER
// ==========================================================

async function test(id, description, action) {

    try {

        await action();

        passed++;

        console.log(
            `[PASS] ${id} — ${description}`
        );

    } catch (error) {

        failed++;

        console.error(
            `[FAIL] ${id} — ${description}`
        );

        console.error(
            '       ' + error.message
        );

    }

}


// ==========================================================
// 5. LEGACY PAYMENT REGRESSION TESTS
// ==========================================================

async function runTests() {


    await test(

        'LP-01',

        'Designated sandbox session identification',

        () => {

            const env = createEnvironment();

            env.context.testSession = SANDBOX;

            assert.equal(

                env.run(
                    'isProtectedHitPaySession(testSession)'
                ),

                true

            );

            env.context.testSession =
                SANDBOX.toUpperCase();

            assert.equal(

                env.run(
                    'isProtectedHitPaySession(testSession)'
                ),

                true

            );

        }

    );


    await test(

        'LP-02',

        'Ordinary session identification',

        () => {

            const env = createEnvironment();

            env.context.testSession = ORDINARY;

            assert.equal(

                env.run(
                    'isProtectedHitPaySession(testSession)'
                ),

                false

            );

            assert.equal(

                env.run(
                    'isProtectedHitPaySession(null)'
                ),

                false

            );

        }

    );


    await test(

        'LP-03',

        'HitPay provider identification',

        () => {

            const env = createEnvironment();

            env.setPayment(

                ordinaryPayment({

                    payment_provider: ' hitpay ',

                    is_sandbox: false

                })

            );

            assert.equal(

                env.run(
                    'isProtectedHitPayPayment(testPayment)'
                ),

                true

            );

        }

    );


    await test(

        'LP-04',

        'Sandbox payment identification',

        () => {

            const env = createEnvironment();

            env.setPayment(

                ordinaryPayment({

                    is_sandbox: true

                })

            );

            assert.equal(

                env.run(
                    'isProtectedHitPayPayment(testPayment)'
                ),

                true

            );

            env.setPayment(

                sandboxPayment({

                    payment_provider: undefined,

                    is_sandbox: undefined

                })

            );

            assert.equal(

                env.run(
                    'isProtectedHitPayPayment(testPayment)'
                ),

                true

            );

        }

    );


    await test(

        'LP-05',

        'Missing required payment identifiers block review',

        () => {

            const env = createEnvironment();

            for (const payment of [

                null,

                {},

                ordinaryPayment({
                    session_id: null
                }),

                ordinaryPayment({
                    registration_id: null
                })

            ]) {

                env.setPayment(payment);

                assert.equal(

                    env.run(
                        'canUseLegacyPaymentReview(testPayment)'
                    ),

                    false

                );

            }

        }

    );


    await test(

        'LP-06',

        'Ordinary payment review remains available',

        () => {

            const env = createEnvironment();

            env.setPayment(
                ordinaryPayment()
            );

            assert.equal(

                env.run(
                    'canUseLegacyPaymentReview(testPayment)'
                ),

                true

            );

        }

    );


    await test(

        'LP-07',

        'Cancelled session review is restricted',

        () => {

            const env = createEnvironment();

            env.setPayment(

                ordinaryPayment({

                    session_status: 'Cancelled'

                })

            );

            assert.equal(

                env.run(
                    'canUseLegacyPaymentReview(testPayment)'
                ),

                false

            );

        }

    );


    await test(

        'LP-08',

        'HitPay manual confirmation buttons are absent',

        () => {

            const env = createEnvironment();

            env.setPayment(
                sandboxPayment()
            );

            const output = env.run(
                'paymentActions(testPayment)'
            );

            assert.match(output, /View/);

            assert.doesNotMatch(
                output,
                /openPaymentReview|Confirm|Mark as paid/
            );

            env.setPayment(

                sandboxPayment({

                    status: 'UNPAID'

                })

            );

            assert.doesNotMatch(

                env.run(
                    'paymentActions(testPayment)'
                ),

                /openPaymentReview|Mark as paid/

            );

        }

    );


    await test(

        'LP-09',

        'HitPay manual rejection button is absent',

        () => {

            const env = createEnvironment();

            env.setPayment(
                sandboxPayment()
            );

            assert.doesNotMatch(

                env.run(
                    'paymentActions(testPayment)'
                ),

                /Reject|openPaymentReview/

            );

        }

    );


    await test(

        'LP-10',

        'Ordinary payment actions remain available',

        () => {

            const env = createEnvironment();

            env.setPayment(
                ordinaryPayment()
            );

            const output = env.run(
                'paymentActions(testPayment)'
            );

            assert.match(output, /Confirm/);

            assert.match(output, /Reject/);

            assert.match(output, /View/);

            env.setPayment(

                ordinaryPayment({

                    status: 'UNPAID',

                    reg_payment_status: 'UNPAID'

                })

            );

            assert.match(

                env.run(
                    'paymentActions(testPayment)'
                ),

                /Mark as paid/

            );

        }

    );


    await test(

        'LP-11',

        'HitPay administrator review modal is blocked',

        () => {

            const env = createEnvironment({

                records: [sandboxPayment()]

            });

            for (const mode of [

                'confirm',

                'reject',

                'mark'

            ]) {

                env.context.testMode = mode;

                env.run(

                    "openPaymentReview(" +
                    "'44444444-4444-4444-8444-444444444444', testMode)"

                );

                assert.equal(

                    env.modals.has('a-pay-review-mo'),

                    false

                );

                assert.equal(

                    env.run('reviewingPayment'),

                    null

                );

            }

            assert.equal(env.calls.length, 0);

        }

    );


    await test(

        'LP-12',

        'HitPay administrator submission is blocked',

        async () => {

            const payment = sandboxPayment();

            const env = createEnvironment({

                records: [payment]

            });

            for (const mode of [

                'confirm',

                'reject',

                'mark'

            ]) {

                env.setReview(payment, mode);

                await env.run(
                    'submitPaymentReview()'
                );

                assert.equal(
                    env.calls.length,
                    0
                );

                assert.equal(

                    env.run('reviewingPayment'),

                    null

                );

            }

        }

    );


    await test(

        'LP-13',

        'Stale administrator payment selection is blocked',

        async () => {

            const payment = ordinaryPayment();

            const env = createEnvironment({

                records: [payment]

            });

            env.run(

                "openPaymentReview(" +
                "'33333333-3333-4333-8333-333333333333', 'confirm')"

            );

            assert.equal(

                env.modals.has('a-pay-review-mo'),

                true

            );

            env.setRecords([

                ordinaryPayment({

                    status: 'PAID'

                })

            ]);

            await env.run(
                'submitPaymentReview()'
            );

            assert.equal(env.calls.length, 0);

            assert.equal(

                env.modals.has('a-pay-review-mo'),

                false

            );

            assert.equal(

                env.run('reviewingPayment'),

                null

            );

        }

    );


    await test(

        'LP-14',

        'Sandbox manual member submission is blocked',

        async () => {

            const env = createEnvironment({

                role: 'member'

            });

            env.setPayingSession(SANDBOX);

            env.element('msp-channel').value =
                'GCASH';

            env.element('msp-ref').value =
                'TEST-123456';

            env.modals.add('m-submit-payment');

            await env.run(
                'submitMemberPayment()'
            );

            assert.equal(env.calls.length, 0);

            assert.equal(

                env.context.payingSessionId,

                null

            );

            assert.equal(

                env.modals.has('m-submit-payment'),

                false

            );

        }

    );


    await test(

        'LP-15',

        'Ordinary member submission is preserved',

        async () => {

            const env = createEnvironment({

                role: 'member'

            });

            env.setPayingSession(ORDINARY);

            env.element('msp-channel').value =
                'GCASH';

            env.element('msp-ref').value =
                'TEST-123456';

            await env.run(
                'submitMemberPayment()'
            );

            assert.equal(env.calls.length, 1);

            assert.equal(

                env.calls[0].name,

                'member_submit_payment'

            );

            assert.deepEqual(

                env.calls[0].args,

                {

                    p_session: ORDINARY,

                    p_channel: 'GCASH',

                    p_reference: 'TEST-123456'

                }

            );

        }

    );


    await test(

        'LP-16',

        'HitPay excluded from manual review queue',

        () => {

            const env = createEnvironment({

                records: [

                    ordinaryPayment(),

                    sandboxPayment()

                ]

            });

            env.run('renderPayments()');

            const queue = env.element(
                'a-pay-review'
            ).innerHTML;

            assert.match(

                queue,

                /Ordinary Training Session/

            );

            assert.doesNotMatch(

                queue,

                /Synthetic HitPay Session|44444444-4444-4444-8444-444444444444/

            );

            assert.match(

                env.element(
                    'a-pay-pending-lbl'
                ).textContent,

                /To confirm \(1\)/

            );

        }

    );


    await test(

        'LP-17',

        'Sandbox Join Session interface requires paid status',

        () => {

            const env = createEnvironment({

                role: 'member',

                sessions: [{

                    session_id: SANDBOX,

                    title: 'Synthetic HitPay Session',

                    speaker: 'Synthetic Speaker',

                    is_registered: true,

                    payment_status: 'PENDING_PAYMENT',

                    zoom_ready: true,

                    fee: 100,

                    duration: 30,

                    start: new Date(
                        Date.now() - 60000
                    ).toISOString(),

                    end: new Date(
                        Date.now() + 1800000
                    ).toISOString()

                }]

            });

            env.context.testSession = SANDBOX;

            env.run(
                'openJoinModal(testSession)'
            );

            const footer = env.element(
                'm-join-footer'
            ).innerHTML;

            assert.match(

                footer,

                /HitPay payment verification required/

            );

            assert.doesNotMatch(

                footer,

                /handleJoinSession|openSubmitPayment|Join Now/

            );

            assert.equal(env.calls.length, 0);

        }

    );


    await test(

        'LP-18',

        'Payment account placeholder removed',

        () => {

            assert.doesNotMatch(

                SCRIPT,

                /\bPAYMENT_ACCOUNTS\b/

            );

            assert.match(

                HTML,

                /Submit Manual Payment Reference/

            );

            assert.match(

                HTML,

                /Review Manual Payment/

            );

            for (const id of [

                'm-submit-payment',

                'a-pay-review-mo',

                'hp-checkout-mo',

                'hp-status-mo',

                'hp-receipt-mo'

            ]) {

                assert.ok(

                    HTML.includes(`id="${id}"`),

                    'Missing interface: ' + id

                );

            }

        }

    );


// ==========================================================
// 6. ADDITIONAL ORDINARY ADMINISTRATOR REGRESSION TESTS
// ==========================================================

    await test(

        'LP-19',

        'Ordinary administrator confirmation is preserved',

        async () => {

            const env = createEnvironment({

                records: [ordinaryPayment()]

            });

            env.run(

                "openPaymentReview(" +
                "'33333333-3333-4333-8333-333333333333', 'confirm')"

            );

            assert.equal(

                env.modals.has('a-pay-review-mo'),

                true

            );

            await env.run(
                'submitPaymentReview()'
            );

            assert.equal(env.calls.length, 1);

            assert.equal(

                env.calls[0].name,

                'admin_confirm_payment'

            );

            assert.equal(

                env.calls[0].args.p_registration,

                REGISTRATION

            );

        }

    );


    await test(

        'LP-20',

        'Ordinary administrator rejection is preserved',

        async () => {

            const env = createEnvironment({

                records: [ordinaryPayment()]

            });

            env.run(

                "openPaymentReview(" +
                "'33333333-3333-4333-8333-333333333333', 'reject')"

            );

            env.element('apr-reason').value =
                'Synthetic test reason';

            await env.run(
                'submitPaymentReview()'
            );

            assert.equal(env.calls.length, 1);

            assert.equal(

                env.calls[0].name,

                'admin_reject_payment'

            );

            assert.deepEqual(

                env.calls[0].args,

                {

                    p_registration: REGISTRATION,

                    p_reason: 'Synthetic test reason'

                }

            );

        }

    );


// ==========================================================
// 7. FINAL SUMMARY
// ==========================================================

    console.log();

    console.log('='.repeat(58));

    console.log(
        'HITPAY LEGACY FRONTEND REGRESSION TEST SUMMARY'
    );

    console.log('='.repeat(58));

    console.log(
        'Tests executed: ' + (passed + failed)
    );

    console.log(
        'Tests passed:   ' + passed
    );

    console.log(
        'Tests failed:   ' + failed
    );

    console.log(
        'Application functions: EXTRACTED FROM SCRIPT.JS'
    );

    console.log(
        'Payment records: SIMULATED'
    );

    console.log(
        'DOM environment: SIMULATED'
    );

    console.log(
        'Supabase RPC calls: MOCKED'
    );

    console.log(
        'Real network requests: NONE'
    );

    console.log(
        'Database changes: NONE'
    );

    console.log(
        'Real payments: NONE'
    );

    console.log(
        'Deployment: NOT PERFORMED'
    );

    console.log('='.repeat(58));

    if (failed > 0) {

        process.exitCode = 1;

    }

}


runTests().catch(error => {

    console.error(
        '[FATAL]',
        error.message
    );

    process.exitCode = 1;

});
