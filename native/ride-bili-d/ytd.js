'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// RideBili uses SmartX PCM or BMW MediaPlayer audio, and paces ytdec from the selected
// audio clock. The app talks to it on /run/ride-bili-d/ctl.sock (JSON
// lines; README.md has the protocol). Node 8: no ?. / ?? / catch without binding.
// 0.1.6: feed{which, items, shelves:[{title, items}]}, items carry meta (the tile's second line).
// The car fetches (ytfetch.py), queries Bilibili and makes thumbs (thumb.js) itself, all as the fetch uid; playback starts while the video is still being fetched.
// It never exits on its own: a stray exception is logged, audio is released, it goes idle.
const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');
const { Account, ID: ID_RE, UA: BILI_UA, qualityHeight } = require('./bili');
const cp = require('child_process');
const readline = require('readline');
const Realtime = require('./realtime');

const SOURCE_ID = 1046, SINK_ID = 1024;
const RIDETUBE = '/var/opt/jap-ridetube-d/current';
const AUDIO_FILE = 'audio.mp3';
const AUDIO_HEAD = 'audio.head.mp3';
const QUALITY_QN = { 360: 16, 480: 32, 720: 64, 1080: 80 };
const STREAM_REUSE_MS = 45000;
const VIDEO_RATE_TTL_MS = 90000;
const CDN_ROUTE_TTL_MS = 90000;
const MEDIA_FILES = [AUDIO_FILE, 'index.bin', 'video.h264'];
// thumb.rgba length -> [w, h]: 160x90 in caches from older proxies, 320x180 since 0.1.6
const THUMB_SIZES = { 57600: [160, 90], 230400: [320, 180] };

function defaults() {
    const env = process.env;
    const here = __dirname;
    const netNode = '/var/opt/jap-node22/current/bin/node';
    return {
        someip: env.MGU_YT_SOMEIP || '/usr/lib/someip.node',
        srcGen: env.MGU_YT_SRCGEN || '/usr/lib/oap-mainapp/src-gen',
        ytdec: env.MGU_YT_YTDEC || path.join(here, 'bili-dec'),
        cacheDir: env.MGU_YT_CACHE || '/var/opt/ride-bili-d/cache',
        logDir: env.MGU_YT_LOGDIR || '/var/opt/ride-bili-d/log',
        sock: env.MGU_YT_SOCK || '/run/ride-bili-d/ctl.sock',
        sockGid: null, // resolve tm_oap_app from the unit's group database
        accountFile: env.MGU_YT_ACCOUNT || '/var/opt/ride-bili-d/state/account.json',
        ytRequest: null,     // null: each request in a child as the fetch uid (fetchRequest)
        // the fetch uid's pick (pickFetchUid) and the helper it runs
        stateDir: env.MGU_YT_STATE || '/var/opt/ride-bili-d/state',
        etcDir: '/etc',
        oapRoot: '/var/opt/public/oap',
        toolRoot: '/var/opt',
        procDir: '/proc',
        mainapps: MAINAPPS,
        fetchCmd: [netNode, '--max-http-header-size=65536', __filename, '--fetch'],
        fetcher: ['/var/opt/mgu-python/current/bin/python3', path.join(here, 'ytfetch.py')],
        pcmOut: ['/var/opt/mgu-python/current/bin/python3', '-I', path.join(here, 'pcmout.py'), 'plug:smartx:CarLifeMedia_CF_48_STEREO'],
        pcmVideoMs: 650,
        thumbCmd: [netNode, path.join(here, 'thumb.js')],
        startVideoMs: 6000,  // video fetched ahead before playback starts (later the buffering pause covers a slow link)
        fetchRetryMs: [3000, 8000], // a fetch failing before playback (the network): tried again after these waits
        leaseFile: '/run/mgu-uplink/lease.json',
        resume: true,        // a play starts where the video was left (positions.json)
        headMarginMs: 1500,  // on the head file: wait for audio.mp3 this close to the head's end
        thumbMax: 150,
        ytTimeoutMs: 10000,
        keep: 0,             // played videos kept in the cache (0: deleted once played; nothing is kept for offline)
        watchdogMs: 5000,
        availWaitMs: 5000,
        log: function (m) { console.log(new Date().toISOString() + ' ' + m); }
    };
}

function monoMs() {
    const t = process.hrtime(); // CLOCK_MONOTONIC on Linux
    return Math.floor(t[0] * 1000 + t[1] / 1e6);
}

// members-only (or members-first) videos: a badge somewhere in the tile, its shape unknown (no capture) - matched on the text
// shortcut: a JSON scan of the tile, swap for the badge's field once a real members tile is captured
const isMembers = (t) => /BADGE_STYLE_TYPE_MEMBERS|"Members (only|first)"/i.test(JSON.stringify(t));
const PERMANENT_RE = /未返回兼容|分 P 不存在|B 站 -(404|403|10403)|B 站 (62002|62004|6002003)/i;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function withTimeout(p, ms, what) {
    return new Promise(function (resolve, reject) {
        const t = setTimeout(function () { reject(new Error(what + ' timed out')); }, ms);
        p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
}
function rmrf(p) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
        fs.readdirSync(p).forEach(function (n) { rmrf(path.join(p, n)); });
        fs.rmdirSync(p);
    } else {
        fs.unlinkSync(p);
    }
}
function mkdirp(p) {
    if (fs.existsSync(p)) return;
    mkdirp(path.dirname(p));
    fs.mkdirSync(p, 0o755);
}

// ---------------------------------------------------------------- playback cache (no downloads: a played video goes)
function readMeta(dir, id) {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); // ytfetch writes it
        return { id: id, title: m.title || id, channel: m.channel || '', duration_s: m.duration_s || null };
    } catch (e) { return { id: id, title: id, channel: '', duration_s: null }; }
}
// enough to start without a fetch. No video.h264.part: play() stops any fetcher first, so a .part is a
// dead fetch's leftover that would never complete (fetched again instead)
function isPlayable(dir) {
    const has = (n) => fs.existsSync(path.join(dir, n));
    return has(AUDIO_FILE) && !has(AUDIO_FILE + '.part') && has('index.bin') && has('video.h264');
}
function isReady(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return false; }
    if (names.some(function (n) { return /\.part$/.test(n); })) return false;
    return MEDIA_FILES.every(function (n) { return names.indexOf(n) >= 0; });
}
function listCache(cacheDir) {
    let names;
    try { names = fs.readdirSync(cacheDir); } catch (e) { return []; }
    const out = [];
    names.forEach(function (n) {
        if (!ID_RE.test(n)) return;
        const dir = path.join(cacheDir, n);
        let st;
        try { st = fs.statSync(dir); } catch (e) { return; }
        if (!st.isDirectory()) return;
        const item = readMeta(dir, n);
        item.ready = isReady(dir);
        item.mtime = st.mtime.getTime();
        out.push(item);
    });
    out.sort(function (a, b) { return b.mtime - a.mtime; });
    return out;
}
// Keep the `keep` most recent ids (dir mtime); never the protected ones (playing/preparing).
function pruneCache(cacheDir, keep, protect, log) {
    const items = listCache(cacheDir);
    const removed = [];
    let kept = 0;
    items.forEach(function (it) {
        if (protect.indexOf(it.id) >= 0) { kept++; return; }
        if (kept < keep) { kept++; return; }
        try { rmrf(path.join(cacheDir, it.id)); removed.push(it.id); } catch (e) { log('lru: ' + it.id + ': ' + e.message); }
    });
    if (removed.length) log('lru removed ' + removed.join(','));
    return removed;
}

// ---------------------------------------------------------------- the fetch uid
// mgu-uplink lets out only the uids it lists, never root: every youtube.com request runs in a child
// as our own "fetch" uid, which the uplink learns from uids.d/ride-bili-d (written here, and by the deploy
// tool from state/internet-uids). Picked as mgu-updater's js/uids.js picks its own: the lowest free
// number above MainApp's app uid ranges, kept in state/uids.json while nothing else holds it.
const SELF = 'ride-bili-d';
const MAX_UID = 60000; // login.defs UID_MAX
const MAINAPPS = [{ root: '/usr/lib/oap-mainapp', hmi: 'HmiMain3D' }, { root: '/usr/lib/oap-mainapp21', hmi: 'Hmi8' }];
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n'); } catch (e) { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const list = (d) => { try { return fs.readdirSync(d); } catch (e) { return []; } };
const isId = (n) => n > 0 && n === Math.floor(n);

// MainApp's app uid ranges [{min,max}] and own uids, from the config of the MainApp the unit runs; null unknown
function mainappRanges(o) {
    const have = o.mainapps.filter((m) => fs.existsSync(path.join(m.root, 'config', 'base.json')));
    let m = have.length === 1 ? have[0] : null;
    if (have.length > 1) {
        const running = list(o.procDir).filter((n) => /^\d+$/.test(n)).map((n) => (lines(path.join(o.procDir, n, 'comm'))[0] || '').trim());
        const which = have.filter((x) => running.indexOf(x.hmi) >= 0);
        m = which.length === 1 ? which[0] : null;
    }
    const c = m && readJson(path.join(m.root, 'config', 'base.json'));
    if (!c) return null;
    const rse = c.usableUidsAndGidsRse || {};
    const ranges = [c.usableUidsAndGids].concat(Object.keys(rse).map((k) => rse[k]))
        .filter((r) => r && isId(Number(r.min)) && Number(r.max) >= Number(r.min)).map((r) => ({ min: Number(r.min), max: Number(r.max) }));
    return ranges.length ? { ranges: ranges, own: (Array.isArray(c.mainAppUids) ? c.mainAppUids : []).map(Number).filter(isId) } : null;
}
// every uid and gid in use: /etc/passwd and group, OAP apps (oap_<uid> folders, MainApp's registry and
// uids.txt), other components' uplink drop-ins, mgu-updater's uids.json, MainApp's own; procs: running ones
function takenIds(o, cfg, procs) {
    const ids = {};
    const add = (v) => { const n = Number(v); if (String(v).trim() !== '' && isId(n)) ids[n] = true; };
    lines(path.join(o.etcDir, 'passwd')).forEach((l) => { const f = l.split(':'); add(f[2] || ''); add(f[3] || ''); });
    lines(path.join(o.etcDir, 'group')).forEach((l) => add(l.split(':')[2] || ''));
    list(o.oapRoot).forEach((n) => { const m = /^oap_(\d+)$/.exec(n); if (m) add(m[1]); });
    const mgr = path.join(o.oapRoot, 'oap_12201');
    list(path.join(mgr, 'data', 'apps')).forEach((n) => { const e = readJson(path.join(mgr, 'data', 'apps', n)); add(e && e.userId !== undefined ? e.userId : ''); });
    lines(path.join(mgr, 'security', 'uids.txt')).forEach((l) => add(l.split('=')[0]));
    const dropins = path.join(o.toolRoot, 'mgu-uplink', 'uids.d');
    list(dropins).filter((n) => n !== SELF && !/^\./.test(n))
        .forEach((n) => lines(path.join(dropins, n)).forEach((l) => l.split('#')[0].split(/[\s,]+/).forEach(add)));
    const upd = readJson(path.join(o.toolRoot, 'mgu-updater', 'state', 'uids.json')) || {};
    Object.keys(upd).forEach((k) => add(upd[k]));
    (cfg ? cfg.own : []).forEach(add);
    if (procs) {
        list(o.procDir).filter((n) => /^\d+$/.test(n)).forEach((pid) => lines(path.join(o.procDir, pid, 'status')).forEach((l) => {
            const m = /^[UG]id:\s+(.*)$/.exec(l);
            if (m) m[1].split(/\s+/).forEach(add);
        }));
    }
    return ids;
}
function writeIfChanged(file, text, mode) {
    try { if (fs.readFileSync(file, 'utf8') === text) return; } catch (e) { /* not there yet */ }
    fs.writeFileSync(file + '.tmp', text, { mode: mode });
    fs.renameSync(file + '.tmp', file);
}
// the kept fetch uid while nothing else holds it, else a new pick; written for the uplink. null: none (logged)
function pickFetchUid(o) {
    const kept = Number((readJson(path.join(o.stateDir, 'uids.json')) || {}).fetch);
    const cfg = mainappRanges(o);
    const inRange = (u) => !!cfg && cfg.ranges.some((r) => u >= r.min && u <= r.max);
    let uid = null;
    if (isId(kept) && !takenIds(o, cfg, false)[kept] && !inRange(kept)) uid = kept;
    else if (cfg) {
        const all = takenIds(o, cfg, true);
        let u = Math.max.apply(null, cfg.ranges.map((r) => r.max)) + 1;
        while (u <= MAX_UID && (all[u] || inRange(u))) u++;
        if (u <= MAX_UID) { uid = u; o.log('internet uid: ' + u + (isId(kept) ? ' (' + kept + ' is taken)' : '')); }
    }
    if (uid === null) {
        o.log('internet uid: none: ' + (cfg ? 'no free uid below ' + MAX_UID : "MainApp's config/base.json (its app uid ranges) cannot be read"));
        return null;
    }
    if (!fs.existsSync(o.stateDir)) { mkdirp(path.dirname(o.stateDir)); fs.mkdirSync(o.stateDir, 0o700); }
    writeIfChanged(path.join(o.stateDir, 'uids.json'), JSON.stringify({ fetch: uid }) + '\n', 0o644);
    writeIfChanged(path.join(o.stateDir, 'internet-uids'), uid + '\n', 0o644);
    const uplink = path.join(o.toolRoot, 'mgu-uplink');
    if (fs.existsSync(path.join(uplink, 'current')) || fs.existsSync(path.join(uplink, 'uids.d'))) {
        try { mkdirp(path.join(uplink, 'uids.d')); writeIfChanged(path.join(uplink, 'uids.d', SELF), uid + '\n', 0o644); } catch (e) { o.log('internet uid: uplink drop-in: ' + e.message); }
    }
    return uid;
}
// one request in a child as uid (fetchCmd: ytd.js --fetch). The request, secrets and all, goes on its stdin
// (argv and env show in ps); {status, body} or {error} comes back on its stdout. Killed past the timeout.
function fetchRequest(o, uid, req) {
    return new Promise(function (resolve, reject) {
        let child;
        try {
            // (o.noSetuid: tests not run as root, which cannot switch uid)
            const ids = o.noSetuid ? {} : { uid: uid, gid: uid };
            child = cp.spawn(o.fetchCmd[0], o.fetchCmd.slice(1), Object.assign(ids, { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'ignore'] }));
        } catch (e) { return reject(e); }
        const chunks = [];
        let size = 0, done = false;
        const finish = function (e, v) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (e) { try { child.kill('SIGKILL'); } catch (x) { /* gone */ } reject(e); } else resolve(v);
        };
        const timer = setTimeout(function () { finish(new Error('timeout')); }, (req.timeoutMs || 10000) + 1000);
        child.on('error', finish);
        child.stdin.on('error', function () { /* it died: close says */ });
        child.stdout.on('data', function (c) {
            size += c.length;
            if (size > 24 << 20) return finish(new Error('answer too big')); // 8 MiB of body, JSON-escaped
            chunks.push(c);
            return undefined;
        });
        child.on('close', function () {
            let r = null;
            try { r = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* none */ }
            if (!r) return finish(new Error('fetch helper gave no answer'));
            if (r.error) return finish(new Error(r.error));
            return finish(null, { status: r.status, body: String(r.body), cookies: r.cookies });
        });
        child.stdin.end(JSON.stringify(req));
    });
}

// HTTP used by the unprivileged Bilibili request helper.
function ytRequest(method, url, headers, body, timeoutMs, lookup) {
    return new Promise(function (resolve, reject) {
        const u = require('url').parse(url);
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const h = Object.assign({ 'User-Agent': BILI_UA }, headers || {});
        if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
        let done = false, size = 0;
        const fail = function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } };
        const req = https.request({ hostname: u.hostname, port: u.port, path: u.path, method: method, headers: h, lookup: lookup }, function (res) {
            const chunks = [];
            res.on('data', function (c) {
                size += c.length;
                if (size > 8 << 20) { fail(new Error('answer too big')); req.abort(); return; }
                chunks.push(c);
            });
            res.on('end', function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), cookies: res.headers['set-cookie'] || [] });
            });
            res.on('error', fail);
        });
        const timer = setTimeout(function () { fail(new Error('timeout')); req.abort(); }, timeoutMs || 10000);
        req.on('error', fail);
        if (data) req.write(data);
        req.end();
    });
}

// ---------------------------------------------------------------- audio: BMW MediaPlayer
function Audio(opts, handlers) {
    this.opts = opts;
    this.h = handlers; // {time(v), state(v), error(v)}
    this.cc = null;
    this.mp = null;
    this.connId = null;
    this.staged = new Map();
    this.stageRoot = path.join(opts.cacheDir, 'player-audio');
}
Audio.prototype.init = async function () {
    if (this.cc && this.mp) return;
    const someip = typeof this.opts.someip === 'string' ? require(this.opts.someip) : this.opts.someip;
    // MainApp firmwares keep the generated SOME/IP descriptions in either directory.
    const cfg = (f) => {
        const candidates = [path.join(this.opts.srcGen, f), path.join(this.opts.srcGen, 'someip', f)];
        const file = candidates.filter((p) => fs.existsSync(p))[0];
        if (!file) throw new Error('SOME/IP description missing: ' + f);
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    };
    const cc = await someip.buildProxy(cfg('org_genivi_am_commandinterface_CommandControl.json'), '1');
    await cc.init();
    const mp = await someip.buildProxy(cfg('de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json'), 'OapGenericMedia');
    await mp.init();
    const h = this.h;
    const safe = (fn) => (v) => { try { fn(v); } catch (e) { this.opts.log('someip handler: ' + (e && e.stack || e)); } };
    mp.subscribe({ name: 'playerState', onReceive: safe(h.state) });
    mp.subscribe({ name: 'currentItemTime', onReceive: safe(h.time) });
    mp.subscribe({ name: 'playbackErrorEvent', onReceive: safe(h.error) });
    this.cc = cc;
    this.mp = mp;
};
Audio.prototype.waitAvailable = async function () {
    const end = Date.now() + this.opts.availWaitMs;
    while (!(await this.cc.isAvailable())) {
        if (Date.now() > end) throw new Error('CommandControl not available');
        await sleep(100);
    }
};
// At start: a connection from our source left by a killed daemon would hold the sink.
Audio.prototype.dropLeftovers = async function () {
    await this.waitAvailable();
    const list = await this.cc.getValue('listOfMainConnections');
    const ours = (Array.isArray(list) ? list : []).filter((c) => c && c.sourceID === SOURCE_ID);
    for (const c of ours) {
        const r = await this.cc.callMethod('disconnect', { mainConnectionID: c.mainConnectionID }, 5000).catch((e) => String(e));
        this.opts.log('leftover connection ' + c.mainConnectionID + ' disconnect ' + JSON.stringify(r));
    }
    return ours.length;
};
// The fetch UID owns the private download directory. Give MediaPlayer a root-owned,
// traversable directory with only a hard link to the finished audio file.
Audio.prototype.stage = function (file) {
    const cached = this.staged.get(file);
    if (cached) return cached;
    const st = fs.lstatSync(file);
    if (!st.isFile() || !st.size) throw new Error('音频文件为空或不可读');
    mkdirp(this.stageRoot);
    fs.chmodSync(this.stageRoot, 0o711);
    const dir = fs.mkdtempSync(path.join(this.stageRoot, 'item-'));
    const target = path.join(dir, path.basename(file));
    try {
        fs.chmodSync(dir, 0o711);
        fs.linkSync(file, target);
        fs.chmodSync(target, 0o644);
        this.staged.set(file, target);
        this.opts.log('MediaPlayer handoff ' + path.extname(file) + ' (' + st.size + ' bytes)');
        return target;
    } catch (e) {
        rmrf(dir);
        throw e;
    }
};
// release() waits for a play in flight, so a stop during connect/playFile still finds connId
Audio.prototype.play = function (file) {
    const p = this.playNow(file);
    this.pending = p.catch(() => {});
    return p;
};
Audio.prototype.playNow = async function (file) {
    await this.init();
    await this.waitAvailable();
    const r = await this.cc.callMethod('connect', { sourceID: SOURCE_ID, sinkID: SINK_ID }, 5000);
    this.opts.log('connect ' + JSON.stringify(r));
    if (!r || (r.amError !== 'E_OK' && r.amError !== 'E_ALREADY_EXISTS')) throw new Error('audio connect: ' + (r && r.amError));
    this.connId = r.mainConnectionID;
    if (this.connId === undefined || this.connId === null) this.connId = -1; // id unknown: release sweeps by source
    const p = await this.mp.callMethod('playFile', { path: this.stage(file), languageCode: 7695972 }, 5000);
    this.opts.log('playFile ' + JSON.stringify(p));
    if (!p || p.EntError !== 'OK') throw new Error('playFile: ' + (p && p.EntError));
};
// playFile again on the live connection: after a STOP the player needs the file, not PLAY
Audio.prototype.replay = function (file) {
    const p = this.mp.callMethod('playFile', { path: this.stage(file), languageCode: 7695972 }, 5000).then((r) => {
        this.opts.log('replay ' + JSON.stringify(r));
        if (!r || r.EntError !== 'OK') throw new Error('playFile: ' + (r && r.EntError));
    });
    this.pending = p.catch(() => {}); // release() waits for it, as for play()
    return p;
};
Audio.prototype.button = function (b) {
    if (!this.mp) return Promise.resolve();
    return this.mp.callMethod('sendButtonEvent', { button: b, action: 'PRESS' }, 3000)
        .catch((e) => this.opts.log(b + ' failed: ' + e));
};
Audio.prototype.seek = function (ms) {
    if (!this.mp) return Promise.resolve();
    return this.mp.callMethod('setTime', { newTimeElapsed: ms }, 3000).catch((e) => this.opts.log('setTime failed: ' + e));
};
// Every exit path ends here. Safe to call twice.
Audio.prototype.release = function () {
    if (!this.releasing) {
        this.releasing = this.releaseNow().then(() => { this.releasing = null; }, (e) => {
            this.releasing = null;
            throw e;
        });
    }
    return this.releasing;
};
Audio.prototype.releaseNow = async function () {
    try { await this.disconnect(); }
    finally {
        for (const file of this.staged.values()) {
            try { rmrf(path.dirname(file)); } catch (e) { this.opts.log('audio cleanup: ' + e.message); }
        }
        this.staged.clear();
    }
};
Audio.prototype.disconnect = async function () {
    if (this.pending) await this.pending;
    if (this.connId === null) return;
    const id = this.connId;
    this.connId = null;
    await this.button('STOP');
    try {
        if (id === -1) throw new Error('no connection id');
        this.opts.log('disconnect ' + JSON.stringify(await this.cc.callMethod('disconnect', { mainConnectionID: id }, 5000)));
    } catch (e) {
        this.opts.log('disconnect failed: ' + e + '; sweeping source ' + SOURCE_ID);
        await this.dropLeftovers().catch((e2) => this.opts.log('sweep failed: ' + e2));
    }
};

// ---------------------------------------------------------------- daemon
function Daemon(o) {
    this.opts = Object.assign(defaults(), o || {});
    this.log = this.opts.log;
    this.state = 'idle';
    this.cur = null;      // {id, title, dir, rect, fill, gen}
    this.gen = 0;         // bumps on every play/stop: stale async work checks it
    this.client = null;
    this.child = null;
    this.deaths = 0;
    this.videoOn = true;
    this.paused = false;
    this.elapsed = 0;
    this.total = 0;
    this.stoppedAt = null;
    this.lastTimeEv = 0;
    this.sawPlay = false;
    this.ticking = false;
    this.preparing = null; // id the fetcher is writing
    this.fetcher = null;   // ytfetch.py, as the fetch uid
    this.fetchedMs = Infinity; // video fetched up to there (pts ms)
    this.buffering = false;
    this.head = null;      // {ms}: playing audio.head.mp3 (the first ms of the audio) until audio.mp3 is ready
    this.fullReady = false; // audio.mp3 complete
    this.headWait = false; // past the head, waiting for audio.mp3: the player is paused, the state buffering
    this.switching = false; // head -> full: the player's events until the seek are the restart's, not ours
    this.settle = null;    // {ms, until}: after the switch, ignore the player's stale times below ms
    this.lastTickAt = 0;
    this.thumbQ = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
    this.thumbN = 0;
    this.timers = [];
    this.ready = new Promise((r) => { this.readyResolve = r; }); // leftover check done
    this.audio = new Audio(this.opts, {
        time: (v) => this.onTime(v),
        state: (v) => this.onPlayerState(v),
        error: (v) => this.onPlaybackError(v)
    });
    this.childFetch = !this.opts.ytRequest;
    if (this.childFetch) this.opts.ytRequest = (m, u, h, b, t) => this.fetch({ method: m, url: u, headers: h, body: b, timeoutMs: t });
    this.fetchUid = null;
    this.account = new Account(this.opts, (o) => this.emit(o));
}
// the fetch uid (picked on first need; none: an error naming why, never a crash)
Daemon.prototype.uid = function () {
    if (this.fetchUid === null) {
        try { this.fetchUid = pickFetchUid(this.opts); } catch (e) { this.log('internet uid: ' + e.message); }
    }
    if (this.fetchUid === null) throw Object.assign(new Error('no internet uid on the car (see the log)'), { noUid: true });
    return this.fetchUid;
};
// Bilibili API requests, as the fetch uid
Daemon.prototype.fetch = function (req) {
    try { return fetchRequest(this.opts, this.uid(), req); } catch (e) { return Promise.reject(e); }
};
// a helper (ytfetch.py, thumb.js) as the fetch uid, as fetchRequest spawns its child
Daemon.prototype.spawnFetchUid = function (cmd, args, stdin, group, pcm) {
    const ids = this.opts.noSetuid ? {} : { uid: this.uid(), gid: this.uid() };
    const stdio = [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'];
    if (pcm) stdio.push('pipe');
    return cp.spawn(cmd[0], cmd.slice(1).concat(args), Object.assign(ids, { cwd: '/', env: {}, detached: !!group, stdio }));
};
// ---- where each video was left (positions.json, kept after its files go): resume, Continue watching, progress bars
Daemon.prototype.positions = function () {
    if (!this.pos) this.pos = readJson(path.join(this.opts.cacheDir, 'positions.json')) || {};
    return this.pos;
};
Daemon.prototype.savePos = function (force) {
    const c = this.cur;
    if (!c || !this.total || this.head && !c.durationMs) return;
    if (!force && Date.now() - (this.posAt || 0) < 15000) return;
    this.posAt = Date.now();
    const p = this.positions(), m = readMeta(c.dir, c.id);
    p[c.id] = { ms: this.elapsed, total: this.total, done: this.total - this.elapsed < Math.max(5000, this.total * 0.05),
        at: Date.now(), title: c.title || m.title, channel: m.channel, duration_s: Math.round(this.total / 1000) };
    const ids = Object.keys(p).sort((a, b) => p[b].at - p[a].at);
    ids.slice(300).forEach((id) => { delete p[id]; });
    try {
        const f = path.join(this.opts.cacheDir, 'positions.json');
        fs.writeFileSync(f + '.tmp', JSON.stringify(p), { mode: 0o600 }); // the watch history: root only
        fs.renameSync(f + '.tmp', f);
    } catch (e) { this.log('positions: ' + e.message); }
};
Daemon.prototype.sendPositions = function () {
    const p = this.positions();
    this.emit({ ev: 'positions', items: Object.keys(p).sort((a, b) => p[b].at - p[a].at).map((id) => Object.assign({ id: id }, p[id])) });
};
// Chapters (if present in the media metadata).
Daemon.prototype.sendExtras = function () {
    const c = this.cur;
    if (c) this.emit({ ev: 'extras', id: c.id, chapters: c.chapters || [] });
};
Daemon.prototype.chownFetch = function (p) {
    if (!this.opts.noSetuid) fs.chownSync(p, this.uid(), this.uid());
};

Daemon.prototype.start = async function () {
    // 0711: the fetch uid reaches its own folders in it, nobody else can list what was watched
    try { mkdirp(this.opts.cacheDir); fs.chmodSync(this.opts.cacheDir, 0o711); } catch (e) { this.log('cache dir: ' + e.message); }
    try { mkdirp(this.opts.logDir); } catch (e) { this.log('log dir: ' + e.message); }
    this.listen();
    // the uplink learns our fetch uid at start (its 5 s rescan), before anyone signs in
    if (this.childFetch && this.fetchUid === null) { try { this.fetchUid = pickFetchUid(this.opts); } catch (e) { this.log('internet uid: ' + e.message); } }
    this.timers.push(setInterval(() => this.guard(() => this.watchdog()), 1000));
    this.prune();
    // The SOME/IP services may come up after us at boot: retry until the leftover check ran.
    for (let i = 0; ; i++) {
        try {
            await this.audio.init();
            if (!fs.existsSync(RIDETUBE)) await this.audio.dropLeftovers();
            try { rmrf(this.audio.stageRoot); } catch (e) { this.log('audio staging cleanup: ' + e.message); }
            this.readyResolve();
            break;
        } catch (e) {
            if (i % 12 === 0) this.log('someip not ready: ' + e.message);
            await sleep(5000);
        }
    }
};
Daemon.prototype.guard = function (fn) {
    try {
        const r = fn();
        if (r && r.catch) r.catch((e) => this.fault(e));
    } catch (e) {
        this.fault(e);
    }
};
// uncaughtException / unhandledRejection / handler errors: log, release audio, idle.
Daemon.prototype.fault = function (e) {
    this.log('fault: ' + (e && e.stack || e));
    this.emit({ ev: 'error', msg: 'internal error: ' + (e && e.message || e) });
    this.stop('idle').catch((e2) => this.log('stop after fault: ' + e2));
};

// ---- control socket
Daemon.prototype.listen = function () {
    const sock = this.opts.sock;
    try { mkdirp(path.dirname(sock)); } catch (e) { this.log('socket dir: ' + e.message); }
    try { fs.unlinkSync(sock); } catch (e) { /* none */ }
    this.server = net.createServer((c) => this.guard(() => this.onClient(c)));
    this.server.on('error', (e) => this.log('ctl server: ' + e.message));
    this.server.listen(sock, () => {
        try { fs.chmodSync(sock, 0o660); } catch (e) { this.log('chmod ctl.sock: ' + e.message); }
        const group = lines(path.join(this.opts.etcDir, 'group')).map((l) => l.split(':')).filter((f) => f[0] === 'tm_oap_app')[0];
        const gid = this.opts.sockGid !== null ? this.opts.sockGid : group && /^\d+$/.test(group[2]) ? Number(group[2]) : 12202;
        try { fs.chownSync(sock, 0, gid); } catch (e) { this.log('chown ctl.sock: ' + e.message); }
        this.log('listening on ' + sock);
    });
};
Daemon.prototype.onClient = function (c) {
    if (this.client) {
        this.log('new client replaces the old one');
        const old = this.client;
        this.client = null; // its close must not stop playback for the new one
        old.destroy();
    }
    this.client = c;
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', (d) => {
        buf += d;
        if (buf.length > 65536) { this.log('client line too long'); c.destroy(); return; }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) this.guard(() => this.onLine(line));
        }
    });
    c.on('error', (e) => this.log('client: ' + e.message));
    c.on('close', () => {
        if (this.client !== c) return;
        this.client = null;
        this.log('client gone: stop');
        this.stop('idle').catch((e) => this.log('stop: ' + e));
    });
};
Daemon.prototype.emit = function (o) {
    if (!this.client) return;
    try { this.client.write(JSON.stringify(o) + '\n'); } catch (e) { this.log('emit: ' + e.message); }
};
Daemon.prototype.onLine = function (line) {
    let m;
    try { m = JSON.parse(line); } catch (e) { return this.emit({ ev: 'error', msg: 'bad json' }); }
    if (!m || typeof m.cmd !== 'string') return this.emit({ ev: 'error', msg: 'no cmd' });
    this.usedAt = Date.now();
    switch (m.cmd) {
    case 'positions': return this.sendPositions();
    case 'status': this.sendState(); if (this.total) this.emit({ ev: 'time', elapsed: this.elapsed, total: this.total }); return undefined;
    case 'search': return this.search(m.q);
    case 'thumb': return this.thumb(m.id);
    case 'play': return this.play(m.id, m.rect, !!m.fill, m.at, m.quality, m.pcm === true, m.resume === false ? { at: 0 } : undefined);
    case 'pcm_route_result':
        if (this.pcm && m.token === this.pcm.token && this.pcm.routeReply) {
            this.pcm.routeReason = m.reason === 'busy' ? 'SmartX source occupied' :
                m.reason === 'unavailable' ? 'AudioManager unavailable' : null;
            this.pcm.routeReply(m.ok === true);
        }
        return undefined;
    case 'pcm_released':
        if (this.pcm && m.token === this.pcm.token && this.pcm.releaseReply) this.pcm.releaseReply(true);
        return undefined;
    case 'pause': return this.pause();
    case 'resume': return this.resume();
    case 'seek': return this.seek(m.ms);
    case 'stop': return this.stop('idle');
    case 'video': return this.setVideo(!!m.on);
    case 'fill': return this.setFill(!!m.on);
    case 'quality': return this.requality(m.quality);
    case 'auth': return this.account.start();
    case 'auth_status': return this.emit(this.account.status());
    case 'sign_out': return this.account.signOut();
    case 'feed': return this.account.feed(m.which);
    case 'channels': return this.account.channels();
    case 'channel': return this.account.channel(m.id);
    default: return this.emit({ ev: 'error', msg: 'unknown cmd ' + m.cmd });
    }
};
Daemon.prototype.setState = function (s) {
    this.state = s;
    this.sendState();
};
Daemon.prototype.sendState = function (pct) {
    this.buffering = this.isBuffering();
    const o = { ev: 'state', state: this.state, pct: pct === undefined ? (this.state === 'preparing' ? this.pct || 0 : null) : pct,
        id: this.cur ? this.cur.id : null, title: this.cur ? this.cur.title : null, buffering: this.buffering,
        sourceQuality: this.cur ? this.cur.sourceQuality : null, qualities: this.cur ? this.cur.qualities : null,
        preview: !!(this.cur && this.cur.preview), phase: this.cur && this.cur.phase };
    this.emit(o);
};
// playing ahead of the video fetched so far, while the fetcher still writes it
Daemon.prototype.isBuffering = function () {
    if (this.pcm && !this.pcm.closed) return this.state === 'playing' && (this.pcm.waiting || this.pcmVideoWait);
    return this.state === 'playing' && (this.headWait || (!!this.fetcher && this.elapsed + 1000 > this.fetchedMs));
};
Daemon.prototype.checkBuffering = function () {
    if (this.isBuffering() !== this.buffering) this.sendState();
};

Daemon.prototype.prune = function () {
    const protect = [];
    if (this.cur) protect.push(this.cur.id);
    if (this.preparing) protect.push(this.preparing);
    return pruneCache(this.opts.cacheDir, this.opts.keep, protect, this.log);
};
// ---- search / thumbs
Daemon.prototype.search = async function (q) {
    q = typeof q === 'string' ? q.trim().slice(0, 150) : '';
    if (!q) return this.emit({ ev: 'results', q: q, items: [] });
    try { return this.emit({ ev: 'results', q: q, items: await this.account.search(q) }); }
    catch (e) {
        this.log('search: ' + e.message);
        return this.emit({ ev: 'results', q: q, items: [], error: e.message === 'timeout' ? 'B 站搜索请求超时' : e.message });
    }
};
Daemon.prototype.thumb = async function (id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return this.emit({ ev: 'error', msg: 'bad id' });
    const tdir = path.join(this.opts.cacheDir, 'thumbs'), tf = path.join(tdir, id + '.rgba');
    const read = (f) => { try { return fs.readFileSync(f); } catch (e) { return null; } };
    let data = read(path.join(this.opts.cacheDir, id, 'thumb.rgba')) || read(tf);
    if (!data || !THUMB_SIZES[data.length]) {
        // at most 3 helpers at once: each is a Node 22 process, and a page asks for 20 thumbs
        const i = this.thumbN++ % this.thumbQ.length;
        const p = this.thumbQ[i].then(async () => {
            // Queued thumbnails should yield the connection and CPU to a newly opened video.
            for (let waited = 0; this.state === 'preparing' && waited < 5000; waited += 200) await sleep(200);
            return this.thumbFetch(id);
        });
        this.thumbQ[i] = p.catch(() => {});
        try { data = await p; } catch (e) {
            this.log('thumb ' + id + ': ' + e.message);
            this.account.covers.delete(id);
            this.account.covers.delete(id.split('_p')[0]);
            return this.emit({ ev: 'thumb_error', id: id });
        }
        try { mkdirp(tdir); fs.chmodSync(tdir, 0o700); fs.writeFileSync(tf, data, { mode: 0o600 }); this.pruneThumbs(tdir); } catch (e) { this.log('thumb cache: ' + e.message); }
    }
    const wh = THUMB_SIZES[data.length];
    if (!wh) { this.log('thumb ' + id + ': ' + data.length + ' bytes, not 160x90 or 320x180 RGBA'); return undefined; }
    return this.emit({ ev: 'thumb', id: id, w: wh[0], h: wh[1], rgba: data.toString('base64') });
};
// Fetch and decode as the uplink UID. Only a complete RGBA image enters the cache.
Daemon.prototype.thumbFetch = async function (id) {
    const cover = await this.account.cover(id);
    if (!cover) throw new Error('cover unavailable');
    return new Promise((resolve, reject) => {
        const child = this.spawnFetchUid(this.opts.thumbCmd, [cover]);
        const out = [], err = [];
        let size = 0;
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, 16000);
        child.stdout.on('data', (c) => { size += c.length; if (size <= 230400) out.push(c); });
        child.stderr.on('data', (c) => err.push(c));
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code, sig) => {
            clearTimeout(timer);
            if (code === 0 && size === 230400) return resolve(Buffer.concat(out));
            return reject(new Error('thumb helper ' + (sig || 'exit ' + code) + ', ' + size + ' bytes: ' + Buffer.concat(err).toString('utf8', 0, 200).trim()));
        });
    });
};
// thumbs/ keeps the newest thumbMax (mtime)
Daemon.prototype.pruneThumbs = function (tdir) {
    const names = list(tdir);
    if (names.length <= this.opts.thumbMax) return;
    names.map((n) => { try { return { n: n, t: fs.statSync(path.join(tdir, n)).mtime.getTime() }; } catch (e) { return { n: n, t: 0 }; } })
        .sort((x, y) => y.t - x.t).slice(this.opts.thumbMax)
        .forEach((x) => { try { fs.unlinkSync(path.join(tdir, x.n)); } catch (e) { /* gone */ } });
};

// ---- playback
Daemon.prototype.play = async function (id, rect, fill, at, quality, usePcm, restart) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return this.emit({ ev: 'error', msg: 'bad id' });
    if (!/^\d{2,4}x\d{2,4}$/.test(String(rect))) rect = '1280x720';
    if (fs.existsSync(RIDETUBE)) return this.emit({ ev: 'error', msg: '请先卸载原版 RideTube 播放服务' });
    const requestedAt = monoMs();
    const stopping = this.stop(null), previous = this.gen;
    await stopping;
    if (previous !== this.gen) return undefined;
    const gen = ++this.gen;
    const dir = path.join(this.opts.cacheDir, id);
    const meta0 = readMeta(dir, id);
    const mode = quality || 'auto';
    this.cur = { id: id, title: meta0.title, durationMs: meta0.duration_s > 0 ? meta0.duration_s * 1000 : undefined, dir: dir, rect: rect, fill: fill, gen: gen, height: qualityHeight(mode), quality: mode,
        chapters: (readJson(path.join(dir, 'meta.json')) || {}).chapters, usePcm, holdOnStart: restart && restart.paused,
        prefetchedStreams: restart && restart.streams, streamsAt: restart && restart.streamsAt, phase: 'source', requestedAt };
    const cur = this.cur;
    const was = this.positions()[id];
    // where it was left (here, else the position the tile carried): seek there on the first tick
    this.startAt = restart ? restart.at || null :
        !this.opts.resume ? null : was ? (!was.done && was.ms > 10000 ? was.ms : null) : (Number(at) > 10000 ? Math.floor(Number(at)) : null);
    this.pcmVideoWait = false;
    this.pcmVideoHeld = false;
    this.paused = false;
    this.posAt = Date.now();
    this.pct = 0;
    this.fetchedMs = Infinity;
    this.head = null;
    this.headWait = false;
    this.headStop = null;
    this.switching = false;
    this.settle = null;
    this.fullReady = true;
    let headMs = null;
    if (usePcm || !isPlayable(dir)) {
        this.fullReady = false;
        this.setState('preparing');
        // PCM gets one session. CDN recovery happens inside the track readers.
        const waits = usePcm ? [] : this.opts.fetchRetryMs || [];
        for (let k = 0; ; k++) {
            try {
                if (gen !== this.gen) return undefined;
                headMs = await this.fetchVideo(id, dir);
                break;
            } catch (e) {
                if (gen !== this.gen) return undefined;
                const hadPreview = cur.preview;
                this.killYtdec();
                if (hadPreview) this.sendState();
                if (e.pcmFallback) return this.failPcm(e.message);
                // the video itself refused (gone, private, members, age): no retry; else the network, maybe back soon
                if (k >= waits.length || PERMANENT_RE.test(e.message)) return this.failPlayback('fetch: ' + e.message);
                this.log('fetch ' + id + ': ' + e.message + ' - again in ' + waits[k] + ' ms');
                this.emit({ ev: 'retry', id: id, n: k + 1, msg: e.message });
                await sleep(waits[k]);
                if (gen !== this.gen) return undefined;
            }
        }
        if (gen !== this.gen) return undefined;
    }
    try { const now = new Date(); fs.utimesSync(dir, now, now); } catch (e) { /* LRU recency only */ }
    this.sendExtras();
    this.prune();
    this.deaths = 0;
    this.paused = false;
    this.elapsed = 0;
    this.total = 0;
    this.stoppedAt = null;
    this.sawPlay = false;
    this.ticking = false;
    this.lastTickAt = Date.now();
    if (this.pcm) {
        const pcm = this.pcm;
        const at = this.startAt || 0;
        const routed = await pcm.route();
        if (gen !== this.gen) return undefined;
        if (!routed || pcm.error) return this.failPcm(pcm.error || pcm.routeReason || 'SmartX route unavailable');
        this.startAt = null;
        this.elapsed = at;
        this.total = cur.durationMs || 0;
        this.paused = !!cur.holdOnStart;
        cur.holdOnStart = false;
        this.ticking = true;
        if (!this.child) this.spawnYtdec(at || null);
        this.setState(this.paused ? 'paused' : 'playing');
        this.emit({ ev: 'time', elapsed: this.elapsed, total: this.total });
        this.log('audio: SmartX PCM started in ' + (monoMs() - requestedAt) + ' ms (streams ' + cur.sourceMs +
            ', first frame data ' + cur.videoMs + ', PCM buffer ' + cur.audioMs + ')');
        this.pcmVideoGate();
        return undefined;
    }
    try {
        await withTimeout(this.ready, 10000, 'audio service'); // never connect before the leftover sweep
        if (gen !== this.gen) return undefined;
        if (headMs !== null && !this.fullReady) this.head = { ms: headMs };
        try {
            await this.audio.play(path.join(dir, this.head ? AUDIO_HEAD : AUDIO_FILE));
        } catch (e) {
            if (!this.head || gen !== this.gen) throw e;
            this.log('short MP3 unavailable: ' + e.message + '; waiting for full audio');
            this.head = null;
            await this.audio.release();
            if (!await cur.audioReady || gen !== this.gen) throw e;
            await this.audio.play(path.join(dir, AUDIO_FILE));
        }
    } catch (e) {
        if (gen !== this.gen) return this.audio.release();
        return this.failPlayback(e.message);
    }
    if (gen !== this.gen) return this.audio.release(); // stopped while connecting
    this.ticking = true;
    if (!this.child) this.spawnYtdec(null);
    this.setState('playing');
    if (this.head && this.fullReady) await this.switchToFull(); // audio.mp3 came during the connect
    return undefined;
};

Daemon.prototype.closePcm = async function () {
    const pcm = this.pcm;
    if (!pcm) return;
    await pcm.close();
    if (this.pcm === pcm) this.pcm = null;
};

Daemon.prototype.restartPcm = function (ms) {
    const c = this.cur;
    if (!c || c.restarting || !this.pcm || this.pcm.closed) return undefined;
    c.restarting = true;
    this.log('SmartX: seeking with PCM at ' + ms);
    const streams = Date.now() - c.streamsAt < STREAM_REUSE_MS && c.streamLink === this.videoLink() ? c.streams : undefined;
    return this.play(c.id, c.rect, c.fill, null, c.quality, true,
        { at: ms, paused: this.paused || !!c.holdOnStart, streams, streamsAt: c.streamsAt });
};

Daemon.prototype.failPcm = function (reason) {
    this.log('SmartX: ' + reason);
    const device = /\[Errno (\d+)\] ALSA (open|set_params|write|recover|delay)/.exec(reason);
    const detail = reason === 'SmartX source occupied' ? '车机音频通道被占用' :
        reason === 'AudioManager unavailable' ? '车机音频服务未就绪' :
        reason === 'SmartX route unavailable' ? '车机音频路由连接失败' :
        device ? '车机音频设备错误 ' + device[2] + '/' + device[1] :
        /^B 站.*音轨解码失败|^B 站音频下载或转换失败/.test(reason) ? '音轨解码失败' :
        reason === 'SmartX 设备启动超时' ? '车机音频设备启动超时' : 'PCM 输出失败';
    return this.failPlayback('实时音频未能播放 · ' + detail);
};

Daemon.prototype.pcmVideoGate = function () {
    const pcm = this.pcm;
    if (!pcm || pcm.closed || !this.ticking) return;
    const margin = this.pcmVideoWait ? 1600 : 500;
    this.pcmVideoWait = this.videoOn && this.elapsed + margin > this.fetchedMs;
    pcm.hold(this.paused || this.pcmVideoWait);
    const holdVideo = this.paused || this.pcmVideoWait || pcm.waiting;
    if (holdVideo !== this.pcmVideoHeld) {
        this.pcmVideoHeld = holdVideo;
        this.toYtdec(holdVideo ? 'pause' : 'resume');
    }
    this.checkBuffering();
};

Daemon.prototype.onPcm = function (pcm, m) {
    if (this.pcm !== pcm || pcm.closed || !this.ticking) return;
    if (m.ev === 'error') return this.failPcm(m.msg);
    if (m.ev === 'buffer') return this.pcmVideoGate();
    if (m.ev === 'ended') {
        if (this.total && m.ms + 3000 < this.total * 0.98) return this.failPlayback('音轨提前结束');
        this.elapsed = this.total || m.ms;
        return this.stop('ended');
    }
    if (m.ev !== 'time' || !Number.isFinite(m.ms)) return;
    this.elapsed = m.ms;
    this.lastTickAt = Date.now();
    this.toYtdec('clock ' + m.ms + ' ' + m.mono);
    this.pcmVideoGate();
    this.savePos(false);
    if (Date.now() - this.lastTimeEv >= 240) {
        this.lastTimeEv = Date.now();
        this.emit({ ev: 'time', elapsed: m.ms, total: this.total });
    }
};
// audio.mp3 is complete. On the head: switch now; paused: resume() switches (as after a STOP mid-file)
Daemon.prototype.onFullAudio = function () {
    this.fullReady = true;
    if (!this.head || !this.ticking || this.switching) return undefined; // not playing yet: play() picks it
    if (this.paused) {
        this.stoppedAt = this.elapsed;
        this.head = null;
        this.headWait = false;
        return undefined;
    }
    return this.switchToFull();
};
// The short MP3 and full MP3 are separate, complete files. Hold the picture
// while switching the stock player, then seek on the full file's own clock.
Daemon.prototype.switchToFull = async function () {
    if (!this.head || this.switching || !this.cur) return;
    const gen = this.gen, dir = this.cur.dir, headMs = this.head.ms, waiting = this.headWait;
    this.switching = true;
    this.head = null;
    this.sawPlay = false;
    this.toYtdec('pause');
    this.log('audio: short MP3 -> full at ' + this.elapsed + (waiting ? ' (waiting)' : ''));
    const file = path.join(dir, AUDIO_FILE);
    let target;
    const open = async (start) => {
        let timer = null, wake = null;
        const clock = new Promise((resolve) => {
            wake = (v) => {
                if (v && v.error) resolve(v.error);
                else if (!v || v.total > headMs + 500) resolve(null);
            };
        });
        this.switchClock = wake;
        try {
            await start();
            if (gen !== this.gen) return;
            const err = await Promise.race([clock, new Promise((r) => { timer = setTimeout(() => r(null), 1200); })]);
            if (err) throw new Error(err);
        } finally {
            clearTimeout(timer);
            if (this.switchClock === wake) this.switchClock = null;
        }
    };
    const reconnect = async () => {
        await this.audio.release();
        if (gen === this.gen) await open(() => this.audio.play(file));
    };
    try {
        if (this.headStop) await this.headStop;
        if (gen !== this.gen) return;
        if (!waiting) {
            try { await open(() => this.audio.replay(file)); }
            catch (e) {
                this.log('audio: reconnect after ' + e.message);
                await reconnect();
            }
        } else {
            await reconnect(); // a player explicitly stopped on the short file needs a new connection
        }
        if (gen !== this.gen) return;
        target = this.total ? Math.min(this.elapsed, Math.max(0, this.total - 1000)) : this.elapsed;
        await this.audio.seek(target);
    } catch (e) {
        if (gen !== this.gen) return;
        this.switching = false;
        return this.failPlayback('audio switch: ' + e.message);
    }
    if (gen !== this.gen) return;
    this.switching = false;
    this.headWait = false;
    this.headStop = null;
    this.elapsed = target;
    this.lastTickAt = Date.now();
    this.settle = { ms: target, until: Date.now() + 3000 };
    this.toYtdec('seek ' + target);
    if (this.paused) await this.hold(target); // pause pressed during the switch
    else this.toYtdec('resume');
    this.checkBuffering();
    try { fs.unlinkSync(path.join(dir, AUDIO_HEAD)); } catch (e) { /* already removed */ }
};
// When the short file is exhausted (or the user seeks past it), wait for the
// full file at this position without turning the pause into an end-of-video.
Daemon.prototype.waitFull = function (ms) {
    if (this.headWait) return this.headStop || Promise.resolve();
    this.log('audio: waiting for the full MP3 at ' + ms);
    this.headWait = true;
    this.elapsed = ms;
    this.toYtdec('pause');
    this.checkBuffering();
    this.sawPlay = false;
    this.headStop = this.audio.button('STOP');
    return this.headStop;
};
Daemon.prototype.videoLink = function () {
    try {
        const st = fs.statSync(this.opts.leaseFile);
        return st.ino + ':' + st.mtimeMs;
    } catch (e) { return 'default'; }
};
Daemon.prototype.cdnPreferences = function (link) {
    const routes = this.cdnRoutes;
    const preferred = {};
    if (!routes || routes.link !== link) return preferred;
    const now = monoMs();
    for (const kind of Object.keys(routes.tracks)) {
        const route = routes.tracks[kind];
        if (now - route.at < CDN_ROUTE_TTL_MS) preferred[kind] = route.host;
    }
    return preferred;
};
Daemon.prototype.observeCdn = function (link, m) {
    if (link === 'default' || this.videoLink() !== link || !['video', 'audio', 'mp4'].includes(m.kind) ||
        typeof m.host !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(m.host)) return;
    if (!this.cdnRoutes || this.cdnRoutes.link !== link) {
        this.cdnRoutes = { link, tracks: Object.create(null) };
    }
    const tracks = this.cdnRoutes.tracks, current = tracks[m.kind];
    if (m.ev === 'cdn_fault') {
        if (current && current.host === m.host) delete tracks[m.kind];
        return;
    }
    if (![m.first_ms, m.ms, m.bytes].every(Number.isFinite) || m.first_ms < 0 || m.ms < m.first_ms ||
        m.bytes < (m.kind === 'audio' ? 32768 : 131072)) return;
    this.log('CDN ' + m.kind + ' ' + m.host + ' first=' + m.first_ms + ' ms read=' + m.bytes + ' B/' + m.ms + ' ms');
    if (m.first_ms <= 1200 && m.bytes * 8000 / Math.max(1, m.ms) >= (m.kind === 'audio' ? 96000 : 500000)) {
        tracks[m.kind] = { host: m.host, at: monoMs() };
    } else if (current && current.host === m.host) delete tracks[m.kind];
};
Daemon.prototype.recentVideoRate = function (link) {
    const sample = this.videoRate;
    return sample && sample.link === link && monoMs() - sample.at < VIDEO_RATE_TTL_MS ? sample.bps : 0;
};
Daemon.prototype.observeVideoRate = function (cursor, m) {
    const bytes = m.wire_bytes - cursor.bytes, ms = m.wire_ms - cursor.ms;
    if (!Number.isFinite(bytes) || !Number.isFinite(ms) || ms < 250 || bytes < 128 * 1024) return;
    cursor.bytes = m.wire_bytes;
    cursor.ms = m.wire_ms;
    const bps = bytes * 8000 / ms, previous = this.recentVideoRate(cursor.link);
    // Reduce the estimate immediately on a slow sample, then raise it gradually.
    this.videoRate = { link: cursor.link, at: monoMs(), bps: previous && bps > previous ? (3 * previous + bps) / 4 : bps };
};
// Resolve when audio and the initial video buffer are ready. The fetcher keeps writing while we play.
Daemon.prototype.fetchVideo = async function (id, dir) {
    const cur = this.cur;
    const prefetched = cur.prefetchedStreams;
    const link = this.videoLink(), sample = { link, bytes: 0, ms: 0 };
    const recentBps = cur.quality === 'auto' && !this.startAt ? this.recentVideoRate(link) : 0;
    const streams = prefetched || await this.account.streams(id, cur.quality, false, recentBps);
    cur.prefetchedStreams = null;
    if (this.cur !== cur || this.gen !== cur.gen) throw new Error('playback replaced');
    if (!prefetched || !cur.streamsAt) cur.streamsAt = Date.now();
    cur.streams = streams;
    cur.streamLink = link;
    cur.sourceQuality = streams.sourceQuality;
    if (cur.quality === 'auto') cur.height = streams.maxHeight;
    cur.qualities = streams.qualities || [streams.sourceQuality];
    cur.sourceMs = monoMs() - cur.requestedAt;
    cur.phase = 'buffer';
    this.sendState();
    const realtime = cur.usePcm && process.platform === 'linux';
    const durationMs = streams.duration_s * 1000;
    const requestedMs = Number(this.startAt);
    const seek = Number.isFinite(requestedMs) ? Math.max(0, Math.floor(requestedMs)) : 0;
    const startMs = durationMs > 0 ? Math.min(seek, Math.max(0, durationMs - 1000)) : seek;
    this.startAt = startMs || null;
    const fast = cur.quality === 'auto' && !streams.progressive;
    this.log('B站播放 ' + id + ' qn=' + streams.sourceQuality + (streams.progressive ? ' MP4' : ' DASH'));
    return new Promise((resolve, reject) => {
        rmrf(dir); // a killed fetch's leftovers
        mkdirp(dir);
        fs.chmodSync(dir, 0o700);
        this.chownFetch(dir);
        const child = this.spawnFetchUid(this.opts.fetcher, [dir], true, process.platform === 'linux', realtime);
        child.stdin.on('error', () => { /* close reports an early exit */ });
        child.stdin.end(JSON.stringify(Object.assign({}, streams, {
            id, resumeMs: this.startAt || 0, pcm: !!realtime, fastCdn: fast, cdnPreferred: this.cdnPreferences(link)
        })) + '\n');
        this.fetcher = child;
        this.preparing = id;
        this.fetchedMs = 0;
        let audio = false, head = null, done = false, started = false, err = null, pcmFallback = false, audioReady;
        let pcm = null, startup = null, firstVideo = false, previewStarted = false;
        let pcmComplete = false, pendingPcmEnd = null;
        cur.audioReady = new Promise((r) => { audioReady = r; });
        const pct = (p) => {
            p = Math.min(99, Math.max(this.pct, Math.round(p)));
            if (p !== this.pct && this.state === 'preparing') { this.pct = p; this.sendState(); }
        };
        const check = () => {
            if (err || started) return;
            const canStart = pcm ? pcm.ready : audio || (head !== null && (!startMs || head >= startMs + 2500) &&
                this.fetchedMs >= startMs + this.opts.startVideoMs);
            const videoTarget = pcm ? startMs + this.opts.pcmVideoMs : this.opts.startVideoMs;
            const videoReady = done || this.fetchedMs >= videoTarget;
            if (pcm) {
                const phase = videoReady ? pcm.ready ? 'route' : 'audio' : 'buffer';
                const p = 8 + 49 * Math.min(1, Math.max(0, this.fetchedMs - startMs) / this.opts.pcmVideoMs) + (pcm.ready ? 34 : 0);
                if (phase !== cur.phase) { cur.phase = phase; this.sendState(); }
                pct(p);
            }
            if (canStart && videoReady) {
                started = true;
                clearTimeout(startup);
                resolve(audio ? null : head);
            }
        };
        const prepareAudio = () => {
            if (pcm && pcm.opened && (pcm.ready || firstVideo && !startMs)) pcm.route();
        };
        const armStartup = () => {
            if (!pcm || started || err) return;
            clearTimeout(startup);
            startup = setTimeout(() => {
                started = true;
                const error = new Error(pcm.opened ? '媒体缓冲超时' : 'SmartX 设备启动超时');
                reject(Object.assign(error, { pcmFallback: !pcm.opened }));
            }, 14000);
        };
        const end = (why) => {
            clearTimeout(startup);
            audioReady(false);
            if (!done) { try { signalFetch(child, 'SIGKILL'); } catch (e) { /* gone */ } }
            if (child === this.fetcher) {
                this.fetcher = null;
                this.preparing = null;
                if (done && why === 'exit 0') {
                    this.fetchedMs = Infinity;
                    if (pcm && pcm.error && this.ticking) this.guard(() => this.failPcm(pcm.error));
                }
                else if (pcm && started) {
                    pcm.error = err || pcm.error || why;
                    if (pcm.routeReply) pcm.routeReply(false);
                    if (this.ticking) this.guard(() => pcmFallback ? this.failPcm(pcm.error) : this.failPlayback(pcm.error));
                    return;
                }
                else if (started && !this.fullReady) { // playing the head: the rest of the audio never comes
                    this.failPlayback('fetch: ' + (err || why)).catch((e) => this.log(e));
                    return;
                } else if (started) {
                    this.failPlayback('视频下载中断 ' + (err || why)).catch((e) => this.log(e));
                    return;
                }
                this.checkBuffering();
            }
            // A short track can finish writing before the sink's READY reaches us.
            if (!started && pcm && done && why === 'exit 0' && !pcm.error && !pcm.closed && this.gen === cur.gen) {
                check();
                armStartup();
                return;
            }
            if (!started && pcm && done && pcm.error) {
                err = pcm.error;
                pcmFallback = true;
            }
            if (!started) { started = true; reject(Object.assign(new Error(err || why), { pcmFallback })); }
        };
        if (realtime) {
            pcm = this.pcm = new Realtime(this.opts, cur.gen, (m) => this.emit(m), (m) => this.guard(() => {
                if (this.cur !== cur || this.gen !== cur.gen || pcm.closed) return;
                if (m.ev === 'ended' && !pcmComplete && !done) { pendingPcmEnd = m; return; }
                if (m.ev === 'error') {
                    // EOF can reach the sink before the fetcher's error record. Give the
                    // producer a chance to distinguish transport failure from PCM failure.
                    if (m.incomplete && !pcmComplete && !done) return;
                    if (!started) { started = true; clearTimeout(startup); reject(Object.assign(new Error(m.msg), { pcmFallback: true })); return; }
                    if (pcm.routeReply) pcm.routeReply(false);
                }
                if (m.ev === 'ready') { cur.audioMs = monoMs() - cur.requestedAt; check(); }
                if (m.ev === 'opened' || m.ev === 'skip' || m.ev === 'ready') armStartup();
                if (m.ev === 'opened' || m.ev === 'ready') prepareAudio();
                return this.onPcm(pcm, m);
            }), startMs);
            pcm.pipe(child.stdio[3]);
            armStartup();
        }
        readline.createInterface({ input: child.stdout }).on('line', (l) => this.guard(() => {
            if (child !== this.fetcher) return;
            let m;
            try { m = JSON.parse(l); } catch (e) { return; }
            if (m.ev === 'cdn_sample' || m.ev === 'cdn_fault') {
                if (this.cur === cur && this.gen === cur.gen) this.observeCdn(link, m);
            } else if (m.ev === 'meta') {
                if (m.title) this.cur.title = String(m.title);
                if (m.duration_s > 0) this.cur.durationMs = m.duration_s * 1000;
                if (Array.isArray(m.chapters)) this.cur.chapters = m.chapters;
            } else if (m.ev === 'audio') { pct(0.7 * (Number(m.pct) || 0)); armStartup(); }
            else if (m.ev === 'audio_head' && Number(m.ms) > 0) { if (!audio && head === null) { head = Number(m.ms); pct(70); } }
            else if (m.ev === 'audio_ready') {
                audio = true;
                audioReady(true);
                pct(70);
                if (started) this.onFullAudio();
                else this.fullReady = true;
            }
            else if (m.ev === 'video') {
                if (fast) this.observeVideoRate(sample, m);
                if (Number(m.ms) > this.fetchedMs && this.fetchedMs < startMs + this.opts.pcmVideoMs) armStartup();
                this.fetchedMs = Number(m.ms) || 0;
                if (!firstVideo && Number(m.frames) > 0) {
                    firstVideo = true;
                    cur.videoMs = monoMs() - cur.requestedAt;
                    prepareAudio();
                }
                const previewAt = startMs;
                if (fast && firstVideo && !previewStarted && !this.child && !started &&
                    (!previewAt || this.fetchedMs >= previewAt + 1000)) {
                    previewStarted = true;
                    this.spawnYtdec(previewAt || null);
                }
                if (!pcm && (audio || head !== null)) pct(70 + 29 * Math.min(1, this.fetchedMs / this.opts.startVideoMs));
            } else if (m.ev === 'video_done' && pcm) {
                this.fetchedMs = Infinity;
            } else if (m.ev === 'pcm_done' || m.ev === 'done') {
                if (m.ev === 'pcm_done') pcmComplete = true;
                else done = true;
                if (pcm && pendingPcmEnd) {
                    const ended = pendingPcmEnd;
                    pendingPcmEnd = null;
                    this.guard(() => this.onPcm(pcm, ended));
                }
            }
            else if (m.ev === 'error') { err = String(m.msg); pcmFallback = m.pcmFallback === true; }
            check();
            if (pcm) this.pcmVideoGate();
            this.checkBuffering();
        }));
        readline.createInterface({ input: child.stderr }).on('line', (l) => {
            if (!pcm || child === this.fetcher) this.log('ytfetch: ' + l);
        });
        child.on('error', (e) => end(e.message));
        child.on('exit', (code) => {
            if (code !== 0) { try { signalFetch(child, 'SIGKILL'); } catch (e) { /* gone */ } }
        });
        child.on('close', (code, sig) => end(sig ? 'killed ' + sig : 'exit ' + code)); // close: after its last line
    });
};
// Linux isolates the media helper and its audio converter in one process group.
function signalFetch(child, signal) {
    if (process.platform === 'linux' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
}
// SIGTERM (it leaves .part files), SIGKILL after 3 s; resolves when it is gone
Daemon.prototype.stopFetch = function () {
    const c = this.fetcher;
    if (!c) return this.stoppingFetch || Promise.resolve();
    this.fetcher = null;
    this.preparing = null;
    this.stoppingFetch = new Promise((resolve) => {
        const t = setTimeout(() => { try { signalFetch(c, 'SIGKILL'); } catch (e) { /* gone */ } }, 3000);
        c.on('exit', () => { clearTimeout(t); resolve(); });
        if (c.exitCode !== null || c.signalCode !== null) { clearTimeout(t); resolve(); }
        try { signalFetch(c, 'SIGTERM'); } catch (e) { /* gone */ }
    }).then(() => { this.stoppingFetch = null; });
    return this.stoppingFetch;
};
Daemon.prototype.failPlayback = async function (msg) {
    const gen = this.gen;
    this.log('error: ' + msg);
    this.ticking = false;
    this.killYtdec();
    await Promise.all([this.audio.release(), this.stopFetch(), this.closePcm()]);
    if (this.gen !== gen) return;
    this.setState('error');
    this.emit({ ev: 'error', msg: msg });
};
// reason: 'idle' | 'ended' | null (internal, before a new play: no state event)
Daemon.prototype.stop = async function (reason) {
    if (this.ticking) {
        this.savePos(true);
        if (reason === 'ended' && this.pos && this.cur && this.pos[this.cur.id]) this.pos[this.cur.id].done = true;
        const p = this.cur && this.pos && this.pos[this.cur.id];
    }
    this.gen++;
    if (this.switchClock) this.switchClock();
    this.ticking = false;
    this.killYtdec();
    const gen = this.gen;
    await Promise.all([this.audio.release(), this.stopFetch(), this.closePcm()]);
    if (gen !== this.gen) return;
    if (reason) {
        this.setState(reason);
        if (this.pos) this.sendPositions();
        this.cur = null;
        this.prune();          // a played video goes
    }
};
Daemon.prototype.pause = async function () {
    if (this.state !== 'playing') return;
    this.paused = true;
    this.toYtdec('pause');
    this.setState('paused'); // at once: the button's reply can take seconds, and a second tap must not send it twice
    // the MediaPlayer answers OK to PAUSE (and PLAY) and plays on (car, 2026-11-03); STOP does stop it, and resume()
    // starts the file again where it stopped
    this.savePos(true);
    if (this.pcm) return this.pcmVideoGate();
    if (this.headWait || this.switching) return; // the audio transition will honor the pause
    await this.hold(this.elapsed); // (the last tick: at most a fraction of a second back)
};
// the player stopped at ms (STOP: our own, not the end of the file), for resume() to start it there again
Daemon.prototype.hold = function (ms) {
    this.stoppedAt = ms;
    this.elapsed = ms;
    this.sawPlay = false;
    return this.audio.button('STOP');
};
Daemon.prototype.resume = async function () {
    if (this.state !== 'paused') return;
    this.paused = false;
    this.lastProgress = Date.now();
    this.setState('playing');
    if (this.pcm) return this.pcmVideoGate();
    if (this.headWait || this.switching) return; // the audio transition will resume at the saved position
    if (this.stoppedAt !== null && this.stoppedAt !== undefined) { // the player stopped mid-file: start it again there
        const token = { gen: this.gen };
        this.resuming = token;
        try { await this.resumeStopped(token); } finally { if (this.resuming === token) this.resuming = null; }
        return;
    }
    this.toYtdec('resume');
    await this.audio.button('PLAY');
};
// Based on RideTube 8977a11: a restarting player's time starts at zero until its seek lands.
// Keep that temporary clock out of saved progress; a newer resume owns the connection and seek.
Daemon.prototype.resumeStopped = async function (token) {
    const gen = token.gen, gone = () => gen !== this.gen || this.resuming !== token;
    this.sawPlay = false; // the new file's own STOP/PLAY is not a stop mid-file
    this.toYtdec('seek ' + this.stoppedAt);
    this.toYtdec('resume');
    // stopped, the player ignores playFile and PLAY (car, 2026-11-03): a new connection, as a new video starts
    try {
        await this.audio.release();
        if (gone()) return;
        await this.audio.play(path.join(this.cur.dir, this.head ? AUDIO_HEAD : AUDIO_FILE));
    } catch (e) {
        if (!gone()) await this.failPlayback('resume: ' + e.message);
        return;
    }
    if (gone() || this.state !== 'playing') return; // stopped, or paused again meanwhile
    // a setTime before the new file's first tick is dropped (it started at 0 on the car): wait for one (3 s at most)
    let timer, waiter;
    try { await new Promise((r) => { waiter = r; this.tickWaiter = r; timer = setTimeout(r, 3000); }); }
    finally { clearTimeout(timer); if (this.tickWaiter === waiter) this.tickWaiter = null; }
    if (gone() || this.state !== 'playing') return;
    const at = this.stoppedAt;  // (a seek meanwhile moved it: seek() keeps it while the file restarts)
    this.stoppedAt = null;
    this.settle = { ms: at, until: Date.now() + 3000 };
    await this.audio.seek(at);
    if (!gone() && this.state === 'playing') {
        this.elapsed = at;
        this.lastTickAt = Date.now();
        this.toYtdec('clock ' + at + ' ' + monoMs());
    }
};
Daemon.prototype.seek = async function (ms) {
    if (this.state !== 'playing' && this.state !== 'paused') return;
    ms = Math.max(0, Math.floor(Number(ms) || 0));
    if (this.total) ms = Math.min(ms, Math.max(0, this.total - 1000));
    if (this.pcm) return this.restartPcm(ms);
    this.elapsed = ms;
    this.lastProgress = Date.now();
    this.lastTickAt = Date.now();
    this.settle = null; // a seek back right after the switch: its times are ours
    this.toYtdec('seek ' + ms);
    // shortcut: once waiting, a seek back into the head still waits for audio.mp3 (a few s), simpler than replaying the head
    if (this.headWait || this.switching) return this.checkBuffering();
    if (this.head && !this.switching && ms > this.head.ms - this.opts.headMarginMs) return this.waitFull(ms);
    this.checkBuffering();
    if (this.stoppedAt !== null && this.stoppedAt !== undefined) { this.stoppedAt = ms; return undefined; } // resume() replays there
    await this.audio.seek(ms);
};
Daemon.prototype.setVideo = function (on) {
    this.videoOn = on;
    this.lastProgress = Date.now();
    this.toYtdec('video ' + (on ? 1 : 0));
    if (this.pcm) this.pcmVideoGate();
};

// zoom while playing: ytdec again at the clock with the other mode (the sound plays on)
Daemon.prototype.setFill = function (on) {
    const c = this.cur;
    if (!c || c.fill === on) return;
    c.fill = on;
    if (!this.child) return; // the next ytdec takes it
    this.killYtdec();
    this.spawnYtdec(this.paused || this.headWait ? this.elapsed : this.elapsed + (Date.now() - this.lastTickAt));
};
// Video quality while playing: the same video fetched again at that height, from where it is
Daemon.prototype.requality = async function (quality, force) {
    const c = this.cur;
    if (!c) return undefined;
    const height = qualityHeight(quality);
    const token = {};
    c.qualityRequest = token;
    let streams;
    if (!force) {
        if (this.state !== 'playing' && this.state !== 'paused') return undefined;
        if (QUALITY_QN[height] === c.sourceQuality) { c.height = height; c.quality = quality; return undefined; }
        try {
            streams = await this.account.streams(c.id, quality, quality !== 'auto');
        } catch (e) {
            if (this.gen === c.gen && c.qualityRequest === token) {
                this.log('quality ' + quality + ': ' + e.message);
                this.emit({ ev: 'quality_done', unavailable: true });
            }
            return undefined;
        }
        if (this.gen !== c.gen || this.cur !== c || c.qualityRequest !== token) return undefined;
        if (streams.sourceQuality === c.sourceQuality || (quality !== 'auto' && height >= c.height && streams.sourceQuality < c.sourceQuality)) {
            c.qualities = Array.from(new Set((c.qualities || []).concat(streams.qualities || [])));
            this.sendState();
            this.emit({ ev: 'quality_done', unavailable: true });
            return undefined;
        }
    }
    const at = this.elapsed, paused = this.paused;
    const stopped = this.stop(null), gen = this.gen;
    await stopped;
    if (this.gen !== gen || this.cur !== c) return undefined;
    rmrf(c.dir);
    return this.play(c.id, c.rect, c.fill, null, quality, c.usePcm, { at, paused, streams });
};

// ---- MediaPlayer events
Daemon.prototype.onTime = function (v) {
    if (this.pcm || !this.ticking || !v || typeof v.elapsed !== 'number') return;
    if (!(v.total > 1)) return; // {elapsed:0,total:1} right after playFile
    if (this.tickWaiter) { this.tickWaiter(); return; } // resume(): the restarted file plays, its setTime can follow
    if (this.resuming && this.resuming.gen === this.gen) return;
    if (this.switching) { if (this.switchClock) this.switchClock(v); return; }
    if (this.headWait) return;
    if (this.settle && Date.now() < this.settle.until && v.elapsed < this.settle.ms - 2000) return; // before our setTime landed
    this.elapsed = v.elapsed;
    this.lastTickAt = Date.now();
    this.total = this.head ? (this.cur.durationMs || v.total) : v.total; // the head's own total is ~60 s
    if (this.head && !this.fullReady && v.elapsed >= this.head.ms - this.opts.headMarginMs) {
        this.waitFull(v.elapsed).catch((e) => this.log(e));
        return;
    }
    if (this.startAt || this.cur.holdOnStart) {
        const cur = this.cur, at = this.startAt, hold = cur.holdOnStart;
        this.startAt = null;
        cur.holdOnStart = false;
        (at ? this.seek(at) : Promise.resolve()).then(() => {
            if (hold && this.cur === cur && cur.gen === this.gen && this.state === 'playing') {
                if (at) this.elapsed = at;
                return this.pause();
            }
        }).catch((e) => this.log('resume at: ' + e));
        return;
    }
    this.savePos(false);
    this.toYtdec('clock ' + v.elapsed + ' ' + monoMs());
    this.checkBuffering();
    const now = Date.now();
    if (now - this.lastTimeEv >= 240) { // <= 4/s
        this.lastTimeEv = now;
        this.emit({ ev: 'time', elapsed: v.elapsed, total: this.total });
    }
};
Daemon.prototype.onPlayerState = function (v) {
    if (this.pcm || !this.ticking) return;
    if (v === 'PLAYER_STATE_PLAY') this.sawPlay = true; // also mid-switch: the full file's own PLAY arms its end
    if (this.switching || this.headWait || (this.resuming && this.resuming.gen === this.gen)) return;
    // the head file ran out (before onTime saw its end): wait for audio.mp3, never `ended`
    if (v === 'PLAYER_STATE_STOP' && this.head && this.sawPlay) {
        this.sawPlay = false;
        if (!this.headWait) this.waitFull(this.elapsed).catch((e) => this.log(e));
        return;
    }
    // STOP we did not ask for, after it played: the end of the file when near it, else the player
    // stopped mid-file (seen after a PLAY sent while playing): hold as paused, resume restarts it there.
    if (v === 'PLAYER_STATE_STOP' && this.sawPlay) {
        this.sawPlay = false;
        if (!this.total || this.total - this.elapsed < 4000) {
            this.log('audio ended');
            this.stop('ended').catch((e) => this.log('stop: ' + e));
            return;
        }
        this.log('audio stopped at ' + this.elapsed + ' of ' + this.total + ': held as paused');
        this.stoppedAt = this.elapsed;
        this.paused = true;
        this.toYtdec('pause');
        this.setState('paused');
    }
};
Daemon.prototype.onPlaybackError = function (v) {
    if (this.pcm || !this.ticking) return;
    if (this.head && v && v.event === 'ITEM_UNPLAYABLE') {
        this.log('short MP3 refused; waiting for the full file');
        this.waitFull(this.elapsed).then(() => { if (this.fullReady && this.head && this.ticking) return this.switchToFull(); })
            .catch((e) => this.log(e));
        return;
    }
    const msg = v && v.event === 'ITEM_UNPLAYABLE' ? 'BMW 播放器拒绝 MP3 音轨 (ITEM_UNPLAYABLE)' : 'playback error ' + JSON.stringify(v);
    if (this.switching && this.switchClock) { this.switchClock({ error: msg }); return; }
    this.failPlayback(msg).catch((e) => this.log(e));
};

// ---- ytdec
Daemon.prototype.spawnYtdec = function (seekMs) {
    const c = this.cur;
    const args = ['--dir', c.dir, '--rect', c.rect];
    if (c.fill) args.push('--fill');
    args.push('--log', path.join(this.opts.logDir, 'ytdec.log'));
    let child;
    try {
        child = cp.spawn(this.opts.ytdec, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
        return this.ytdecDied(null, 'spawn: ' + e.message);
    }
    this.child = child;
    this.lastProgress = Date.now();
    this.lastDecoded = -1;
    this.eof = false;
    child.stdin.on('error', () => { /* EPIPE when it dies: handled by exit */ });
    child.on('error', (e) => this.ytdecDied(child, e.message));
    child.on('exit', (code, sig) => this.ytdecDied(child, 'exit ' + (sig || code)));
    readline.createInterface({ input: child.stdout }).on('line', (l) => this.guard(() => this.onYtdecLine(child, l)));
    if (seekMs !== null) this.toYtdec('seek ' + seekMs);
    if (this.paused || this.pcmVideoHeld && this.pcm) this.toYtdec('pause');
    if (!this.videoOn) this.toYtdec('video 0');
    this.log('ytdec ' + args.join(' ') + (seekMs !== null ? ' (restart at ' + seekMs + ')' : ''));
};
Daemon.prototype.toYtdec = function (line) {
    if (!this.child) return;
    try { this.child.stdin.write(line + '\n'); } catch (e) { /* dying */ }
};
Daemon.prototype.onYtdecLine = function (child, l) {
    if (child !== this.child) return;
    let m;
    try { m = JSON.parse(l); } catch (e) { return; }
    if (m.ev === 'stats') {
        if (typeof m.decoded === 'number' && m.decoded !== this.lastDecoded) {
            this.lastDecoded = m.decoded;
            this.lastProgress = Date.now();
        }
    } else if (m.ev === 'ready') {
        this.lastProgress = Date.now();
        if (this.state === 'preparing' && this.cur && !this.cur.preview) {
            this.cur.preview = true;
            this.sendState();
        }
    } else if (m.ev === 'eof') {
        this.eof = true;
    } else if (m.ev === 'error') {
        this.log('ytdec error: ' + m.msg);
    }
};
Daemon.prototype.killYtdec = function () {
    if (this.cur) this.cur.preview = false;
    const c = this.child;
    if (!c) return;
    this.child = null;
    try { c.stdin.write('quit\n'); } catch (e) { /* gone */ }
    try { c.stdin.end(); } catch (e) { /* gone */ }
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1000);
    c.on('exit', () => clearTimeout(t));
};
// Child died on its own (or the watchdog killed it): restart once at the clock, then audio only.
Daemon.prototype.ytdecDied = function (child, why) {
    if (child && child !== this.child) return; // a child we already let go
    this.child = null;
    if (this.cur && this.cur.preview) {
        this.cur.preview = false;
        if (this.state === 'preparing') this.sendState();
    }
    if (!this.ticking) return;
    this.deaths++;
    this.log('ytdec died (' + why + '), death ' + this.deaths);
    if (this.deaths === 1) return this.spawnYtdec(this.elapsed);
    if (this.cur && this.cur.sourceQuality === 80) {
        this.log('1080p decoder failed twice; retrying at 720p');
        return this.requality('720', true).catch((e) => this.failPlayback(e.message));
    }
    this.emit({ ev: 'error', msg: 'video failed, audio only' });
    return undefined;
};
Daemon.prototype.watchdog = function () {
    if (!this.child || this.state !== 'playing' || !this.videoOn || this.eof) return;
    // waiting for video not fetched yet (buffering, or the fetcher ended early): not a stall
    if (this.headWait || this.pcm && (this.pcm.waiting || this.pcmVideoWait) || this.elapsed + 1000 > this.fetchedMs) { this.lastProgress = Date.now(); return; }
    if (Date.now() - this.lastProgress < this.opts.watchdogMs) return;
    this.log('watchdog: no decoded frames for ' + this.opts.watchdogMs + ' ms');
    const c = this.child;
    try { c.kill('SIGKILL'); } catch (e) { /* gone */ }
    this.lastProgress = Date.now();
};

Daemon.prototype.close = async function () {
    this.timers.forEach(clearInterval);
    this.account.close();
    await this.stop(null);
    if (this.client) this.client.destroy();
    if (this.server) this.server.close();
};

module.exports = { qualityHeight: qualityHeight, Daemon: Daemon, Audio: Audio, Account: Account, isPlayable: isPlayable, ytRequest: ytRequest, uplinkLookup: uplinkLookup, pickFetchUid: pickFetchUid, fetchRequest: fetchRequest, listCache: listCache, pruneCache: pruneCache, isReady: isReady };

// the uplink's DNS servers (its lease): the system resolver (127.0.0.1) answers no internet names. No
// lease (uplink down or not installed): the system resolver, as before
function uplinkLookup(leaseFile, search) {
    const servers = ((readJson(leaseFile || '/run/mgu-uplink/lease.json') || {}).dns || []).filter((x) => typeof x === 'string');
    if (!servers.length) return undefined;
    // Let a slow DNS server on the current hotspot yield sooner on interactive search.
    const r = new (require('dns').Resolver)(search ? { timeout: 1250, tries: 2 } : undefined);
    r.setServers(servers);
    return function (host, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        r.resolve4(host, (e, a) => (e ? cb(e) : opts.all ? cb(null, a.map((address) => ({ address, family: 4 }))) : cb(null, a[0], 4)));
    };
}

if (require.main === module && process.argv[2] === '--fetch') {
    // the fetch helper (as the fetch uid): one request from stdin, its answer on stdout
    let input = '';
    const out = (o) => process.stdout.write(JSON.stringify(o), () => process.exit(0));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { input += d; });
    process.stdin.on('end', () => {
        let q;
        try { q = JSON.parse(input); } catch (e) { return out({ error: 'bad request' }); }
        const search = /^https:\/\/api\.bilibili\.com\/x\/web-interface\/(?:wbi\/search\/type|search\/all\/v2)\?/.test(q.url);
        return ytRequest(q.method, q.url, q.headers, q.body, q.timeoutMs, uplinkLookup(undefined, search)).then(out, (e) => out({ error: e.message }));
    });
} else if (require.main === module) {
    const d = new Daemon();
    process.on('uncaughtException', (e) => d.fault(e));
    process.on('unhandledRejection', (e) => d.fault(e));
    let exiting = false;
    ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((s) => process.on(s, () => {
        if (exiting) return;
        exiting = true;
        d.log(s + ': releasing audio');
        setTimeout(() => process.exit(0), 4000); // TimeoutStopSec=5
        d.close().then(() => process.exit(0), () => process.exit(0));
    }));
    d.start().catch((e) => d.fault(e));
}
