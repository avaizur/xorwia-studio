const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Configure test environment variables before requiring server/entitlements
const TEST_SECRET = 'xorwia-test-secret-value-xyz789';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_stripe_key_for_testing';
process.env.XORWIA_BILLING_SERVICE_SECRET = TEST_SECRET;
process.env.AWS_REGION = 'eu-west-2';
process.env.ACCESS_TABLE_NAME = 'xorwia_user_access';
process.env.ENTITLEMENTS_TABLE_NAME = 'xorwia_entitlements';

const { app, dynamodb } = require('../server');
const {
    validateExternalUserId,
    validateProduct,
    validateServiceAuth,
    isRecordEntitled
} = require('../agent/entitlements');

let server;
let baseUrl;

// In-memory mock stores for DynamoDB
let entitlementsStore = new Map();
let userAccessStore = new Map();
let originalSend;

function makeEntitlementKey(external_user_id, product) {
    return `${external_user_id}#${product}`;
}

function makeAccessKey(email, product) {
    return `${email}#${product}`;
}

before(async () => {
    // Intercept dynamodb.send for hermetic unit & integration testing
    originalSend = dynamodb.send;
    dynamodb.send = async (command) => {
        const input = command.input || {};
        const tableName = input.TableName;

        if (tableName === process.env.ENTITLEMENTS_TABLE_NAME) {
            if (command.constructor.name === 'GetCommand' || input.Key) {
                const key = makeEntitlementKey(input.Key.external_user_id, input.Key.product);
                const item = entitlementsStore.get(key) || null;
                return { Item: item };
            }
            if (command.constructor.name === 'PutCommand' || input.Item) {
                const key = makeEntitlementKey(input.Item.external_user_id, input.Item.product);
                entitlementsStore.set(key, input.Item);
                return {};
            }
        }

        if (tableName === process.env.ACCESS_TABLE_NAME) {
            if (command.constructor.name === 'GetCommand' || input.Key) {
                const key = makeAccessKey(input.Key.email, input.Key.product);
                const item = userAccessStore.get(key) || null;
                return { Item: item };
            }
        }

        return {};
    };

    // Spin up local HTTP server on an ephemeral port
    await new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(0, () => {
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
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
    process.env.XORWIA_BILLING_SERVICE_SECRET = TEST_SECRET;
});

async function request(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = options.headers || {};
    const method = options.method || 'GET';
    const body = options.body ? JSON.stringify(options.body) : undefined;

    if (body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
        method,
        headers,
        body
    });

    let json = null;
    const text = await res.text();
    try {
        json = JSON.parse(text);
    } catch {
        json = text;
    }

    return {
        status: res.status,
        headers: res.headers,
        body: json
    };
}

describe('Unit Validation: Inputs & Credentials', () => {
    it('validates external_user_id correctly', () => {
        // Valid Hayder IDs
        assert.equal(validateExternalUserId('hayder:c61d5f38-6f6a-4a6c-9c71-2945d8b85bc3', 'HAYDER_PRO'), true);
        assert.equal(validateExternalUserId('hayder:user-12345', 'HAYDER_PRO'), true);
        assert.equal(validateExternalUserId('hayder:user_cognito_sub', 'HAYDER_PRO'), true);

        // Invalid Hayder IDs
        assert.equal(validateExternalUserId('', 'HAYDER_PRO'), false);
        assert.equal(validateExternalUserId(null, 'HAYDER_PRO'), false);
        assert.equal(validateExternalUserId(12345, 'HAYDER_PRO'), false);
        assert.equal(validateExternalUserId('c61d5f38-6f6a-4a6c-9c71-2945d8b85bc3', 'HAYDER_PRO'), false);
        assert.equal(validateExternalUserId('hayder:', 'HAYDER_PRO'), false);
        assert.equal(validateExternalUserId('hayder:   ', 'HAYDER_PRO'), false);
        assert.equal(validateExternalUserId('lectura:123', 'HAYDER_PRO'), false);
        assert.equal(validateExternalUserId('hayder:invalid with spaces', 'HAYDER_PRO'), false);
    });

    it('validates products correctly', () => {
        assert.equal(validateProduct('HAYDER_PRO'), true);
        assert.equal(validateProduct('lectura'), false);
        assert.equal(validateProduct('capcut'), false);
        assert.equal(validateProduct(''), false);
        assert.equal(validateProduct(null), false);
        assert.equal(validateProduct('UNKNOWN'), false);
    });

    it('evaluates entitlement records correctly', () => {
        assert.equal(isRecordEntitled(null), false);
        assert.equal(isRecordEntitled({ status: 'inactive' }), false);
        assert.equal(isRecordEntitled({ status: 'active' }), true);
        assert.equal(isRecordEntitled({ status: 'active', source: 'paid' }), true);
        assert.equal(isRecordEntitled({ status: 'active', source: 'founder' }), true);
        assert.equal(isRecordEntitled({ status: 'active', source: 'admin' }), true);

        // Expired record
        const past = new Date(Date.now() - 100000).toISOString();
        assert.equal(isRecordEntitled({ status: 'active', expires_at: past }), false);

        // Future expiration
        const future = new Date(Date.now() + 100000).toISOString();
        assert.equal(isRecordEntitled({ status: 'active', expires_at: future }), true);
    });
});

describe('POST /api/billing/entitlement: Service Authentication', () => {
    it('rejects missing service credential with 401', async () => {
        const res = await request('/api/billing/entitlement', {
            method: 'POST',
            body: {
                external_user_id: 'hayder:c61d5f38-6f6a-4a6c-9c71-2945d8b85bc3',
                product: 'HAYDER_PRO'
            }
        });

        assert.equal(res.status, 401);
        assert.equal(res.body.error, 'Unauthorized: Missing service credential');
    });

    it('rejects invalid Bearer token credential with 401', async () => {
        const res = await request('/api/billing/entitlement', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer wrong-credential-token'
            },
            body: {
                external_user_id: 'hayder:c61d5f38-6f6a-4a6c-9c71-2945d8b85bc3',
                product: 'HAYDER_PRO'
            }
        });

        assert.equal(res.status, 401);
        assert.equal(res.body.error, 'Unauthorized: Invalid service credential');
    });

    it('rejects x-service-key header with 401 (only Authorization Bearer accepted)', async () => {
        const res = await request('/api/billing/entitlement', {
            method: 'POST',
            headers: {
                'x-service-key': TEST_SECRET
            },
            body: {
                external_user_id: 'hayder:c61d5f38-6f6a-4a6c-9c71-2945d8b85bc3',
                product: 'HAYDER_PRO'
            }
        });

        assert.equal(res.status, 401);
        assert.equal(res.body.error, 'Unauthorized: Missing service credential');
    });

    it('rejects non-Bearer Authorization header with 401', async () => {
        const res = await request('/api/billing/entitlement', {
            method: 'POST',
            headers: {
                Authorization: TEST_SECRET
            },
            body: {
                external_user_id: 'hayder:c61d5f38-6f6a-4a6c-9c71-2945d8b85bc3',
                product: 'HAYDER_PRO'
            }
        });

        assert.equal(res.status, 401);
        assert.equal(res.body.error, 'Unauthorized: Missing service credential');
    });

    it('fails closed with 500 when server has no secret configured', async () => {
        delete process.env.XORWIA_BILLING_SERVICE_SECRET;

        const res = await request('/api/billing/entitlement', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${TEST_SECRET}`
            },
            body: {
                external_user_id: 'hayder:c61d5f38-6f6a-4a6c-9c71-2945d8b85bc3',
                product: 'HAYDER_PRO'
            }
        });

        assert.equal(res.status, 500);
        assert.equal(res.body.error, 'Service credential not configured on server');
    });
});

describe('POST /api/billing/entitlement: Input Validation', () => {
    it('rejects missing or malformed external_user_id with 400', async () => {
        const testCases = [
            {},
            { external_user_id: '' },
            { external_user_id: 'c61d5f38-6f6a-4a6c-9c71-2945d8b85bc3' }, // missing hayder: prefix
            { external_user_id: 'hayder:' }, // empty sub
            { external_user_id: 'lectura:sub123' }, // wrong namespace
            { external_user_id: 12345 }
        ];

        for (const tc of testCases) {
            const res = await request('/api/billing/entitlement', {
                method: 'POST',
                headers: { Authorization: `Bearer ${TEST_SECRET}` },
                body: { ...tc, product: 'HAYDER_PRO' }
            });
            assert.equal(res.status, 400, `Expected 400 for input: ${JSON.stringify(tc)}`);
            assert.equal(res.body.error, 'Invalid external_user_id format');
        }
    });

    it('rejects unsupported product with 400', async () => {
        const testCases = [
            {},
            { product: '' },
            { product: 'lectura' },
            { product: 'capcut' },
            { product: 'UNKNOWN_PRODUCT' }
        ];

        for (const tc of testCases) {
            const res = await request('/api/billing/entitlement', {
                method: 'POST',
                headers: { Authorization: `Bearer ${TEST_SECRET}` },
                body: { external_user_id: 'hayder:user-sub-1', ...tc }
            });
            assert.equal(res.status, 400, `Expected 400 for product: ${JSON.stringify(tc)}`);
            assert.equal(res.body.error, 'Unsupported product');
        }
    });
});

describe('POST /api/billing/entitlement: Entitlement Scenarios', () => {
    it('returns active for active HAYDER_PRO (paid record)', async () => {
        const external_user_id = 'hayder:user-sub-active-paid';
        const product = 'HAYDER_PRO';

        entitlementsStore.set(makeEntitlementKey(external_user_id, product), {
            external_user_id,
            product,
            status: 'active',
            source: 'paid',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });

        // Test with Authorization: Bearer <secret>
        const res = await request('/api/billing/entitlement', {
            method: 'POST',
            headers: { Authorization: `Bearer ${TEST_SECRET}` },
            body: { external_user_id, product }
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            entitled: true,
            status: 'active',
            product: 'HAYDER_PRO'
        });
    });

    it('returns inactive (none) for inactive HAYDER_PRO record', async () => {
        const external_user_id = 'hayder:user-sub-inactive';
        const product = 'HAYDER_PRO';

        entitlementsStore.set(makeEntitlementKey(external_user_id, product), {
            external_user_id,
            product,
            status: 'inactive',
            source: 'paid',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });

        const res = await request('/api/billing/entitlement', {
            method: 'POST',
            headers: { Authorization: `Bearer ${TEST_SECRET}` },
            body: { external_user_id, product }
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            entitled: false,
            status: 'none',
            product: 'HAYDER_PRO'
        });
    });

    it('returns inactive (none) when user has no entitlement record', async () => {
        const external_user_id = 'hayder:user-sub-not-found';
        const product = 'HAYDER_PRO';

        const res = await request('/api/billing/entitlement', {
            method: 'POST',
            headers: { Authorization: `Bearer ${TEST_SECRET}` },
            body: { external_user_id, product }
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            entitled: false,
            status: 'none',
            product: 'HAYDER_PRO'
        });
    });

    it('returns active for founder complimentary access without email hardcoding', async () => {
        const external_user_id = 'hayder:founder-sub-cognito-001';
        const product = 'HAYDER_PRO';

        entitlementsStore.set(makeEntitlementKey(external_user_id, product), {
            external_user_id,
            product,
            status: 'active',
            source: 'founder',
            email: 'founder@xorwia.com', // metadata only
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });

        const res = await request('/api/billing/entitlement', {
            method: 'POST',
            headers: { Authorization: `Bearer ${TEST_SECRET}` },
            body: { external_user_id, product }
        });

        assert.equal(res.status, 200);
        // Assert Hayder receives ONLY final entitled result - no source, no email exposed
        assert.deepEqual(res.body, {
            entitled: true,
            status: 'active',
            product: 'HAYDER_PRO'
        });
        assert.equal(res.body.source, undefined);
        assert.equal(res.body.email, undefined);
    });

    it('returns active for admin complimentary access without email hardcoding', async () => {
        const external_user_id = 'hayder:admin-sub-cognito-002';
        const product = 'HAYDER_PRO';

        entitlementsStore.set(makeEntitlementKey(external_user_id, product), {
            external_user_id,
            product,
            status: 'active',
            source: 'admin',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });

        const res = await request('/api/billing/entitlement', {
            method: 'POST',
            headers: { Authorization: `Bearer ${TEST_SECRET}` },
            body: { external_user_id, product }
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            entitled: true,
            status: 'active',
            product: 'HAYDER_PRO'
        });
        assert.equal(res.body.source, undefined);
    });
});

describe('Legacy Compatibility: Existing Lectura/CapCut Routes Unchanged', () => {
    it('legacy GET /api/access/check works for Lectura with active access', async () => {
        const email = 'lectura-user@example.com';
        const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

        userAccessStore.set(makeAccessKey(email, 'lectura'), {
            email,
            product: 'lectura',
            payment_status: 'paid',
            access_until: futureDate
        });

        // Legacy endpoint does NOT require service credential
        const res = await request(`/api/access/check?email=${encodeURIComponent(email)}&product=lectura`);

        assert.equal(res.status, 200);
        assert.equal(res.body.hasAccess, true);
        assert.equal(res.body.product, 'lectura');
        assert.equal(res.body.access_until, futureDate);
    });

    it('legacy GET /api/access/check works for Lectura with expired access', async () => {
        const email = 'expired-lectura@example.com';
        const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        userAccessStore.set(makeAccessKey(email, 'lectura'), {
            email,
            product: 'lectura',
            payment_status: 'paid',
            access_until: pastDate
        });

        const res = await request(`/api/access/check?email=${encodeURIComponent(email)}&product=lectura`);

        assert.equal(res.status, 200);
        assert.equal(res.body.hasAccess, false);
        assert.equal(res.body.product, 'lectura');
    });

    it('legacy GET /api/access/check works for CapCut with remaining credits', async () => {
        const email = 'capcut-user@example.com';

        userAccessStore.set(makeAccessKey(email, 'capcut'), {
            email,
            product: 'capcut',
            payment_status: 'paid',
            credits_remaining: 12
        });

        const res = await request(`/api/access/check?email=${encodeURIComponent(email)}&product=capcut`);

        assert.equal(res.status, 200);
        assert.equal(res.body.hasAccess, true);
        assert.equal(res.body.product, 'capcut');
        assert.equal(res.body.credits_remaining, 12);
        assert.equal(res.body.videos_remaining, 3);
        assert.equal(res.body.clips_remaining, 12);
    });

    it('legacy GET /api/access/check returns 400 when missing email or product', async () => {
        const res = await request('/api/access/check');

        assert.equal(res.status, 400);
        assert.equal(res.body.error, 'Valid email and product are required');
    });

    it('legacy POST /api/access/consume returns 400 when missing required body fields', async () => {
        const res = await request('/api/access/consume', {
            method: 'POST',
            body: { email: 'user@example.com' } // missing usageType
        });

        assert.equal(res.status, 400);
        assert.equal(res.body.error, 'Valid email and usageType (video or clip) are required');
    });
});
