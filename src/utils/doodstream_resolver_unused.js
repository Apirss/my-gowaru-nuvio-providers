function md5Hash(str) {
    // Simple hash for cache keys (not cryptographic, just for dedup)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return "h_" + Math.abs(hash).toString(36);
}

class TTLCache {
    constructor(maxSize = 500, ttlMs = 7200000) {
        this._cache = new Map();
        this._maxSize = maxSize;
        this._ttlMs = ttlMs;
    }

    get(key) {
        const entry = this._cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.ts > this._ttlMs) {
            this._cache.delete(key);
            return null;
        }
        return entry.value;
    }

    set(key, value) {
        if (this._cache.size >= this._maxSize) {
            // Evict oldest
            const firstKey = this._cache.keys().next().value;
            this._cache.delete(firstKey);
        }
        this._cache.set(key, { value, ts: Date.now() });
    }
}

// Caches per service
const caches = {
    voe: new TTLCache(500, 7200000),
    fsvid: new TTLCache(500, 60000),
    vidzy: new TTLCache(500, 7200000),
    vidmoly: new TTLCache(500, 7200000),
    sibnet: new TTLCache(500, 7200000),
    uqload: new TTLCache(500, 7200000),
    doodstream: new TTLCache(500, 3600000),
    lulustream: new TTLCache(500, 3600000),
    veev: new TTLCache(500, 3600000),
    // Vidara's token is IP-bound and short-lived: cache briefly or we hand back
    // a URL that is already dead.
    vidara: new TTLCache(500, 900000),
    seekstreaming: new TTLCache(500, 300000),
};

const DOODSTREAM_MAKEPLAY_PATTERN = /dsplayer\.hotkeys[^']+'(\/[^']+)'/;
const DOODSTREAM_PASS_PATTERN = /\/pass_md5\/[\w-]+\/(?<token>[\w-]+)/;
const DOODSTREAM_TOKEN_PATTERN = /[?&]token=([\w-]+)/;
async function resolveDood(doodUrl) {
    console.log(`[EXT-DOODSTREAM] Extracting from: ${doodUrl}`);

    const cacheKey = md5Hash(doodUrl);
    const cached = caches.doodstream.get(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);

        // DoodStream checks the Referer against the domain it served, so it has
        // to follow the mirror rather than stay pinned to d0000d.com.
        const embedOrigin = new URL(doodUrl).origin;
        const headers = {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            Referer: `${embedOrigin}/`,
        };

        // Step 1: Fetch the embed page
        const resp = await fetch(doodUrl, {
            headers,
            redirect: "follow",
            signal: controller.signal,
        });
        //const resp = await safeFetch(doodUrl);
        if (!resp.ok) {
            clearTimeout(timer);
            console.err(`DoodStream: HTTP ${resp.status}`)
            return { doodUrl };
            //return { success: false, error: `DoodStream: HTTP ${resp.status}` };
        }
        let html = await resp.text();
        let playerUrl = resp.url || doodUrl;

        // A `/d/<id>` link serves a shell page whose iframe holds the real
        // player — without that hop there is no pass_md5 to find.
        if (
            !DOODSTREAM_MAKEPLAY_PATTERN.test(html) &&
            !DOODSTREAM_PASS_PATTERN.test(html)
        ) {
            const iframe = html.match(/<iframe[^>]*\ssrc="([^"]+)"/i);
            const nextUrl = iframe
                ? new URL(iframe[1], playerUrl).href
                : playerUrl.includes("/d/")
                    ? playerUrl.replace("/d/", "/e/")
                    : null;
            if (nextUrl && nextUrl !== playerUrl) {
                try {
                    const nextResp = await fetch(nextUrl, {
                        headers: { ...headers, Referer: playerUrl },
                        redirect: "follow",
                        signal: controller.signal,
                    });
                    if (nextResp.ok) {
                        html = await nextResp.text();
                        playerUrl = nextResp.url || nextUrl;
                    }
                } catch {
                    /* keep the shell page and let the patterns below decide */
                }
            }
        }

        // Step 2: Extract pass_md5 URL and token. The recent player publishes the
        // token inside makePlay(), separately from the pass_md5 path; the older
        // one reuses the path's last segment.
        const passMatch = html.match(DOODSTREAM_PASS_PATTERN);
        const makePlay = html.match(DOODSTREAM_MAKEPLAY_PATTERN);
        const passMd5Url = passMatch
            ? passMatch[0]
            : makePlay
                ? makePlay[1]
                : null;
        if (!passMd5Url) {
            clearTimeout(timer);
            console.err(`DoodStream: File was deleted`)
            return { doodUrl };
            //return {
            //    success: false,
            //    error: "DoodStream: File was deleted",
            //    reason: "deleted",
            //};
        }

        const parsedUrl = new URL(playerUrl);
        const domain = `${parsedUrl.protocol}//${parsedUrl.host}`;
        const tokenMatch = html.match(DOODSTREAM_TOKEN_PATTERN);
        const token = tokenMatch
            ? tokenMatch[1]
            : passMd5Url.replace(/\/+$/, "").split("/").pop();

        // Step 3: Call pass_md5 endpoint
        const passHeaders = {
            Referer: playerUrl,
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        };

        const passUrl = passMd5Url.startsWith("http")
            ? passMd5Url
            : `${domain}${passMd5Url}`;
        const passResp = await fetch(passUrl, {
            headers: passHeaders,
            signal: controller.signal,
        });
        const baseUrl = (await passResp.text()).trim();
        clearTimeout(timer);

        if (!baseUrl.startsWith("http")) {
            console.err(`DoodStream: unexpected pass_md5 payload`)
            return { doodUrl };
            //return {
            //    success: false,
            //    error: "DoodStream: unexpected pass_md5 payload",
            //};
        }

        // Step 4: Build final video URL. Files served from Cloudflare R2 come
        // back already signed — appending a suffix and token would break them.
        let videoUrl;
        if (baseUrl.includes("cloudflarestorage.")) {
            videoUrl = baseUrl;
        } else {
            const chars =
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            let randomStr = "";
            for (let i = 0; i < 10; i++) {
                randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            videoUrl = `${baseUrl}${randomStr}?token=${token}&expiry=${Date.now()}`;
        }

        //const result = { m3u8Url: videoUrl, success: true, source: "doodstream" };
        const result = {
            //url: videoUrl,
            //headers: { "Referer": playerUrl }
            url: 'https://neocine.embedseek.com/v4/pl/spz.platformdocumentationhub.site/ipt/iflfk/master.1787674609.m3u8?k=znbs3lChX-Q5J4XTs56X4w&kx=1792280573',
            headers: { "Referer": "https://neocine.embedseek.com/" }
        };
        caches.doodstream.set(cacheKey, result);
        console.log(`RESULT FROM DOOD : ${JSON.stringify(result)}`)
        return result;
    } catch (e) {
        console.error("[EXT-DOODSTREAM] Error:", e);
        return { doodUrl };
        //return {
        //    success: false,
        //    error: e.message || "DoodStream extraction failed",
        //};
    }
}

