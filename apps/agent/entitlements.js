const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand
} = require('@aws-sdk/lib-dynamodb');

const ENTITLEMENTS_TABLE_NAME =
    process.env.ENTITLEMENTS_TABLE_NAME || 'xorwia_entitlements';

const SUPPORTED_PRODUCTS = new Set(['HAYDER_PRO']);

let dynamoDocClient = null;

function getDynamoDbClient() {
    if (!dynamoDocClient) {
        const rawClient = new DynamoDBClient({
            region: process.env.AWS_REGION || 'eu-west-2'
        });
        dynamoDocClient = DynamoDBDocumentClient.from(rawClient);
    }
    return dynamoDocClient;
}

function setDynamoDbClient(client) {
    dynamoDocClient = client;
}

/**
 * Timing-safe string comparison to prevent side-channel timing attacks.
 */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Extracts Bearer token from request.
 * Supports canonical header only: Authorization: Bearer <token>
 */
function extractProvidedSecret(req) {
    const authHeader = req.headers?.['authorization'];
    if (authHeader && typeof authHeader === 'string') {
        const parts = authHeader.trim().split(/\s+/);
        if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
            return parts[1];
        }
    }

    return null;
}

/**
 * Validates service-to-service credential.
 * Dedicated to the shared billing/entitlement API.
 */
function validateServiceAuth(req) {
    const expectedSecret = process.env.XORWIA_BILLING_SERVICE_SECRET;

    if (!expectedSecret) {
        return {
            valid: false,
            status: 500,
            error: 'Service credential not configured on server'
        };
    }

    const providedSecret = extractProvidedSecret(req);
    if (!providedSecret) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Missing service credential'
        };
    }

    if (!safeEqual(providedSecret, expectedSecret)) {
        return {
            valid: false,
            status: 401,
            error: 'Unauthorized: Invalid service credential'
        };
    }

    return { valid: true };
}

/**
 * Validates external_user_id format.
 * For Hayder: hayder:<cognito_sub> where sub is alphanumeric and hyphens/underscores.
 * Generic fallback for future products: <namespace>:<id>.
 */
function validateExternalUserId(userId, product) {
    if (typeof userId !== 'string') return false;
    const trimmed = userId.trim();
    if (!trimmed) return false;

    if (product === 'HAYDER_PRO') {
        return /^hayder:[a-zA-Z0-9_-]{1,128}$/.test(trimmed);
    }

    return /^[a-z0-9_-]+:[a-zA-Z0-9_-]{1,128}$/.test(trimmed);
}

/**
 * Validates product name against supported catalog.
 */
function validateProduct(product) {
    if (typeof product !== 'string') return false;
    return SUPPORTED_PRODUCTS.has(product.trim());
}

/**
 * Checks whether an entitlement record represents an active grant.
 * Hayder receives only the final entitled result.
 * Founder/admin complimentary access is stored with source 'founder'|'admin' and status 'active'.
 */
function isRecordEntitled(record) {
    if (!record || record.status !== 'active') {
        return false;
    }

    if (record.expires_at) {
        const exp = new Date(record.expires_at);
        if (!Number.isNaN(exp.getTime()) && exp <= new Date()) {
            return false;
        }
    }

    return true;
}

/**
 * Retrieves entitlement record from DynamoDB store.
 */
async function getEntitlementRecord(external_user_id, product, client = null) {
    const ddb = client || getDynamoDbClient();
    const result = await ddb.send(
        new GetCommand({
            TableName: ENTITLEMENTS_TABLE_NAME,
            Key: {
                external_user_id,
                product
            }
        })
    );

    return result.Item || null;
}

/**
 * Saves or updates an entitlement record in the store.
 * Supports sources: paid | founder | admin | future_trial.
 */
async function putEntitlementRecord(
    {
        external_user_id,
        product,
        status = 'active',
        source = 'paid',
        email = null,
        expires_at = null,
        notes = null
    },
    client = null
) {
    const ddb = client || getDynamoDbClient();
    const now = new Date().toISOString();

    const item = {
        external_user_id,
        product,
        status,
        source,
        created_at: now,
        updated_at: now
    };

    if (email) item.email = email;
    if (expires_at) item.expires_at = expires_at;
    if (notes) item.notes = notes;

    await ddb.send(
        new PutCommand({
            TableName: ENTITLEMENTS_TABLE_NAME,
            Item: item
        })
    );

    return item;
}

/**
 * Express handler for POST /api/billing/entitlement.
 */
async function handleEntitlementCheck(req, res) {
    try {
        // 1. Service credential authentication
        const auth = validateServiceAuth(req);
        if (!auth.valid) {
            return res.status(auth.status).json({
                error: auth.error
            });
        }

        // 2. Body shape validation
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
            return res.status(400).json({
                error: 'Request body must be a JSON object'
            });
        }

        const { external_user_id, product } = req.body;

        // 3. Product validation
        if (!validateProduct(product)) {
            return res.status(400).json({
                error: 'Unsupported product'
            });
        }

        // 4. External User ID validation
        if (!validateExternalUserId(external_user_id, product)) {
            return res.status(400).json({
                error: 'Invalid external_user_id format'
            });
        }

        // 5. Look up record in central entitlement store
        const record = await getEntitlementRecord(
            external_user_id.trim(),
            product.trim()
        );

        // 6. Entitlement evaluation
        const entitled = isRecordEntitled(record);

        if (entitled) {
            return res.status(200).json({
                entitled: true,
                status: 'active',
                product: product.trim()
            });
        }

        return res.status(200).json({
            entitled: false,
            status: 'none',
            product: product.trim()
        });
    } catch (err) {
        console.error('[ENTITLEMENT CHECK] Error:', err);

        return res.status(500).json({
            error: 'Unable to check entitlement'
        });
    }
}

module.exports = {
    ENTITLEMENTS_TABLE_NAME,
    SUPPORTED_PRODUCTS,
    extractProvidedSecret,
    validateServiceAuth,
    validateExternalUserId,
    validateProduct,
    isRecordEntitled,
    getEntitlementRecord,
    putEntitlementRecord,
    handleEntitlementCheck,
    getDynamoDbClient,
    setDynamoDbClient
};
