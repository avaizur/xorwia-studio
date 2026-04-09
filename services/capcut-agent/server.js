const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const serverless = require('serverless-http');
const axios = require('axios');
const { fetchChannelVideos, createVerticalClip, fetchVideoTranscript } = require('./agent/clip_maker');
const { uploadToS3AndGetUrl, analyzeTranscriptWithBedrock, debugCodeWithBedrock } = require('./agent/aws_services');

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
app.use(express.static(path.join(__dirname, 'web')));
app.use('/output', express.static(path.join(__dirname, 'output')));

/**
 * Health Check
 */
app.get('/api/status', (req, res) => {
    res.json({ status: 'Online', agent: 'Agentic Content Repurposer v1.6 (Ultimate IP Edition)' });
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
        try {
            // Upload the clip to S3 and generate a Temporary Presigned URL 
            // (Extremely cheap and perfect for Serverless storage)
            const s3DownloadUrl = await uploadToS3AndGetUrl(result.filePath, result.fileName);
            
            // Clean up the local memory/disk space (Required for Lambda)
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

    // Call Amazon Bedrock for True AI Analytics Instead of Hardcoded Recommendations
    const recommendations = await analyzeTranscriptWithBedrock(transcript);

    res.json({ success: true, recommendations, snippet: transcript.substring(0, 300) + "..." });
});

/**
 * TraceFix AI: Debug Code
 */
app.post('/api/tracefix/debug', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code provided' });

    console.log(`[SERVER] TraceFix analyzing snippet (${code.length} chars)`);
    const result = await debugCodeWithBedrock(code);
    
    res.json({ success: true, ...result });
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
 * Validate PayPal Transactions securely via PayPal Orders API
 */
app.post('/api/verify-payment', async (req, res) => {
    const { transactionId } = req.body;
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const secret = process.env.PAYPAL_SECRET;

    if (!transactionId || !clientId || !secret) {
        return res.status(400).json({ success: false, error: 'Missing Transaction ID or Server Credentials' });
    }

    try {
        console.log(`[PAYPAL] Verifying transaction: ${transactionId}`);

        // 1. Get Access Token from PayPal
        const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
        const tokenRes = await axios.post('https://api-m.paypal.com/v1/oauth2/token', 'grant_type=client_credentials', {
            headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = tokenRes.data.access_token;

        // 2. Verify Order Details
        const orderRes = await axios.get(`https://api-m.paypal.com/v2/checkout/orders/${transactionId}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        const status = orderRes.data.status;
        const amount = orderRes.data.purchase_units[0].amount.value;

        if (status === 'COMPLETED' && parseFloat(amount) >= 2.99) {
            console.log(`[PAYPAL] ✅ Payment Validated for ID: ${transactionId}`);
            return res.json({ success: true, message: 'Payment authenticated!' });
        } else {
            console.warn(`[PAYPAL] ❌ Validation Failure: Status ${status}, Amount ${amount}`);
            return res.status(401).json({ success: false, error: 'Transaction not completed or invalid amount' });
        }
    } catch (err) {
        console.error('[PAYPAL ERROR]', err.response?.data || err.message);
        res.status(500).json({ success: false, error: 'Failed to communicate with PayPal' });
    }
});

app.listen(PORT, () => {
    console.log(`[SERVER] Dashboard running at http://localhost:${PORT}`);
});

// AWS Lambda Serverless Export
module.exports.handler = serverless(app);
