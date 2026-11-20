const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Configure hermetic test environment before requiring server
const TEST_SERVICE_SECRET = 'xorwia-test-secret-value-xyz789';
const TEST_WEBHOOK_SECRET = 'whsec_test_hayder_stripe_webhook_secret_12345';

process.env.STRIPE_SECRET_KEY =
    process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_stripe_key_for_testing';
process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
process.env.XORWIA_BILLING_SERVICE_SECRET = TEST_SERVICE_SECRET;
process.env.AWS_REGION = 'eu-west-2';
process.env.ACCESS_TABLE_NAME = 'xorwia_user_access';
process.env.ENTITLEMENTS_TABLE_NAME = 'xorwia_entitlements';

const { app, dynamodb, stripe } = require('../server');
const {
    buildHayderEntitlementUpdateParams,
    computeEventOrder,
    extractInvoiceSubscriptionContext
} = require('../agent/stripe_webhook');

let server;
let baseUrl;
let originalSend;

const entitlementsStore = new Map();
const userAccessStore = new Map();
let capturedUpdateCommands = [];

function makeEntitlementKey(external_user_id, product) {
    return `${external_user_id}#${product}`;
}

function makeAccessKey(email, product) {
    return `${email}#${product}`;
}

function cloneItem(item) {
    if (!item) return null;
    const copy = {};
    for (const [k, v] of Object.entries(item)) {
        copy[k] = v instanceof Set ? new Set(v) : v;
    }
    return copy;
}

/**
 * Faithful DynamoDB ConditionExpression evaluator supporting:
 * parentheses, OR, AND, NOT, attribute_not_exists(attr), contains(attr, :val),
 * and comparison operators (=, <>, <, <=, >, >=).
 */
function tokenizeCondition(expr) {
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
        if (/\s/.test(expr[i])) {
            i += 1;
            continue;
        }
        if (expr[i] === '(' || expr[i] === ')' || expr[i] === ',') {
            tokens.push({ type: expr[i], value: expr[i] });
            i += 1;
            continue;
        }
        if (expr.slice(i, i + 2) === '<>' || expr.slice(i, i + 2) === '<=' || expr.slice(i, i + 2) === '>=') {
            tokens.push({ type: 'OP', value: expr.slice(i, i + 2) });
            i += 2;
            continue;
        }
        if (expr[i] === '=' || expr[i] === '<' || expr[i] === '>') {
            tokens.push({ type: 'OP', value: expr[i] });
            i += 1;
            continue;
        }
        const match = expr.slice(i).match(/^[#:a-zA-Z0-9_]+/);
        if (!match) {
            throw new Error(`Unexpected token in ConditionExpression at: ${expr.slice(i)}`);
        }
        const word = match[0];
        const upper = word.toUpperCase();
        if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
            tokens.push({ type: upper, value: upper });
        } else {
            tokens.push({ type: 'IDENT', value: word });
        }
        i += word.length;
    }
    return tokens;
}

function evaluateConditionExpression(expr, item, names = {}, values = {}) {
    if (!expr) return true;
    const tokens = tokenizeCondition(expr);
    let pos = 0;

    function peek() {
        return tokens[pos];
    }

    function consume(expectedType) {
        const tok = tokens[pos];
        if (!tok || (expectedType && tok.type !== expectedType)) {
            throw new Error(`Expected ${expectedType}, got ${tok ? tok.type : 'EOF'}`);
        }
        pos += 1;
        return tok;
    }

    function resolveAttrName(tokenVal) {
        return tokenVal.startsWith('#') ? names[tokenVal] : tokenVal;
    }

    function resolveOperand(tokenVal) {
        if (tokenVal.startsWith(':')) {
            if (!(tokenVal in values)) {
                throw new Error(`Missing ExpressionAttributeValue: ${tokenVal}`);
            }
            return values[tokenVal];
        }
        const attrName = resolveAttrName(tokenVal);
        return item ? item[attrName] : undefined;
    }

    function parseOr() {
        let left = parseAnd();
        while (peek()?.type === 'OR') {
            consume('OR');
            const right = parseAnd();
            left = left || right;
        }
        return left;
    }

    function parseAnd() {
        let left = parseNot();
        while (peek()?.type === 'AND') {
            consume('AND');
            const right = parseNot();
            left = left && right;
        }
        return left;
    }

    function parseNot() {
        if (peek()?.type === 'NOT') {
            consume('NOT');
            return !parseNot();
        }
        return parsePrimary();
    }

    function parsePrimary() {
        if (peek()?.type === '(') {
            consume('(');
            const result = parseOr();
            consume(')');
            return result;
        }

        const ident = consume('IDENT').value;

        if (peek()?.type === '(') {
            consume('(');
            const fnName = ident.toLowerCase();
            if (fnName === 'attribute_not_exists') {
                const attrToken = consume('IDENT').value;
                consume(')');
                const attrName = resolveAttrName(attrToken);
                return !item || !(attrName in item) || item[attrName] === undefined;
            }
            if (fnName === 'attribute_exists') {
                const attrToken = consume('IDENT').value;
                consume(')');
                const attrName = resolveAttrName(attrToken);
                return Boolean(item && attrName in item && item[attrName] !== undefined);
            }
            if (fnName === 'contains') {
                const containerToken = consume('IDENT').value;
                consume(',');
                const needleToken = consume('IDENT').value;
                consume(')');
                const container = resolveOperand(containerToken);
                const needle = resolveOperand(needleToken);
                if (container instanceof Set) return container.has(needle);
                if (Array.isArray(container)) return container.includes(needle);
                if (typeof container === 'string') return container.includes(String(needle));
                return false;
            }
            throw new Error(`Unsupported ConditionExpression function: ${ident}`);
        }

        const op = consume('OP').value;
        const rhsToken = consume('IDENT').value;
        const lhs = resolveOperand(ident);
        const rhs = resolveOperand(rhsToken);

        switch (op) {
            case '=':
                return lhs === rhs;
            case '<>':
                return lhs !== rhs;
            case '<':
                return typeof lhs === 'number' && typeof rhs === 'number' && lhs < rhs;
            case '<=':
                return typeof lhs === 'number' && typeof rhs === 'number' && lhs <= rhs;
            case '>':
                return typeof lhs === 'number' && typeof rhs === 'number' && lhs > rhs;
            case '>=':
                return typeof lhs === 'number' && typeof rhs === 'number' && lhs >= rhs;
            default:
                throw new Error(`Unsupported operator: ${op}`);
        }
    }

    const result = parseOr();
    if (pos !== tokens.length) {
        throw new Error(`Unparsed ConditionExpression tokens remaining at pos ${pos}`);
    }
    return result;
}

/**
 * Faithful DynamoDB UpdateExpression applier supporting SET (including if_not_exists), REMOVE, ADD.
 */
function applyUpdateExpression(existingItem, keyObj, input) {
    const names = input.ExpressionAttributeNames || {};
    const values = input.ExpressionAttributeValues || {};

    // Verify all declared attribute names/values are actually referenced (like real DynamoDB)
    const combinedExpr = `${input.UpdateExpression || ''} ${input.ConditionExpression || ''}`;
    for (const k of Object.keys(names)) {
        if (!combinedExpr.includes(k)) {
            throw new Error(`Unused ExpressionAttributeName: ${k}`);
        }
    }
    for (const k of Object.keys(values)) {
        if (!combinedExpr.includes(k)) {
            throw new Error(`Unused ExpressionAttributeValue: ${k}`);
        }
    }

    if (
        input.ConditionExpression &&
        !evaluateConditionExpression(input.ConditionExpression, existingItem, names, values)
    ) {
        const err = new Error('The conditional request failed');
        err.name = 'ConditionalCheckFailedException';
        throw err;
    }

    const item = existingItem ? cloneItem(existingItem) : { ...keyObj };
    const expr = input.UpdateExpression || '';

    const clauseRegex = /\b(SET|REMOVE|ADD)\b/g;
    const matches = [];
    let m;
    while ((m = clauseRegex.exec(expr)) !== null) {
        matches.push({ keyword: m[1], index: m.index, end: m.index + m[1].length });
    }

    const resolveName = (raw) => {
        const trimmed = raw.trim();
        return trimmed.startsWith('#') ? names[trimmed] : trimmed;
    };

    for (let idx = 0; idx < matches.length; idx += 1) {
        const current = matches[idx];
        const nextIndex = idx + 1 < matches.length ? matches[idx + 1].index : expr.length;
        const body = expr.slice(current.end, nextIndex).trim();

        // Split top-level commas (not inside parentheses)
        const parts = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < body.length; i += 1) {
            if (body[i] === '(') depth += 1;
            else if (body[i] === ')') depth -= 1;
            else if (body[i] === ',' && depth === 0) {
                parts.push(body.slice(start, i).trim());
                start = i + 1;
            }
        }
        if (body.slice(start).trim()) {
            parts.push(body.slice(start).trim());
        }

        if (current.keyword === 'SET') {
            for (const part of parts) {
                const eqIdx = part.indexOf('=');
                const attrName = resolveName(part.slice(0, eqIdx));
                const rhs = part.slice(eqIdx + 1).trim();

                const ifNotExistsMatch = rhs.match(/^if_not_exists\(\s*([^,]+)\s*,\s*([^)]+)\s*\)$/);
                if (ifNotExistsMatch) {
                    const checkAttr = resolveName(ifNotExistsMatch[1]);
                    const fallbackVal = values[ifNotExistsMatch[2].trim()];
                    if (item[checkAttr] === undefined) {
                        item[attrName] = fallbackVal;
                    }
                } else {
                    item[attrName] = values[rhs];
                }
            }
        } else if (current.keyword === 'REMOVE') {
            for (const part of parts) {
                const attrName = resolveName(part);
                delete item[attrName];
            }
        } else if (current.keyword === 'ADD') {
            for (const part of parts) {
                const [attrToken, valToken] = part.trim().split(/\s+/);
                const attrName = resolveName(attrToken);
                const val = values[valToken];

                if (val instanceof Set) {
                    const currentSet = item[attrName] instanceof Set ? new Set(item[attrName]) : new Set();
                    for (const elem of val) currentSet.add(elem);
                    item[attrName] = currentSet;
                } else if (typeof val === 'number') {
                    item[attrName] = Number(item[attrName] || 0) + val;
                } else {
                    throw new Error(`Unsupported ADD value type for ${attrName}`);
                }
            }
        }
    }

    return item;
}

function buildSignedWebhookRequest(eventObj, secret = TEST_WEBHOOK_SECRET) {
    const payload = JSON.stringify(eventObj);
    const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret
    });
    return { payload, signature };
}

async function sendWebhook(eventObj, options = {}) {
    const secret = options.secret !== undefined ? options.secret : TEST_WEBHOOK_SECRET;
    const { payload, signature } = buildSignedWebhookRequest(eventObj, secret);
    const bodyToSend = options.rawBody !== undefined ? options.rawBody : payload;

    const headers = {
        'Content-Type': 'application/json'
    };

    if (options.omitSignature !== true) {
        headers['stripe-signature'] =
            options.signature !== undefined ? options.signature : signature;
    }

    const res = await fetch(`${baseUrl}/stripe/webhook`, {
        method: 'POST',
        headers,
        body: bodyToSend
    });

    const text = await res.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = text;
    }

    return { status: res.status, body: parsed };
}

async function checkEntitlement(external_user_id, product = 'HAYDER_PRO') {
    const res = await fetch(`${baseUrl}/api/billing/entitlement`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TEST_SERVICE_SECRET}`
        },
        body: JSON.stringify({ external_user_id, product })
    });
    return { status: res.status, body: await res.json() };
}

async function checkLegacyAccess(email, product) {
    const res = await fetch(
        `${baseUrl}/api/access/check?email=${encodeURIComponent(email)}&product=${encodeURIComponent(product)}`
    );
    return { status: res.status, body: await res.json() };
}

before(async () => {
    originalSend = dynamodb.send;
    dynamodb.send = async (command) => {
        const input = command.input || {};
        const tableName = input.TableName;
        const cmdName = command.constructor.name;

        if (tableName === process.env.ENTITLEMENTS_TABLE_NAME) {
            if (cmdName === 'GetCommand') {
                const key = makeEntitlementKey(input.Key.external_user_id, input.Key.product);
                return { Item: cloneItem(entitlementsStore.get(key) || null) };
            }
            if (cmdName === 'UpdateCommand') {
                capturedUpdateCommands.push(input);
                const key = makeEntitlementKey(input.Key.external_user_id, input.Key.product);
                const existing = entitlementsStore.get(key) || null;
                const updated = applyUpdateExpression(existing, input.Key, input);
                entitlementsStore.set(key, updated);
                return { Attributes: cloneItem(updated) };
            }
        }

        if (tableName === process.env.ACCESS_TABLE_NAME) {
            if (cmdName === 'GetCommand') {
                const key = makeAccessKey(input.Key.email, input.Key.product);
                return { Item: cloneItem(userAccessStore.get(key) || null) };
            }
            if (cmdName === 'UpdateCommand') {
                capturedUpdateCommands.push(input);
                const key = makeAccessKey(input.Key.email, input.Key.product);
                const existing = userAccessStore.get(key) || null;
                const updated = applyUpdateExpression(existing, input.Key, input);
                userAccessStore.set(key, updated);
                return { Attributes: cloneItem(updated) };
            }
        }

        throw new Error(`Unexpected DynamoDB call: ${cmdName} on ${tableName}`);
    };

    await new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(0, () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            resolve();
        });
    });
});

after(async () => {
    if (originalSend) {
        dynamodb.send = originalSend;
    }
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
});

beforeEach(() => {
    entitlementsStore.clear();
    userAccessStore.clear();
    capturedUpdateCommands = [];
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    process.env.XORWIA_BILLING_SERVICE_SECRET = TEST_SERVICE_SECRET;
});

const FUTURE_EPOCH_1 = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
const FUTURE_EPOCH_2 = Math.floor(Date.now() / 1000) + 60 * 24 * 3600;
const BASE_EVENT_TS = Math.floor(Date.now() / 1000) - 1000;

describe('POST /stripe/webhook: Signature Verification & Safety', () => {
    it('rejects missing stripe-signature header with 400', async () => {
        const res = await sendWebhook(
            { id: 'evt_nosig_1', type: 'customer.subscription.deleted', created: BASE_EVENT_TS, data: { object: {} } },
            { omitSignature: true }
        );
        assert.equal(res.status, 400);
        assert.equal(capturedUpdateCommands.length, 0);
    });

    it('rejects when STRIPE_WEBHOOK_SECRET is missing with 400', async () => {
        delete process.env.STRIPE_WEBHOOK_SECRET;
        const res = await sendWebhook({
            id: 'evt_nosecret_1',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS,
            data: { object: {} }
        });
        assert.equal(res.status, 400);
        assert.equal(capturedUpdateCommands.length, 0);
    });

    it('rejects invalid signature and tampered body with 400 without leaking secrets', async () => {
        const event = {
            id: 'evt_tamper_1',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'cs_test_tamper',
                    mode: 'subscription',
                    payment_status: 'paid',
                    customer: 'cus_test_1',
                    subscription: 'sub_test_1',
                    client_reference_id: 'hayder:user-tamper',
                    metadata: { product: 'HAYDER_PRO', external_user_id: 'hayder:user-tamper' }
                }
            }
        };

        const wrongSecretRes = await sendWebhook(event, { secret: 'whsec_wrong_secret' });
        assert.equal(wrongSecretRes.status, 400);
        assert.equal(String(wrongSecretRes.body).includes(TEST_WEBHOOK_SECRET), false);

        const tamperedPayload = JSON.stringify({ ...event, id: 'evt_tamper_modified' });
        const tamperedRes = await sendWebhook(event, { rawBody: tamperedPayload });
        assert.equal(tamperedRes.status, 400);
        assert.equal(capturedUpdateCommands.length, 0);
    });
});

describe('POST /stripe/webhook: HAYDER_PRO Subscription Lifecycle', () => {
    const userId = 'hayder:sub-user-lifecycle-001';
    const customerId = 'cus_test_lifecycle_001';
    const subscriptionId = 'sub_test_lifecycle_001';

    it('activates HAYDER_PRO on paid checkout.session.completed and passes entitlement check', async () => {
        const res = await sendWebhook({
            id: 'evt_checkout_001',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'cs_test_hayder_001',
                    mode: 'subscription',
                    payment_status: 'paid',
                    customer: customerId,
                    subscription: subscriptionId,
                    client_reference_id: userId,
                    customer_details: { email: 'ProUser@Example.com' },
                    metadata: {
                        product: 'HAYDER_PRO',
                        external_user_id: userId,
                        billing_interval: 'monthly'
                    }
                }
            }
        });

        assert.equal(res.status, 200);
        assert.equal(res.body.accessGranted, true);
        assert.equal(res.body.status, 'active');

        const record = entitlementsStore.get(makeEntitlementKey(userId, 'HAYDER_PRO'));
        assert.equal(record.status, 'active');
        assert.equal(record.source, 'paid');
        assert.equal(record.stripe_customer_id, customerId);
        assert.equal(record.stripe_subscription_id, subscriptionId);
        assert.equal(record.billing_interval, 'monthly');
        assert.equal(record.email, 'prouser@example.com');

        const ent = await checkEntitlement(userId);
        assert.equal(ent.status, 200);
        assert.deepEqual(ent.body, {
            entitled: true,
            status: 'active',
            product: 'HAYDER_PRO'
        });
    });

    it('does not activate HAYDER_PRO when checkout session payment_status is unpaid', async () => {
        const res = await sendWebhook({
            id: 'evt_checkout_unpaid_001',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'cs_test_unpaid_001',
                    mode: 'subscription',
                    payment_status: 'unpaid',
                    customer: customerId,
                    subscription: subscriptionId,
                    client_reference_id: userId,
                    metadata: {
                        product: 'HAYDER_PRO',
                        external_user_id: userId,
                        billing_interval: 'monthly'
                    }
                }
            }
        });

        assert.equal(res.status, 200);
        assert.equal(res.body.accessGranted, false);
        assert.equal(res.body.reason, 'payment_not_paid');
        assert.equal(entitlementsStore.size, 0);
    });

    it('handles renewal via invoice.paid (both Basil parent.subscription_details and classic shapes)', async () => {
        // Initial activation
        await sendWebhook({
            id: 'evt_init_001',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'cs_test_init_001',
                    mode: 'subscription',
                    payment_status: 'paid',
                    customer: customerId,
                    subscription: subscriptionId,
                    client_reference_id: userId,
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId, billing_interval: 'monthly' }
                }
            }
        });

        // First invoice paid (Basil 2025+ nested parent.subscription_details format)
        const inv1 = await sendWebhook({
            id: 'evt_inv_paid_001',
            type: 'invoice.paid',
            created: BASE_EVENT_TS + 5,
            data: {
                object: {
                    id: 'in_test_001',
                    status: 'paid',
                    paid: true,
                    billing_reason: 'subscription_create',
                    customer: customerId,
                    parent: {
                        subscription_details: {
                            subscription: subscriptionId,
                            metadata: {
                                product: 'HAYDER_PRO',
                                external_user_id: userId,
                                billing_interval: 'monthly'
                            }
                        }
                    },
                    lines: {
                        data: [{ period: { end: FUTURE_EPOCH_1 } }]
                    }
                }
            }
        });
        assert.equal(inv1.status, 200);
        assert.equal(inv1.body.status, 'active');

        const afterFirst = entitlementsStore.get(makeEntitlementKey(userId, 'HAYDER_PRO'));
        assert.equal(afterFirst.expires_at, new Date(FUTURE_EPOCH_1 * 1000).toISOString());

        // Recurring renewal (classic Stripe invoice shape)
        const inv2 = await sendWebhook({
            id: 'evt_inv_renew_002',
            type: 'invoice.paid',
            created: BASE_EVENT_TS + 100,
            data: {
                object: {
                    id: 'in_test_002',
                    status: 'paid',
                    paid: true,
                    billing_reason: 'subscription_cycle',
                    customer: customerId,
                    subscription: subscriptionId,
                    subscription_details: {
                        metadata: {
                            product: 'HAYDER_PRO',
                            external_user_id: userId,
                            billing_interval: 'monthly'
                        }
                    },
                    lines: {
                        data: [{ period: { end: FUTURE_EPOCH_2 } }]
                    }
                }
            }
        });
        assert.equal(inv2.status, 200);
        assert.equal(inv2.body.accessGranted, true);

        const afterRenewal = entitlementsStore.get(makeEntitlementKey(userId, 'HAYDER_PRO'));
        assert.equal(afterRenewal.expires_at, new Date(FUTURE_EPOCH_2 * 1000).toISOString());
        assert.equal(afterRenewal.last_invoice_id, 'in_test_002');
        assert.equal((await checkEntitlement(userId)).body.entitled, true);
    });

    it('handles payment failure (invoice.payment_failed) and payment recovery (invoice.paid)', async () => {
        // Activate first
        await sendWebhook({
            id: 'evt_pf_init',
            type: 'invoice.paid',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'in_pf_1',
                    status: 'paid',
                    paid: true,
                    billing_reason: 'subscription_create',
                    customer: customerId,
                    subscription: subscriptionId,
                    subscription_details: {
                        metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                    },
                    lines: { data: [{ period: { end: FUTURE_EPOCH_1 } }] }
                }
            }
        });
        assert.equal((await checkEntitlement(userId)).body.entitled, true);

        // Payment fails on renewal
        const failRes = await sendWebhook({
            id: 'evt_pf_fail',
            type: 'invoice.payment_failed',
            created: BASE_EVENT_TS + 50,
            data: {
                object: {
                    id: 'in_pf_2',
                    status: 'open',
                    paid: false,
                    customer: customerId,
                    subscription: subscriptionId,
                    subscription_details: {
                        metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                    }
                }
            }
        });
        assert.equal(failRes.status, 200);
        assert.equal(failRes.body.status, 'past_due');
        assert.equal(failRes.body.accessGranted, false);

        const failedEnt = await checkEntitlement(userId);
        assert.deepEqual(failedEnt.body, {
            entitled: false,
            status: 'none',
            product: 'HAYDER_PRO'
        });

        const failedRecord = entitlementsStore.get(makeEntitlementKey(userId, 'HAYDER_PRO'));
        assert.equal(failedRecord.status, 'past_due');
        assert.equal(failedRecord.last_payment_status, 'failed');
        assert.ok(failedRecord.payment_failed_at);

        // Payment recovers on retry
        const recoverRes = await sendWebhook({
            id: 'evt_pf_recover',
            type: 'invoice.paid',
            created: BASE_EVENT_TS + 120,
            data: {
                object: {
                    id: 'in_pf_2',
                    status: 'paid',
                    paid: true,
                    billing_reason: 'subscription_cycle',
                    customer: customerId,
                    subscription: subscriptionId,
                    subscription_details: {
                        metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                    },
                    lines: { data: [{ period: { end: FUTURE_EPOCH_2 } }] }
                }
            }
        });
        assert.equal(recoverRes.status, 200);
        assert.equal(recoverRes.body.status, 'active');
        assert.equal(recoverRes.body.accessGranted, true);

        const recoveredRecord = entitlementsStore.get(makeEntitlementKey(userId, 'HAYDER_PRO'));
        assert.equal(recoveredRecord.status, 'active');
        assert.equal(recoveredRecord.payment_failed_at, undefined);
        assert.equal(recoveredRecord.expires_at, new Date(FUTURE_EPOCH_2 * 1000).toISOString());
        assert.equal((await checkEntitlement(userId)).body.entitled, true);
    });

    it('keeps access active for cancel_at_period_end, revokes on customer.subscription.deleted, and allows clean re-subscription', async () => {
        // Activate
        await sendWebhook({
            id: 'evt_cancel_init',
            type: 'customer.subscription.created',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: subscriptionId,
                    customer: customerId,
                    status: 'active',
                    current_period_end: FUTURE_EPOCH_1,
                    cancel_at_period_end: false,
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId, billing_interval: 'monthly' }
                }
            }
        });

        // User schedules cancel at period end -> still active until period end
        const scheduleCancelRes = await sendWebhook({
            id: 'evt_cancel_sched',
            type: 'customer.subscription.updated',
            created: BASE_EVENT_TS + 10,
            data: {
                object: {
                    id: subscriptionId,
                    customer: customerId,
                    status: 'active',
                    current_period_end: FUTURE_EPOCH_1,
                    cancel_at_period_end: true,
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId, billing_interval: 'monthly' }
                }
            }
        });
        assert.equal(scheduleCancelRes.status, 200);
        assert.equal(scheduleCancelRes.body.status, 'active');
        assert.equal(
            entitlementsStore.get(makeEntitlementKey(userId, 'HAYDER_PRO')).cancel_at_period_end,
            true
        );
        assert.equal((await checkEntitlement(userId)).body.entitled, true);

        // Subscription definitively deleted
        const deleteRes = await sendWebhook({
            id: 'evt_cancel_del',
            type: 'customer.subscription.deleted',
            created: BASE_EVENT_TS + 200,
            data: {
                object: {
                    id: subscriptionId,
                    customer: customerId,
                    status: 'canceled',
                    canceled_at: BASE_EVENT_TS + 200,
                    current_period_end: FUTURE_EPOCH_1,
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                }
            }
        });
        assert.equal(deleteRes.status, 200);
        assert.equal(deleteRes.body.status, 'inactive');
        assert.equal(deleteRes.body.accessGranted, false);

        const canceledEnt = await checkEntitlement(userId);
        assert.deepEqual(canceledEnt.body, {
            entitled: false,
            status: 'none',
            product: 'HAYDER_PRO'
        });

        // User re-subscribes later with a brand new customer & subscription ID via Checkout
        const resubRes = await sendWebhook({
            id: 'evt_resub_checkout',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS + 500,
            data: {
                object: {
                    id: 'cs_test_resub_002',
                    mode: 'subscription',
                    payment_status: 'paid',
                    customer: 'cus_test_resub_002',
                    subscription: 'sub_test_resub_002',
                    client_reference_id: userId,
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId, billing_interval: 'annual' }
                }
            }
        });
        assert.equal(resubRes.status, 200);
        assert.equal(resubRes.body.accessGranted, true);

        const resubRecord = entitlementsStore.get(makeEntitlementKey(userId, 'HAYDER_PRO'));
        assert.equal(resubRecord.stripe_customer_id, 'cus_test_resub_002');
        assert.equal(resubRecord.stripe_subscription_id, 'sub_test_resub_002');
        assert.equal(resubRecord.billing_interval, 'annual');
        assert.equal(resubRecord.canceled_at, undefined);
        assert.equal((await checkEntitlement(userId)).body.entitled, true);
    });
});

describe('POST /stripe/webhook: Idempotency, Event Ordering & Identity Verification', () => {
    const userId = 'hayder:sub-user-guard-002';
    const customerId = 'cus_test_guard_A';
    const subscriptionId = 'sub_test_guard_A';

    it('enforces idempotency on duplicate Stripe event deliveries', async () => {
        const event = {
            id: 'evt_dup_001',
            type: 'invoice.paid',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'in_dup_001',
                    status: 'paid',
                    paid: true,
                    billing_reason: 'subscription_create',
                    customer: customerId,
                    subscription: subscriptionId,
                    subscription_details: {
                        metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                    },
                    lines: { data: [{ period: { end: FUTURE_EPOCH_1 } }] }
                }
            }
        };

        const first = await sendWebhook(event);
        assert.equal(first.status, 200);
        assert.equal(first.body.accessGranted, true);

        const second = await sendWebhook(event);
        assert.equal(second.status, 200);
        assert.equal(second.body.duplicate, true);
        assert.equal(second.body.reason, 'duplicate_event');
    });

    it('rejects out-of-order stale events so older invoice.paid cannot resurrect a canceled subscription', async () => {
        // Newer cancellation arrives first (t + 100)
        const delRes = await sendWebhook({
            id: 'evt_order_del',
            type: 'customer.subscription.deleted',
            created: BASE_EVENT_TS + 100,
            data: {
                object: {
                    id: subscriptionId,
                    customer: customerId,
                    status: 'canceled',
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                }
            }
        });
        assert.equal(delRes.status, 200);
        assert.equal(delRes.body.status, 'inactive');

        // Stale invoice.paid from earlier timestamp (t + 50) arrives late
        const stalePaidRes = await sendWebhook({
            id: 'evt_order_stale_paid',
            type: 'invoice.paid',
            created: BASE_EVENT_TS + 50,
            data: {
                object: {
                    id: 'in_order_stale',
                    status: 'paid',
                    paid: true,
                    billing_reason: 'subscription_cycle',
                    customer: customerId,
                    subscription: subscriptionId,
                    subscription_details: {
                        metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                    },
                    lines: { data: [{ period: { end: FUTURE_EPOCH_2 } }] }
                }
            }
        });
        assert.equal(stalePaidRes.status, 200);
        assert.equal(stalePaidRes.body.ignored, true);
        assert.equal(stalePaidRes.body.reason, 'stale_event');

        // Entitlement must remain inactive
        assert.equal((await checkEntitlement(userId)).body.entitled, false);
    });

    it('handles same-second activation events safely regardless of arrival order', async () => {
        const sameSec = BASE_EVENT_TS + 10;

        // invoice.paid arrives FIRST in same second
        const invRes = await sendWebhook({
            id: 'evt_same_sec_inv',
            type: 'invoice.paid',
            created: sameSec,
            data: {
                object: {
                    id: 'in_same_sec',
                    status: 'paid',
                    paid: true,
                    billing_reason: 'subscription_create',
                    customer: customerId,
                    subscription: subscriptionId,
                    subscription_details: {
                        metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                    },
                    lines: { data: [{ period: { end: FUTURE_EPOCH_1 } }] }
                }
            }
        });
        assert.equal(invRes.status, 200);
        assert.equal(invRes.body.accessGranted, true);

        // checkout.session.completed arrives SECOND in same second (lower precedence rank)
        const checkoutRes = await sendWebhook({
            id: 'evt_same_sec_checkout',
            type: 'checkout.session.completed',
            created: sameSec,
            data: {
                object: {
                    id: 'cs_same_sec',
                    mode: 'subscription',
                    payment_status: 'paid',
                    customer: customerId,
                    subscription: subscriptionId,
                    client_reference_id: userId,
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                }
            }
        });
        assert.equal(checkoutRes.status, 200);
        assert.equal(checkoutRes.body.reason, 'stale_event');

        // expires_at set by invoice.paid must remain intact!
        const rec = entitlementsStore.get(makeEntitlementKey(userId, 'HAYDER_PRO'));
        assert.equal(rec.status, 'active');
        assert.equal(rec.expires_at, new Date(FUTURE_EPOCH_1 * 1000).toISOString());

        assert.ok(
            computeEventOrder(sameSec, 'customer.subscription.deleted') >
            computeEventOrder(sameSec, 'invoice.paid')
        );
    });

    it('blocks mismatched subscription/customer IDs from cancelling or mutating an active subscription', async () => {
        // Active subscription A
        await sendWebhook({
            id: 'evt_id_active_A',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'cs_id_A',
                    mode: 'subscription',
                    payment_status: 'paid',
                    customer: customerId,
                    subscription: subscriptionId,
                    client_reference_id: userId,
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                }
            }
        });

        // Different subscription ID tries to delete active subscription A
        const wrongSubDel = await sendWebhook({
            id: 'evt_id_wrong_sub',
            type: 'customer.subscription.deleted',
            created: BASE_EVENT_TS + 50,
            data: {
                object: {
                    id: 'sub_test_rogue_B',
                    customer: customerId,
                    status: 'canceled',
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                }
            }
        });
        assert.equal(wrongSubDel.status, 200);
        assert.equal(wrongSubDel.body.ignored, true);
        assert.equal(wrongSubDel.body.reason, 'identity_mismatch');

        // Different customer ID with same subscription ID tries to fail payment
        const wrongCusFail = await sendWebhook({
            id: 'evt_id_wrong_cus',
            type: 'invoice.payment_failed',
            created: BASE_EVENT_TS + 60,
            data: {
                object: {
                    id: 'in_wrong_cus',
                    customer: 'cus_test_rogue_B',
                    subscription: subscriptionId,
                    subscription_details: {
                        metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                    }
                }
            }
        });
        assert.equal(wrongCusFail.status, 200);
        assert.equal(wrongCusFail.body.ignored, true);
        assert.equal(wrongCusFail.body.reason, 'identity_mismatch');

        // Active subscription A must remain active and unchanged
        const rec = entitlementsStore.get(makeEntitlementKey(userId, 'HAYDER_PRO'));
        assert.equal(rec.status, 'active');
        assert.equal(rec.stripe_customer_id, customerId);
        assert.equal(rec.stripe_subscription_id, subscriptionId);
    });

    it('rejects malformed or conflicting HAYDER_PRO identity payloads with 400', async () => {
        // Conflicting client_reference_id vs metadata.external_user_id
        const conflictRes = await sendWebhook({
            id: 'evt_bad_conflict',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'cs_bad_conflict',
                    mode: 'subscription',
                    payment_status: 'paid',
                    customer: customerId,
                    subscription: subscriptionId,
                    client_reference_id: 'hayder:user-real',
                    metadata: {
                        product: 'HAYDER_PRO',
                        external_user_id: 'hayder:user-spoofed'
                    }
                }
            }
        });
        assert.equal(conflictRes.status, 400);

        // Wrong checkout mode for HAYDER_PRO
        const badModeRes = await sendWebhook({
            id: 'evt_bad_mode',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'cs_bad_mode',
                    mode: 'payment',
                    payment_status: 'paid',
                    customer: customerId,
                    subscription: subscriptionId,
                    client_reference_id: userId,
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                }
            }
        });
        assert.equal(badModeRes.status, 400);

        // Invalid external_user_id format on subscription event
        const badSubUserRes = await sendWebhook({
            id: 'evt_bad_user',
            type: 'customer.subscription.updated',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: subscriptionId,
                    customer: customerId,
                    status: 'active',
                    metadata: { product: 'HAYDER_PRO', external_user_id: 'not-a-hayder-id' }
                }
            }
        });
        assert.equal(badSubUserRes.status, 400);

        // Conflicting invoice subscription metadata
        const badInvCtx = extractInvoiceSubscriptionContext({
            id: 'in_bad_conflict',
            customer: customerId,
            subscription: subscriptionId,
            parent: {
                subscription_details: {
                    subscription: 'sub_other_conflict',
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId }
                }
            }
        });
        assert.equal(badInvCtx.valid, false);
    });
});

describe('POST /stripe/webhook: Atomic Founder/Admin Lifetime Protection', () => {
    it('builds atomic DynamoDB ConditionExpression protecting founder, admin, and lifetime records', () => {
        const params = buildHayderEntitlementUpdateParams({
            tableName: 'xorwia_entitlements',
            externalUserId: 'hayder:founder-001',
            entitlementStatus: 'inactive',
            subscriptionStatus: 'canceled',
            customerId: 'cus_test_1',
            subscriptionId: 'sub_test_1',
            eventId: 'evt_test_1',
            eventType: 'customer.subscription.deleted',
            eventCreated: BASE_EVENT_TS,
            eventOrder: computeEventOrder(BASE_EVENT_TS, 'customer.subscription.deleted')
        });

        assert.ok(params.ConditionExpression.includes('(attribute_not_exists(#source) OR #source = :paidSource)'));
        assert.ok(params.ConditionExpression.includes('(attribute_not_exists(#lifetime) OR #lifetime <> :trueVal)'));
        assert.ok(params.ConditionExpression.includes('attribute_not_exists(stripe_subscription_id) AND attribute_not_exists(stripe_customer_id)'));
        assert.equal(params.ExpressionAttributeValues[':paidSource'], 'paid');
        assert.equal(params.ExpressionAttributeValues[':trueVal'], true);
    });

    it('preserves expires_at when checkout.session.completed arrives 1s after invoice.paid, and clears stale expires_at only on re-subscription', async () => {
        const userId = 'hayder:sub-user-expires-race-003';
        const customerId = 'cus_test_exp_1';
        const subscriptionId = 'sub_test_exp_1';

        // 1. invoice.paid arrives at T=BASE_EVENT_TS setting expires_at = FUTURE_EPOCH_1
        const invRes = await sendWebhook({
            id: 'evt_exp_inv_1',
            type: 'invoice.paid',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'in_exp_1',
                    status: 'paid',
                    paid: true,
                    billing_reason: 'subscription_create',
                    customer: customerId,
                    subscription: subscriptionId,
                    lines: {
                        data: [
                            { amount: 0 },
                            {
                                metadata: { product: 'HAYDER_PRO', external_user_id: userId, billing_interval: 'monthly' },
                                period: { end: FUTURE_EPOCH_1 }
                            }
                        ]
                    }
                }
            }
        });
        assert.equal(invRes.status, 200);
        assert.equal(invRes.body.accessGranted, true);

        // 2. checkout.session.completed arrives 1s LATER for the SAME subscription -> MUST NOT wipe expires_at!
        const checkoutRes = await sendWebhook({
            id: 'evt_exp_checkout_1',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS + 1,
            data: {
                object: {
                    id: 'cs_exp_1',
                    mode: 'subscription',
                    payment_status: 'paid',
                    customer: customerId,
                    subscription: subscriptionId,
                    client_reference_id: userId,
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId, billing_interval: 'monthly' }
                }
            }
        });
        assert.equal(checkoutRes.status, 200);

        const afterCheckout = entitlementsStore.get(makeEntitlementKey(userId, 'HAYDER_PRO'));
        assert.equal(afterCheckout.expires_at, new Date(FUTURE_EPOCH_1 * 1000).toISOString());

        // 3. Simulate past_due with expired expires_at, then re-subscribe with new sub via Checkout -> MUST clear stale expires_at
        afterCheckout.status = 'past_due';
        afterCheckout.expires_at = '2020-01-01T00:00:00.000Z';
        entitlementsStore.set(makeEntitlementKey(userId, 'HAYDER_PRO'), afterCheckout);

        const resubCheckout = await sendWebhook({
            id: 'evt_exp_resub_2',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS + 100,
            data: {
                object: {
                    id: 'cs_exp_2',
                    mode: 'subscription',
                    payment_status: 'paid',
                    customer: 'cus_test_exp_2',
                    subscription: 'sub_test_exp_2',
                    client_reference_id: userId,
                    metadata: { product: 'HAYDER_PRO', external_user_id: userId, billing_interval: 'annual' }
                }
            }
        });
        assert.equal(resubCheckout.status, 200);
        const afterResub = entitlementsStore.get(makeEntitlementKey(userId, 'HAYDER_PRO'));
        assert.equal(afterResub.stripe_subscription_id, 'sub_test_exp_2');
        assert.equal(afterResub.expires_at, undefined);
        assert.equal((await checkEntitlement(userId)).body.entitled, true);
    });

    it('protects lifetime flag and case-variant non-paid sources atomically', async () => {
        const lifetimeUserId = 'hayder:lifetime-flag-003';
        const initialRecord = {
            external_user_id: lifetimeUserId,
            product: 'HAYDER_PRO',
            status: 'active',
            source: 'paid',
            lifetime: true,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z'
        };
        entitlementsStore.set(makeEntitlementKey(lifetimeUserId, 'HAYDER_PRO'), cloneItem(initialRecord));

        const delRes = await sendWebhook({
            id: 'evt_lifetime_del',
            type: 'customer.subscription.deleted',
            created: BASE_EVENT_TS + 10,
            data: {
                object: {
                    id: 'sub_lifetime_1',
                    customer: 'cus_lifetime_1',
                    status: 'canceled',
                    metadata: { product: 'HAYDER_PRO', external_user_id: lifetimeUserId }
                }
            }
        });
        assert.equal(delRes.status, 200);
        assert.equal(delRes.body.reason, 'protected_entitlement');
        assert.deepEqual(entitlementsStore.get(makeEntitlementKey(lifetimeUserId, 'HAYDER_PRO')), initialRecord);
    });

    it('prevents ALL Stripe subscription events from overwriting founder or admin lifetime entitlements', async () => {
        const founderId = 'hayder:founder-lifetime-001';
        const adminId = 'hayder:admin-lifetime-002';

        const founderInitial = {
            external_user_id: founderId,
            product: 'HAYDER_PRO',
            status: 'active',
            source: 'founder',
            stripe_customer_id: 'cus_founder_old',
            stripe_subscription_id: 'sub_founder_old',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z'
        };
        const adminInitial = {
            external_user_id: adminId,
            product: 'HAYDER_PRO',
            status: 'active',
            source: 'admin',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z'
        };

        entitlementsStore.set(makeEntitlementKey(founderId, 'HAYDER_PRO'), cloneItem(founderInitial));
        entitlementsStore.set(makeEntitlementKey(adminId, 'HAYDER_PRO'), cloneItem(adminInitial));

        // 1. Cancellation targeting founder (even with matching old sub/cus IDs!)
        const founderCancel = await sendWebhook({
            id: 'evt_founder_del',
            type: 'customer.subscription.deleted',
            created: BASE_EVENT_TS + 10,
            data: {
                object: {
                    id: 'sub_founder_old',
                    customer: 'cus_founder_old',
                    status: 'canceled',
                    metadata: { product: 'HAYDER_PRO', external_user_id: founderId }
                }
            }
        });
        assert.equal(founderCancel.status, 200);
        assert.equal(founderCancel.body.ignored, true);
        assert.equal(founderCancel.body.reason, 'protected_entitlement');

        // 2. Payment failure targeting founder
        const founderFail = await sendWebhook({
            id: 'evt_founder_fail',
            type: 'invoice.payment_failed',
            created: BASE_EVENT_TS + 20,
            data: {
                object: {
                    id: 'in_founder_fail',
                    customer: 'cus_founder_old',
                    subscription: 'sub_founder_old',
                    subscription_details: {
                        metadata: { product: 'HAYDER_PRO', external_user_id: founderId }
                    }
                }
            }
        });
        assert.equal(founderFail.status, 200);
        assert.equal(founderFail.body.reason, 'protected_entitlement');

        // 3. Checkout activation targeting admin (must not downgrade source from 'admin' to 'paid' or add expires_at)
        const adminCheckout = await sendWebhook({
            id: 'evt_admin_checkout',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS + 30,
            data: {
                object: {
                    id: 'cs_admin_test',
                    mode: 'subscription',
                    payment_status: 'paid',
                    customer: 'cus_admin_new',
                    subscription: 'sub_admin_new',
                    client_reference_id: adminId,
                    metadata: { product: 'HAYDER_PRO', external_user_id: adminId }
                }
            }
        });
        assert.equal(adminCheckout.status, 200);
        assert.equal(adminCheckout.body.reason, 'protected_entitlement');

        // 4. Invoice paid targeting admin (must not add expiring expires_at)
        const adminInvoice = await sendWebhook({
            id: 'evt_admin_inv',
            type: 'invoice.paid',
            created: BASE_EVENT_TS + 40,
            data: {
                object: {
                    id: 'in_admin_test',
                    status: 'paid',
                    paid: true,
                    billing_reason: 'subscription_create',
                    customer: 'cus_admin_new',
                    subscription: 'sub_admin_new',
                    subscription_details: {
                        metadata: { product: 'HAYDER_PRO', external_user_id: adminId }
                    },
                    lines: { data: [{ period: { end: FUTURE_EPOCH_1 } }] }
                }
            }
        });
        assert.equal(adminInvoice.status, 200);
        assert.equal(adminInvoice.body.reason, 'protected_entitlement');

        // Verify both records are 100% untouched and remain actively entitled
        assert.deepEqual(
            entitlementsStore.get(makeEntitlementKey(founderId, 'HAYDER_PRO')),
            founderInitial
        );
        assert.deepEqual(
            entitlementsStore.get(makeEntitlementKey(adminId, 'HAYDER_PRO')),
            adminInitial
        );
        assert.equal((await checkEntitlement(founderId)).body.entitled, true);
        assert.equal((await checkEntitlement(adminId)).body.entitled, true);
    });
});

describe('POST /stripe/webhook: Preserved Lectura & CapCut Payments', () => {
    it('preserves Lectura one-time payment fulfillment and duplicate session idempotency', async () => {
        const event = {
            id: 'evt_lectura_001',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'cs_lectura_001',
                    mode: 'payment',
                    payment_status: 'paid',
                    customer_details: { email: 'Student@Example.com' },
                    metadata: { product: 'lectura' }
                }
            }
        };

        const first = await sendWebhook(event);
        assert.equal(first.status, 200);
        assert.deepEqual(first.body, { received: true, accessGranted: true });

        const access = await checkLegacyAccess('student@example.com', 'lectura');
        assert.equal(access.status, 200);
        assert.equal(access.body.hasAccess, true);
        assert.equal(access.body.product, 'lectura');

        const dup = await sendWebhook({ ...event, id: 'evt_lectura_001_retry' });
        assert.equal(dup.status, 200);
        assert.deepEqual(dup.body, { received: true, duplicate: true });
    });

    it('preserves CapCut one-time payment credit fulfillment and prevents double credits on retry', async () => {
        const event = {
            id: 'evt_capcut_001',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'cs_capcut_001',
                    mode: 'payment',
                    payment_status: 'paid',
                    customer_email: 'Creator@Example.com',
                    metadata: { product: 'capcut' }
                }
            }
        };

        const first = await sendWebhook(event);
        assert.equal(first.status, 200);
        assert.deepEqual(first.body, { received: true, accessGranted: true });

        const dup = await sendWebhook(event);
        assert.equal(dup.status, 200);
        assert.deepEqual(dup.body, { received: true, duplicate: true });

        const access = await checkLegacyAccess('creator@example.com', 'capcut');
        assert.equal(access.status, 200);
        assert.equal(access.body.hasAccess, true);
        assert.equal(access.body.credits_remaining, 20);
        assert.equal(access.body.videos_remaining, 5);
    });

    it('ignores unrelated Stripe events and non-HAYDER_PRO subscriptions safely', async () => {
        const unrelatedEvent = await sendWebhook({
            id: 'evt_unrelated_001',
            type: 'payment_intent.created',
            created: BASE_EVENT_TS,
            data: { object: { id: 'pi_test_1' } }
        });
        assert.equal(unrelatedEvent.status, 200);
        assert.deepEqual(unrelatedEvent.body, { received: true, ignored: true });

        const otherSub = await sendWebhook({
            id: 'evt_other_sub_001',
            type: 'customer.subscription.updated',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    id: 'sub_other_app',
                    customer: 'cus_other_app',
                    status: 'active',
                    metadata: { product: 'OTHER_APP' }
                }
            }
        });
        assert.equal(otherSub.status, 200);
        assert.deepEqual(otherSub.body, { received: true, ignored: true });
        assert.equal(capturedUpdateCommands.length, 0);
    });

    it('rejects malformed legacy checkout session missing session id with 400', async () => {
        const res = await sendWebhook({
            id: 'evt_legacy_missing_sid',
            type: 'checkout.session.completed',
            created: BASE_EVENT_TS,
            data: {
                object: {
                    mode: 'payment',
                    payment_status: 'paid',
                    customer_email: 'student@example.com',
                    metadata: { product: 'lectura' }
                }
            }
        });
        assert.equal(res.status, 400);
        assert.equal(capturedUpdateCommands.length, 0);
    });
});
