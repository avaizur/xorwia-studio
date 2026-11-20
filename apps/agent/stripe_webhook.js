const { GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const {
    ENTITLEMENTS_TABLE_NAME,
    validateExternalUserId,
    getDynamoDbClient
} = require('./entitlements');
const { HAYDER_PRODUCT, normalizeBillingInterval } = require('./checkout');

const LEGACY_PRODUCTS = new Set(['lectura', 'capcut']);

const SUPPORTED_HAYDER_SUBSCRIPTION_EVENTS = new Set([
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.paid',
    'invoice.payment_succeeded',
    'invoice.payment_failed'
]);

let customWebhookStripeClient = null;

function setWebhookStripeClient(client) {
    customWebhookStripeClient = client;
}

function getWebhookStripeClient(defaultClient = null) {
    return customWebhookStripeClient || defaultClient;
}

function normalizeEmail(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return normalized && normalized.includes('@') ? normalized : null;
}

function normalizeLegacyProduct(value) {
    const product = String(value || '').trim().toLowerCase();
    return LEGACY_PRODUCTS.has(product) ? product : null;
}

/**
 * Extracts and validates a Stripe object ID (string or expanded object) with expected prefix.
 */
function extractStripeId(value, prefix) {
    const raw = typeof value === 'string' ? value : value?.id;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    const pattern = new RegExp(`^${prefix}_[a-zA-Z0-9_]+$`);
    return pattern.test(trimmed) ? trimmed : null;
}

/**
 * Converts a positive Unix timestamp (seconds) to an ISO-8601 string.
 */
function toIsoFromUnixSeconds(unixSeconds) {
    if (
        typeof unixSeconds !== 'number' ||
        !Number.isFinite(unixSeconds) ||
        unixSeconds <= 0
    ) {
        return null;
    }
    const date = new Date(unixSeconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Ensures multiple candidate values for the same field do not conflict.
 */
function resolveNonConflictingValue(candidates, transform = (v) => v) {
    let resolved = null;

    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) continue;
        const transformed = transform(String(candidate).trim());
        if (!transformed) continue;

        if (resolved === null) {
            resolved = transformed;
        } else if (resolved !== transformed) {
            return { conflict: true, value: null };
        }
    }

    return { conflict: false, value: resolved };
}

/**
 * Maps Stripe subscription status to Xorwia entitlement status.
 */
function mapSubscriptionStatusToEntitlement(subscriptionStatus) {
    const normalized = String(subscriptionStatus || '').trim().toLowerCase();

    switch (normalized) {
        case 'active':
        case 'trialing':
            return {
                entitlementStatus: 'active',
                subscriptionStatus: normalized,
                isTerminalCancel: false
            };
        case 'past_due':
            return {
                entitlementStatus: 'past_due',
                subscriptionStatus: 'past_due',
                isTerminalCancel: false
            };
        case 'canceled':
        case 'incomplete_expired':
            return {
                entitlementStatus: 'inactive',
                subscriptionStatus: normalized,
                isTerminalCancel: true
            };
        case 'unpaid':
        case 'paused':
        case 'incomplete':
            return {
                entitlementStatus: 'inactive',
                subscriptionStatus: normalized,
                isTerminalCancel: false
            };
        default:
            return null;
    }
}

/**
 * Computes a deterministic monotonic ordering key combining event.created (seconds)
 * and a same-second lifecycle precedence rank (0..99).
 */
function computeEventOrder(eventCreated, eventType, options = {}) {
    const { subscriptionStatus = '', cancelAtPeriodEnd = false } = options;
    const status = String(subscriptionStatus || '').trim().toLowerCase();
    let rank = 35;

    switch (eventType) {
        case 'customer.subscription.created':
            rank = status === 'incomplete' ? 10 : 30;
            break;
        case 'checkout.session.completed':
            rank = 20;
            break;
        case 'invoice.payment_failed':
            rank = 40;
            break;
        case 'invoice.payment_succeeded':
            rank = 50;
            break;
        case 'invoice.paid':
            rank = 55;
            break;
        case 'customer.subscription.updated':
            if (status === 'canceled' || status === 'incomplete_expired') {
                rank = 75;
            } else if (status === 'active' || status === 'trialing') {
                rank = cancelAtPeriodEnd ? 65 : 60;
            } else {
                rank = 45;
            }
            break;
        case 'customer.subscription.deleted':
            rank = 85;
            break;
        default:
            rank = 35;
    }

    return eventCreated * 100 + rank;
}

/**
 * Checks whether an entitlement record is a protected founder/admin/lifetime record.
 */
function isProtectedEntitlementRecord(record) {
    if (!record || typeof record !== 'object') return false;
    const normalizedSource =
        typeof record.source === 'string' ? record.source.trim().toLowerCase() : '';
    return (
        normalizedSource === 'founder' ||
        normalizedSource === 'admin' ||
        record.lifetime === true ||
        (Boolean(normalizedSource) && normalizedSource !== 'paid')
    );
}

/**
 * Extracts and validates HAYDER_PRO context from checkout.session.completed.
 */
function extractCheckoutHayderContext(session) {
    const rawProduct = String(session?.metadata?.product || '').trim().toUpperCase();
    if (rawProduct !== HAYDER_PRODUCT) {
        return { isHayder: false };
    }

    if (session?.mode !== 'subscription') {
        return {
            isHayder: true,
            valid: false,
            error: 'Invalid checkout session mode for HAYDER_PRO'
        };
    }

    if (session.payment_status !== 'paid') {
        return {
            isHayder: true,
            valid: true,
            unpaid: true,
            paymentStatus: session.payment_status || 'unknown'
        };
    }

    const userIdResolution = resolveNonConflictingValue([
        session.metadata?.external_user_id,
        session.client_reference_id
    ]);

    if (userIdResolution.conflict) {
        return {
            isHayder: true,
            valid: false,
            error: 'Conflicting external_user_id identity in checkout session'
        };
    }

    const externalUserId = userIdResolution.value;
    if (!validateExternalUserId(externalUserId, HAYDER_PRODUCT)) {
        return {
            isHayder: true,
            valid: false,
            error: 'Missing or invalid external_user_id'
        };
    }

    const subscriptionId = extractStripeId(session.subscription, 'sub');
    const customerId = extractStripeId(session.customer, 'cus');

    if (!subscriptionId || !customerId) {
        return {
            isHayder: true,
            valid: false,
            error: 'Missing or invalid subscription/customer identity'
        };
    }

    return {
        isHayder: true,
        valid: true,
        unpaid: false,
        externalUserId,
        customerId,
        subscriptionId,
        checkoutSessionId: typeof session.id === 'string' ? session.id.trim() : null,
        email: normalizeEmail(session.customer_details?.email || session.customer_email),
        billingInterval: normalizeBillingInterval(session.metadata?.billing_interval)
    };
}

/**
 * Extracts and validates HAYDER_PRO context from customer.subscription.* events.
 */
function extractSubscriptionContext(subscription) {
    const metadata = subscription?.metadata || {};
    const rawProduct = String(metadata.product || '').trim().toUpperCase();

    if (rawProduct !== HAYDER_PRODUCT) {
        return { isHayder: false };
    }

    const externalUserId = String(metadata.external_user_id || '').trim();
    if (!validateExternalUserId(externalUserId, HAYDER_PRODUCT)) {
        return {
            isHayder: true,
            valid: false,
            error: 'Missing or invalid external_user_id in subscription metadata'
        };
    }

    const subscriptionId = extractStripeId(subscription?.id, 'sub');
    const customerId = extractStripeId(subscription?.customer, 'cus');

    if (!subscriptionId || !customerId) {
        return {
            isHayder: true,
            valid: false,
            error: 'Missing or invalid subscription/customer identity'
        };
    }

    let periodEndSec =
        typeof subscription.current_period_end === 'number' &&
        Number.isFinite(subscription.current_period_end)
            ? subscription.current_period_end
            : null;

    if (!periodEndSec && Array.isArray(subscription.items?.data)) {
        for (const item of subscription.items.data) {
            if (
                typeof item?.current_period_end === 'number' &&
                Number.isFinite(item.current_period_end)
            ) {
                periodEndSec =
                    periodEndSec === null
                        ? item.current_period_end
                        : Math.max(periodEndSec, item.current_period_end);
            }
        }
    }

    const recurringInterval =
        subscription.items?.data?.[0]?.price?.recurring?.interval ||
        subscription.items?.data?.[0]?.plan?.interval;

    const billingInterval =
        normalizeBillingInterval(metadata.billing_interval) ||
        normalizeBillingInterval(recurringInterval);

    return {
        isHayder: true,
        valid: true,
        externalUserId,
        customerId,
        subscriptionId,
        subscriptionStatus: String(subscription.status || '').trim().toLowerCase(),
        periodEndIso: toIsoFromUnixSeconds(periodEndSec),
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        canceledAtIso: toIsoFromUnixSeconds(subscription.canceled_at),
        billingInterval
    };
}

/**
 * Extracts and validates HAYDER_PRO context from invoice.paid / invoice.payment_succeeded / invoice.payment_failed.
 * Supports both classic Stripe invoice fields and 2025+ Basil `parent.subscription_details` structure.
 */
function extractInvoiceSubscriptionContext(invoice) {
    const invoiceLines = Array.isArray(invoice?.lines?.data)
        ? invoice.lines.data
        : [];

    const metadataSources = [
        invoice?.parent?.subscription_details?.metadata,
        invoice?.subscription_details?.metadata,
        ...invoiceLines.map((line) => line?.metadata),
        invoice?.metadata
    ].filter((m) => m && typeof m === 'object');

    const productResolution = resolveNonConflictingValue(
        metadataSources.map((m) => m.product),
        (v) => v.toUpperCase()
    );

    if (productResolution.conflict) {
        const mentionsHayder = metadataSources.some(
            (m) => String(m.product || '').trim().toUpperCase() === HAYDER_PRODUCT
        );
        if (mentionsHayder) {
            return {
                isHayder: true,
                valid: false,
                error: 'Conflicting product metadata on invoice'
            };
        }
        return { isHayder: false };
    }

    if (productResolution.value !== HAYDER_PRODUCT) {
        return { isHayder: false };
    }

    const userIdResolution = resolveNonConflictingValue(
        metadataSources.map((m) => m.external_user_id)
    );

    if (userIdResolution.conflict) {
        return {
            isHayder: true,
            valid: false,
            error: 'Conflicting external_user_id metadata on invoice'
        };
    }

    const externalUserId = userIdResolution.value;
    if (!validateExternalUserId(externalUserId, HAYDER_PRODUCT)) {
        return {
            isHayder: true,
            valid: false,
            error: 'Missing or invalid external_user_id in invoice metadata'
        };
    }

    const subCandidates = [
        invoice?.subscription,
        invoice?.parent?.subscription_details?.subscription,
        ...invoiceLines.flatMap((line) => [
            line?.subscription,
            line?.parent?.subscription_item_details?.subscription
        ])
    ]
        .map((v) => extractStripeId(v, 'sub'))
        .filter(Boolean);

    const subResolution = resolveNonConflictingValue(subCandidates);
    if (subResolution.conflict || !subResolution.value) {
        return {
            isHayder: true,
            valid: false,
            error: 'Missing or conflicting subscription identity on invoice'
        };
    }

    const customerId = extractStripeId(invoice?.customer, 'cus');
    if (!customerId) {
        return {
            isHayder: true,
            valid: false,
            error: 'Missing or invalid customer identity on invoice'
        };
    }

    let periodEndSec = null;
    for (const line of invoiceLines) {
        const end = line?.period?.end;
        if (typeof end === 'number' && Number.isFinite(end) && end > 0) {
            periodEndSec = periodEndSec === null ? end : Math.max(periodEndSec, end);
        }
    }

    if (
        !periodEndSec &&
        typeof invoice?.period_end === 'number' &&
        Number.isFinite(invoice.period_end) &&
        invoice.period_end > 0
    ) {
        periodEndSec = invoice.period_end;
    }

    const billingIntervalCandidate =
        metadataSources.find((m) => m.billing_interval)?.billing_interval ||
        invoiceLines.find((l) => l?.price?.recurring?.interval)?.price?.recurring?.interval ||
        invoiceLines.find((l) => l?.plan?.interval)?.plan?.interval;

    return {
        isHayder: true,
        valid: true,
        externalUserId,
        customerId,
        subscriptionId: subResolution.value,
        invoiceId: typeof invoice?.id === 'string' ? invoice.id.trim() : null,
        billingReason: String(invoice?.billing_reason || '').trim().toLowerCase(),
        isPaid: invoice?.paid === true || invoice?.status === 'paid',
        periodEndIso: toIsoFromUnixSeconds(periodEndSec),
        email: normalizeEmail(invoice?.customer_email),
        billingInterval: normalizeBillingInterval(billingIntervalCandidate)
    };
}

/**
 * Builds atomic DynamoDB UpdateCommand parameters for a HAYDER_PRO subscription transition.
 * Enforces:
 * 1. Founder/admin/lifetime protection (atomic, cannot be overwritten by Stripe events)
 * 2. Event idempotency (processed_stripe_event_ids set)
 * 3. Monotonic event ordering (last_stripe_event_order)
 * 4. Customer/subscription identity verification
 */
function buildHayderEntitlementUpdateParams({
    tableName,
    externalUserId,
    entitlementStatus,
    subscriptionStatus,
    customerId,
    subscriptionId,
    eventId,
    eventType,
    eventCreated,
    eventOrder,
    canBindNewSubscription = false,
    requireDifferentSubscription = false,
    checkoutSessionId = null,
    billingInterval = null,
    email = null,
    periodEndIso = null,
    clearExpiresAt = false,
    cancelAtPeriodEnd = undefined,
    canceledAtIso = null,
    lastInvoiceId = null,
    lastPaymentStatus = null,
    paymentFailedAtIso = null,
    nowIso = new Date().toISOString()
}) {
    const expressionAttributeNames = {
        '#status': 'status',
        '#source': 'source',
        '#lifetime': 'lifetime'
    };

    const expressionAttributeValues = {
        ':status': entitlementStatus,
        ':paidSource': 'paid',
        ':trueVal': true,
        ':subscriptionStatus': subscriptionStatus,
        ':customerId': customerId,
        ':subscriptionId': subscriptionId,
        ':eventId': eventId,
        ':eventIdSet': new Set([eventId]),
        ':eventType': eventType,
        ':eventCreated': eventCreated,
        ':eventOrder': eventOrder,
        ':nowIso': nowIso
    };

    const setClauses = [
        '#status = :status',
        '#source = :paidSource',
        'subscription_status = :subscriptionStatus',
        'stripe_customer_id = :customerId',
        'stripe_subscription_id = :subscriptionId',
        'last_stripe_event_id = :eventId',
        'last_stripe_event_type = :eventType',
        'last_stripe_event_created = :eventCreated',
        'last_stripe_event_order = :eventOrder',
        'created_at = if_not_exists(created_at, :nowIso)',
        'updated_at = :nowIso'
    ];

    const removeClauses = [];

    if (checkoutSessionId) {
        setClauses.push('stripe_checkout_session_id = :checkoutSessionId');
        expressionAttributeValues[':checkoutSessionId'] = checkoutSessionId;
    }

    if (billingInterval) {
        setClauses.push('billing_interval = :billingInterval');
        expressionAttributeValues[':billingInterval'] = billingInterval;
    }

    if (email) {
        setClauses.push('email = :email');
        expressionAttributeValues[':email'] = email;
    }

    if (periodEndIso) {
        setClauses.push('current_period_end = :currentPeriodEnd');
        expressionAttributeValues[':currentPeriodEnd'] = periodEndIso;
        if (!clearExpiresAt) {
            setClauses.push('expires_at = :expiresAt');
            expressionAttributeValues[':expiresAt'] = periodEndIso;
        }
    }

    if (clearExpiresAt) {
        removeClauses.push('expires_at');
    }

    if (typeof cancelAtPeriodEnd === 'boolean') {
        setClauses.push('cancel_at_period_end = :cancelAtPeriodEnd');
        expressionAttributeValues[':cancelAtPeriodEnd'] = cancelAtPeriodEnd;
    }

    if (canceledAtIso) {
        setClauses.push('canceled_at = :canceledAt');
        expressionAttributeValues[':canceledAt'] = canceledAtIso;
    } else if (entitlementStatus === 'active') {
        removeClauses.push('canceled_at');
    }

    if (lastInvoiceId) {
        setClauses.push('last_invoice_id = :lastInvoiceId');
        expressionAttributeValues[':lastInvoiceId'] = lastInvoiceId;
    }

    if (lastPaymentStatus) {
        setClauses.push('last_payment_status = :lastPaymentStatus');
        expressionAttributeValues[':lastPaymentStatus'] = lastPaymentStatus;
    }

    if (paymentFailedAtIso) {
        setClauses.push('payment_failed_at = :paymentFailedAt');
        expressionAttributeValues[':paymentFailedAt'] = paymentFailedAtIso;
    } else if (entitlementStatus === 'active') {
        removeClauses.push('payment_failed_at');
    }

    let identityCondition;
    if (requireDifferentSubscription) {
        expressionAttributeValues[':activeStatus'] = 'active';
        identityCondition =
            '(#status <> :activeStatus AND stripe_subscription_id <> :subscriptionId)';
    } else if (canBindNewSubscription) {
        expressionAttributeValues[':activeStatus'] = 'active';
        identityCondition =
            '((attribute_not_exists(stripe_subscription_id) AND attribute_not_exists(stripe_customer_id)) OR (stripe_customer_id = :customerId AND stripe_subscription_id = :subscriptionId) OR #status <> :activeStatus)';
    } else {
        identityCondition =
            '((attribute_not_exists(stripe_subscription_id) AND attribute_not_exists(stripe_customer_id)) OR (stripe_customer_id = :customerId AND stripe_subscription_id = :subscriptionId))';
    }

    const conditionExpression = [
        '(attribute_not_exists(#source) OR #source = :paidSource)',
        '(attribute_not_exists(#lifetime) OR #lifetime <> :trueVal)',
        '(attribute_not_exists(processed_stripe_event_ids) OR NOT contains(processed_stripe_event_ids, :eventId))',
        '(attribute_not_exists(last_stripe_event_order) OR last_stripe_event_order < :eventOrder)',
        identityCondition
    ].join(' AND ');

    const updateParts = [`SET ${setClauses.join(', ')}`];
    if (removeClauses.length > 0) {
        updateParts.push(`REMOVE ${removeClauses.join(', ')}`);
    }
    updateParts.push('ADD processed_stripe_event_ids :eventIdSet');

    return {
        TableName: tableName,
        Key: {
            external_user_id: externalUserId,
            product: HAYDER_PRODUCT
        },
        UpdateExpression: updateParts.join(' '),
        ConditionExpression: conditionExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues
    };
}

/**
 * Classifies why an atomic DynamoDB ConditionExpression failed, purely for logging and safe HTTP 200 responses.
 */
function classifyConditionFailure(existing, { eventId, eventOrder, customerId, subscriptionId }) {
    if (isProtectedEntitlementRecord(existing)) {
        return {
            body: {
                received: true,
                ignored: true,
                reason: 'protected_entitlement'
            }
        };
    }

    const processedIds = existing?.processed_stripe_event_ids;
    const isDuplicate =
        (processedIds instanceof Set && processedIds.has(eventId)) ||
        (Array.isArray(processedIds) && processedIds.includes(eventId));

    if (isDuplicate) {
        return {
            body: {
                received: true,
                duplicate: true,
                reason: 'duplicate_event'
            }
        };
    }

    if (
        typeof existing?.last_stripe_event_order === 'number' &&
        existing.last_stripe_event_order >= eventOrder
    ) {
        return {
            body: {
                received: true,
                ignored: true,
                reason: 'stale_event'
            }
        };
    }

    if (
        existing?.stripe_subscription_id &&
        (existing.stripe_subscription_id !== subscriptionId ||
            existing.stripe_customer_id !== customerId)
    ) {
        return {
            body: {
                received: true,
                ignored: true,
                reason: 'identity_mismatch'
            }
        };
    }

    return {
        body: {
            received: true,
            ignored: true,
            reason: 'condition_not_met'
        }
    };
}

/**
 * Preserved legacy Lectura / CapCut one-time payment fulfillment handler.
 */
async function handleLegacyCheckoutCompleted({
    session,
    dynamodb,
    accessTableName,
    lecturaAccessMonths,
    capcutTotalUnits,
    res
}) {
    if (session.payment_status !== 'paid') {
        console.warn('[STRIPE WEBHOOK] Checkout completed but not paid', {
            sessionId: session.id,
            paymentStatus: session.payment_status
        });
        return res.status(200).json({
            received: true,
            accessGranted: false,
            reason: 'payment_not_paid'
        });
    }

    const email = normalizeEmail(
        session.customer_details?.email || session.customer_email
    );

    const product = normalizeLegacyProduct(session.metadata?.product);
    const sessionId = typeof session.id === 'string' ? session.id.trim() : '';

    if (!email || !product || !sessionId) {
        console.error(
            '[STRIPE WEBHOOK] Missing/invalid email or product metadata',
            { sessionId: session.id }
        );

        return res.status(400).json({
            error: 'Missing or invalid email/product metadata'
        });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const sessionSet = new Set([sessionId]);

    try {
        if (product === 'lectura') {
            const existingRes = await dynamodb.send(
                new GetCommand({
                    TableName: accessTableName,
                    Key: { email, product }
                })
            );
            const existing = existingRes.Item || null;

            let accessBase = now;
            if (existing?.access_until) {
                const existingUntil = new Date(existing.access_until);
                if (
                    !Number.isNaN(existingUntil.getTime()) &&
                    existingUntil > now
                ) {
                    accessBase = existingUntil;
                }
            }

            const accessUntil = new Date(accessBase);
            accessUntil.setMonth(accessUntil.getMonth() + lecturaAccessMonths);

            await dynamodb.send(
                new UpdateCommand({
                    TableName: accessTableName,
                    Key: { email, product },
                    UpdateExpression:
                        'SET payment_status = :paid, stripe_session_id = :sessionId, purchased_at = :purchasedAt, updated_at = :updatedAt, access_until = :accessUntil ADD processed_session_ids :sessionSet',
                    ConditionExpression:
                        'attribute_not_exists(processed_session_ids) OR NOT contains(processed_session_ids, :sessionId)',
                    ExpressionAttributeValues: {
                        ':paid': 'paid',
                        ':sessionId': sessionId,
                        ':purchasedAt': nowIso,
                        ':updatedAt': nowIso,
                        ':accessUntil': accessUntil.toISOString(),
                        ':sessionSet': sessionSet
                    }
                })
            );
        }

        if (product === 'capcut') {
            await dynamodb.send(
                new UpdateCommand({
                    TableName: accessTableName,
                    Key: { email, product },
                    UpdateExpression:
                        'SET payment_status = :paid, stripe_session_id = :sessionId, purchased_at = :purchasedAt, updated_at = :updatedAt ADD credits_remaining :credits, processed_session_ids :sessionSet',
                    ConditionExpression:
                        'attribute_not_exists(processed_session_ids) OR NOT contains(processed_session_ids, :sessionId)',
                    ExpressionAttributeValues: {
                        ':paid': 'paid',
                        ':sessionId': sessionId,
                        ':purchasedAt': nowIso,
                        ':updatedAt': nowIso,
                        ':credits': capcutTotalUnits,
                        ':sessionSet': sessionSet
                    }
                })
            );
        }

        console.log('[STRIPE WEBHOOK] Paid access saved', {
            email,
            product,
            sessionId
        });

        return res.status(200).json({
            received: true,
            accessGranted: true
        });
    } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') {
            console.log('[STRIPE WEBHOOK] Duplicate event ignored', {
                sessionId
            });

            return res.status(200).json({
                received: true,
                duplicate: true
            });
        }

        throw err;
    }
}

/**
 * Executes an atomic HAYDER_PRO entitlement update and handles ConditionalCheckFailedException safely.
 */
async function applyHayderSubscriptionUpdate({ ddb, tableName, updateConfig, res }) {
    const params = buildHayderEntitlementUpdateParams({
        tableName,
        ...updateConfig
    });

    try {
        await ddb.send(new UpdateCommand(params));

        console.log('[STRIPE WEBHOOK] HAYDER_PRO entitlement updated', {
            eventId: updateConfig.eventId,
            eventType: updateConfig.eventType,
            externalUserId: updateConfig.externalUserId,
            status: updateConfig.entitlementStatus,
            subscriptionStatus: updateConfig.subscriptionStatus
        });

        return res.status(200).json({
            received: true,
            product: HAYDER_PRODUCT,
            status: updateConfig.entitlementStatus,
            accessGranted: updateConfig.entitlementStatus === 'active'
        });
    } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') {
            let existing = null;
            try {
                const lookup = await ddb.send(
                    new GetCommand({
                        TableName: tableName,
                        Key: {
                            external_user_id: updateConfig.externalUserId,
                            product: HAYDER_PRODUCT
                        }
                    })
                );
                existing = lookup.Item || null;
            } catch {
                // Fall back to generic condition_not_met classification
            }

            const classification = classifyConditionFailure(existing, {
                eventId: updateConfig.eventId,
                eventOrder: updateConfig.eventOrder,
                customerId: updateConfig.customerId,
                subscriptionId: updateConfig.subscriptionId
            });

            console.log('[STRIPE WEBHOOK] HAYDER_PRO event skipped by atomic condition', {
                eventId: updateConfig.eventId,
                eventType: updateConfig.eventType,
                externalUserId: updateConfig.externalUserId,
                reason: classification.body.reason
            });

            return res.status(200).json(classification.body);
        }

        throw err;
    }
}

/**
 * Creates the Express route handler for POST /stripe/webhook.
 */
function createStripeWebhookHandler({
    stripe: defaultStripeClient,
    dynamodb: defaultDynamoDb = null,
    entitlementsTableName = null,
    accessTableName = null,
    lecturaAccessMonths = 6,
    capcutTotalUnits = 20
}) {
    return async function handleStripeWebhook(req, res) {
        const signature = req.headers['stripe-signature'];
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

        if (
            typeof signature !== 'string' ||
            !signature.trim() ||
            typeof webhookSecret !== 'string' ||
            !webhookSecret.trim()
        ) {
            console.error('[STRIPE WEBHOOK] Missing signature or webhook secret');
            return res.status(400).send('Webhook configuration error');
        }

        if (!Buffer.isBuffer(req.body) && typeof req.body !== 'string') {
            console.error('[STRIPE WEBHOOK] Raw request body is required');
            return res.status(400).send('Webhook Error: Raw request body required');
        }

        const stripeClient = getWebhookStripeClient(defaultStripeClient);
        if (!stripeClient?.webhooks?.constructEvent) {
            console.error('[STRIPE WEBHOOK] Stripe client unavailable');
            return res.status(500).json({ error: 'Webhook processing failed' });
        }

        let event;
        try {
            event = stripeClient.webhooks.constructEvent(
                req.body,
                signature.trim(),
                webhookSecret.trim()
            );
        } catch (err) {
            console.error(
                '[STRIPE WEBHOOK] Signature verification failed:',
                err.message
            );
            return res.status(400).send('Webhook Error: Invalid signature');
        }

        if (
            !event ||
            typeof event.id !== 'string' ||
            !event.id.trim() ||
            typeof event.type !== 'string' ||
            !event.data ||
            typeof event.data.object !== 'object' ||
            event.data.object === null
        ) {
            return res.status(400).json({ error: 'Malformed webhook event' });
        }

        const eventId = event.id.trim();
        const eventType = event.type;
        const eventObject = event.data.object;
        const ddb = defaultDynamoDb || getDynamoDbClient();
        const resolvedEntitlementsTable =
            entitlementsTableName ||
            process.env.ENTITLEMENTS_TABLE_NAME ||
            ENTITLEMENTS_TABLE_NAME;
        const resolvedAccessTable =
            accessTableName ||
            process.env.ACCESS_TABLE_NAME ||
            'xorwia_user_access';

        if (!SUPPORTED_HAYDER_SUBSCRIPTION_EVENTS.has(eventType)) {
            return res.status(200).json({ received: true, ignored: true });
        }

        try {
            // 1. checkout.session.completed (HAYDER_PRO subscription OR legacy Lectura/CapCut)
            if (eventType === 'checkout.session.completed') {
                const hayderCtx = extractCheckoutHayderContext(eventObject);

                if (!hayderCtx.isHayder) {
                    return await handleLegacyCheckoutCompleted({
                        session: eventObject,
                        dynamodb: ddb,
                        accessTableName: resolvedAccessTable,
                        lecturaAccessMonths,
                        capcutTotalUnits,
                        res
                    });
                }

                if (!hayderCtx.valid) {
                    return res.status(400).json({ error: hayderCtx.error });
                }

                if (hayderCtx.unpaid) {
                    return res.status(200).json({
                        received: true,
                        accessGranted: false,
                        reason: 'payment_not_paid'
                    });
                }

                if (
                    typeof event.created !== 'number' ||
                    !Number.isFinite(event.created) ||
                    event.created <= 0
                ) {
                    return res.status(400).json({ error: 'Invalid event timestamp' });
                }

                const eventOrder = computeEventOrder(event.created, eventType);

                // Only clear a stale expires_at when atomically rebinding from a different
                // non-active subscription; never wipe expires_at already set for this subscription.
                let shouldClearStaleExpiresAt = false;
                try {
                    const existingLookup = await ddb.send(
                        new GetCommand({
                            TableName: resolvedEntitlementsTable,
                            Key: {
                                external_user_id: hayderCtx.externalUserId,
                                product: HAYDER_PRODUCT
                            }
                        })
                    );
                    const existingItem = existingLookup.Item || null;
                    if (
                        existingItem &&
                        !isProtectedEntitlementRecord(existingItem) &&
                        existingItem.expires_at &&
                        existingItem.status !== 'active' &&
                        existingItem.stripe_subscription_id &&
                        existingItem.stripe_subscription_id !== hayderCtx.subscriptionId
                    ) {
                        shouldClearStaleExpiresAt = true;
                    }
                } catch {
                    // Proceed safely without clearing expires_at; atomic conditions still govern the write.
                }

                return await applyHayderSubscriptionUpdate({
                    ddb,
                    tableName: resolvedEntitlementsTable,
                    updateConfig: {
                        externalUserId: hayderCtx.externalUserId,
                        entitlementStatus: 'active',
                        subscriptionStatus: 'active',
                        customerId: hayderCtx.customerId,
                        subscriptionId: hayderCtx.subscriptionId,
                        eventId,
                        eventType,
                        eventCreated: event.created,
                        eventOrder,
                        canBindNewSubscription: true,
                        requireDifferentSubscription: shouldClearStaleExpiresAt,
                        checkoutSessionId: hayderCtx.checkoutSessionId,
                        billingInterval: hayderCtx.billingInterval,
                        email: hayderCtx.email,
                        clearExpiresAt: shouldClearStaleExpiresAt,
                        cancelAtPeriodEnd: false,
                        lastPaymentStatus: 'paid'
                    },
                    res
                });
            }

            // Validate event.created for all HAYDER_PRO subscription/invoice events
            const validateEventTimestamp = () =>
                typeof event.created === 'number' &&
                Number.isFinite(event.created) &&
                event.created > 0;

            // 2. customer.subscription.created / updated / deleted
            if (
                eventType === 'customer.subscription.created' ||
                eventType === 'customer.subscription.updated' ||
                eventType === 'customer.subscription.deleted'
            ) {
                const subCtx = extractSubscriptionContext(eventObject);

                if (!subCtx.isHayder) {
                    return res.status(200).json({ received: true, ignored: true });
                }

                if (!subCtx.valid) {
                    return res.status(400).json({ error: subCtx.error });
                }

                if (!validateEventTimestamp()) {
                    return res.status(400).json({ error: 'Invalid event timestamp' });
                }

                const nowIso = new Date().toISOString();

                if (eventType === 'customer.subscription.deleted') {
                    const eventOrder = computeEventOrder(event.created, eventType, {
                        subscriptionStatus: 'canceled'
                    });

                    return await applyHayderSubscriptionUpdate({
                        ddb,
                        tableName: resolvedEntitlementsTable,
                        updateConfig: {
                            externalUserId: subCtx.externalUserId,
                            entitlementStatus: 'inactive',
                            subscriptionStatus: 'canceled',
                            customerId: subCtx.customerId,
                            subscriptionId: subCtx.subscriptionId,
                            eventId,
                            eventType,
                            eventCreated: event.created,
                            eventOrder,
                            canBindNewSubscription: false,
                            billingInterval: subCtx.billingInterval,
                            periodEndIso: subCtx.periodEndIso,
                            clearExpiresAt: true,
                            cancelAtPeriodEnd: false,
                            canceledAtIso: subCtx.canceledAtIso || nowIso,
                            nowIso
                        },
                        res
                    });
                }

                const mapped = mapSubscriptionStatusToEntitlement(subCtx.subscriptionStatus);
                if (!mapped) {
                    return res.status(400).json({
                        error: 'Unsupported subscription status'
                    });
                }

                const eventOrder = computeEventOrder(event.created, eventType, {
                    subscriptionStatus: mapped.subscriptionStatus,
                    cancelAtPeriodEnd: subCtx.cancelAtPeriodEnd
                });

                const canBindNewSubscription =
                    eventType === 'customer.subscription.created' &&
                    mapped.entitlementStatus === 'active';

                return await applyHayderSubscriptionUpdate({
                    ddb,
                    tableName: resolvedEntitlementsTable,
                    updateConfig: {
                        externalUserId: subCtx.externalUserId,
                        entitlementStatus: mapped.entitlementStatus,
                        subscriptionStatus: mapped.subscriptionStatus,
                        customerId: subCtx.customerId,
                        subscriptionId: subCtx.subscriptionId,
                        eventId,
                        eventType,
                        eventCreated: event.created,
                        eventOrder,
                        canBindNewSubscription,
                        billingInterval: subCtx.billingInterval,
                        periodEndIso: subCtx.periodEndIso,
                        clearExpiresAt: mapped.isTerminalCancel,
                        cancelAtPeriodEnd: mapped.isTerminalCancel
                            ? false
                            : subCtx.cancelAtPeriodEnd,
                        canceledAtIso: mapped.isTerminalCancel
                            ? subCtx.canceledAtIso || nowIso
                            : null,
                        nowIso
                    },
                    res
                });
            }

            // 3. invoice.paid / invoice.payment_succeeded / invoice.payment_failed
            if (
                eventType === 'invoice.paid' ||
                eventType === 'invoice.payment_succeeded' ||
                eventType === 'invoice.payment_failed'
            ) {
                const invCtx = extractInvoiceSubscriptionContext(eventObject);

                if (!invCtx.isHayder) {
                    return res.status(200).json({ received: true, ignored: true });
                }

                if (!invCtx.valid) {
                    return res.status(400).json({ error: invCtx.error });
                }

                if (!validateEventTimestamp()) {
                    return res.status(400).json({ error: 'Invalid event timestamp' });
                }

                const nowIso = new Date().toISOString();

                if (eventType === 'invoice.payment_failed') {
                    const eventOrder = computeEventOrder(event.created, eventType, {
                        subscriptionStatus: 'past_due'
                    });

                    return await applyHayderSubscriptionUpdate({
                        ddb,
                        tableName: resolvedEntitlementsTable,
                        updateConfig: {
                            externalUserId: invCtx.externalUserId,
                            entitlementStatus: 'past_due',
                            subscriptionStatus: 'past_due',
                            customerId: invCtx.customerId,
                            subscriptionId: invCtx.subscriptionId,
                            eventId,
                            eventType,
                            eventCreated: event.created,
                            eventOrder,
                            canBindNewSubscription: false,
                            billingInterval: invCtx.billingInterval,
                            email: invCtx.email,
                            lastInvoiceId: invCtx.invoiceId,
                            lastPaymentStatus: 'failed',
                            paymentFailedAtIso:
                                toIsoFromUnixSeconds(event.created) || nowIso,
                            nowIso
                        },
                        res
                    });
                }

                // invoice.paid or invoice.payment_succeeded (activation, renewal, or payment recovery)
                if (!invCtx.isPaid) {
                    return res.status(200).json({
                        received: true,
                        accessGranted: false,
                        reason: 'invoice_not_paid'
                    });
                }

                const eventOrder = computeEventOrder(event.created, eventType, {
                    subscriptionStatus: 'active'
                });

                const canBindNewSubscription =
                    invCtx.billingReason === 'subscription_create';

                return await applyHayderSubscriptionUpdate({
                    ddb,
                    tableName: resolvedEntitlementsTable,
                    updateConfig: {
                        externalUserId: invCtx.externalUserId,
                        entitlementStatus: 'active',
                        subscriptionStatus: 'active',
                        customerId: invCtx.customerId,
                        subscriptionId: invCtx.subscriptionId,
                        eventId,
                        eventType,
                        eventCreated: event.created,
                        eventOrder,
                        canBindNewSubscription,
                        billingInterval: invCtx.billingInterval,
                        email: invCtx.email,
                        periodEndIso: invCtx.periodEndIso,
                        clearExpiresAt: false,
                        lastInvoiceId: invCtx.invoiceId,
                        lastPaymentStatus: 'paid',
                        nowIso
                    },
                    res
                });
            }

            return res.status(200).json({ received: true, ignored: true });
        } catch (err) {
            console.error('[STRIPE WEBHOOK] Processing failed:', err.message || err);
            return res.status(500).json({
                error: 'Webhook processing failed'
            });
        }
    };
}

module.exports = {
    SUPPORTED_HAYDER_SUBSCRIPTION_EVENTS,
    createStripeWebhookHandler,
    setWebhookStripeClient,
    getWebhookStripeClient,
    extractStripeId,
    toIsoFromUnixSeconds,
    mapSubscriptionStatusToEntitlement,
    computeEventOrder,
    isProtectedEntitlementRecord,
    extractCheckoutHayderContext,
    extractSubscriptionContext,
    extractInvoiceSubscriptionContext,
    buildHayderEntitlementUpdateParams,
    classifyConditionFailure
};
