const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Snapchat Story Viewer API is running' });
});

app.get('/stories', async (req, res) => {
    const username = (req.query.username || '').trim().replace(/^@/, '').toLowerCase();

    if (!username) {
        return res.status(400).json({ error: 'Username is required.' });
    }

    if (!/^[a-z0-9._-]{1,50}$/i.test(username)) {
        return res.status(400).json({ error: 'Invalid username format.' });
    }

    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        };

        // Try fetching public profile page
        let displayName = username;
        let avatar = null;
        let profileExists = false;

        try {
            const profileRes = await axios.get(
                `https://www.snapchat.com/add/${username}`,
                { headers, timeout: 8000, maxRedirects: 3 }
            );

            const html = profileRes.data;

            // Extract og:title
            const titleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
                            || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
            if (titleMatch) displayName = titleMatch[1].replace(/\s*[\|\-].*$/, '').trim();

            // Extract og:image
            const imgMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
                           || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
            if (imgMatch) avatar = imgMatch[1];

            profileExists = true;
        } catch (e) {
            // profile fetch failed
        }

        // Try story page
        let stories = [];
        try {
            const storyRes = await axios.get(
                `https://story.snapchat.com/s/${username}`,
                { headers, timeout: 8000, maxRedirects: 3 }
            );
            const html = storyRes.data;

            // Look for media URLs in script tags
            const mediaMatches = html.matchAll(/"url"\s*:\s*"(https:\/\/[^"]+\.(mp4|jpg|jpeg|webp)[^"]*)"/gi);
            for (const match of mediaMatches) {
                const url = match[1].replace(/\\u0026/g, '&');
                const type = match[2].toLowerCase() === 'mp4' ? 'video' : 'image';
                if (!stories.find(s => s.url === url)) {
                    stories.push({ type, url, thumbnail: type === 'image' ? url : null, timestamp: null });
                }
            }

            // Also look for snapMedia
            const snapMatches = html.matchAll(/"mediaUrl"\s*:\s*"([^"]+)"/gi);
            for (const match of snapMatches) {
                const url = match[1].replace(/\\u0026/g, '&');
                if (!stories.find(s => s.url === url)) {
                    stories.push({ type: 'image', url, thumbnail: url, timestamp: null });
                }
            }

            if (!profileExists) profileExists = true;
        } catch (e) {
            // story page failed
        }

        if (!profileExists && stories.length === 0) {
            return res.status(404).json({
                error: 'no_stories',
                message: 'No public stories found. The account may be private, have no active stories, or the username may be incorrect.',
                username
            });
        }

        return res.json({
            username,
            displayName,
            avatar,
            stories
        });

    } catch (err) {
        console.error('Error:', err.message);
        return res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
