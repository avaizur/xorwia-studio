const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const serverless = require('serverless-http');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand
} = require('@aws-sdk/lib-dynamodb');

const { fetchChannelVideos, createVerticalClip, fetchVideoTranscript } = require('./agent/clip_maker');
const { uploadToS3AndGetUrl, analyzeTranscriptWithBedrock, debugCodeWithBedrock, enhanceTranscriptWithBedrock } = require('./agent/aws_services');

const app = express();
const PORT = 3000;

const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION || 'eu-west-2'
});

const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const ACCESS_TABLE_NAME =
  process.env.ACCESS_TABLE_NAME || 'xorwia_user_access';

const LECTURA_ACCESS_MONTHS =
  Number(process.env.LECTURA_ACCESS_MONTHS || 6);

const CAPCUT_VIDEO_CREDITS =
  Number(process.env.CAPCUT_VIDEO_CREDITS || 5);

const CAPCUT_CLIP_CREDITS =
  Number(process.env.CAPCUT_CLIP_CREDITS || 20);

// One CapCut purchase is a shared allowance: 5 videos OR 20 clips.
// Internally we use 20 units: one clip = 1 unit, one video = 4 units.
const CAPCUT_TOTAL_UNITS = CAPCUT_CLIP_CREDITS;
const CAPCUT_VIDEO_UNIT_COST =
  Math.max(1, Math.floor(CAPCUT_TOTAL_UNITS / CAPCUT_VIDEO_CREDITS));

// Detect if running on AWS Lambda
const IS_LAMBDA = !!process.env.LAMBDA_TASK_ROOT;
const STORAGE_BASE = IS_LAMBDA ? '/tmp' : __dirname;
const DEPLOY_ENV = process.env.DEPLOY_ENV || 'green';

const mediaDir = path.join(STORAGE_BASE, 'media');
const outputDir = path.join(STORAGE_BASE, 'output');

// Setup Upload Management
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
        cb(null, mediaDir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Ensure directories exist safely
try {
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    console.log(`[${DEPLOY_ENV.toUpperCase()}] 📁 Storage initialized at ${STORAGE_BASE}`);
} catch (err) {
    console.warn('[SERVER] ⚠️ Storage warning:', err.message);
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeProduct(value) {
    const product = String(value || '').trim().toLowerCase();
    return ['lectura', 'capcut'].includes(product) ? product : null;
}

async function getAccessRecord(email, product) {
    const result = await dynamodb.send(
        new GetCommand({
            TableName: ACCESS_TABLE_NAME,
            Key: { email, product }
        })
    );

    return result.Item || null;
}

app.use(cors());

/**
 * Stripe Webhook
 *
 * IMPORTANT:
 * This route must be registered BEFORE app.use(express.json()).
 * Stripe signature verification requires the original raw request body.
 */
app.post(
    '/stripe/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        const signature = req.headers['stripe-signature'];
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

        if (!signature || !webhookSecret) {
            console.error('[STRIPE WEBHOOK] Missing signature or webhook secret');
            return res.status(400).send('Webhook configuration error');
        }

        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                signature,
                webhookSecret
            );
        } catch (err) {
            console.error(
                '[STRIPE WEBHOOK] Signature verification failed:',
                err.message
            );
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        if (event.type !== 'checkout.session.completed') {
            return res.status(200).json({ received: true, ignored: true });
        }

        const session = event.data.object;

        try {
            // We only grant access after Stripe reports the session as paid.
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
                session.customer_details?.email ||
                session.customer_email
            );

            const product = normalizeProduct(session.metadata?.product);

            if (!email || !product) {
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
            const sessionSet = new Set([session.id]);

            if (product === 'lectura') {
                // A genuine repeat purchase extends the current valid access;
                // an expired account starts again from now.
                const existing = await getAccessRecord(email, product);

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
                accessUntil.setMonth(
                    accessUntil.getMonth() + LECTURA_ACCESS_MONTHS
                );

                await dynamodb.send(
                    new UpdateCommand({
                        TableName: ACCESS_TABLE_NAME,
                        Key: { email, product },
                        UpdateExpression:
                            'SET payment_status = :paid, stripe_session_id = :sessionId, purchased_at = :purchasedAt, updated_at = :updatedAt, access_until = :accessUntil ADD processed_session_ids :sessionSet',
                        ConditionExpression:
                            'attribute_not_exists(processed_session_ids) OR NOT contains(processed_session_ids, :sessionId)',
                        ExpressionAttributeValues: {
                            ':paid': 'paid',
                            ':sessionId': session.id,
                            ':purchasedAt': nowIso,
                            ':updatedAt': nowIso,
                            ':accessUntil': accessUntil.toISOString(),
                            ':sessionSet': sessionSet
                        }
                    })
                );
            }

            if (product === 'capcut') {
                // Add one shared allowance for a genuine new purchase.
                // 20 units = 5 videos OR 20 clips (or a proportional mixture).
                await dynamodb.send(
                    new UpdateCommand({
                        TableName: ACCESS_TABLE_NAME,
                        Key: { email, product },
                        UpdateExpression:
                            'SET payment_status = :paid, stripe_session_id = :sessionId, purchased_at = :purchasedAt, updated_at = :updatedAt ADD credits_remaining :credits, processed_session_ids :sessionSet',
                        ConditionExpression:
                            'attribute_not_exists(processed_session_ids) OR NOT contains(processed_session_ids, :sessionId)',
                        ExpressionAttributeValues: {
                            ':paid': 'paid',
                            ':sessionId': session.id,
                            ':purchasedAt': nowIso,
                            ':updatedAt': nowIso,
                            ':credits': CAPCUT_TOTAL_UNITS,
                            ':sessionSet': sessionSet
                        }
                    })
                );
            }

            console.log('[STRIPE WEBHOOK] Paid access saved', {
                email,
                product,
                sessionId: session.id
            });

            return res.status(200).json({
                received: true,
                accessGranted: true
            });
        } catch (err) {
            // Stripe retries webhook deliveries. The same Checkout Session must
            // never reset or add credits twice.
            if (err.name === 'ConditionalCheckFailedException') {
                console.log('[STRIPE WEBHOOK] Duplicate event ignored', {
                    sessionId: session.id
                });

                return res.status(200).json({
                    received: true,
                    duplicate: true
                });
            }

            console.error('[STRIPE WEBHOOK] Processing failed:', err);

            return res.status(500).json({
                error: 'Webhook processing failed'
            });
        }
    }
);

// All normal JSON APIs come AFTER the Stripe raw-body webhook.
app.use(express.json());

// STRIP /studio PREFIX FOR LAMBDA (Xorwia Migration)
app.use((req, res, next) => {
    if (req.url.startsWith('/studio')) {
        req.url = req.url.replace('/studio', '') || '/';
    }
    next();
});

// SEO Landing Page Routes
app.get('/lectura', (req, res) => res.sendFile(path.join(__dirname, 'web/lectura.html')));
app.get('/tracefix', (req, res) => res.sendFile(path.join(__dirname, 'web/tracefix.html')));
app.get('/repurposer', (req, res) => res.sendFile(path.join(__dirname, 'web/repurposer.html')));

app.use(express.static(path.join(__dirname, 'web')));
app.use('/output', express.static(outputDir));

/**
 * Paid Access Check
 *
 * Examples:
 * /api/access/check?email=user@example.com&product=lectura
 * /api/access/check?email=user@example.com&product=capcut
 */
app.get('/api/access/check', async (req, res) => {
    try {
        const email = normalizeEmail(req.query.email);
        const product = normalizeProduct(req.query.product);

        if (!email || !product) {
            return res.status(400).json({
                error: 'Valid email and product are required'
            });
        }

        const item = await getAccessRecord(email, product);

        if (!item || item.payment_status !== 'paid') {
            return res.json({
                hasAccess: false,
                product
            });
        }

        if (product === 'lectura') {
            const accessUntil = item.access_until
                ? new Date(item.access_until)
                : null;

            const hasAccess = Boolean(
                accessUntil &&
                !Number.isNaN(accessUntil.getTime()) &&
                accessUntil > new Date()
            );

            return res.json({
                hasAccess,
                product,
                access_until: item.access_until || null
            });
        }

        const creditsRemaining = Number(item.credits_remaining || 0);
        const videosRemaining =
            Math.floor(creditsRemaining / CAPCUT_VIDEO_UNIT_COST);
        const clipsRemaining = creditsRemaining;

        return res.json({
            hasAccess: creditsRemaining > 0,
            product,
            credits_remaining: creditsRemaining,
            videos_remaining: videosRemaining,
            clips_remaining: clipsRemaining
        });
    } catch (err) {
        console.error('[ACCESS CHECK] Failed:', err);

        return res.status(500).json({
            error: 'Unable to check access'
        });
    }
});

/**
 * CapCut Credit Consumption
 *
 * Frontend calls this after a successful paid operation.
 * body: { email, usageType: "video" | "clip" }
 *
 * DynamoDB condition prevents the balance from going below zero.
 */
app.post('/api/access/consume', async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const usageType = String(req.body?.usageType || '').trim().toLowerCase();

        if (!email || !['video', 'clip'].includes(usageType)) {
            return res.status(400).json({
                error: 'Valid email and usageType (video or clip) are required'
            });
        }

        const unitsToConsume =
            usageType === 'video'
                ? CAPCUT_VIDEO_UNIT_COST
                : 1;

        const result = await dynamodb.send(
            new UpdateCommand({
                TableName: ACCESS_TABLE_NAME,
                Key: {
                    email,
                    product: 'capcut'
                },
                UpdateExpression:
                    'SET credits_remaining = credits_remaining - :units, updated_at = :updatedAt',
                ConditionExpression:
                    'payment_status = :paid AND attribute_exists(credits_remaining) AND credits_remaining >= :units',
                ExpressionAttributeValues: {
                    ':units': unitsToConsume,
                    ':paid': 'paid',
                    ':updatedAt': new Date().toISOString()
                },
                ReturnValues: 'ALL_NEW'
            })
        );

        const creditsRemaining =
            Number(result.Attributes?.credits_remaining || 0);

        return res.json({
            success: true,
            product: 'capcut',
            usageType,
            credits_remaining: creditsRemaining,
            videos_remaining:
                Math.floor(creditsRemaining / CAPCUT_VIDEO_UNIT_COST),
            clips_remaining: creditsRemaining
        });
    } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') {
            return res.status(403).json({
                success: false,
                error: 'No remaining CapCut credits for this usage type'
            });
        }

        console.error('[ACCESS CONSUME] Failed:', err);

        return res.status(500).json({
            success: false,
            error: 'Unable to consume access credit'
        });
    }
});

/**
 * Health Check
 */
app.get('/api/status', (req, res) => {
    res.json({
        status: 'Online',
        environment: DEPLOY_ENV,
        version: '2.1.0',
        platform: 'Xorwia Studio',
        tools: ['CapCut Repurposer', 'Lectura', 'TraceFix AI'],
        agent: 'Xorwia Studio v2.1 (Paid Access Memory)'
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'UP' });
});

/**
 * Fetch Channel Videos
 */
app.post('/api/fetch-channel', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No channel URL provided' });

    console.log(`[SERVER] Fetching channel: ${url}`);
    const result = await fetchChannelVideos(url);

    if (result.error) {
        return res.status(500).json({ error: result.error });
    }

    res.json(result);
});

/**
 * Generate Clip
 */
app.post('/api/create-clip', async (req, res) => {
    const { videoUrl, startTime, id } = req.body;
    if (!videoUrl || startTime === undefined || startTime === null)
        return res.status(400).json({ error: 'Missing parameters' });

    const clipId = id || Date.now();
    console.log(`[SERVER] Creating vertical clip for: ${videoUrl} at ${startTime}s`);

    const result = await createVerticalClip(videoUrl, startTime, clipId);

    if (result.success) {
        try {
            const s3DownloadUrl = await uploadToS3AndGetUrl(result.filePath, result.fileName);

            if (fs.existsSync(result.filePath)) fs.unlinkSync(result.filePath);

            res.json({
                success: true,
                downloadUrl: s3DownloadUrl,
                caption: "🔥 Check this out! #newchannel #shortcontent #tiktok",
                capcutTip: "💡 PRO TIP: Import this to CapCut and add 'Trending' music to boost views!"
            });
        } catch (err) {
            console.error('[SERVER] AWS S3 Upload Failed:', err.message);
            res.status(500).json({ error: "Clip generated, but AWS S3 upload failed." });
        }
    } else {
        res.status(500).json({ error: result.error });
    }
});

/**
 * AI Hook Analysis
 */
app.post('/api/analyze-hooks', async (req, res) => {
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ error: 'Missing video URL' });

    console.log(`[SERVER] Analyzing hooks for: ${videoUrl}`);
    const transcript = await fetchVideoTranscript(videoUrl);

    const recommendations = await analyzeTranscriptWithBedrock(transcript);

    res.json({
        success: true,
        recommendations,
        snippet: transcript.substring(0, 300) + "..."
    });
});

const TRACEFIX_FREE_CREDITS = 3;
const TRACEFIX_COOLDOWN_MS = 60 * 1000;
const TRACEFIX_MAX_CODE_CHARS = 1000000;
const tracefixUsers = new Map();

function tracefixGuard(req, res, next) {
    const { code } = req.body || {};
    const authHeader = req.headers.authorization;

    if (!code) {
        return res.status(400).json({ error: 'No code provided' });
    }

    if (code.length > TRACEFIX_MAX_CODE_CHARS) {
        return res.status(413).json({
            error: 'TraceFix input too large. Maximum allowed size is 1MB.'
        });
    }

    if (!authHeader) {
        return res.status(401).json({
            error: 'Please sign in to use TraceFix AI analysis.'
        });
    }

    const userId = authHeader.replace('Bearer ', '').trim();
    const now = Date.now();

    if (!tracefixUsers.has(userId)) {
        tracefixUsers.set(userId, {
            credits: TRACEFIX_FREE_CREDITS,
            lastRequestAt: 0
        });
    }

    const user = tracefixUsers.get(userId);

    if (now - user.lastRequestAt < TRACEFIX_COOLDOWN_MS) {
        return res.status(429).json({
            error: 'Please wait 60 seconds before running another TraceFix analysis.'
        });
    }

    if (user.credits <= 0) {
        return res.status(403).json({
            error: 'You have used your free TraceFix credits. Please upgrade to continue.'
        });
    }

    user.credits -= 1;
    user.lastRequestAt = now;
    tracefixUsers.set(userId, user);

    req.tracefixUser = user;
    next();
}

/**
 * TraceFix AI: Debug Code
 */
app.post('/api/tracefix/debug', tracefixGuard, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code provided' });

    console.log(`[SERVER] TraceFix analyzing snippet (${code.length} chars)`);
    const result = await debugCodeWithBedrock(code);

    res.json({ success: true, ...result });
});

/**
 * Lectura: AI-Enhanced Transcript Notes
 */
app.post('/api/lectura/enhance', async (req, res) => {
    const { transcript, lang } = req.body;
    if (!transcript) return res.status(400).json({ error: 'No transcript provided' });

    console.log(
        `[SERVER] Lectura enhancing transcript (${transcript.length} chars, lang: ${lang || 'en-GB'})`
    );

    try {
        const enhanced = await enhanceTranscriptWithBedrock(transcript, lang);
        res.json({ success: true, enhanced });
    } catch (err) {
        console.error('[LECTURA] Enhancement error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Upload Video API
 */
app.post('/api/upload-video', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    res.json({
        success: true,
        videoUrl: `local://${req.file.path}`,
        title: req.file.originalname,
        thumbnail: 'https://images.unsplash.com/photo-1542204172-356399558651?auto=format&fit=crop&q=80&w=300&h=170',
        id: Date.now()
    });
});

/**
 * Upload Cookies API
 */
app.post('/api/upload-cookies', upload.single('cookies'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No cookies file uploaded' });
        }

        const finalPath = path.join(__dirname, 'media/cookies.txt');

        fs.copyFileSync(req.file.path, finalPath);
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            message: 'Cookie Bridge active! YouTube URLs unlocked.'
        });
    } catch (err) {
        console.error('[SERVER] ❌ Cookie upload error:', err.message);
        res.status(500).json({
            error: `Server failed to save cookies: ${err.message}`
        });
    }
});

/**
 * Stripe Checkout Session Creation
 */
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { productName, amount, successUrl, email } = req.body;
        const protocol = req.protocol;
        const host = req.get('host');

        const finalAmount = Number(amount) || 299;
        const finalProductName =
            productName || 'Xorwia Studio - Agent Access';
        const finalSuccessPath = successUrl || '/success.html';

        const productNameLower = finalProductName.toLowerCase();

        let product = 'capcut';

        if (
            productNameLower.includes('lectura') ||
            finalAmount === 499
        ) {
            product = 'lectura';
        } else if (
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

        const sessionPayload = {
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'gbp',
                    product_data: {
                        name: finalProductName,
                        description: 'Full access via Xorwia Studio.'
                    },
                    unit_amount: expectedAmount
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url:
                `${protocol}://${host}${finalSuccessPath}` +
                `?session_id={CHECKOUT_SESSION_ID}&product=${product}`,
            cancel_url: `${protocol}://${host}/index.html`,
            metadata: {
                product,
                productName: finalProductName,
                accessRule:
                    product === 'lectura'
                        ? '6_months'
                        : '5_videos_or_20_clips'
            }
        };

        if (email && email.includes('@')) {
            sessionPayload.customer_email =
                normalizeEmail(email);
        }

        const session =
            await stripe.checkout.sessions.create(sessionPayload);

        res.json({
            id: session.id,
            url: session.url
        });
    } catch (err) {
        console.error(
            '[STRIPE] ❌ Session creation error:',
            err.message
        );

        res.status(500).json({
            error: err.message
        });
    }
});

/**
 * Validate PayPal payment and save paid access in DynamoDB
 */
app.post('/api/verify-payment', async (req, res) => {
    const {
        transactionId,
        product: rawProduct
    } = req.body;

    const clientId = process.env.PAYPAL_CLIENT_ID;
    const secret = process.env.PAYPAL_SECRET;
    const product = normalizeProduct(rawProduct);

    if (
        !transactionId ||
        !clientId ||
        !secret ||
        !product
    ) {
        return res.status(400).json({
            success: false,
            error: 'Missing transaction, product, or server credentials'
        });
    }

    try {
        console.log(`[PAYPAL] Verifying transaction: ${transactionId}`);

        const auth =
            Buffer.from(`${clientId}:${secret}`).toString('base64');

        const tokenRes = await axios.post(
            'https://api-m.paypal.com/v1/oauth2/token',
            'grant_type=client_credentials',
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const accessToken = tokenRes.data.access_token;

        const orderRes = await axios.get(
            `https://api-m.paypal.com/v2/checkout/orders/${transactionId}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        const order = orderRes.data;

        const status = order.status;
        const paymentAmount =
            order.purchase_units?.[0]?.amount?.value;
        const currency =
            order.purchase_units?.[0]?.amount?.currency_code;

        // Use PayPal's verified payer email, not browser-supplied email.
        const email =
            normalizeEmail(order.payer?.email_address);

        const expectedAmount =
            product === 'lectura' ? '4.99' : '2.99';

        if (!email) {
            return res.status(400).json({
                success: false,
                error: 'PayPal did not return a verified payer email'
            });
        }

        if (
            status !== 'COMPLETED' ||
            paymentAmount !== expectedAmount ||
            currency !== 'GBP'
        ) {
            console.warn('[PAYPAL] Validation failure', {
                transactionId,
                status,
                paymentAmount,
                currency,
                product
            });

            return res.status(401).json({
                success: false,
                error: 'Transaction not completed or amount/product mismatch'
            });
        }

        const now = new Date();
        const nowIso = now.toISOString();
        const processedSet = new Set([transactionId]);

        if (product === 'lectura') {
            const existing =
                await getAccessRecord(email, product);

            let baseDate = now;

            if (existing?.access_until) {
                const currentExpiry =
                    new Date(existing.access_until);

                if (
                    !Number.isNaN(currentExpiry.getTime()) &&
                    currentExpiry > now
                ) {
                    baseDate = currentExpiry;
                }
            }

            const accessUntil = new Date(baseDate);

            accessUntil.setMonth(
                accessUntil.getMonth() +
                LECTURA_ACCESS_MONTHS
            );

            await dynamodb.send(
                new UpdateCommand({
                    TableName: ACCESS_TABLE_NAME,
                    Key: {
                        email,
                        product
                    },
                    UpdateExpression:
                        'SET payment_status = :paid, paypal_transaction_id = :transactionId, purchased_at = :purchasedAt, updated_at = :updatedAt, access_until = :accessUntil ADD processed_paypal_ids :processedSet',
                    ConditionExpression:
                        'attribute_not_exists(processed_paypal_ids) OR NOT contains(processed_paypal_ids, :transactionId)',
                    ExpressionAttributeValues: {
                        ':paid': 'paid',
                        ':transactionId': transactionId,
                        ':purchasedAt': nowIso,
                        ':updatedAt': nowIso,
                        ':accessUntil':
                            accessUntil.toISOString(),
                        ':processedSet': processedSet
                    }
                })
            );
        }

        if (product === 'capcut') {
            await dynamodb.send(
                new UpdateCommand({
                    TableName: ACCESS_TABLE_NAME,
                    Key: {
                        email,
                        product
                    },
                    UpdateExpression:
                        'SET payment_status = :paid, paypal_transaction_id = :transactionId, purchased_at = :purchasedAt, updated_at = :updatedAt ADD credits_remaining :credits, processed_paypal_ids :processedSet',
                    ConditionExpression:
                        'attribute_not_exists(processed_paypal_ids) OR NOT contains(processed_paypal_ids, :transactionId)',
                    ExpressionAttributeValues: {
                        ':paid': 'paid',
                        ':transactionId': transactionId,
                        ':purchasedAt': nowIso,
                        ':updatedAt': nowIso,
                        ':credits': CAPCUT_TOTAL_UNITS,
                        ':processedSet': processedSet
                    }
                })
            );
        }

        console.log('[PAYPAL] Paid access saved', {
            email,
            product,
            transactionId
        });

        return res.json({
            success: true,
            message: 'Payment authenticated and access activated!'
        });

    } catch (err) {
        if (
            err.name ===
            'ConditionalCheckFailedException'
        ) {
            console.log(
                '[PAYPAL] Duplicate payment ignored',
                { transactionId }
            );

            return res.json({
                success: true,
                duplicate: true,
                message: 'Payment already processed'
            });
        }

        console.error(
            '[PAYPAL ERROR]',
            err.response?.data || err.message
        );

        return res.status(500).json({
            success: false,
            error: 'Failed to verify PayPal payment'
        });
    }
});

app.listen(PORT, () => {
    console.log(
        `[SERVER] Xorwia Studio v2.1 running at http://localhost:${PORT}`
    );
});

// AWS Lambda Serverless Export
module.exports.handler = serverless(app);
