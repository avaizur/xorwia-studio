const crypto = require('crypto');
const axios = require('axios');
const {
    extractProvidedSecret,
    validateExternalUserId
} = require('./entitlements');

const HAYDER_PRODUCT = 'HAYDER_PRO';
const LEGACY_PRODUCTS = new Set(['lectura', 'capcut']);

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const jwksCache = new Map();

let customJwks = null;
let customJwksFetcher = null;
let customStripeClient = null;

function setStripeClient(client) {
    customStripeClient = client;
}

function getStripeClient(defaultClient = null) {
    return customStripeClient || defaultClient;
}

function setCognitoJwks(jwks) {
    customJwks = jwks;
}

function setCognitoJwksFetcher(fetcher) {
    customJwksFetcher = fetcher;
}

function clearCognitoJwksCache() {
    jwksCache.clear();
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

/**
 * Normalizes subscription billing interval for HAYDER_PRO.
 * Supports monthly and annual intervals.
 */
function normalizeBillingInterval(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'monthly' || normalized === 'month') {
        return 'monthly';
    }
    if (
        normalized === 'annual' ||
        normalized === 'annually' ||
        normalized === 'yearly' ||
        normalized === 'year'
    ) {
        return 'annual';
    }
    return null;
}

/**
 * Extracts and normalizes the requested billing interval from request body.
 */
function extractBillingInterval(body) {
    if (!body || typeof body !== 'object') return null;
    const raw =
        body.billingInterval ??
        body.billing_interval ??
        body.interval ??
        body.plan ??
        body.billingCycle ??
        body.billing_cycle;
    return normalizeBillingInterval(raw);
}

/**
 * Resolves the server-side configured Stripe Price ID for HAYDER_PRO.
 * Never trusts client-supplied price IDs or amounts.
 */
function getHayderStripePriceId(billingInterval) {
    let rawPriceId = '';

    if (billingInterval === 'monthly') {
        rawPriceId =
            process.env.STRIPE_PRICE_HAYDER_PRO_MONTHLY ||
            process.env.HAYDER_PRO_MONTHLY_PRICE_ID ||
            process.env.STRIPE_HAYDER_PRO_MONTHLY_PRICE_ID ||
            process.env.HAYDER_STRIPE_PRICE_MONTHLY ||
            '';
    } else if (billingInterval === 'annual') {
        rawPriceId =
            process.env.STRIPE_PRICE_HAYDER_PRO_ANNUAL ||
            process.env.HAYDER_PRO_ANNUAL_PRICE_ID ||
            process.env.STRIPE_HAYDER_PRO_ANNUAL_PRICE_ID ||
            process.env.HAYDER_STRIPE_PRICE_ANNUAL ||
            process.env.STRIPE_PRICE_HAYDER_PRO_YEARLY ||
            process.env.HAYDER_PRO_YEARLY_PRICE_ID ||
            '';
    }

    const trimmed = String(rawPriceId).trim();
    if (!/^price_[a-zA-Z0-9_]+$/.test(trimmed)) {
        return null;
    }

    return trimmed;
}

/**
 * Extracts AWS region from a Cognito User Pool ID (e.g., "eu-west-2_abc123" -> "eu-west-2").
 */
function extractRegionFromUserPoolId(userPoolId) {
    if (typeof userPoolId !== 'string') return null;
    const idx = userPoolId.indexOf('_');
    if (idx <= 0) return null;
    const candidate = userPoolId.slice(0, idx).trim();
    if (/^[a-z]{2}-[a-z]+-\d+$/.test(candidate)) {
        return candidate;
    }
    return null;
}

/**
 * Resolves JWKS for the given Cognito issuer URL.
 */
async function resolveCognitoJwks(issuerUrl, kid) {
    if (customJwks && Array.isArray(customJwks.keys)) {
        return customJwks;
    }

    const envJwksJson =
        process.env.HAYDER_COGNITO_JWKS_JSON || process.env.COGNITO_JWKS_JSON;
    if (envJwksJson) {
        try {
            const parsed = JSON.parse(envJwksJson);
            if (parsed && Array.isArray(parsed.keys)) {
                return parsed;
            }
        } catch {
            throw new Error('Invalid Cognito JWKS JSON configuration');
        }
    }

    const jwksUrl = `${issuerUrl}/.well-known/jwks.json`;

    if (customJwksFetcher) {
        return await customJwksFetcher(jwksUrl);
    }

    const now = Date.now();
    const cached = jwksCache.get(issuerUrl);
    if (
        cached &&
        now - cached.fetchedAt < JWKS_CACHE_TTL_MS &&
        Array.isArray(cached.jwks?.keys) &&
        (!kid || cached.jwks.keys.some((k) => k.kid === kid))
    ) {
        return cached.jwks;
    }

    const response = await axios.get(jwksUrl, { timeout: 5000 });
    const jwks = response.data;
    if (!jwks || !Array.isArray(jwks.keys)) {
        throw new Error('Malformed JWKS response from Cognito');
    }

    jwksCache.set(issuerUrl, {
        jwks,
        fetchedAt: now
    });

    return jwks;
}

/**
 * Decodes a base64url JSON segment safely.
 */
function parseJwtSegment(segment) {
    if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) {
        return null;
    }
    try {
        const jsonStr = Buffer.from(segment, 'base64url').toString('utf8');
        const parsed = JSON.parse(jsonStr);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Verifies a Cognito Bearer JWT server-side using RS256 and Cognito JWKS.
 * Never trusts browser-supplied external_user_id; always derives `hayder:<sub>`
 * from the cryptographically verified Cognito token.
 */
async function verifyCognitoIdentity(req) {
    const userPoolId = String(
        process.env.HAYDER_COGNITO_USER_POOL_ID ||
        process.env.COGNITO_USER_POOL_ID ||
        ''
    ).trim();

    if (!userPoolId) {
        return {
            valid: false,
            status: 500,
            error: 'Cognito authentication not configured on server'
        };
    }

    const token = extractProvidedSecret(req);
    if (!token) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Missing Cognito bearer token'
        };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Invalid Cognito token'
        };
    }

    const [rawHeader, rawPayload, rawSignature] = parts;
    if (!rawSignature || !/^[A-Za-z0-9_-]+$/.test(rawSignature)) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Invalid Cognito token'
        };
    }

    const header = parseJwtSegment(rawHeader);
    const payload = parseJwtSegment(rawPayload);

    if (!header || !payload) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Invalid Cognito token'
        };
    }

    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid.trim()) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Invalid Cognito token'
        };
    }

    const region = String(
        process.env.HAYDER_COGNITO_REGION ||
        process.env.COGNITO_REGION ||
        extractRegionFromUserPoolId(userPoolId) ||
        process.env.AWS_REGION ||
        'eu-west-2'
    ).trim();

    const expectedIssuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;

    if (payload.iss !== expectedIssuer) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Invalid Cognito token issuer'
        };
    }

    if (payload.token_use !== 'id' && payload.token_use !== 'access') {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Invalid Cognito token_use claim'
        };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= nowSec) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Cognito token has expired'
        };
    }

    if (
        payload.nbf !== undefined &&
        (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > nowSec)
    ) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Cognito token is not yet valid'
        };
    }

    const configuredClientIdsRaw = String(
        process.env.HAYDER_COGNITO_CLIENT_ID ||
        process.env.COGNITO_CLIENT_ID ||
        ''
    ).trim();

    if (configuredClientIdsRaw) {
        const allowedClientIds = new Set(
            configuredClientIdsRaw
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean)
        );
        const tokenClientId =
            payload.token_use === 'id' ? payload.aud : payload.client_id;

        if (typeof tokenClientId !== 'string' || !allowedClientIds.has(tokenClientId)) {
            return {
                valid: false,
                status: 401,
                error: 'Unauthorized: Invalid Cognito token client_id'
            };
        }
    }

    if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Missing Cognito subject claim'
        };
    }

    const externalUserId = `hayder:${payload.sub.trim()}`;
    if (!validateExternalUserId(externalUserId, HAYDER_PRODUCT)) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Invalid Cognito subject format'
        };
    }

    let jwks;
    try {
        jwks = await resolveCognitoJwks(expectedIssuer, header.kid);
    } catch {
        return {
            valid: false,
            status: 500,
            error: 'Unable to verify Cognito authentication'
        };
    }

    const matchingJwk = jwks.keys.find(
        (key) =>
            key &&
            key.kid === header.kid &&
            key.kty === 'RSA' &&
            (!key.use || key.use === 'sig') &&
            (!key.alg || key.alg === 'RS256')
    );

    if (!matchingJwk) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Invalid Cognito token signing key'
        };
    }

    try {
        const publicKey = crypto.createPublicKey({
            key: matchingJwk,
            format: 'jwk'
        });

        const signingInput = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8');
        const signatureBuf = Buffer.from(rawSignature, 'base64url');

        const isVerified = crypto.verify(
            'RSA-SHA256',
            signingInput,
            publicKey,
            signatureBuf
        );

        if (!isVerified) {
            return {
                valid: false,
                status: 401,
                error: 'Unauthorized: Invalid Cognito token signature'
            };
        }
    } catch {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Invalid Cognito token signature'
        };
    }

    const verifiedEmail =
        typeof payload.email === 'string' &&
        payload.email.includes('@') &&
        payload.email_verified !== false
            ? normalizeEmail(payload.email)
            : null;

    return {
        valid: true,
        sub: payload.sub.trim(),
        external_user_id: externalUserId,
        email: verifiedEmail
    };
}

/**
 * Builds the set of allowed return URL origins for Stripe Checkout redirects.
 */
function getAllowedReturnOrigins(baseOrigin) {
    const allowed = new Set([baseOrigin]);

    const extraOriginsRaw = [
        process.env.HAYDER_ALLOWED_RETURN_ORIGINS,
        process.env.ALLOWED_RETURN_ORIGINS
    ]
        .filter(Boolean)
        .join(',');

    if (extraOriginsRaw) {
        for (const entry of extraOriginsRaw.split(',')) {
            const trimmed = entry.trim();
            if (!trimmed) continue;
            try {
                const parsed = new URL(trimmed);
                const isLocal =
                    parsed.hostname === 'localhost' ||
                    parsed.hostname === '127.0.0.1';
                if (
                    (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLocal)) &&
                    !parsed.username &&
                    !parsed.password
                ) {
                    allowed.add(parsed.origin);
                }
            } catch {
                // Ignore invalid configured origins
            }
        }
    }

    return allowed;
}

/**
 * Validates a single candidate return URL (relative path or allowed origin URL).
 * Prevents open redirects, protocol-relative URLs, userinfo tricks, and script schemes.
 */
function resolveSafeReturnUrl(rawInput, defaultPath, baseOrigin, allowedOrigins) {
    const candidate =
        rawInput === undefined || rawInput === null || rawInput === ''
            ? defaultPath
            : rawInput;

    if (typeof candidate !== 'string') {
        return null;
    }

    const trimmed = candidate.trim();
    if (!trimmed) {
        return null;
    }

    // Reject control characters, whitespace, backslashes, userinfo (@), and path traversal (..)
    if (
        /[\x00-\x20\x7f\\@]/.test(trimmed) ||
        trimmed.includes('..')
    ) {
        return null;
    }

    // Relative path case: must start with single '/' (not '//')
    if (trimmed.startsWith('/')) {
        if (trimmed.startsWith('//')) {
            return null;
        }
        try {
            const resolved = new URL(trimmed, baseOrigin);
            if (
                resolved.origin !== baseOrigin ||
                resolved.username ||
                resolved.password ||
                !resolved.pathname.startsWith('/')
            ) {
                return null;
            }
            return resolved.toString();
        } catch {
            return null;
        }
    }

    // Absolute URL case: must match an allowed origin and safe protocol
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            const isLocal =
                parsed.hostname === 'localhost' ||
                parsed.hostname === '127.0.0.1';
            const protocolOk =
                parsed.protocol === 'https:' ||
                (parsed.protocol === 'http:' && isLocal) ||
                parsed.origin === baseOrigin;

            if (
                !protocolOk ||
                parsed.username ||
                parsed.password ||
                !allowedOrigins.has(parsed.origin)
            ) {
                return null;
            }

            return parsed.toString();
        } catch {
            return null;
        }
    }

    return null;
}

/**
 * Appends Stripe checkout session query params safely while preserving `{CHECKOUT_SESSION_ID}` template literal.
 */
function appendCheckoutQueryParams(urlStr, product) {
    const separator = urlStr.includes('?') ? '&' : '?';
    const hasSessionId = urlStr.includes('session_id={CHECKOUT_SESSION_ID}');
    const hasProduct = /[?&]product=/.test(urlStr);

    const params = [];
    if (!hasSessionId) {
        params.push('session_id={CHECKOUT_SESSION_ID}');
    }
    if (!hasProduct) {
        params.push(`product=${encodeURIComponent(product)}`);
    }

    if (params.length === 0) {
        return urlStr;
    }

    return `${urlStr}${separator}${params.join('&')}`;
}

/**
 * Validates and builds safe success_url and cancel_url for Stripe Checkout.
 */
function validateAndBuildReturnUrls({ req, successUrl, cancelUrl, product }) {
    const protocol = req.protocol || 'https';
    const host = req.get('host');
    if (!host || /[\x00-\x20\x7f\\/@]/.test(host)) {
        return {
            valid: false,
            status: 400,
            error: 'Invalid request host'
        };
    }

    const baseOrigin = `${protocol}://${host}`;
    const allowedOrigins = getAllowedReturnOrigins(baseOrigin);

    const defaultSuccess =
        product === HAYDER_PRODUCT
            ? process.env.HAYDER_CHECKOUT_SUCCESS_URL || '/success.html'
            : '/success.html';
    const defaultCancel =
        product === HAYDER_PRODUCT
            ? process.env.HAYDER_CHECKOUT_CANCEL_URL || '/index.html'
            : '/index.html';

    const resolvedSuccess = resolveSafeReturnUrl(
        successUrl,
        defaultSuccess,
        baseOrigin,
        allowedOrigins
    );

    if (!resolvedSuccess) {
        return {
            valid: false,
            status: 400,
            error: 'Invalid return URL'
        };
    }

    const resolvedCancel = resolveSafeReturnUrl(
        cancelUrl,
        defaultCancel,
        baseOrigin,
        allowedOrigins
    );

    if (!resolvedCancel) {
        return {
            valid: false,
            status: 400,
            error: 'Invalid return URL'
        };
    }

    return {
        valid: true,
        successUrl: appendCheckoutQueryParams(resolvedSuccess, product),
        cancelUrl: resolvedCancel
    };
}

/**
 * Creates Express route handler for POST /api/create-checkout-session.
 * Supports:
 * - HAYDER_PRO monthly/annual subscriptions (subscription mode, verified Cognito identity, configurable Price IDs)
 * - Legacy Lectura & CapCut one-time payments (payment mode, preserved behavior)
 */
function createCheckoutSessionHandler(defaultStripeClient) {
    return async function handleCreateCheckoutSession(req, res) {
        try {
            const body =
                req.body && typeof req.body === 'object' && !Array.isArray(req.body)
                    ? req.body
                    : {};

            const rawProduct = body.product;
            const hasExplicitProduct =
                rawProduct !== undefined &&
                rawProduct !== null &&
                String(rawProduct).trim() !== '';

            const normalizedUpperProduct = hasExplicitProduct
                ? String(rawProduct).trim().toUpperCase()
                : '';
            const normalizedLowerProduct = hasExplicitProduct
                ? String(rawProduct).trim().toLowerCase()
                : '';

            const rawSuccessUrl =
                body.successUrl !== undefined ? body.successUrl : body.success_url;
            const rawCancelUrl =
                body.cancelUrl !== undefined ? body.cancelUrl : body.cancel_url;

            const stripeClient = getStripeClient(defaultStripeClient);
            if (!stripeClient || !stripeClient.checkout?.sessions?.create) {
                return res.status(500).json({
                    error: 'Unable to create checkout session'
                });
            }

            // --- HAYDER_PRO Subscription Checkout Flow ---
            if (normalizedUpperProduct === HAYDER_PRODUCT) {
                // 1. Server-side Cognito identity verification (never trust browser-supplied external_user_id)
                const auth = await verifyCognitoIdentity(req);
                if (!auth.valid) {
                    return res.status(auth.status).json({
                        error: auth.error
                    });
                }

                // 2. Billing interval validation (monthly | annual)
                const billingInterval = extractBillingInterval(body);
                if (!billingInterval) {
                    return res.status(400).json({
                        error: 'Invalid or missing billing interval. Must be monthly or annual'
                    });
                }

                // 3. Resolve configurable server-side Stripe Price ID
                const priceId = getHayderStripePriceId(billingInterval);
                if (!priceId) {
                    return res.status(500).json({
                        error: 'Stripe price configuration missing for selected plan'
                    });
                }

                // 4. Validate and build safe return URLs
                const returnUrls = validateAndBuildReturnUrls({
                    req,
                    successUrl: rawSuccessUrl,
                    cancelUrl: rawCancelUrl,
                    product: HAYDER_PRODUCT
                });

                if (!returnUrls.valid) {
                    return res.status(returnUrls.status).json({
                        error: returnUrls.error
                    });
                }

                // 5. Build subscription mode Checkout Session payload using verified Cognito identity
                const sessionPayload = {
                    payment_method_types: ['card'],
                    line_items: [
                        {
                            price: priceId,
                            quantity: 1
                        }
                    ],
                    mode: 'subscription',
                    client_reference_id: auth.external_user_id,
                    success_url: returnUrls.successUrl,
                    cancel_url: returnUrls.cancelUrl,
                    metadata: {
                        product: HAYDER_PRODUCT,
                        external_user_id: auth.external_user_id,
                        billing_interval: billingInterval
                    },
                    subscription_data: {
                        metadata: {
                            product: HAYDER_PRODUCT,
                            external_user_id: auth.external_user_id,
                            billing_interval: billingInterval
                        }
                    }
                };

                if (auth.email) {
                    sessionPayload.customer_email = auth.email;
                }

                const session =
                    await stripeClient.checkout.sessions.create(sessionPayload);

                return res.status(200).json({
                    id: session.id,
                    url: session.url
                });
            }

            // Reject unknown explicit product names
            if (hasExplicitProduct && !LEGACY_PRODUCTS.has(normalizedLowerProduct)) {
                return res.status(400).json({
                    error: 'Unsupported product'
                });
            }

            // --- Legacy Lectura / CapCut One-Time Payment Flow ---
            const { productName, amount, email } = body;

            const finalAmount = Number(amount) || 299;
            const finalProductName =
                productName || 'Xorwia Studio - Agent Access';

            const productNameLower = String(finalProductName).toLowerCase();

            let product = 'capcut';

            if (
                normalizedLowerProduct === 'lectura' ||
                productNameLower.includes('lectura') ||
                (!normalizedLowerProduct &&
                    !productNameLower.includes('capcut') &&
                    finalAmount === 499)
            ) {
                product = 'lectura';
            } else if (
                normalizedLowerProduct === 'capcut' ||
                productNameLower.includes('capcut') ||
                finalAmount === 299
            ) {
                product = 'capcut';
            }

            // Server-side price enforcement prevents a client from changing the
            // amount and receiving paid access for an arbitrary value.
            const expectedAmount = product === 'lectura' ? 499 : 299;

            if (finalAmount !== expectedAmount) {
                return res.status(400).json({
                    error: 'Invalid product price'
                });
            }

            const returnUrls = validateAndBuildReturnUrls({
                req,
                successUrl: rawSuccessUrl,
                cancelUrl: rawCancelUrl,
                product
            });

            if (!returnUrls.valid) {
                return res.status(returnUrls.status).json({
                    error: returnUrls.error
                });
            }

            const sessionPayload = {
                payment_method_types: ['card'],
                line_items: [
                    {
                        price_data: {
                            currency: 'gbp',
                            product_data: {
                                name: finalProductName,
                                description: 'Full access via Xorwia Studio.'
                            },
                            unit_amount: expectedAmount
                        },
                        quantity: 1
                    }
                ],
                mode: 'payment',
                success_url: returnUrls.successUrl,
                cancel_url: returnUrls.cancelUrl,
                metadata: {
                    product,
                    productName: finalProductName,
                    accessRule:
                        product === 'lectura'
                            ? '6_months'
                            : '5_videos_or_20_clips'
                }
            };

            if (email && typeof email === 'string' && email.includes('@')) {
                sessionPayload.customer_email = normalizeEmail(email);
            }

            const session =
                await stripeClient.checkout.sessions.create(sessionPayload);

            return res.status(200).json({
                id: session.id,
                url: session.url
            });
        } catch (err) {
            console.error('[STRIPE] ❌ Session creation error');

            return res.status(500).json({
                error: 'Unable to create checkout session'
            });
        }
    };
}

module.exports = {
    HAYDER_PRODUCT,
    normalizeBillingInterval,
    extractBillingInterval,
    getHayderStripePriceId,
    verifyCognitoIdentity,
    validateAndBuildReturnUrls,
    resolveSafeReturnUrl,
    createCheckoutSessionHandler,
    setStripeClient,
    getStripeClient,
    setCognitoJwks,
    setCognitoJwksFetcher,
    clearCognitoJwksCache
};
