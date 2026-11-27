
'use strict';

// ==========================================================
// GAMECHANGER — HITPAY MEMBER PAYMENT HISTORY TESTS
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

const SANDBOX = 'cd2f1fa3-c011-481f-b8fa-333354d14e27';
const ORDINARY = '11111111-1111-4111-8111-111111111111';
const MEMBER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TRANSACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REGISTRATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORDER = 'GC-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

let passed = 0;
let failed = 0;


// ==========================================================
// 1. EXTRACT ACTUAL APPLICATION FUNCTIONS
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

const AUTH_SOURCE = extract(
    '// HITPAY_MEMBER_PAYMENT_ISOLATION_V1',
    'function clearHitPayInterface('
);

const LOADER_SOURCE = extract(
    'async function loadMemberPayments() {',
    'let payingSessionId = null;'
);

const HISTORY_SOURCE = extract(
    '// HITPAY_MEMBER_PAYMENT_HISTORY_V1',
    'function renderMemberPayments() {'
);

const EXPORT_SOURCE = extract(
    'function safeMemberPaymentCSVValue(',
    'function handleExport('
);


// ==========================================================
// 2. SYNTHETIC PAYMENT RECORDS
// ==========================================================

function ordinaryPayment(overrides = {}) {
    return {
        transaction_id: TRANSACTION,
        registration_id: REGISTRATION,
        session_id: ORDINARY,
        session: 'Ordinary Training Session',
        payment_provider: 'MANUAL',
        is_sandbox: false,
        status: 'PAID',
        amount: 250,
        currency: 'PHP',
        channel: 'GCASH',
        reference: 'ORDINARY-TEST-001',
        date: '2026-12-05T06:00:00Z',
        reconciliation_required: false,
        ...overrides
    };
}

function sandboxPayment(overrides = {}) {
    return ordinaryPayment({
        session_id: SANDBOX,
        session: 'Synthetic HitPay Session',
        payment_provider: 'HITPAY',
        is_sandbox: true,
        amount: 100,
        order_reference: ORDER,
        reference: 'HITPAY-TEST-001',
        checkout_state: 'CREATED',
        receipt_available: true,
        ...overrides
    });
}

function paymentResponse(transactions = [], registrations = []) {
    return {
        transactions,
        registrations
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


// ==========================================================
// 3. SIMULATED APPLICATION ENVIRONMENT
// ==========================================================

function createEnvironment(options = {}) {
    const elements = new Map();

    const calls = {
        rpc: [],
        status: [],
        exports: [],
        notifications: [],
        renders: 0,
        badges: 0
    };

    let authUser = MEMBER_A;

    let rpcHandler = async () =>
        paymentResponse([sandboxPayment()]);

    let statusHandler = async () => true;

    let authHandler = async () => ({
        data: {
            session: authUser
                ? { user: { id: authUser } }
                : null
        },
        error: null
    });

    function element(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                textContent: '',
                innerHTML: '',
                value: '',
                style: {}
            });
        }

        return elements.get(id);
    }

    const context = vm.createContext({
        console: {
            log() {},
            warn() {},
            error() {}
        },

        currentRole: 'member',
        loggedInUser: { uid: MEMBER_A },

        memberPayments: null,
        memberData: null,
        payingSessionId: null,

        document: {
            getElementById: element
        },

        sb: {
            auth: {
                getSession: () => authHandler()
            }
        },

        GameChangerPayment: {
            CONFIG: {
                paymentStatusEnabled:
                    options.statusEnabled === true
            }
        },

        GameChangerPaymentUI: {
            async openStatus(reference) {
                calls.status.push(reference);
                return statusHandler(reference);
            }
        },

        async rpc(name) {
            calls.rpc.push(name);
            return rpcHandler(name);
        },

        renderMemberPayments() {
            calls.renders++;
        },

        updateMemberBadges() {
            calls.badges++;
        },

        showToast(...args) {
            calls.notifications.push(args);
        },

        downloadCSV(filename, headers, rows) {
            calls.exports.push({
                filename,
                headers,
                rows
            });
        },

        isProtectedHitPaySession(id) {
            return typeof id === 'string' &&
                id.toLowerCase() === SANDBOX;
        },

        PAYMENT_LABEL: {
            PAID: ['bg-g', 'Paid'],
            PENDING_PAYMENT: ['bg-y', 'Pending'],
            FAILED: ['bg-r', 'Failed'],
            CANCELLED: ['bg-gr', 'Cancelled'],
            REFUNDED: ['bg-gr', 'Refunded'],
            WAIVED: ['bg-g', 'Waived'],
            UNPAID: ['bg-y', 'Unpaid']
        },

        CHANNEL_LABEL: {
            GCASH: 'GCash',
            CARD: 'Card',
            MAYA: 'Maya'
        },

        paymentBadge(status) {
            return `<span>${status}</span>`;
        },

        esc(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },

        fmtMoney(value) {
            return 'PHP ' + Number(value).toFixed(2);
        },

        fmtDate(value) {
            return value ? 'Dec 5, 2026' : '—';
        }
    });

    vm.runInContext(
        [
            AUTH_SOURCE,
            LOADER_SOURCE,
            HISTORY_SOURCE,
            EXPORT_SOURCE
        ].join('\n\n'),
        context,
        { filename: 'member-history-extracted.js' }
    );

    context.memberPaymentAuthUserId = MEMBER_A;

    function setMember(userId) {
        context.invalidateMemberPaymentState();

        authUser = userId;

        context.currentRole = 'member';
        context.loggedInUser = { uid: userId };
        context.memberPaymentAuthUserId = userId;
    }

    function setCache(records, owner = authUser) {
        context.memberPaymentOwnerId = owner;
        context.memberPayments = paymentResponse(records);
    }

    function logout() {
        context.invalidateMemberPaymentState();

        authUser = null;

        context.loggedInUser = null;
        context.currentRole = null;
    }

    return {
        context,
        calls,
        element,
        setMember,
        setCache,
        logout,

        setAuthUser(value) {
            authUser = value;
        },

        setRpcHandler(handler) {
            rpcHandler = handler;
        },

        setStatusHandler(handler) {
            statusHandler = handler;
        },

        setAuthHandler(handler) {
            authHandler = handler;
        }
    };
}


// ==========================================================
// 4. TEST EXECUTION HELPERS
// ==========================================================

async function test(id, description, run) {
    try {
        await run();

        passed++;

        console.log(
            `[PASS] ${id} — ${description}`
        );

    } catch (error) {
        failed++;

        console.error(
            `[FAIL] ${id} — ${description}`
        );

        console.error(error.stack || error.message);
    }
}

async function waitFor(condition) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (condition()) return;

        await new Promise(resolve =>
            setImmediate(resolve)
        );
    }

    throw new Error(
        'Expected simulated operation did not start.'
    );
}


// ==========================================================
// 5. MEMBER PAYMENT HISTORY TESTS
// ==========================================================

async function main() {

    await test(
        'MH-01',
        'Identify HitPay transactions',
        () => {
            const { context: c } = createEnvironment();

            assert.equal(
                c.isMemberHitPayTransaction(sandboxPayment()),
                true
            );

            assert.equal(
                c.isMemberHitPayTransaction(
                    sandboxPayment({
                        payment_provider: ' hitpay '
                    })
                ),
                true
            );

            assert.equal(
                c.isMemberHitPayTransaction(ordinaryPayment()),
                false
            );
        }
    );

    await test(
        'MH-02',
        'Identify sandbox transactions',
        () => {
            const { context: c } = createEnvironment();

            assert.equal(
                c.isMemberSandboxPayment(sandboxPayment()),
                true
            );

            assert.equal(
                c.isMemberSandboxPayment(
                    sandboxPayment({ is_sandbox: false })
                ),
                true
            );

            assert.equal(
                c.isMemberSandboxPayment(ordinaryPayment()),
                false
            );
        }
    );

    await test(
        'MH-03',
        'Preserve ordinary payment records',
        () => {
            const { context: c } = createEnvironment();

            const record = ordinaryPayment();

            assert.equal(
                c.memberPaymentDisplayStatus(record),
                'PAID'
            );

            assert.equal(
                c.memberPaymentMetadata(record),
                ''
            );

            const row = c.renderMemberPaymentHistoryRow(record);

            assert.ok(row.includes(record.session));
            assert.ok(row.includes(record.reference));
            assert.ok(!row.includes('Test amount'));
            assert.ok(!row.includes('Check status'));
        }
    );

    await test(
        'MH-04',
        'Display reconciliation-required status',
        () => {
            const { context: c } = createEnvironment();

            for (const overrides of [
                { reconciliation_required: true },
                { checkout_state: 'REVIEW_REQUIRED' },
                { display_status: 'REVIEW_REQUIRED' }
            ]) {
                const record = sandboxPayment(overrides);

                assert.equal(
                    c.memberPaymentDisplayStatus(record),
                    'REVIEW_REQUIRED'
                );

                assert.ok(
                    c.memberPaymentStatusBadge(record)
                        .includes('Review required')
                );
            }
        }
    );

    await test(
        'MH-05',
        'Exclude sandbox amounts from actual paid totals',
        () => {
            const { context: c } = createEnvironment();

            const records = [
                ordinaryPayment({ amount: 250 }),
                sandboxPayment({ amount: 100 }),
                ordinaryPayment({
                    amount: 50,
                    status: 'PENDING_PAYMENT'
                }),
                ordinaryPayment({
                    amount: 100,
                    payment_provider: 'HITPAY'
                }),
                ordinaryPayment({
                    amount: 'invalid'
                })
            ];

            assert.equal(
                c.memberActualPaidTotal(records),
                250
            );
        }
    );

    await test(
        'MH-06',
        'Exclude sandbox outstanding amounts',
        () => {
            const { context: c } = createEnvironment();

            const result = c.memberActualPaymentDues([
                {
                    session_id: ORDINARY,
                    fee: 250
                },
                {
                    session_id: SANDBOX,
                    fee: 100
                }
            ]);

            assert.equal(result.length, 1);
            assert.equal(result[0].fee, 250);
        }
    );

    await test(
        'MH-07',
        'Search using order reference',
        () => {
            const { context: c } = createEnvironment();

            assert.equal(
                c.memberPaymentMatchesSearch(
                    sandboxPayment(),
                    ORDER.toLowerCase()
                ),
                true
            );

            assert.equal(
                c.memberPaymentMatchesSearch(
                    sandboxPayment(),
                    'missing-reference'
                ),
                false
            );
        }
    );

    await test(
        'MH-08',
        'Search using payment provider',
        () => {
            const { context: c } = createEnvironment();

            assert.equal(
                c.memberPaymentMatchesSearch(
                    sandboxPayment(),
                    'hitpay'
                ),
                true
            );

            assert.equal(
                c.memberPaymentMatchesSearch(
                    sandboxPayment(),
                    'sandbox'
                ),
                true
            );

            assert.equal(
                c.memberPaymentMatchesSearch(
                    ordinaryPayment(),
                    'hitpay'
                ),
                false
            );
        }
    );

    await test(
        'MH-09',
        'Escape unsafe transaction text',
        () => {
            const { context: c } = createEnvironment();

            const row = c.renderMemberPaymentHistoryRow(
                sandboxPayment({
                    session: '<unsafe-session>',
                    reference: '<unsafe-reference>',
                    channel: '<unsafe-method>'
                })
            );

            assert.ok(row.includes('&lt;unsafe-session&gt;'));
            assert.ok(row.includes('&lt;unsafe-reference&gt;'));
            assert.ok(row.includes('&lt;unsafe-method&gt;'));

            assert.ok(!row.includes('<unsafe-session>'));
            assert.ok(!row.includes('<unsafe-reference>'));
            assert.ok(!row.includes('<unsafe-method>'));
        }
    );

    await test(
        'MH-10',
        'Display sandbox metadata',
        () => {
            const { context: c } = createEnvironment();

            const row = c.renderMemberPaymentHistoryRow(
                sandboxPayment()
            );

            assert.ok(row.includes('HitPay'));
            assert.ok(row.includes('Sandbox'));
            assert.ok(row.includes('Test amount'));
            assert.ok(row.includes(ORDER));
        }
    );

    await test(
        'MH-11',
        'Disable actions when services are unavailable',
        async () => {
            const env = createEnvironment();

            env.setCache([sandboxPayment()]);

            const html = env.context.memberPaymentHistoryActions(
                sandboxPayment()
            );

            assert.ok(html.includes('disabled'));
            assert.ok(html.includes('Status service unavailable'));

            assert.equal(
                await env.context.openMemberHitPayHistoryAction(
                    TRANSACTION
                ),
                false
            );

            assert.equal(env.calls.status.length, 0);
        }
    );

    await test(
        'MH-12',
        'Reject malformed transaction identifiers',
        () => {
            const { context: c } = createEnvironment();

            assert.equal(
                c.canCheckMemberHitPayPayment(
                    sandboxPayment({
                        transaction_id: 'invalid-id'
                    })
                ),
                false
            );

            assert.equal(
                c.isMemberPaymentTransactionId(TRANSACTION),
                true
            );
        }
    );

    await test(
        'MH-13',
        'Reject malformed order references',
        () => {
            const { context: c } = createEnvironment();

            assert.equal(
                c.canCheckMemberHitPayPayment(
                    sandboxPayment({
                        order_reference: 'INVALID-ORDER'
                    })
                ),
                false
            );

            assert.equal(
                c.isMemberPaymentOrderReference(ORDER),
                true
            );
        }
    );

    await test(
        'MH-14',
        'Pending transactions cannot request receipts',
        () => {
            const { context: c } = createEnvironment();

            const record = sandboxPayment({
                status: 'PENDING_PAYMENT',
                receipt_available: true
            });

            assert.equal(
                c.canRequestMemberHitPayReceipt(record),
                false
            );

            assert.ok(
                !c.memberPaymentHistoryActions(record)
                    .includes('View receipt')
            );
        }
    );

    await test(
        'MH-15',
        'Eligible paid records permit receipt verification',
        async () => {
            const env = createEnvironment({
                statusEnabled: true
            });

            const record = sandboxPayment();

            env.setCache([record]);

            assert.equal(
                env.context.canRequestMemberHitPayReceipt(record),
                true
            );

            assert.equal(
                await env.context.openMemberHitPayHistoryAction(
                    TRANSACTION,
                    'receipt'
                ),
                true
            );

            assert.deepEqual(
                env.calls.status,
                [ORDER]
            );
        }
    );

    await test(
        'MH-16',
        'Reconciliation records cannot request receipts',
        async () => {
            const env = createEnvironment({
                statusEnabled: true
            });

            const record = sandboxPayment({
                reconciliation_required: true
            });

            env.setCache([record]);

            assert.equal(
                env.context.canRequestMemberHitPayReceipt(record),
                false
            );

            assert.equal(
                await env.context.openMemberHitPayHistoryAction(
                    TRANSACTION,
                    'receipt'
                ),
                false
            );

            assert.equal(env.calls.status.length, 0);
        }
    );


// ==========================================================
// 6. AUTHENTICATION AND CACHE ISOLATION TESTS
// ==========================================================

    await test(
        'MH-17',
        'Unauthenticated payment loading is blocked',
        async () => {
            const env = createEnvironment();

            env.logout();

            assert.equal(
                await env.context.loadMemberPayments(),
                false
            );

            assert.equal(env.calls.rpc.length, 0);
        }
    );

    await test(
        'MH-18',
        'Administrator payment loading is blocked',
        async () => {
            const env = createEnvironment();

            env.context.currentRole = 'admin';

            assert.equal(
                await env.context.loadMemberPayments(),
                false
            );

            assert.equal(env.calls.rpc.length, 0);
        }
    );

    await test(
        'MH-19',
        'Authenticated member owns loaded payment cache',
        async () => {
            const env = createEnvironment();

            assert.equal(
                await env.context.loadMemberPayments(),
                true
            );

            assert.equal(
                env.context.memberPaymentOwnerId,
                MEMBER_A
            );

            assert.equal(
                env.context.ownsMemberPaymentCache(),
                true
            );

            assert.equal(
                env.context.mp().transactions.length,
                1
            );
        }
    );

    await test(
        'MH-20',
        'Logout invalidates payment records',
        async () => {
            const env = createEnvironment();

            await env.context.loadMemberPayments();

            env.element('mpay-tbody').textContent =
                'Synthetic payment information';

            env.logout();

            assert.equal(
                env.context.memberPayments,
                null
            );

            assert.equal(
                env.context.memberPaymentOwnerId,
                null
            );

            assert.equal(
                env.context.mp().transactions.length,
                0
            );

            assert.equal(
                env.element('mpay-tbody').textContent,
                ''
            );
        }
    );

    await test(
        'MH-21',
        'Account switching discards outdated responses',
        async () => {
            const env = createEnvironment();

            const oldResponse = deferred();

            env.setRpcHandler(
                () => oldResponse.promise
            );

            const oldRequest =
                env.context.loadMemberPayments();

            await waitFor(
                () => env.calls.rpc.length === 1
            );

            env.setMember(MEMBER_B);

            env.setRpcHandler(async () =>
                paymentResponse([
                    ordinaryPayment({
                        reference: 'MEMBER-B'
                    })
                ])
            );

            assert.equal(
                await env.context.loadMemberPayments(),
                true
            );

            oldResponse.resolve(
                paymentResponse([
                    sandboxPayment({
                        reference: 'MEMBER-A'
                    })
                ])
            );

            assert.equal(await oldRequest, false);

            assert.equal(
                env.context.memberPaymentOwnerId,
                MEMBER_B
            );

            assert.equal(
                env.context.mp().transactions[0].reference,
                'MEMBER-B'
            );
        }
    );

    await test(
        'MH-22',
        'Older requests cannot overwrite newer records',
        async () => {
            const env = createEnvironment();

            const first = deferred();
            const second = deferred();

            let count = 0;

            env.setRpcHandler(() => {
                count++;

                return count === 1
                    ? first.promise
                    : second.promise;
            });

            const oldRequest =
                env.context.loadMemberPayments();

            await waitFor(() => count === 1);

            const newRequest =
                env.context.loadMemberPayments();

            await waitFor(() => count === 2);

            second.resolve(
                paymentResponse([
                    sandboxPayment({
                        reference: 'NEW'
                    })
                ])
            );

            assert.equal(await newRequest, true);

            first.resolve(
                paymentResponse([
                    sandboxPayment({
                        reference: 'OLD'
                    })
                ])
            );

            assert.equal(await oldRequest, false);

            assert.equal(
                env.context.mp().transactions[0].reference,
                'NEW'
            );
        }
    );

    await test(
        'MH-23',
        'Failed RPC does not expose fallback records',
        async () => {
            const env = createEnvironment();

            env.context.memberData = {
                upcoming: [
                    {
                        session_id: ORDINARY,
                        reference: 'STALE-DATA'
                    }
                ]
            };

            env.setRpcHandler(async () => {
                throw new Error('Simulated RPC failure');
            });

            assert.equal(
                await env.context.loadMemberPayments(),
                false
            );

            assert.equal(
                env.context.memberPayments.fallback,
                true
            );

            assert.equal(
                env.context.mp().transactions.length,
                0
            );

            assert.equal(
                env.context.mp().registrations.length,
                0
            );
        }
    );


// ==========================================================
// 7. PAYMENT HISTORY ACTION ISOLATION TESTS
// ==========================================================

    await test(
        'MH-24',
        'Unauthorized payment history actions are blocked',
        async () => {
            const env = createEnvironment({
                statusEnabled: true
            });

            env.setCache(
                [sandboxPayment()],
                MEMBER_B
            );

            assert.equal(
                await env.context.openMemberHitPayHistoryAction(
                    TRANSACTION
                ),
                false
            );

            env.setCache([sandboxPayment()]);

            env.setAuthUser(MEMBER_B);

            assert.equal(
                await env.context.openMemberHitPayHistoryAction(
                    TRANSACTION
                ),
                false
            );

            assert.equal(env.calls.status.length, 0);
        }
    );

    await test(
        'MH-25',
        'Duplicate history actions are blocked',
        async () => {
            const env = createEnvironment({
                statusEnabled: true
            });

            env.setCache([sandboxPayment()]);

            const response = deferred();

            env.setStatusHandler(
                () => response.promise
            );

            const first =
                env.context.openMemberHitPayHistoryAction(
                    TRANSACTION
                );

            await waitFor(
                () => env.calls.status.length === 1
            );

            assert.equal(
                await env.context.openMemberHitPayHistoryAction(
                    TRANSACTION
                ),
                false
            );

            assert.equal(env.calls.status.length, 1);

            response.resolve(true);

            assert.equal(await first, true);
        }
    );

    await test(
        'MH-26',
        'Older actions cannot unlock newer actions',
        async () => {
            const env = createEnvironment({
                statusEnabled: true
            });

            env.setCache([sandboxPayment()]);

            const first = deferred();
            const second = deferred();

            env.setStatusHandler(
                () => first.promise
            );

            const oldAction =
                env.context.openMemberHitPayHistoryAction(
                    TRANSACTION
                );

            await waitFor(
                () => env.calls.status.length === 1
            );

            env.setMember(MEMBER_B);
            env.setCache([sandboxPayment()]);

            env.setStatusHandler(
                () => second.promise
            );

            const newAction =
                env.context.openMemberHitPayHistoryAction(
                    TRANSACTION
                );

            await waitFor(
                () => env.calls.status.length === 2
            );

            const activeId =
                env.context.memberPaymentActiveAction;

            first.resolve(true);

            assert.equal(await oldAction, false);

            assert.equal(
                env.context.memberPaymentActiveAction,
                activeId
            );

            assert.equal(
                await env.context.openMemberHitPayHistoryAction(
                    TRANSACTION
                ),
                false
            );

            second.resolve(true);

            assert.equal(await newAction, true);

            assert.equal(
                env.context.memberPaymentActiveAction,
                null
            );
        }
    );


// ==========================================================
// 8. MEMBER PAYMENT CSV EXPORT TESTS
// ==========================================================

    await test(
        'MH-27',
        'CSV export requires owned payment records',
        async () => {
            const env = createEnvironment();

            env.setCache(
                [sandboxPayment()],
                MEMBER_B
            );

            assert.equal(
                await env.context.exportOwnedMemberPayments(),
                false
            );

            assert.equal(env.calls.exports.length, 0);
        }
    );

    await test(
        'MH-28',
        'CSV export identifies sandbox transactions',
        async () => {
            const env = createEnvironment();

            env.setCache([
                ordinaryPayment(),
                sandboxPayment({
                    reconciliation_required: true
                })
            ]);

            assert.equal(
                await env.context.exportOwnedMemberPayments(),
                true
            );

            assert.equal(env.calls.exports.length, 1);

            const exported = env.calls.exports[0];

            assert.equal(exported.headers.length, 11);
            assert.equal(exported.rows.length, 2);

            const providerIndex =
                exported.headers.indexOf('Payment Provider');

            const environmentIndex =
                exported.headers.indexOf('Environment');

            const statusIndex =
                exported.headers.indexOf('Status');

            const orderIndex =
                exported.headers.indexOf('Order Reference');

            const reconciliationIndex =
                exported.headers.indexOf(
                    'Reconciliation Required'
                );

            assert.equal(
                exported.rows[0][environmentIndex],
                'ORDINARY'
            );

            assert.equal(
                exported.rows[1][providerIndex],
                'HitPay'
            );

            assert.equal(
                exported.rows[1][environmentIndex],
                'SANDBOX - TEST ONLY'
            );

            assert.equal(
                exported.rows[1][statusIndex],
                'REVIEW_REQUIRED'
            );

            assert.equal(
                exported.rows[1][orderIndex],
                ORDER
            );

            assert.equal(
                exported.rows[1][reconciliationIndex],
                'Yes'
            );
        }
    );

    await test(
        'MH-29',
        'CSV formula-injection mitigation',
        async () => {
            const env = createEnvironment();
            const c = env.context;

            const unsafeValues = [
                '=1+1',
                '+1+1',
                '-1+1',
                '@SUM(1,1)',
                '   =1+1',
                '\tTest',
                '\rTest',
                '\nTest',
                '＝1+1'
            ];

            for (const value of unsafeValues) {
                assert.equal(
                    c.safeMemberPaymentCSVValue(value),
                    "'" + value
                );
            }

            assert.equal(
                c.safeMemberPaymentCSVValue(100),
                100
            );

            assert.equal(
                c.safeMemberPaymentCSVValue('Normal text'),
                'Normal text'
            );

            env.setCache([
                sandboxPayment({
                    session: '=1+1',
                    reference: '@SUM(1,1)'
                })
            ]);

            assert.equal(
                await c.exportOwnedMemberPayments(),
                true
            );

            const row = env.calls.exports[0].rows[0];

            assert.equal(row[0], "'=1+1");
            assert.equal(row[4], "'@SUM(1,1)");
        }
    );

    await test(
        'MH-30',
        'Account switching prevents stale CSV export',
        async () => {
            const env = createEnvironment();

            env.setCache([sandboxPayment()]);

            const authResponse = deferred();

            let authStarted = false;

            env.setAuthHandler(() => {
                authStarted = true;
                return authResponse.promise;
            });

            const exportRequest =
                env.context.exportOwnedMemberPayments();

            await waitFor(() => authStarted);

            env.setMember(MEMBER_B);

            env.setCache([
                ordinaryPayment({
                    reference: 'MEMBER-B'
                })
            ]);

            authResponse.resolve({
                data: {
                    session: {
                        user: { id: MEMBER_A }
                    }
                },
                error: null
            });

            assert.equal(await exportRequest, false);
            assert.equal(env.calls.exports.length, 0);
        }
    );


// ==========================================================
// 9. FINAL TEST SUMMARY
// ==========================================================

    console.log();
    console.log('='.repeat(62));
    console.log('HITPAY MEMBER PAYMENT HISTORY TEST SUMMARY');
    console.log('='.repeat(62));

    console.log(`Tests executed: ${passed + failed}`);
    console.log(`Tests passed:   ${passed}`);
    console.log(`Tests failed:   ${failed}`);

    console.log('Application functions: EXTRACTED FROM SCRIPT.JS');
    console.log('Authentication: SIMULATED');
    console.log('Payment records: SYNTHETIC');
    console.log('Supabase RPC calls: MOCKED');
    console.log('Status controller: MOCKED');
    console.log('Formatting helpers: MOCKED');
    console.log('CSV download: MOCKED');
    console.log('Real network requests: NONE');
    console.log('Database changes: NONE');
    console.log('Real payments: NONE');
    console.log('Deployment: NOT PERFORMED');

    console.log('='.repeat(62));

    if (failed > 0 || passed !== 30) {
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error('TEST SUITE ERROR:', error);
    process.exitCode = 1;
});
