'use strict';
// node22 thumb.js <cover-url> [--lease <path>]: 320x180 RGBA (230400 bytes) on stdout.
// Runs as the fetch uid (env {}, cwd /); the car has no image library, so the JPEG is decoded here.
const https = require('https');
const decode = require('./vendor/jpeg-js/decoder.js');
const { cdnUrl, UA, WEB } = require('./bili');

const W = 320, H = 180, MAX = 2 * 1024 * 1024, TIMEOUT_MS = 4000;

// as ytd.js's uplinkLookup (Node 8 there); Node 22's autoSelectFamily asks with {all: true}
function uplinkLookup(leaseFile) {
    let servers = [];
    try { servers = (JSON.parse(require('fs').readFileSync(leaseFile || '/run/mgu-uplink/lease.json', 'utf8')).dns || []).filter((x) => typeof x === 'string'); } catch (e) { /* no lease: system resolver */ }
    if (!servers.length) return undefined;
    const r = new (require('dns').Resolver)();
    r.setServers(servers);
    return function (host, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        r.resolve4(host, (e, a) => (e ? cb(e) : opts.all ? cb(null, a.map((address) => ({ address, family: 4 }))) : cb(null, a[0], 4)));
    };
}

function fetchJpeg(url, lookup, redirects) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { lookup, headers: { 'User-Agent': UA, Referer: WEB, Accept: 'image/jpeg' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                res.resume();
                let next;
                try { next = cdnUrl(new URL(res.headers.location, url).href, 'hdslb.com'); } catch (e) { /* bad redirect */ }
                return next ? fetchJpeg(next, lookup, redirects - 1).then(resolve, reject) : reject(new Error('unexpected cover redirect'));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const parts = [];
            let n = 0;
            res.on('data', (d) => { n += d.length; if (n > MAX) req.destroy(new Error('body over 2 MB')); else parts.push(d); });
            res.on('end', () => resolve(Buffer.concat(parts)));
            res.on('error', reject);
        });
        const timer = setTimeout(() => req.destroy(new Error('timeout')), TIMEOUT_MS);
        req.on('close', () => clearTimeout(timer));
        req.on('error', reject);
    });
}

async function fetchCover(url, lookup, get) {
    const u = new URL(url);
    const base = u.origin + u.pathname.split('@')[0];
    const variants = new Set([base + '@320w_180h_1c.jpg' + u.search, base + '@320w.jpg' + u.search, url]);
    let last;
    for (const variant of variants) {
        try { return thumbRgba(await (get || fetchJpeg)(variant, lookup, 1)); }
        catch (e) { last = e; }
    }
    throw last;
}

function thumbRgba(jpeg) {
    const img = decode(jpeg, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
    const out = Buffer.alloc(W * H * 4);
    const cropW = Math.min(img.width, img.height * W / H), cropH = Math.min(img.height, img.width * H / W);
    const ox = (img.width - cropW) / 2, oy = (img.height - cropH) / 2;
    for (let y = 0; y < H; y++) {
        const sy = Math.floor(oy + (y + 0.5) * cropH / H);
        for (let x = 0; x < W; x++) {
            const s = (sy * img.width + Math.floor(ox + (x + 0.5) * cropW / W)) * 4;
            const d = (y * W + x) * 4;
            out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = 255;
        }
    }
    return out;
}

module.exports = { thumbRgba, fetchCover, uplinkLookup };

if (require.main === module) {
    const fail = (m) => { process.stderr.write('thumb: ' + m + '\n'); process.exit(1); };
    const a = process.argv.slice(2);
    const url = cdnUrl(a[0], 'hdslb.com');
    const li = a.indexOf('--lease');
    if (!url) fail('bad cover URL');
    if (li > 0 && !a[li + 1]) fail('--lease needs a path');
    fetchCover(url, uplinkLookup(li > 0 ? a[li + 1] : undefined))
        .then((b) => process.stdout.write(b, () => process.exit(0)))
        .catch((e) => fail(e.message));
}
