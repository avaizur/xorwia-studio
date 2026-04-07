const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * The Content Agent: Clip Maker
 * ----------------------------
 * This module handles the heavy lifting of downloading, 
 * cropping, and clipping YouTube videos.
 */

// Auto-detect FFmpeg path based on OS (Windows .exe vs Linux command)
const FFMPEG_PATH = process.platform === 'win32' 
    ? path.join(__dirname, '../../node_modules/ffmpeg-static/ffmpeg.exe') 
    : 'ffmpeg';
const YT_DLP_PATH = 'yt-dlp'; // Using direct binary for EC2 reliability

const OUTPUT_DIR = path.join(__dirname, '../output');
const TEMP_DIR = path.join(__dirname, '../media/temp');
const COOKIE_FILE = path.join(__dirname, '../media/cookies.txt');

// Helper to get cookies flag
const getCookiesFlag = () => {
    // Force absolute path for EC2 reliability
    const cookiePath = '/home/ubuntu/capcut-agent/media/cookies.txt';
    if (fs.existsSync(cookiePath)) {
        console.log(`[AGENT] ✅ Forced Cookie Bridge: ${cookiePath}`);
        return `--cookies "${cookiePath}"`;
    }
    console.log(`[AGENT] ⚠️ No Cookie Bridge found! AWS IP will likely be blocked.`);
    return '';
};

// Ensure directories exist
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * Fetches video metadata for a YouTube channel.
 */
async function fetchChannelVideos(channelUrl) {
    console.log(`[AGENT] Fetching videos for: ${channelUrl}`);
    try {
        const cookiePath = '/home/ubuntu/capcut-agent/media/cookies.txt';
        const cmd = `${YT_DLP_PATH} --cookies "${cookiePath}" --extractor-args "youtubetab:skip=authcheck" --print "%(title)s ### %(id)s ### %(thumbnail)s" --flat-playlist --max-downloads 10 "${channelUrl}"`;
    
        const stdout = execSync(cmd).toString();
        const lines = stdout.trim().split('\n');
        const videos = [];
        
        for (let line of lines) {
            const parts = line.split(' ### ');
            if (parts.length >= 3) {
                videos.push({
                    title: parts[0],
                    id: parts[1],
                    thumbnail: parts[2],
                    url: `https://www.youtube.com/watch?v=${parts[1]}`
                });
            }
        }
        return videos;
    } catch (err) {
        console.error('[AGENT] ❌ Fetch Error:', err.message);
        let errorMsg = err.message;
        
        // If we see "Sign in to confirm you are not a bot", the cookies are bad
        if (err.message.toLowerCase().includes('bot') || err.message.includes('403')) {
            console.error('[AGENT] 🤖 YouTube flagged us as a bot! Upload fresh cookies.txt.');
            errorMsg = "YouTube blocked this Cloud IP. Please Refresh/Upload your cookies.txt!";
        }
        return { error: errorMsg };
    }
}

/**
 * Creates a 5-second vertical clip.
 */
async function createVerticalClip(videoUrl, startTime, clipId) {
    const isLocal = videoUrl.startsWith('local://');
    const localPath = isLocal ? videoUrl.replace('local://', '') : null;
    const rawFile = isLocal ? localPath : path.join(TEMP_DIR, `raw_${clipId}.mp4`);
    const finalFile = path.join(OUTPUT_DIR, `clip_${clipId}_916.mp4`);

    console.log(`[AGENT] Creating clip at ${startTime}s for ${isLocal ? 'Local File' : videoUrl}`);

    try {
        // 1. Download segment UNLESS it is already local
        if (!isLocal) {
            const formatStr = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
            const downloadCmd = `${YT_DLP_PATH} ${getCookiesFlag()} -f "${formatStr}" --external-downloader "${FFMPEG_PATH}" --external-downloader-args "ffmpeg_i:-ss ${startTime} -t 5" -o "${rawFile}" "${videoUrl}"`;
            execSync(downloadCmd);
        }

        // 2. Crop to Vertical (9:16)
        // For local files, we use -ss and -t in ffmpeg directly
        const timeSelection = isLocal ? `-ss ${startTime} -t 5` : '';
        const cropCmd = `"${FFMPEG_PATH}" ${timeSelection} -i "${rawFile}" -vf "crop=ih*(9/16):ih" -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${finalFile}" -y`;
        execSync(cropCmd);

        // Clean up raw file
        if (fs.existsSync(rawFile)) fs.unlinkSync(rawFile);

        return {
            success: true,
            filePath: finalFile,
            fileName: `clip_${clipId}_916.mp4`
        };
    } catch (e) {
        console.error('[AGENT] Clipping Error:', e.message);
        return { success: false, error: e.message };
    }
}

/**
 * Fetches the transcript/subtitles for a YouTube video.
 */
async function fetchVideoTranscript(videoUrl) {
    console.log(`[AGENT] Fetching transcript for: ${videoUrl}`);
    try {
        const cmd = `${YT_DLP_PATH} ${getCookiesFlag()} --write-auto-subs --skip-download --sub-format "vtt" --sub-langs "en" -o "${TEMP_DIR}/sub_%(id)s" "${videoUrl}"`;
        execSync(cmd);
        
        // Find the generated .vtt file
        const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith('sub_') && f.endsWith('.en.vtt'));
        if (files.length > 0) {
            const transcript = fs.readFileSync(path.join(TEMP_DIR, files[0]), 'utf8');
            // Basic cleanup (remove VTT metadata tags)
            return transcript.replace(/<[^>]*>/g, '').substring(0, 15000); // Send first 15k chars for analysis
        }
        return "No transcript available.";
    } catch (e) {
        console.error('[AGENT] Transcript error:', e.message);
        return "No transcript available.";
    }
}

module.exports = { fetchChannelVideos, createVerticalClip, fetchVideoTranscript };
