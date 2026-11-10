const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

// Configure test environment before requiring server
const TEST_SECRET = 'xorwia-test-secret-value-xyz789';
const TEST_USER_POOL_ID = 'eu-west-2_HayderTestPool1';
const TEST_COGNITO_REGION = 'eu-west-2';
const TEST_COGNITO_CLIENT_ID = 'hayder-web-client-id-123';
const TEST_MONTHLY_PRICE_ID = 'price_1HayderProMonthlyTest999';
const TEST_ANNUAL_PRICE_ID = 'price_1HayderProAnnualTest888';
const TEST_KID = 'hayder-cognito-key-1';

process.env.STRIPE_SECRET_KEY =
    process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_stripe_key_for_testing';
process.env.XORWIA_BILLING_SERVICE_SECRET = TEST_SECRET;
process.env.AWS_REGION = 'eu-west-2';
process.env.HAYDER_COGNITO_USER_POOL_ID = TEST_USER_POOL_ID;
process.env.HAYDER_COGNITO_REGION = TEST_COGNITO_REGION;
process.env.HAYDER_COGNITO_CLIENT_ID = TEST_COGNITO_CLIENT_ID;
process.env.STRIPE_PRICE_HAYDER_PRO_MONTHLY = TEST_MONTHLY_PRICE_ID;
process.env.STRIPE_PRICE_HAYDER_PRO_ANNUAL = TEST_ANNUAL_PRICE_ID;

const {
    app,
    setStripeClient,
    setCognitoJwks,
    clearCognitoJwksCache
} = require('../server');
const {
    normalizeBillingInterval,
    extractBillingInterval,
    getHayderStripePriceId,
    resolveSafeReturnUrl
} = require('../agent/checkout');

let server;
let baseUrl;

// Ephemeral RSA keypairs for hermetic Cognito RS256 JWT verification tests
let validKeyPair;
let wrongKeyPair;
let validPublicJwk;

// Captured Stripe session creation calls
let createdStripeSessions = [];
let stripeShouldThrow = null;

function signTestJwt(payload, options = {}) {
    const privateKey = options.privateKey || validKeyPair.privateKey;
    const header = options.header || {
        alg: 'RS256',
        kid: TEST_KID,
        typ: 'JWT'
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    if (header.alg === 'none') {
        return `${signingInput}.`;
    }

    const signature = crypto
        .sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey)
        .toString('base64url');

    return `${signingInput}.${signature}`;
}

function buildValidCognitoClaims(overrides = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
        sub: 'c61d5f38-6f6a-4a6c-9c71-2945d8b85bc3',
        iss: `https://cognito-idp.${TEST_COGNITO_REGION}.amazonaws.com/${TEST_USER_POOL_ID}`,
        token_use: 'id',
        aud: TEST_COGNITO_CLIENT_ID,
        email: 'Subscriber@Example.com',
        email_verified: true,
        iat: nowSec - 60,
        exp: nowSec + 3600,
        ...overrides
    };
}

before(async () => {
    validKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    wrongKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

    const exportedJwk = validKeyPair.publicKey.export({ format: 'jwk' });
    validPublicJwk = {
        ...exportedJwk,
        kid: TEST_KID,
        use: 'sig',
        alg: 'RS256'
    };

    setCognitoJwks({ keys: [validPublicJwk] });

    setStripeClient({
        checkout: {
            sessions: {
                create: async (payload) => {
                    if (stripeShouldThrow) {
                        throw stripeShouldThrow;
                    }
                    createdStripeSessions.push(payload);
                    return {
                        id: `cs_test_${createdStripeSessions.length}`,
                        url: `https://checkout.stripe.com/c/pay/cs_test_${createdStripeSessions.length}`
                    };
                }
            }
        }
    });

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
    setStripeClient(null);
    setCognitoJwks(null);
    clearCognitoJwksCache();
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
});

beforeEach(() => {
    createdStripeSessions = [];
    stripeShouldThrow = null;
    process.env.HAYDER_COGNITO_USER_POOL_ID = TEST_USER_POOL_ID;
    process.env.HAYDER_COGNITO_REGION = TEST_COGNITO_REGION;
    process.env.HAYDER_COGNITO_CLIENT_ID = TEST_COGNITO_CLIENT_ID;
    process.env.STRIPE_PRICE_HAYDER_PRO_MONTHLY = TEST_MONTHLY_PRICE_ID;
    process.env.STRIPE_PRICE_HAYDER_PRO_ANNUAL = TEST_ANNUAL_PRICE_ID;
    delete process.env.HAYDER_ALLOWED_RETURN_ORIGINS;
    setCognitoJwks({ keys: [validPublicJwk] });
});

async function request(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = { ...(options.headers || {}) };
    const method = options.method || 'GET';
    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;

    if (body !== undefined && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
        method,
        headers,
        body
    });

    const text = await res.text();
    let json;
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

describe('Checkout Unit Helpers: Intervals, Price IDs, and Safe URLs', () => {
    it('normalizes monthly and annual billing intervals', () => {
        assert.equal(normalizeBillingInterval('monthly'), 'monthly');
        assert.equal(normalizeBillingInterval('MONTH'), 'monthly');
        assert.equal(normalizeBillingInterval('annual'), 'annual');
        assert.equal(normalizeBillingInterval('annually'), 'annual');
        assert.equal(normalizeBillingInterval('yearly'), 'annual');
        assert.equal(normalizeBillingInterval('year'), 'annual');
        assert.equal(normalizeBillingInterval('weekly'), null);
        assert.equal(normalizeBillingInterval(''), null);
        assert.equal(normalizeBillingInterval(null), null);

        assert.equal(extractBillingInterval({ billingInterval: 'monthly' }), 'monthly');
        assert.equal(extractBillingInterval({ plan: 'annual' }), 'annual');
        assert.equal(extractBillingInterval({ interval: 'yearly' }), 'annual');
    });

    it('resolves configurable Stripe Price IDs and rejects invalid values', () => {
        assert.equal(getHayderStripePriceId('monthly'), TEST_MONTHLY_PRICE_ID);
        assert.equal(getHayderStripePriceId('annual'), TEST_ANNUAL_PRICE_ID);

        process.env.STRIPE_PRICE_HAYDER_PRO_MONTHLY = 'invalid_not_a_price_id';
        assert.equal(getHayderStripePriceId('monthly'), null);

        delete process.env.STRIPE_PRICE_HAYDER_PRO_MONTHLY;
        assert.equal(getHayderStripePriceId('monthly'), null);
    });

    it('validates safe return URLs and blocks open redirects', () => {
        const origin = 'https://xorwia.com';
        const allowed = new Set(['https://xorwia.com', 'https://hayder.xorwia.com']);

        assert.equal(
            resolveSafeReturnUrl('/success.html', '/success.html', origin, allowed),
            'https://xorwia.com/success.html'
        );
        assert.equal(
            resolveSafeReturnUrl('https://hayder.xorwia.com/billing/done', '/success.html', origin, allowed),
            'https://hayder.xorwia.com/billing/done'
        );

        // Dangerous / untrusted return URLs must be rejected
        assert.equal(resolveSafeReturnUrl('https://evil.com/phish', '/success.html', origin, allowed), null);
        assert.equal(resolveSafeReturnUrl('//evil.com/phish', '/success.html', origin, allowed), null);
        assert.equal(resolveSafeReturnUrl('/\\evil.com', '/success.html', origin, allowed), null);
        assert.equal(resolveSafeReturnUrl('javascript:alert(1)', '/success.html', origin, allowed), null);
        assert.equal(resolveSafeReturnUrl('https://xorwia.com@evil.com', '/success.html', origin, allowed), null);
        assert.equal(resolveSafeReturnUrl('/path/../admin', '/success.html', origin, allowed), null);
        assert.equal(resolveSafeReturnUrl('http://hayder.xorwia.com/insecure', '/success.html', origin, allowed), null);
    });
});

describe('POST /api/create-checkout-session: HAYDER_PRO Subscriptions', () => {
    it('creates a monthly subscription checkout session with verified Cognito identity', async () => {
        const token = signTestJwt(
            buildValidCognitoClaims({
                sub: 'user-monthly-sub-001',
                email: 'MonthlyUser@Example.com'
            })
        );

        const res = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
            },
            body: {
                product: 'HAYDER_PRO',
                billingInterval: 'monthly'
            }
        });

        assert.equal(res.status, 200);
        assert.equal(res.body.id, 'cs_test_1');
        assert.ok(res.body.url.startsWith('https://checkout.stripe.com/'));

        assert.equal(createdStripeSessions.length, 1);
        const sessionPayload = createdStripeSessions[0];
        assert.equal(sessionPayload.mode, 'subscription');
        assert.deepEqual(sessionPayload.line_items, [
            {
                price: TEST_MONTHLY_PRICE_ID,
                quantity: 1
            }
        ]);
        assert.equal(sessionPayload.client_reference_id, 'hayder:user-monthly-sub-001');
        assert.equal(sessionPayload.customer_email, 'monthlyuser@example.com');
        assert.deepEqual(sessionPayload.metadata, {
            product: 'HAYDER_PRO',
            external_user_id: 'hayder:user-monthly-sub-001',
            billing_interval: 'monthly'
        });
        assert.deepEqual(sessionPayload.subscription_data, {
            metadata: {
                product: 'HAYDER_PRO',
                external_user_id: 'hayder:user-monthly-sub-001',
                billing_interval: 'monthly'
            }
        });
        assert.ok(
            sessionPayload.success_url.includes(
                '/success.html?session_id={CHECKOUT_SESSION_ID}&product=HAYDER_PRO'
            )
        );
    });

    it('creates an annual subscription checkout session using configurable annual Price ID', async () => {
        const token = signTestJwt(
            buildValidCognitoClaims({
                sub: 'user-annual-sub-002',
                token_use: 'access',
                client_id: TEST_COGNITO_CLIENT_ID
            })
        );

        const res = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
            },
            body: {
                product: 'HAYDER_PRO',
                plan: 'annual',
                priceId: 'price_attacker_override_attempt',
                amount: 1
            }
        });

        assert.equal(res.status, 200);
        assert.equal(createdStripeSessions.length, 1);

        const sessionPayload = createdStripeSessions[0];
        assert.equal(sessionPayload.mode, 'subscription');
        assert.deepEqual(sessionPayload.line_items, [
            {
                price: TEST_ANNUAL_PRICE_ID,
                quantity: 1
            }
        ]);
        assert.equal(sessionPayload.client_reference_id, 'hayder:user-annual-sub-002');
        assert.deepEqual(sessionPayload.metadata, {
            product: 'HAYDER_PRO',
            external_user_id: 'hayder:user-annual-sub-002',
            billing_interval: 'annual'
        });
        assert.deepEqual(sessionPayload.subscription_data.metadata, {
            product: 'HAYDER_PRO',
            external_user_id: 'hayder:user-annual-sub-002',
            billing_interval: 'annual'
        });
    });

    it('never trusts browser-supplied external_user_id when unauthenticated (rejects with 401)', async () => {
        const res = await request('/api/create-checkout-session', {
            method: 'POST',
            body: {
                product: 'HAYDER_PRO',
                billingInterval: 'monthly',
                external_user_id: 'hayder:spoofed-browser-user-id'
            }
        });

        assert.equal(res.status, 401);
        assert.equal(res.body.error, 'Unauthorized: Missing Cognito bearer token');
        assert.equal(createdStripeSessions.length, 0);
    });

    it('ignores spoofed browser-supplied external_user_id and uses verified Cognito sub', async () => {
        const token = signTestJwt(
            buildValidCognitoClaims({
                sub: 'verified-cognito-sub-777'
            })
        );

        const res = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
            },
            body: {
                product: 'HAYDER_PRO',
                billingInterval: 'monthly',
                external_user_id: 'hayder:attacker-spoofed-sub-999'
            }
        });

        assert.equal(res.status, 200);
        assert.equal(createdStripeSessions.length, 1);

        const sessionPayload = createdStripeSessions[0];
        assert.equal(sessionPayload.client_reference_id, 'hayder:verified-cognito-sub-777');
        assert.equal(sessionPayload.metadata.external_user_id, 'hayder:verified-cognito-sub-777');
        assert.equal(
            sessionPayload.subscription_data.metadata.external_user_id,
            'hayder:verified-cognito-sub-777'
        );
    });

    it('rejects forged, expired, wrong-issuer, or alg:none Cognito tokens with 401', async () => {
        // 1. Signed with wrong RSA key
        const wrongKeyToken = signTestJwt(buildValidCognitoClaims(), {
            privateKey: wrongKeyPair.privateKey
        });
        const resWrongKey = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${wrongKeyToken}` },
            body: { product: 'HAYDER_PRO', billingInterval: 'monthly' }
        });
        assert.equal(resWrongKey.status, 401);

        // 2. Expired token
        const expiredToken = signTestJwt(
            buildValidCognitoClaims({
                exp: Math.floor(Date.now() / 1000) - 120
            })
        );
        const resExpired = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${expiredToken}` },
            body: { product: 'HAYDER_PRO', billingInterval: 'monthly' }
        });
        assert.equal(resExpired.status, 401);

        // 3. Wrong issuer
        const wrongIssuerToken = signTestJwt(
            buildValidCognitoClaims({
                iss: 'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_WrongPool'
            })
        );
        const resWrongIssuer = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${wrongIssuerToken}` },
            body: { product: 'HAYDER_PRO', billingInterval: 'monthly' }
        });
        assert.equal(resWrongIssuer.status, 401);

        // 4. alg: none token
        const algNoneToken = signTestJwt(buildValidCognitoClaims(), {
            header: { alg: 'none', kid: TEST_KID, typ: 'JWT' }
        });
        const resAlgNone = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${algNoneToken}` },
            body: { product: 'HAYDER_PRO', billingInterval: 'monthly' }
        });
        assert.equal(resAlgNone.status, 401);

        // 5. Wrong client_id / aud
        const wrongClientToken = signTestJwt(
            buildValidCognitoClaims({
                aud: 'untrusted-client-id'
            })
        );
        const resWrongClient = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${wrongClientToken}` },
            body: { product: 'HAYDER_PRO', billingInterval: 'monthly' }
        });
        assert.equal(resWrongClient.status, 401);

        assert.equal(createdStripeSessions.length, 0);
    });

    it('rejects invalid or missing billing interval for HAYDER_PRO with 400', async () => {
        const token = signTestJwt(buildValidCognitoClaims());

        for (const body of [
            { product: 'HAYDER_PRO' },
            { product: 'HAYDER_PRO', billingInterval: 'weekly' },
            { product: 'HAYDER_PRO', plan: 'lifetime' }
        ]) {
            const res = await request('/api/create-checkout-session', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body
            });
            assert.equal(res.status, 400);
            assert.equal(
                res.body.error,
                'Invalid or missing billing interval. Must be monthly or annual'
            );
        }

        assert.equal(createdStripeSessions.length, 0);
    });

    it('fails closed with 500 when Stripe Price ID is not configured for requested plan', async () => {
        delete process.env.STRIPE_PRICE_HAYDER_PRO_ANNUAL;
        const token = signTestJwt(buildValidCognitoClaims());

        const res = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: { product: 'HAYDER_PRO', billingInterval: 'annual' }
        });

        assert.equal(res.status, 500);
        assert.equal(res.body.error, 'Stripe price configuration missing for selected plan');
        assert.equal(createdStripeSessions.length, 0);
    });

    it('rejects unsafe return URLs and allows configured origins', async () => {
        const token = signTestJwt(buildValidCognitoClaims());

        // Reject external open redirect in successUrl
        const resUnsafeSuccess = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: {
                product: 'HAYDER_PRO',
                billingInterval: 'monthly',
                successUrl: 'https://evil.example.com/steal-session'
            }
        });
        assert.equal(resUnsafeSuccess.status, 400);
        assert.equal(resUnsafeSuccess.body.error, 'Invalid return URL');

        // Reject protocol-relative cancelUrl
        const resUnsafeCancel = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: {
                product: 'HAYDER_PRO',
                billingInterval: 'monthly',
                cancelUrl: '//evil.example.com'
            }
        });
        assert.equal(resUnsafeCancel.status, 400);
        assert.equal(resUnsafeCancel.body.error, 'Invalid return URL');

        // Allow explicitly configured Hayder origin
        process.env.HAYDER_ALLOWED_RETURN_ORIGINS = 'https://hayder.xorwia.com';
        const resAllowedOrigin = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: {
                product: 'HAYDER_PRO',
                billingInterval: 'monthly',
                successUrl: 'https://hayder.xorwia.com/billing/success',
                cancelUrl: 'https://hayder.xorwia.com/billing/cancel'
            }
        });
        assert.equal(resAllowedOrigin.status, 200);
        assert.equal(
            createdStripeSessions[0].success_url,
            'https://hayder.xorwia.com/billing/success?session_id={CHECKOUT_SESSION_ID}&product=HAYDER_PRO'
        );
        assert.equal(
            createdStripeSessions[0].cancel_url,
            'https://hayder.xorwia.com/billing/cancel'
        );
    });

    it('does not expose secrets or raw internal error messages when Stripe fails', async () => {
        const sensitiveSecret = 'sk_live_SUPER_SECRET_KEY_DO_NOT_LEAK_12345';
        stripeShouldThrow = new Error(`Invalid API Key provided: ${sensitiveSecret}`);

        const token = signTestJwt(buildValidCognitoClaims());
        const res = await request('/api/create-checkout-session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: {
                product: 'HAYDER_PRO',
                billingInterval: 'monthly'
            }
        });

        assert.equal(res.status, 500);
        assert.deepEqual(res.body, {
            error: 'Unable to create checkout session'
        });
        assert.equal(JSON.stringify(res.body).includes(sensitiveSecret), false);
    });
});

describe('POST /api/create-checkout-session: Preserved Lectura & CapCut Payments', () => {
    it('preserves CapCut £2.99 one-time payment checkout session without requiring Cognito auth', async () => {
        const res = await request('/api/create-checkout-session', {
            method: 'POST',
            body: {
                productName: 'CapCut Repurposer',
                product: 'capcut',
                amount: 299,
                successUrl: '/dashboard.html',
                email: 'Creator@Example.com'
            }
        });

        assert.equal(res.status, 200);
        assert.equal(res.body.id, 'cs_test_1');
        assert.equal(createdStripeSessions.length, 1);

        const sessionPayload = createdStripeSessions[0];
        assert.equal(sessionPayload.mode, 'payment');
        assert.equal(sessionPayload.customer_email, 'creator@example.com');
        assert.equal(sessionPayload.line_items[0].price_data.currency, 'gbp');
        assert.equal(sessionPayload.line_items[0].price_data.unit_amount, 299);
        assert.deepEqual(sessionPayload.metadata, {
            product: 'capcut',
            productName: 'CapCut Repurposer',
            accessRule: '5_videos_or_20_clips'
        });
        assert.ok(
            sessionPayload.success_url.endsWith(
                '/dashboard.html?session_id={CHECKOUT_SESSION_ID}&product=capcut'
            )
        );
    });

    it('preserves Lectura £4.99 one-time payment checkout session', async () => {
        const res = await request('/api/create-checkout-session', {
            method: 'POST',
            body: {
                productName: 'Lectura — Live Transcription',
                product: 'lectura',
                amount: 499,
                successUrl: '/lectura.html',
                email: 'Student@Example.com'
            }
        });

        assert.equal(res.status, 200);
        assert.equal(createdStripeSessions.length, 1);

        const sessionPayload = createdStripeSessions[0];
        assert.equal(sessionPayload.mode, 'payment');
        assert.equal(sessionPayload.customer_email, 'student@example.com');
        assert.equal(sessionPayload.line_items[0].price_data.unit_amount, 499);
        assert.deepEqual(sessionPayload.metadata, {
            product: 'lectura',
            productName: 'Lectura — Live Transcription',
            accessRule: '6_months'
        });
        assert.ok(
            sessionPayload.success_url.endsWith(
                '/lectura.html?session_id={CHECKOUT_SESSION_ID}&product=lectura'
            )
        );
    });

    it('rejects tampered legacy product prices with 400', async () => {
        const res = await request('/api/create-checkout-session', {
            method: 'POST',
            body: {
                productName: 'Lectura — Live Transcription',
                product: 'lectura',
                amount: 299
            }
        });

        assert.equal(res.status, 400);
        assert.equal(res.body.error, 'Invalid product price');
        assert.equal(createdStripeSessions.length, 0);
    });
});
