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
    // voe: new TTLCache(500, 7200000),
    // fsvid: new TTLCache(500, 60000),
    // vidzy: new TTLCache(500, 7200000),
    // vidmoly: new TTLCache(500, 7200000),
    // sibnet: new TTLCache(500, 7200000),
    // uqload: new TTLCache(500, 7200000),
    // doodstream: new TTLCache(500, 3600000),
    // lulustream: new TTLCache(500, 3600000),
    // veev: new TTLCache(500, 3600000),
    // // Vidara's token is IP-bound and short-lived: cache briefly or we hand back
    // // a URL that is already dead.
    // vidara: new TTLCache(500, 900000),
    seekstreaming: new TTLCache(500, 300000),
};

/**
 * Extract HLS URL from a SeekStreaming root-fragment embed
 */
const SEEKSTREAMING_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

function safelyDecodeSeekStreamingUrl(value) {
    let decoded = String(value || '').trim();
    for (let index = 0; index < 2; index += 1) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
        } catch {
            return null;
        }
    }
    return decoded;
}

function parseSeekStreamingEmbedUrl(input) {
    const decoded = safelyDecodeSeekStreamingUrl(input);
    if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)) { return null; }
    try {
        const url = new URL(decoded);
        if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search !== '?'
        ) return null;
        const videoId = url.hash.slice(1);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(videoId)) { return null; };
        const origin = url.origin;
        return {
            embedUrl: `${origin} / #${videoId}`,
            hostname: url.hostname.toLowerCase(),
            videoId,
            origin,
            referer: `${origin} / `,
            cacheKey: `${url.hostname.toLowerCase()}: ${videoId}`,
        };
    } catch (e) {
        console.log(`Error in parsing: ${e.message}`);
        return null;
    }
}

function selectSeekStreamingPlaybackSource(data) {
    if (!data || typeof data !== 'object') return null;
    for (const kind of ['source', 'master', 'masterUrl']) {
        const rawUrl = data[kind];
        if (typeof rawUrl !== 'string') continue;
        try {
            const url = new URL(rawUrl);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
            return { kind, url: url.href };
        } catch {
            continue;
        }
    }
    return null;
}

function selectSeekStreamingPlaybackSources(data) {
    if (!data || typeof data !== 'object') return [];
    const candidates = [];
    const seen = new Set();
    const add = (kind, rawUrl) => {
        if (typeof rawUrl !== 'string') return;
        try {
            const url = new URL(rawUrl);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
            if (seen.has(url.href)) return;
            seen.add(url.href);
            candidates.push({ kind, url: url.href });
        } catch {
            // Ignore invalid playback candidates.
        }
    };

    add('cfNative', data.cfNative);
    const source = selectSeekStreamingPlaybackSource(data);
    if (source) add('source', source.url);
    return candidates;
}

function getSeekStreamingRequestHeaders(embedUrl) {
    const parsed = typeof embedUrl === 'object' && embedUrl?.origin
        ? embedUrl
        : parseSeekStreamingEmbedUrl(embedUrl);
    if (!parsed) return null;
    return { Origin: parsed.origin, Referer: parsed.referer };
}

function getSeekStreamingPlaybackRulePattern(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        const pathSegments = parsed.pathname.split('/').filter(Boolean);
        const directorySegments = parsed.pathname.endsWith('/')
            ? pathSegments
            : pathSegments.slice(0, -1);
        const mediaTypeIndex = directorySegments.length - 2;
        const mediaType = directorySegments[mediaTypeIndex];
        const videoId = directorySegments[mediaTypeIndex + 1];
        const v4Index = directorySegments.indexOf('v4');
        if (
            v4Index !== -1 &&
            mediaTypeIndex > v4Index &&
            /^[a-z0-9_-]+$/i.test(mediaType || '') &&
            /^[a-z0-9_-]+$/i.test(videoId || '')
        ) {
            return `*://*/${mediaType}/${videoId}/*`;
        }
        const slash = parsed.pathname.lastIndexOf('/');
        const directory = slash >= 0 ? parsed.pathname.slice(0, slash + 1) : '/';
        return `*://${parsed.host}${directory}*`;
    } catch {
        return null;
    }
}

/**
 * Convert hex to Uint8Array
 */
function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

/**
 * AES-CBC decryption for SeekStreaming using Web Crypto API
 */
async function decryptAesCbc(hexData, keyStr, ivStr) {
    try {
        const cleanHex = hexData.trim().replace(/"/g, '');
        const data = hexToBytes(cleanHex);

        const keyBytes = new TextEncoder().encode(keyStr);
        const ivBytes = new TextEncoder().encode(ivStr);

        const cryptoKey = await crypto.subtle.importKey(
            'raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']
        );

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv: ivBytes },
            cryptoKey,
            data
        );

        return new TextDecoder().decode(decrypted);
    } catch (e) {
        console.error('[EXT-SEEKSTREAMING] AES decryption error:', e);
        return null;
    }
}

// AES constants for SeekStreaming (embed4me)
const SEEKSTREAMING_AES_KEY_HEX = '6b69656d7469656e6d7561393131636131323334353637383930';
const SEEKSTREAMING_AES_KEY_RAW = 'kiemtienmua911ca';
const SEEKSTREAMING_AES_IV_RAW = '1234567890oiuytr';

export async function extractSeekStreaming(seekUrl) {
    console.log(`ENTERING SEEK with ${seekUrl}`);
    const parsed = parseSeekStreamingEmbedUrl(seekUrl);
    if (!parsed) {
        console.log("Here1");
        return { seekUrl };
    }
    const cacheKey = md5Hash(parsed.cacheKey);
    const cached = caches.seekstreaming.get(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
        const headers = {
            'User-Agent': SEEKSTREAMING_USER_AGENT,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.5',
            ...getSeekStreamingRequestHeaders(parsed),
        };
        const query = new URLSearchParams({
            id: parsed.videoId,
            w: "1920",
            h: "1080",
            r: "",
        }).toString();

        const apiUrl = `${parsed.origin}/api/v1/video?${query}`;
        const response = await fetch(apiUrl, { headers, signal: controller.signal });
        console.log(`GOT ${JSON.stringify(response)}`);
        if (!response.ok) {
            return { seekUrl };
        }
        const decryptedRaw = await decryptAesCbc(
            await response.text(),
            SEEKSTREAMING_AES_KEY_RAW,
            SEEKSTREAMING_AES_IV_RAW,
        );
        const selected = selectSeekStreamingPlaybackSources(JSON.parse(decryptedRaw));
        if (selected.length === 0) {
            return { seekUrl };
        }

        const result = { url: selected[0].url, Referer: parsed.referer };
        caches.seekstreaming.set(cacheKey, result);
        return result;
    } catch (error) {
        console.err(`extractSeekStreaming Error : ${error.message}`);
        return { seekUrl };
    } finally {
        clearTimeout(timer);
    }
}

//(async () => {
//    const res = await extractSeekStreaming("https://neocine.embedseek.com/#iflfk");
//    //const res = parseSeekStreamingEmbedUrl("https://neocine.embedseek.com/#iflfk");
//    console.log(JSON.stringify(res));
//})();
