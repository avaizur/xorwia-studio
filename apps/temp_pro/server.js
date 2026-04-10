const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { fetchChannelVideos, createVerticalClip, fetchVideoTranscript } = require('./agent/clip_maker');

const app = express();
const PORT = 3000;

// Setup Upload Management
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'media')),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));
app.use('/output', express.static(path.join(__dirname, 'output')));

/**
 * Health Check
 */
app.get('/api/status', (req, res) => {
    res.json({ status: 'Online', agent: 'Agentic Content Repurposer v1.0' });
});

/**
 * Fetch Channel Videos
 */
app.post('/api/fetch-channel', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No channel URL provided' });

    console.log(`[SERVER] Fetching channel: ${url}`);
    const videos = await fetchChannelVideos(url);
    res.json(videos);
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
    if (!req.file) return res.status(400).json({ error: 'No cookies file uploaded' });

    // Move to standard location
    const finalPath = path.join(__dirname, 'media/cookies.txt');
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    fs.renameSync(req.file.path, finalPath);

    res.json({ success: true, message: 'Cookie Bridge active! YouTube URLs unlocked.' });
});

app.listen(PORT, () => {
    console.log(`[SERVER] Dashboard running at http://localhost:${PORT}`);
});
