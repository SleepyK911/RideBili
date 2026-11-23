'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const parse = require('url').parse;

const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const WEB = 'https://www.bilibili.com/';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ID = /^BV[0-9A-Za-z]{10}(?:_p[1-9][0-9]{0,3})?$/;
const MIX = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
const SESSION = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
const FINGER = ['buvid3', 'buvid4'];
const COOKIE_VALUE = /^[!-~]+$/;
const SEARCH_WBI_MS = 7000, SEARCH_FALLBACK_MS = 5000;

function searchBlocked(e) {
    return e.biliCode === -352 || e.biliCode === -412 || e.message === 'B 站 HTTP 412';
}

async function withinSearchTime(promise, ms) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), ms);
        })]);
    } finally { clearTimeout(timer); }
}

function cookieValue(v) { return typeof v === 'string' && COOKIE_VALUE.test(v) && !/[;,]/.test(v); }
function query(q) {
    return Object.keys(q).sort().map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
}
function sign(q, key, now) {
    const clean = {};
    Object.keys(q).forEach((k) => { clean[k] = String(q[k]).replace(/[!'()*]/g, ''); });
    clean.wts = Math.floor(now / 1000);
    const s = query(clean);
    return s + '&w_rid=' + crypto.createHash('md5').update(s + key).digest('hex');
}
function clean(s) {
    return String(s || '').replace(/<[^>]*>/g, '').replace(/&(amp|quot|apos|lt|gt|#39|nbsp);/g,
        (_, k) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', '#39': "'", nbsp: ' ' })[k]).trim().slice(0, 180);
}
function seconds(x) {
    if (typeof x === 'string' && /^\d+(?::\d+)+$/.test(x)) return x.split(':').reduce((s, n) => s * 60 + Number(n), 0);
    return Math.max(0, Number(x) || 0);
}
function cdnUrl(value, suffix, exact) {
    if (typeof value !== 'string' || value.length > 8192) return null;
    const url = value.replace(/^(?:http:)?\/\//, 'https://');
    const u = parse(url);
    return u.protocol === 'https:' && u.hostname && (exact ? u.hostname === exact : u.hostname.endsWith('.' + suffix)) && !u.auth && !u.port ? url : null;
}
function mediaUrl(value) {
    return cdnUrl(value, 'bilivideo.com') || cdnUrl(value, 'bilivideo.cn') ||
        cdnUrl(value, 'akamaized.net', 'upos-hz-mirrorakam.akamaized.net');
}
function urlsFor(track) {
    const list = (x) => Array.isArray(x) ? x : x ? [x] : [];
    return Array.from(new Set([track.baseUrl, track.base_url, track.url]
        .concat(list(track.backupUrl), list(track.backup_url)).map(mediaUrl).filter(Boolean))).slice(0, 12);
}
function coverUrl(item) {
    return cdnUrl(item.pic, 'hdslb.com') || cdnUrl(item.cover, 'hdslb.com') || cdnUrl(item.cover_url, 'hdslb.com');
}
function videoRow(x) {
    if (!x || !ID.test(x.bvid || '') || !x.title) return null;
    const name = x.author || (x.owner && x.owner.name) || '';
    const mid = x.mid || (x.owner && x.owner.mid);
    return { id: x.bvid, title: clean(x.title), channel: clean(name), channelId: /^\d{1,18}$/.test(String(mid)) ? String(mid) : '',
        duration_s: seconds(x.duration), cover: coverUrl(x) };
}
function directId(q) {
    if (ID.test(q)) return q;
    const u = parse(q, true);
    const m = u.protocol === 'https:' && u.hostname === 'www.bilibili.com' && /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(u.pathname || '');
    if (!m) return null;
    return /^[1-9][0-9]{0,3}$/.test(String(u.query.p)) && Number(u.query.p) > 1 ? m[1] + '_p' + u.query.p : m[1];
}
const QUALITIES = {
    360: { qn: 16, long: 640 }, 480: { qn: 32, long: 864 },
    720: { qn: 64, long: 1280 }, 1080: { qn: 80, long: 1920 }
};
function qualityHeight(q) {
    if (q === 'auto') return 480;
    return Object.prototype.hasOwnProperty.call(QUALITIES, q) ? Number(q) : 1080;
}
function rate(v) {
    const m = /^(\d+(?:\.\d+)?)(?:\/(\d+))?$/.exec(String(v || ''));
    return m && Number(m[1]) > 0 && (m[2] === undefined || Number(m[2]) > 0) ? Number(m[1]) / Number(m[2] || 1) : null;
}
function tracks(list) { return Array.isArray(list) ? list.filter((x) => x && typeof x === 'object') : []; }
function fits(v, height) {
    return !v.width || !v.height || (Math.min(v.width, v.height) <= height &&
        Math.max(v.width, v.height) <= QUALITIES[height].long);
}
function pickStreams(dash, height, recentBps) {
    const auto = height === 'auto', cap = qualityHeight(height), limit = QUALITIES[cap];
    const videos = tracks(dash.video).map((v) => ({
        id: Number(v.id) || 0, width: Number(v.width) || 0, height: Number(v.height) || 0,
        fps: rate(v.frameRate || v.frame_rate), bandwidth: Number(v.bandwidth) || 0, urls: urlsFor(v),
        avc: v.codecs ? /^avc[13](?:\.|$)/i.test(v.codecs) : Number(v.codecid) === 7
    })).filter((v) => {
        const tier = Object.keys(QUALITIES).find((q) => QUALITIES[q].qn === v.id);
        return tier && v.avc && v.urls.length && (v.fps === null || v.fps <= 31) && fits(v, 1080);
    })
        .sort((a, b) => b.id - a.id || b.width * b.height - a.width * a.height ||
            Number(b.fps !== null) - Number(a.fps !== null) || b.bandwidth - a.bandwidth);
    const eligible = videos.filter((v) => v.id <= limit.qn && fits(v, cap));
    const audio = tracks(dash.audio).map((a) => ({
        urls: urlsFor(a), bandwidth: Number(a.bandwidth) || 0,
        score: /^mp4a\.40\.2$/i.test(a.codecs) ? 3 :
            /^mp4a\.40\.(5|29)$/i.test(a.codecs) ? 1 :
            !a.codecs && [30216, 30232, 30280].includes(Number(a.id)) &&
                (a.mimeType || a.mime_type) === 'audio/mp4' ? 2 : 0
    })).filter((a) => a.score && a.urls.length)
        .sort((a, b) => b.score - a.score || (a.bandwidth || Infinity) - (b.bandwidth || Infinity));
    if (!audio.length) return null;
    let video = eligible[0];
    if (auto) {
        const standard = eligible.filter((v) => v.id <= 32 && fits(v, 480));
        const sd = standard[0];
        const sameTier = sd ? standard.filter((v) => v.id === sd.id) : [];
        // Leave room for startup bursts, concurrent audio and changing network conditions.
        const audioBps = audio[0].bandwidth || 192000;
        const affordable = (v, share) => v.bandwidth > 0 && v.bandwidth + audioBps <= recentBps * share;
        const sustainable = sameTier.find((v) => affordable(v, 0.75));
        const lightest = recentBps > 0 && sameTier.reduce((best, v) =>
            v.bandwidth > 0 && (!best || v.bandwidth < best.bandwidth) ? v : best, null);
        video = sustainable || lightest || sd || video ||
            videos.reduce((best, v) => !best || v.id < best.id ? v : best, null);
    }
    if (!video) return null;
    const available = Object.keys(QUALITIES).filter((q) => videos.some((v) => v.id === QUALITIES[q].qn && fits(v, Number(q))));
    const qualities = Array.from(new Set([video.id].concat(available.map((q) => QUALITIES[q].qn))));
    const maxHeight = auto && video.id <= 32 && fits(video, 480) ? 480 :
        eligible.includes(video) ? cap : video.id <= 64 && fits(video, 720) ? 720 : 1080;
    return { video: video.urls, audio: audio[0].urls, width: video.width, height: video.height,
        sourceQuality: video.id, maxHeight, qualities };
}
function loginCookies(res, redirect) {
    const out = {};
    (res.cookies || []).forEach((c) => {
        const m = /^([^=]+)=([^;]*)/.exec(c);
        if (m && SESSION.concat(FINGER).includes(m[1].trim()) && cookieValue(m[2])) out[m[1].trim()] = m[2];
    });
    const url = parse(typeof redirect === 'string' ? redirect : '', true);
    if (url.protocol === 'https:' && url.hostname === 'www.bilibili.com') {
        SESSION.forEach((k) => {
            // parse() URL-decodes the query; SESSDATA needs the original cookie escaping.
            if (!out[k] && typeof url.query[k] === 'string') {
                const value = encodeURIComponent(url.query[k]);
                if (cookieValue(value)) out[k] = value;
            }
        });
    }
    return out;
}

class Account {
    constructor(opts, emit) {
        this.opts = opts;
        this.emit = emit;
        this.gen = 0;
        this.covers = new Map();
        this.views = new Map();
        this.tileMeta = new Map();
        this.feeding = Object.create(null);
        this.identity = null;
        this.saved = this.load();
    }
    load() {
        try {
            const a = JSON.parse(fs.readFileSync(this.opts.accountFile, 'utf8'));
            return a && a.cookies && cookieValue(a.cookies.SESSDATA) ? a : null;
        } catch (e) { return null; }
    }
    save(a) {
        const f = this.opts.accountFile, dir = path.dirname(f), tmp = f + '.tmp';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, 0o700);
        try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(a)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, f);
    }
    async request(origin, endpoint, q, cookies, allowed, timeoutMs) {
        const names = SESSION.concat(FINGER);
        const header = names.filter((k) => cookieValue(cookies && cookies[k])).map((k) => k + '=' + cookies[k]).join('; ');
        const r = await this.opts.ytRequest('GET', origin + endpoint + (q ? '?' + q : ''),
            Object.assign({ 'User-Agent': UA, Referer: WEB, Accept: 'application/json' }, header ? { Cookie: header } : {}),
            null, timeoutMs || this.opts.ytTimeoutMs);
        if (r.status !== 200) throw new Error('B 站 HTTP ' + r.status);
        let j;
        try { j = JSON.parse(r.body); } catch (e) { throw new Error('B 站响应格式异常'); }
        if (j.code !== 0 && j.code !== allowed) {
            const e = new Error('B 站 ' + j.code + ' ' + clean(j.message));
            e.biliCode = j.code;
            throw e;
        }
        return { data: j.data || {}, cookies: r.cookies };
    }
    fingerprint() {
        if (!this.device) {
            this.device = this.request(API, '/x/frontend/finger/spi').then((r) => {
                if (!cookieValue(r.data.b_3)) throw new Error('B 站访客会话不可用');
                return { buvid3: r.data.b_3, buvid4: r.data.b_4 };
            }).catch((e) => { this.device = null; throw e; });
        }
        return this.device;
    }
    status() {
        if (this.saved) return { ev: 'auth', state: 'signed_in' };
        if (this.pending) return { ev: 'auth', state: 'code', url: this.pending.url, scanned: !!this.pending.scanned };
        return { ev: 'auth', state: this.starting ? 'asking' : 'signed_out' };
    }
    async start() {
        if (this.saved || this.pending || this.starting) return this.emit(this.status());
        const gen = this.gen;
        this.starting = true;
        this.emit(this.status());
        try {
            const r = await this.request(PASSPORT, '/x/passport-login/web/qrcode/generate');
            if (gen !== this.gen) return;
            const d = r.data, u = parse(d.url || '');
            if (u.protocol !== 'https:' || !['account.bilibili.com', 'passport.bilibili.com'].includes(u.hostname) || u.auth || u.port ||
                typeof d.qrcode_key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(d.qrcode_key) ||
                Buffer.byteLength(d.url) > 192) throw new Error('二维码格式异常');
            this.starting = false;
            this.pending = { key: d.qrcode_key, url: d.url, expires: Date.now() + 180000 };
            this.emit(this.status());
            this.schedule(2000);
        } catch (e) {
            if (gen !== this.gen) return;
            this.starting = false;
            this.emit({ ev: 'auth', state: 'error', msg: '获取二维码失败，请重试' });
        }
    }
    schedule(ms) {
        this.pending.timer = setTimeout(() => this.poll(), ms);
    }
    async poll() {
        const p = this.pending;
        if (!p) return;
        try {
            if (Date.now() >= p.expires) throw new Error('二维码已过期，请重新获取');
            const r = await this.request(PASSPORT, '/x/passport-login/web/qrcode/poll', query({ qrcode_key: p.key }));
            if (this.pending !== p) return;
            if (r.data.code === 0) {
                const cookies = loginCookies(r, r.data.url);
                if (!cookies.SESSDATA) throw new Error('扫码会话建立失败，请重试');
                const nav = (await this.request(API, '/x/web-interface/nav', null, cookies)).data;
                if (this.pending !== p) return;
                if (!nav.isLogin || !nav.mid) throw new Error('扫码会话验证失败，请重试');
                this.save({ cookies: cookies, mid: String(nav.mid) });
                this.saved = { cookies: cookies, mid: String(nav.mid) };
                this.identity = null;
                this.pending = null;
                this.emit(this.status());
                return;
            }
            if (r.data.code === 86038) throw new Error('二维码已过期，请重新获取');
            if (r.data.code === 86090 && !p.scanned) { p.scanned = true; this.emit(this.status()); }
            if (r.data.code !== 86101 && r.data.code !== 86090) throw new Error('扫码登录失败，请重试');
            this.schedule(2000);
        } catch (e) {
            if (this.pending !== p) return;
            if (/^B 站 HTTP 5/.test(e.message) && Date.now() < p.expires) { this.schedule(4000); return; }
            this.pending = null;
            this.emit({ ev: 'auth', state: 'error', msg: /[\u4e00-\u9fff]/.test(e.message) ? e.message : '扫码登录失败，请重试' });
        }
    }
    close() {
        this.gen++;
        if (this.pending) clearTimeout(this.pending.timer);
        this.pending = null;
        this.starting = false;
    }
    signOut() {
        try { fs.unlinkSync(this.opts.accountFile); } catch (e) {
            if (e.code !== 'ENOENT') { this.emit({ ev: 'error', msg: '退出登录失败' }); return; }
        }
        this.close();
        this.saved = null;
        this.identity = null;
        this.feeding = Object.create(null);
        this.emit(this.status());
    }
    wbiKey(cookies, saved) {
        const now = Date.now();
        if (!this.identity || this.identity.saved !== saved || this.identity.until <= now) {
            const entry = { saved: saved, until: now + 900000 };
            this.identity = entry;
            entry.key = this.request(API, '/x/web-interface/nav', null, cookies, -101).then(({ data: n }) => {
                if (saved && !n.isLogin && this.saved === saved) {
                    this.signOut();
                    throw new Error('登录已过期，请重新扫码');
                }
                const img = n.wbi_img || {};
                const keys = [img.img_url, img.sub_url].map((u) => (/\/([a-f0-9]{32})\.[a-z]+$/i.exec(u || '') || [])[1]);
                if (!keys[0] || !keys[1]) throw new Error('B 站签名接口不可用');
                const pair = keys.join('');
                return MIX.map((i) => pair[i]).join('');
            }).catch((e) => { if (this.identity === entry) this.identity = null; throw e; });
        }
        return this.identity.key;
    }
    async api(endpoint, q, options) {
        const o = options || {}, saved = o.guest ? null : this.saved;
        if (o.login && !saved) throw new Error('请先扫码登录');
        const cookies = Object.assign({}, await this.fingerprint(), saved && saved.cookies);
        if (o.deadline && Date.now() >= o.deadline) throw new Error('timeout');
        try {
            const qs = o.wbi ? sign(q || {}, await this.wbiKey(cookies, saved), Date.now()) : query(q || {});
            const left = o.deadline ? o.deadline - Date.now() : null;
            if (left !== null && left <= 0) throw new Error('timeout');
            const timeout = left === null ? o.timeoutMs : Math.min(left, o.timeoutMs || left);
            return (await this.request(API, endpoint, qs, cookies, undefined, timeout)).data;
        } catch (e) {
            if (e.biliCode === -101 && saved && this.saved === saved) this.signOut();
            throw e;
        }
    }
    view(bvid) {
        const hit = this.views.get(bvid);
        if (hit && hit.until > Date.now()) return hit.value;
        const entry = { until: Date.now() + 300000 };
        entry.value = this.api('/x/web-interface/view', { bvid }).catch((e) => {
            if (this.views.get(bvid) === entry) this.views.delete(bvid);
            throw e;
        });
        this.views.delete(bvid);
        this.views.set(bvid, entry);
        if (this.views.size > 48) this.views.delete(this.views.keys().next().value);
        return entry.value;
    }
    rows(xs) {
        return tracks(xs).map((x) => {
            const v = videoRow(x);
            if (!v) return null;
            if (Number(x.videos) === 1 && /^\d{1,18}$/.test(String(x.cid)) && Number(x.cid) > 0 && v.duration_s > 0) {
                this.tileMeta.delete(v.id);
                this.tileMeta.set(v.id, { cid: x.cid, title: v.title, channel: v.channel, duration_s: v.duration_s });
                if (this.tileMeta.size > 100) this.tileMeta.delete(this.tileMeta.keys().next().value);
            }
            if (v.cover) {
                this.covers.delete(v.id);
                this.covers.set(v.id, v.cover);
                if (this.covers.size > 300) this.covers.delete(this.covers.keys().next().value);
            }
            delete v.cover;
            return v;
        }).filter(Boolean).slice(0, 50);
    }
    async search(q) {
        const id = directId(q);
        if (id) {
            const v = await withinSearchTime(this.view(id.split('_')[0]), SEARCH_WBI_MS + SEARCH_FALLBACK_MS);
            const rows = this.rows([v]);
            if (rows.length) {
                if (this.covers.has(rows[0].id)) this.covers.set(id, this.covers.get(rows[0].id));
                rows[0].id = id;
            }
            return rows;
        }
        try {
            const d = await withinSearchTime(this.api('/x/web-interface/wbi/search/type', { keyword: q, search_type: 'video', page: 1 },
                { wbi: true, deadline: Date.now() + SEARCH_WBI_MS }), SEARCH_WBI_MS);
            if (!d.v_voucher && (Array.isArray(d.result) || d.numResults === 0)) return this.rows(d.result);
        } catch (e) {
            if (!searchBlocked(e) && !/timeout|B 站 HTTP 5\d\d|签名接口不可用|访客会话不可用/i.test(e.message)) throw e;
        }
        try {
            const { data: d } = await this.request(API, '/x/web-interface/search/all/v2', query({ keyword: q, page: 1 }),
                null, undefined, SEARCH_FALLBACK_MS);
            if (d.v_voucher) throw new Error('B 站要求搜索验证，请稍后重试');
            if (!Array.isArray(d.result) && d.numResults !== 0) throw new Error('B 站搜索响应格式异常');
            const videos = tracks(d.result).find((group) => group && group.result_type === 'video');
            return this.rows(videos && videos.data);
        } catch (e) {
            if (searchBlocked(e)) throw new Error('B 站限制搜索请求，请稍后重试');
            if (/timeout/i.test(e.message)) throw new Error('B 站搜索请求超时');
            throw e;
        }
    }
    async feed(which) {
        if (!['home', 'subs', 'wl'].includes(which) || this.feeding[which]) return;
        const t = this.feeding[which] = {};
        const gen = this.gen;
        try {
            let xs;
            if (which === 'home') {
                try { xs = (await this.api('/x/web-interface/wbi/index/top/feed/rcmd', { ps: 20, fresh_idx: 1 }, { wbi: true })).item; }
                catch (e) { xs = null; }
                if (!Array.isArray(xs) || !xs.some((v) => videoRow(v))) xs = (await this.api('/x/web-interface/popular', { ps: 20, pn: 1 })).list;
            } else if (which === 'subs') {
                const d = await this.api('/x/polymer/web-dynamic/v1/feed/all', { type: 'video' }, { login: true });
                xs = (d.items || []).map((x) => {
                    const m = x.modules || {}, a = m.module_author || {}, v = ((m.module_dynamic || {}).major || {}).archive;
                    return v && Object.assign({}, v, { owner: { name: a.name, mid: a.mid }, duration: v.duration_text });
                });
            } else xs = (await this.api('/x/v2/history/toview/web', {}, { login: true })).list;
            if (gen === this.gen) this.emit({ ev: 'feed', which: which, items: this.rows(xs) });
        } catch (e) {
            if (gen === this.gen) this.emit({ ev: 'feed', which: which, items: [], error: e.message });
        } finally { if (this.feeding[which] === t) delete this.feeding[which]; }
    }
    async channels() {
        const gen = this.gen;
        try {
            if (!this.saved) return;
            const r = await this.api('/x/relation/followings', { vmid: this.saved.mid, pn: 1, ps: 30 }, { login: true });
            if (gen === this.gen) this.emit({ ev: 'channels', items: (r.list || []).filter((x) => /^\d{1,18}$/.test(String(x.mid)))
                .map((x) => ({ id: String(x.mid), title: clean(x.uname) })) });
        } catch (e) { if (gen === this.gen) this.emit({ ev: 'channels', items: [], error: e.message }); }
    }
    async channel(id) {
        if (!/^\d{1,18}$/.test(String(id))) return;
        const gen = this.gen;
        try {
            const r = await this.api('/x/space/wbi/arc/search', { mid: id, pn: 1, ps: 20, order: 'pubdate' }, { wbi: true });
            const items = this.rows((r.list || {}).vlist);
            if (gen === this.gen) this.emit({ ev: 'channel', id: id, title: items.length ? items[0].channel : id, items: items });
        } catch (e) { if (gen === this.gen) this.emit({ ev: 'channel', id: id, items: [], error: e.message }); }
    }
    async cover(id) {
        if (this.covers.has(id)) return this.covers.get(id);
        const bvid = id.split('_p')[0];
        if (this.covers.has(bvid)) return this.covers.get(bvid);
        const v = await this.view(bvid);
        const cover = coverUrl(v);
        if (cover) {
            this.covers.set(bvid, cover);
            if (this.covers.size > 300) this.covers.delete(this.covers.keys().next().value);
        }
        return cover;
    }
    async streams(id, height, preferMp4, recentBps) {
        const cap = qualityHeight(height), [bvid, part] = id.split('_p');
        const cached = !part && this.tileMeta.get(bvid);
        let tile = cached;
        if (!tile) {
            const v = await this.view(bvid);
            const pages = v.pages || [], p = pages[Number(part || 1) - 1];
            if (!p || !p.cid) throw new Error('分 P 不存在');
            tile = { cid: p.cid, title: clean(v.title) + (pages.length > 1 ? ' · ' + clean(p.part) : ''),
                channel: clean((v.owner || {}).name), duration_s: seconds(p.duration || v.duration) };
        }
        const q = { bvid: bvid, cid: tile.cid, qn: QUALITIES[cap].qn, fnver: 0, fourk: 0 };
        const meta = { title: tile.title, channel: tile.channel, duration_s: tile.duration_s };
        const requests = [
            { fnval: 4048, guest: false },
            { fnval: 16, guest: false }
        ];
        if (this.saved) requests.push({ fnval: 4048, guest: true });
        let lastError = null, best = null;
        for (const request of requests) {
            if (best && request.guest) break;
            try {
                const d = await this.api('/x/player/wbi/playurl', Object.assign({ fnval: request.fnval, prefer_codec: 7 }, q),
                    { wbi: true, guest: request.guest, timeoutMs: best ? 2400 : undefined });
                const dash = d.dash || {}, selected = pickStreams(dash, height, recentBps);
                if (selected) {
                    if (height === 'auto') return Object.assign(selected, meta);
                    const offered = (Array.isArray(d.accept_quality) ? d.accept_quality : []).map(Number);
                    if (!best || selected.sourceQuality > best.sourceQuality) best = selected;
                    best.qualities = Array.from(new Set(best.qualities.concat(selected.qualities)));
                    if (!this.saved || request.fnval === 16 || request.guest ||
                        !offered.some((v) => v > best.sourceQuality && v <= q.qn)) break;
                    continue;
                }
                (this.opts.log || (() => {}))('B站取流 ' + id + ' DASH ' + request.fnval + (request.guest ? ' guest' : '') +
                    '：视频 ' + tracks(dash.video).length + ' 条，音频 ' + tracks(dash.audio).length + ' 条，未匹配到兼容流');
            } catch (e) {
                if (!best && !cached && [-404, -403, -10403, 62002, 62004].includes(e.biliCode)) throw e;
                lastError = e;
            }
        }
        if (best && (!preferMp4 || cap < 720 || best.sourceQuality >= 64)) return Object.assign(best, meta);
        try {
            // HTML5 high_quality can return a complete 720P H.264 MP4 even when
            // the DASH manifest only has 480P. Try it on an explicit HD selection.
            const hd = preferMp4 && cap >= 720;
            const d = await this.api('/x/player/wbi/playurl', Object.assign({}, q, {
                qn: Math.min(hd ? 64 : 32, q.qn), fnval: 1, platform: 'html5', high_quality: hd ? 1 : 0
            }), { wbi: true, guest: !hd || !this.saved, timeoutMs: best ? 3500 : undefined });
            const files = tracks(d.durl), progressive = files.length === 1 && urlsFor(files[0]);
            if (progressive && progressive.length && Number(d.video_codecid) === 7 && /mp4/i.test(d.format || '')) {
                const sourceQuality = Number(d.quality) || 16;
                if (sourceQuality <= Math.min(hd ? 64 : 32, q.qn) && (!best || sourceQuality > best.sourceQuality)) {
                    return Object.assign({ progressive: progressive, sourceQuality, maxHeight: Math.min(hd ? 720 : 480, cap),
                        qualities: Array.from(new Set([sourceQuality].concat(best ? best.qualities : []))) }, meta);
                }
            }
        } catch (e) {
            if (!best && !cached && [-404, -403, -10403, 62002, 62004].includes(e.biliCode)) throw e;
            if (!lastError) lastError = e;
        }
        if (best) return Object.assign(best, meta);
        if (cached) {
            this.tileMeta.delete(bvid);
            this.views.delete(bvid);
            return this.streams(id, height, preferMp4, recentBps);
        }
        throw lastError || new Error('B 站未返回兼容的 H.264/AAC 播放地址');
    }
}
module.exports = { Account, ID, UA, WEB, sign, directId, pickStreams, qualityHeight, cdnUrl };
