const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { fetchChannelVideos, createVerticalClip, fetchVideoTranscript } = require('./agent/clip_maker');

const app = express();
const PORT = 3000;

// Setup Upload Management
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'media')),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Ensure media directory exists
const mediaDir = path.join(__dirname, 'media');
if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
    console.log('[SERVER] 📁 Created media directory');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../web')));
app.use('/output', express.static(path.join(__dirname, 'output')));

/**
 * Health Check
 */
app.get('/api/status', (req, res) => {
    res.json({ status: 'Online', agent: 'Agentic Content Repurposer v1.4 (Memory Edition)' });
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
    if (!videoUrl || !startTime) return res.status(400).json({ error: 'Missing parameters' });

    const clipId = id || Date.now();
    console.log(`[SERVER] Creating vertical clip for: ${videoUrl} at ${startTime}s`);

    const result = await createVerticalClip(videoUrl, startTime, clipId);

    if (result.success) {
        res.json({
            success: true,
            downloadUrl: `http://localhost:${PORT}/output/${result.fileName}`,
            caption: "🔥 Check this out! #newchannel #shortcontent #tiktok",
            capcutTip: "💡 PRO TIP: Import this to CapCut and add 'Trending' music to boost views!"
        });
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

    // Simulate AI Hook analysis (In a real set, this sends to an LLM)
    // For now, I've curated a "Smart Selection" logic:
    const recommendations = [
        { time: 10, reason: "🔥 Exciting Intro/Hook", tag: "Viral Start" },
        { time: 45, reason: "💡 Key Learning/Explainer", tag: "Insightful" },
        { time: 90, reason: "👀 High Interest Moment", tag: "Must-See" },
        { time: 240, reason: "🙌 Dramatic Conclusion", tag: "Final Thought" }
    ];

    res.json({ success: true, recommendations, snippet: transcript.substring(0, 300) + "..." });
});

/**
 * Upload Video API
 */
app.post('/api/upload-video', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    res.json({
        success: true,
        videoUrl: `local://${req.file.path}`, // Special local marker
        title: req.file.originalname,
        thumbnail: 'https://images.unsplash.com/photo-1542204172-356399558651?auto=format&fit=crop&q=80&w=300&h=170', // Placeholder for local
        id: Date.now()
    });
});

/**
 * Upload Cookies API
 */
app.post('/api/upload-cookies', upload.single('cookies'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No cookies file uploaded' });

        // Move to standard location
        const finalPath = path.join(__dirname, 'media/cookies.txt');
        
        // Use copy + unlink instead of rename because rename 
        // doesn't work across different disk partitions (common on EC2)
        fs.copyFileSync(req.file.path, finalPath);
        fs.unlinkSync(req.file.path);

        res.json({ success: true, message: 'Cookie Bridge active! YouTube URLs unlocked.' });
    } catch (err) {
        console.error('[SERVER] ❌ Cookie upload error:', err.message);
        res.status(500).json({ error: `Server failed to save cookies: ${err.message}` });
    }
});

/**
 * Stripe Checkout Session Creation
 */
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Xorwia Studio - Agent Access',
                        description: 'Access to the professional content repurposing engine.',
                    },
                    unit_amount: 299, // $2.99
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `https://xorwia.com/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `https://xorwia.com/index.html`,
        });
        res.json({ id: session.id });
    } catch (err) {
        console.error('[STRIPE] ❌ Session creation error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Handle Payment Verification (Mock for PayPal/Stripe)
 */
app.post('/api/verify-payment', (req, res) => {
    const { transactionId, sessionId } = req.body;
    console.log(`[PAYMENT] Verifying payment: ${transactionId || sessionId}`);
    // In production, we would verify with Stripe/PayPal API
    res.json({ success: true, message: 'Payment verified!' });
});

const serverless = require('serverless-http');

const handler = serverless(app);

module.exports.handler = async (event, context) => {
    // Standard Lambda handler
    const result = await handler(event, context);
    return result;
};

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`[SERVER] Dashboard running at http://localhost:${PORT}`);
    });
}
