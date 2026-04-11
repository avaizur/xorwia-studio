/* --- GLOBAL STATE --- */
let currentVideos = [];
let currentVideo = null;

// DOM Elements
const channelUrlInput = document.getElementById('channel-url');
const fetchBtn = document.getElementById('fetch-btn');
const uploadBtn = document.getElementById('upload-btn');
const fileInput = document.getElementById('file-input');
const videoGrid = document.getElementById('video-grid');
const modal = document.getElementById('clip-modal');
const closeBtn = document.querySelector('.close-btn');

const generateClipBtn = document.getElementById('generate-clip-btn');
const genStatus = document.getElementById('generation-status');
const downloadArea = document.getElementById('download-area');

const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.querySelector('.close-settings-btn');
const cookiesInput = document.getElementById('cookies-input');
const uploadCookiesBtn = document.getElementById('upload-cookies-btn');

const guideModal = document.getElementById('guide-modal');
const closeGuideBtn = document.querySelector('.close-guide-btn');
const navGuide = document.getElementById('nav-guide');

/* --- INITIALIZATION --- */
window.addEventListener('load', () => {
    const savedChannel = localStorage.getItem('lastXorwiaChannel');
    if (savedChannel) {
        channelUrlInput.value = savedChannel;
    }
});

fetchBtn.addEventListener('click', () => {
    const url = channelUrlInput.value;
    if (url) {
        localStorage.setItem('lastXorwiaChannel', url);
        fetchChannel(url);
    }
});

navGuide.addEventListener('click', () => guideModal.style.display = 'block');
closeGuideBtn.addEventListener('click', () => guideModal.style.display = 'none');

settingsBtn.addEventListener('click', () => settingsModal.style.display = 'block');
closeSettingsBtn.addEventListener('click', () => settingsModal.style.display = 'none');

uploadCookiesBtn.addEventListener('click', () => cookiesInput.click());

cookiesInput.addEventListener('change', async (e) => {
    if (e.target.files.length > 0) {
        await uploadCookies(e.target.files[0]);
    }
});

uploadBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
    if (e.target.files.length > 0) {
        await uploadVideo(e.target.files[0]);
    }
});

closeBtn.addEventListener('click', () => {
    modal.style.display = 'none';
});

window.onclick = (e) => {
    if (e.target == modal) {
        modal.style.display = 'none';
    }
};

/* --- CORE FUNCTIONS --- */

/**
 * Scan the channel for videos
 */
async function fetchChannel(url) {
    videoGrid.innerHTML = '<div class="loading-state">Scanning channel... this may take a moment.</div>';
    
    try {
        const response = await fetch('/api/fetch-channel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const result = await response.json();
        
        if (result.error) {
            videoGrid.innerHTML = `<div class="error-state">❌ ${result.error}</div>`;
            return;
        }
        
        currentVideos = result;
        renderVideos(currentVideos);
    } catch (err) {
        videoGrid.innerHTML = '<div class="error-state">Oops! Failed to connect to server. Make sure it is running on your EC2.</div>';
    }
}

/**
 * Display videos in the grid
 */
function renderVideos(videos) {
    if (videos.length === 0) {
        videoGrid.innerHTML = '<div class="error-state">No videos found. Check the URL and try again.</div>';
        return;
    }

    videoGrid.innerHTML = '';
    videos.forEach((video, index) => {
        const card = document.createElement('div');
        card.className = 'video-card glass-panel';
        card.innerHTML = `
            <div class="thumb-container">
                <img src="${video.thumbnail}" alt="Thumbnail" referrerpolicy="no-referrer">
            </div>
            <div class="card-info">
                <h3>${video.title}</h3>
                <p>Ready for clipping</p>
            </div>
        `;
        card.onclick = () => openClippingModal(video);
        videoGrid.appendChild(card);
    });
}

/**
 * Open the Clipping Modal
 */
function openClippingModal(video) {
    currentVideo = video;
    modal.style.display = 'block';
    document.getElementById('modal-title').innerText = `Repurposing: ${video.title}`;
    document.getElementById('modal-thumb').src = video.thumbnail;
    document.getElementById('modal-thumb').referrerPolicy = "no-referrer";
    
    // Reset modal state
    genStatus.classList.add('hidden');
    downloadArea.classList.add('hidden');
    generateClipBtn.classList.remove('hidden');
    document.getElementById('ai-recommendations').classList.add('hidden');
    
    // Fetch AI Recommendations
    fetchAIHooks(video.url);
}

/**
 * Fetch AI Recommendations for a video
 */
async function fetchAIHooks(videoUrl) {
    const list = document.getElementById('recommendation-list');
    const container = document.getElementById('ai-recommendations');
    list.innerHTML = '<p>Agent is scanning for hooks...</p>';
    container.classList.remove('hidden');

    try {
        const response = await fetch('/api/analyze-hooks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoUrl })
        });
        const result = await response.json();
        
        if (result.success && result.recommendations.length > 0) {
            list.innerHTML = '';
            result.recommendations.forEach(rec => {
                const item = document.createElement('div');
                item.className = 'rec-item';
                item.innerHTML = `
                    <span class="rec-time">${rec.time}s</span>
                    <span class="rec-reason">${rec.reason}</span>
                    <span class="rec-badge">${rec.tag}</span>
                `;
                item.onclick = () => {
                    document.getElementById('start-time').value = rec.time;
                };
                list.appendChild(item);
            });
        }
    } catch (err) {
        list.innerHTML = '<p>AI Scan was unavailable, but you can still choose manual timestamps.</p>';
    }
}

/**
 * Upload a video file to the server
 */
async function uploadVideo(file) {
    videoGrid.innerHTML = '<div class="loading-state">Uploading video to Xorwia Cloud...</div>';
    
    const formData = new FormData();
    formData.append('video', file);

    try {
        const response = await fetch('/api/upload-video', {
            method: 'POST',
            body: formData
        });
        const video = await response.json();
        
        if (video.success) {
            renderVideos([video]); // Show the uploaded video in the grid
        }
    } catch (err) {
        alert('Upload failed. Check server connection.');
    }
}

/**
 * Upload Cookies file to the server
 */
async function uploadCookies(file) {
    const status = document.getElementById('cookie-status');
    status.innerText = 'Uploading Cookie Bridge...';
    
    const formData = new FormData();
    formData.append('cookies', file);

    try {
        const response = await fetch('/api/upload-cookies', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        
        if (result.success) {
            status.innerText = '✅ ' + result.message;
            status.classList.add('status-good');
        } else {
            status.innerText = `❌ ${result.error || 'Failed to activate bridge.'}`;
        }
    } catch (err) {
        status.innerText = '❌ Failed to connect to server.';
    }
}

/**
 * Generate the 5-second vertical clip
 */
generateClipBtn.addEventListener('click', async () => {
    const startTime = document.getElementById('start-time').value;
    
    genStatus.classList.remove('hidden');
    generateClipBtn.classList.add('hidden');
    
    try {
        const response = await fetch('/api/create-clip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                videoUrl: currentVideo.url,
                startTime: startTime,
                id: Date.now()
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            genStatus.classList.add('hidden');
            downloadArea.classList.remove('hidden');
            document.getElementById('download-link').href = result.downloadUrl;
            document.getElementById('generated-caption').innerText = result.caption;
        } else {
            alert('Error generating clip: ' + result.error);
            generateClipBtn.classList.remove('hidden');
        }
    } catch (err) {
        alert('Server connection error.');
        generateClipBtn.classList.remove('hidden');
    }
});
