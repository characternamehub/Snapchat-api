const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'], optionsSuccessStatus: 200 }));
app.options('*', cors());
app.use(express.json());

// Simple in-memory cache — avoids refetching the same user within 2 minutes
const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000;

function fetchUrl(url, redirectCount) {
    redirectCount = redirectCount || 0;
    if (redirectCount > 4) return Promise.reject(new Error('Too many redirects'));
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
                'Cache-Control': 'no-cache',
            },
            timeout: 8000,
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const loc = res.headers.location;
                return fetchUrl(loc.startsWith('http') ? loc : `https://www.snapchat.com${loc}`, redirectCount + 1).then(resolve).catch(reject);
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function getMeta(html, prop) {
    const patterns = [
        new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${prop}["']`, 'i'),
        new RegExp(`<meta[^>]*name=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'),
    ];
    for (const p of patterns) { const m = html.match(p); if (m) return m[1].replace(/&amp;/g,'&').trim(); }
    return null;
}

// Extract stories with timestamps — filter to last 24 hours only
function extractStories(html, type) {
    const seen = new Set();
    const stories = [];
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    const add = (url, mediaType, timestamp) => {
        const clean = url.replace(/\\u0026/g,'&').replace(/\\\//g,'/').replace(/\\"/g,'').split('"')[0];
        if (!clean.startsWith('http') || seen.has(clean)) return;
        // Filter: only include if timestamp is within last 24h, or no timestamp
        if (timestamp) {
            const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
            if (now - ts > TWENTY_FOUR_HOURS) return;
        }
        seen.add(clean);
        const isVideo = clean.includes('.mp4') || mediaType === 'video';
        stories.push({ type: isVideo ? 'video' : 'image', url: clean, thumbnail: isVideo ? null : clean, timestamp: timestamp || null, storyType: type || 'story' });
    };

    // Try to parse embedded JSON for timestamps
    try {
        const jsonMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*({.+?});<\/script>/s)
                       || html.match(/<script type="application\/json">({.+?})<\/script>/s);
        if (jsonMatch) {
            const walk = (obj, depth) => {
                if (!obj || typeof obj !== 'object' || depth > 15) return;
                if (obj.url && obj.captureTimeSecs) add(obj.url, obj.snapMediaType === 1 ? 'video' : 'image', obj.captureTimeSecs);
                if (obj.mediaUrl && obj.captureTimeSecs) add(obj.mediaUrl, 'image', obj.captureTimeSecs);
                for (const k of Object.keys(obj)) {
                    if (Array.isArray(obj[k])) obj[k].forEach(i => walk(i, depth+1));
                    else if (typeof obj[k] === 'object') walk(obj[k], depth+1);
                }
            };
            walk(JSON.parse(jsonMatch[1]), 0);
        }
    } catch(e) {}

    // Fallback regex patterns if JSON parse didn't get everything
    if (stories.length === 0) {
        for (const m of html.matchAll(/"url"\s*:\s*"(https:[^"]+)"/g)) add(m[1], 'image', null);
        for (const m of html.matchAll(/"mediaUrl"\s*:\s*"(https:[^"]+)"/g)) add(m[1], 'image', null);
        for (const m of html.matchAll(/"snapUrl"\s*:\s*"(https:[^"]+)"/g)) add(m[1], 'image', null);
        for (const m of html.matchAll(/"(https:\/\/[^"]*(?:sc-cdn|cf-st\.sc)[^"]*(?:\.mp4|\.jpg|\.jpeg|\.webp)[^"]*)"/g)) {
            add(m[1], m[1].includes('.mp4') ? 'video' : 'image', null);
        }
    }

    return stories;
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Snapchat Story Viewer API' }));

app.get('/stories', async (req, res) => {
    const username = (req.query.username || '').trim().replace(/^@/, '').toLowerCase();
    if (!username) return res.status(400).json({ error: 'Username is required.' });
    if (!/^[a-z0-9._-]{1,50}$/i.test(username)) return res.status(400).json({ error: 'Invalid username.' });

    // Serve from cache if fresh
    const cacheKey = `story:${username}`;
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.ts < CACHE_TTL) return res.json(cached.data);
    }

    try {
        let displayName = username;
        let avatar = null;
        let stories = [];
        let spotlight = [];
        let profileFound = false;

        // Run profile + story fetch in PARALLEL for speed
        const [profileResult, storyResult, spotlightResult] = await Promise.allSettled([
            fetchUrl(`https://www.snapchat.com/add/${username}`),
            fetchUrl(`https://story.snapchat.com/s/${username}`),
            fetchUrl(`https://story.snapchat.com/spotlight/${username}`),
        ]);

        // Profile
        if (profileResult.status === 'fulfilled' && profileResult.value.status === 200) {
            profileFound = true;
            const html = profileResult.value.body;
            const title = getMeta(html, 'og:title');
            if (title) displayName = title.replace(/\s*[\|\-–].*$/, '').trim();
            avatar = getMeta(html, 'og:image');
        }

        // Stories
        if (storyResult.status === 'fulfilled' && storyResult.value.status === 200) {
            profileFound = true;
            const html = storyResult.value.body;
            if (!avatar) avatar = getMeta(html, 'og:image');
            if (displayName === username) {
                const title = getMeta(html, 'og:title');
                if (title) displayName = title.replace(/\s*[\|\-–].*$/, '').trim();
            }
            stories = extractStories(html, 'story');
        }

        // Spotlight
        if (spotlightResult.status === 'fulfilled' && spotlightResult.value.status === 200) {
            profileFound = true;
            spotlight = extractStories(spotlightResult.value.body, 'spotlight');
        }

        if (!profileFound) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Account not found or is private. Make sure the username is correct and the account is public.',
                username
            });
        }

        const data = { username, displayName, avatar, stories, spotlight };

        // Cache the result
        cache.set(cacheKey, { ts: Date.now(), data });

        return res.json(data);

    } catch(err) {
        console.error('Error:', err.message);
        return res.status(500).json({ error: 'server_error', message: 'Server error. Please try again.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app;
