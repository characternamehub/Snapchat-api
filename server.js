const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();

// Allow ALL origins explicitly
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 200
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());

function fetchUrl(url, redirectCount) {
    redirectCount = redirectCount || 0;
    if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));

    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
            timeout: 12000,
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const location = res.headers.location;
                const nextUrl = location.startsWith('http') ? location : `https://www.snapchat.com${location}`;
                return fetchUrl(nextUrl, redirectCount + 1).then(resolve).catch(reject);
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    });
}

function extractMeta(html, property) {
    const patterns = [
        new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${property}["']`, 'i'),
        new RegExp(`<meta[^>]*name=["']${property}["'][^>]*content=["']([^"']+)["']`, 'i'),
    ];
    for (const p of patterns) {
        const m = html.match(p);
        if (m) return decodeURIComponent(m[1].replace(/&amp;/g, '&').replace(/&#x27;/g, "'"));
    }
    return null;
}

function extractStories(html) {
    const stories = [];
    const seen = new Set();

    const addStory = (url, type) => {
        const clean = url.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\"/g, '');
        if (!seen.has(clean) && clean.startsWith('http')) {
            seen.add(clean);
            const isVideo = clean.includes('.mp4') || type === 'video';
            stories.push({ type: isVideo ? 'video' : 'image', url: clean, thumbnail: isVideo ? null : clean, timestamp: null });
        }
    };

    // Pattern 1: "url":"https://..."
    for (const m of html.matchAll(/"url"\s*:\s*"(https:[^"]+)"/g)) addStory(m[1], 'image');

    // Pattern 2: "mediaUrl":"https://..."
    for (const m of html.matchAll(/"mediaUrl"\s*:\s*"(https:[^"]+)"/g)) addStory(m[1], 'image');

    // Pattern 3: "snapUrl":"https://..."
    for (const m of html.matchAll(/"snapUrl"\s*:\s*"(https:[^"]+)"/g)) addStory(m[1], 'image');

    // Pattern 4: direct mp4/jpg URLs
    for (const m of html.matchAll(/"(https:\/\/[^"]*(?:sc-cdn|cf-st\.sc|snapchat)[^"]*(?:\.mp4|\.jpg|\.jpeg|\.webp)[^"]*)"/g)) {
        addStory(m[1], m[1].includes('.mp4') ? 'video' : 'image');
    }

    return stories;
}

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Snapchat Story Viewer API' });
});

app.get('/stories', async (req, res) => {
    const username = (req.query.username || '').trim().replace(/^@/, '').toLowerCase();

    if (!username) return res.status(400).json({ error: 'Username is required.' });
    if (!/^[a-z0-9._-]{1,50}$/i.test(username)) return res.status(400).json({ error: 'Invalid username.' });

    try {
        let displayName = username;
        let avatar = null;
        let stories = [];
        let profileFound = false;

        // ── 1. Profile page ───────────────────────────────────────────
        try {
            const r = await fetchUrl(`https://www.snapchat.com/add/${username}`);
            if (r.status === 200 && r.body.length > 500) {
                profileFound = true;
                const title = extractMeta(r.body, 'og:title');
                if (title) displayName = title.replace(/\s*[\|\-–].*$/, '').trim();
                avatar = extractMeta(r.body, 'og:image');
            }
        } catch(e) { console.log('Profile fetch error:', e.message); }

        // ── 2. Story page ─────────────────────────────────────────────
        try {
            const r = await fetchUrl(`https://story.snapchat.com/s/${username}`);
            if (r.status === 200 && r.body.length > 500) {
                profileFound = true;
                if (!avatar) avatar = extractMeta(r.body, 'og:image');
                if (displayName === username) {
                    const title = extractMeta(r.body, 'og:title');
                    if (title) displayName = title.replace(/\s*[\|\-–].*$/, '').trim();
                }
                stories = extractStories(r.body);
            }
        } catch(e) { console.log('Story fetch error:', e.message); }

        // ── 3. Map page fallback ──────────────────────────────────────
        if (!profileFound) {
            try {
                const r = await fetchUrl(`https://map.snapchat.com/@${username}`);
                if (r.status === 200) profileFound = true;
            } catch(e) {}
        }

        if (!profileFound) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Account not found or is private. Make sure the username is correct and the account is public.',
                username
            });
        }

        return res.json({ username, displayName, avatar, stories });

    } catch(err) {
        console.error('Unexpected error:', err.message);
        return res.status(500).json({ error: 'server_error', message: 'Server error. Please try again.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
module.exports = app;
