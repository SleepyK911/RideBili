'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Account, directId, pickStreams, qualityHeight } = require('../../native/ride-bili-d/bili');
const { headUnit } = require('./hu-stub');
const { Model } = require('../../apps/ride_bili/yt');
const { Audio, Daemon } = require('../../native/ride-bili-d/ytd');

const id = 'BV1CmxQ6pEC5';
const scanUrl = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=' + 'a'.repeat(64);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, what) {
    for (let i = 0; i < 100; i++) { if (f()) return; await sleep(30); }
    throw new Error('timed out: ' + what);
}

async function account(dir) {
    const file = path.join(dir, 'account.json');
    const events = [];
    let code = 86101;
    const client = new Account({ accountFile: file, ytRequest: async (method, url, h) => {
        let data, cookies;
        const u = require('url').parse(url);
        assert.strictEqual(method, 'GET');
        if (u.path.endsWith('/generate')) data = { url: scanUrl, qrcode_key: 'a'.repeat(32) };
        else if (u.pathname.endsWith('/poll')) {
            assert(!h.Cookie);
            data = { code: code };
            if (code === 0) cookies = ['SESSDATA=test%2Csession; Domain=.bilibili.com; Secure; HttpOnly'];
        } else if (u.pathname.endsWith('/nav')) {
            assert.strictEqual(h.Cookie, 'SESSDATA=test%2Csession');
            data = { isLogin: true, mid: 1234 };
        } else throw new Error('unexpected request ' + url);
        return { status: 200, body: JSON.stringify({ code: 0, data: data }), cookies: cookies };
    } }, (event) => events.push(event));
    await client.start();
    assert.strictEqual(client.status().url, scanUrl);
    clearTimeout(client.pending.timer);
    await client.poll();
    assert.strictEqual(client.status().scanned, false);
    clearTimeout(client.pending.timer);
    code = 86090; await client.poll();
    assert.strictEqual(client.status().scanned, true);
    clearTimeout(client.pending.timer);
    code = 0; await client.poll();
    assert.strictEqual(client.status().state, 'signed_in');
    assert.strictEqual(new Account({ accountFile: file }, () => {}).status().state, 'signed_in');
    assert(!JSON.stringify(events).includes('test%2Csession'));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    client.signOut();
    assert(!fs.existsSync(file));
    assert.strictEqual(client.status().state, 'signed_out');
    await client.start(); clearTimeout(client.pending.timer);
    code = 86038; await client.poll();
    assert.strictEqual(events[events.length - 1].state, 'error');
    assert.strictEqual(directId('https://www.bilibili.com/video/' + id + '/?p=2'), id + '_p2');
    assert.strictEqual(directId('https://elsewhere.test/video/' + id), null);
    const baseUrl = 'https://test.bilivideo.com/media';
    const video = [[80, 1920, 1080, 'avc1.1', '30'], [64, 1280, 720, 'avc1.1', '60'], [64, 720, 1280, 'avc1.1', '30'], [64, 1280, 720, 'hvc1.1', '30'], [32, 852, 480, 'avc1.1', '30']]
        .map(([id, width, height, codecs, frameRate]) => ({ id, width, height, codecs, frameRate, baseUrl }));
    const dash = { video, audio: [{ codecs: 'mp4a.40.2', baseUrl }] };
    assert.strictEqual(pickStreams(dash, 1080).height, 1080);
    assert.strictEqual(pickStreams(dash, 480).height, 480);
    const withAudioChoices = Object.assign({}, dash, { audio: [
        { codecs: 'mp4a.40.2', bandwidth: 192000, baseUrl: baseUrl + '/high-audio' },
        { codecs: 'mp4a.40.2', bandwidth: 64000, baseUrl: baseUrl + '/light-audio' }
    ] });
    assert.strictEqual(pickStreams(withAudioChoices, '1080').audio[0], baseUrl + '/light-audio');
    const low = Object.assign({}, video[4], { baseUrl: baseUrl + '/low', bandwidth: 300000 });
    const high = Object.assign({}, video[4], { baseUrl: baseUrl + '/high', bandwidth: 800000 });
    const variants = Object.assign({}, dash, { video: video.concat([high, low]) });
    const adaptive = pickStreams(variants, 'auto');
    assert.strictEqual(adaptive.sourceQuality, 32);
    assert.strictEqual(adaptive.video[0], high.baseUrl);
    const hd = Object.assign({}, video[2], { baseUrl: baseUrl + '/hd', bandwidth: 1800000 });
    variants.video.push(hd);
    assert.strictEqual(pickStreams(variants, 'auto', 6000000).video[0], high.baseUrl);
    assert.strictEqual(pickStreams(variants, 'auto', 3000000).video[0], high.baseUrl);
    assert.strictEqual(pickStreams(variants, 'auto', 1500000).video[0], high.baseUrl);
    assert.strictEqual(pickStreams(variants, 'auto', 950000).video[0], low.baseUrl);
    assert.strictEqual(pickStreams(variants, '480').video[0], high.baseUrl);
    const onlyHd = pickStreams(Object.assign({}, dash, { video: video.slice(0, 4) }), 'auto');
    assert.strictEqual(onlyHd.sourceQuality, 64);
    assert.strictEqual(onlyHd.maxHeight, 720);
    console.log('ok QR login lifecycle, expiration, local credentials, DASH quality and codec selection');
}

async function playbackAndThumbs(dir) {
    const akamai = 'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/video.m4s';
    const video = { id: 80, width: 1920, height: 1080, codecid: 7, frame_rate: '30000/1001', base_url: akamai };
    const audio = { id: 30232, mime_type: 'audio/mp4', baseUrl: akamai };
    assert.strictEqual(qualityHeight(), 1080);
    assert.strictEqual(pickStreams({ video: [video], audio: [audio] }, 1080).video[0], akamai);
    assert.strictEqual(pickStreams({ video: [video], audio: [audio] }, 720), null);
    assert.strictEqual(pickStreams({ video: [Object.assign({}, video, { frame_rate: '60000/1001' })], audio: [audio] }, 1080), null);
    assert.strictEqual(pickStreams({ video: [Object.assign({}, video, { codecid: 12 })], audio: [audio] }, 1080), null);
    assert.strictEqual(pickStreams({ video: [Object.assign({}, video, { base_url: 'https://other.akamaized.net/a' })], audio: [audio] }, 1080), null);
    const client = new Account({ accountFile: path.join(dir, 'test-session.json'), log() {} }, () => {});
    client.saved = { cookies: { SESSDATA: 'example' } };
    const attempts = [];
    let progressive = false, signedLow = false, views = 0;
    const low = Object.assign({}, video, { id: 32, width: 864, height: 480 });
    client.api = async (end, q, opt) => {
        if (end.endsWith('/view')) {
            views++;
            return { pages: [{ cid: 1, duration: 12 }], title: 'sample',
                pic: 'https://other.akamaized.net/cover.jpg', cover: 'https://i0.hdslb.com/cover.jpg' };
        }
        attempts.push([q.fnval, q.qn, opt.guest]);
        if (q.fnval === 1) return { durl: [{ url: akamai }], video_codecid: 7, format: 'mp4', quality: q.high_quality ? 64 : 16 };
        if (signedLow) return { dash: { video: [q.fnval === 4048 ? low : video], audio: [audio] }, accept_quality: [80, 32] };
        if (!opt.guest || progressive) return { dash: { video: [], audio: [] } };
        return { dash: { video: [low], audio: [audio] } };
    };
    const dash = await client.streams(id, 1080);
    assert.strictEqual(dash.sourceQuality, 32);
    assert.deepStrictEqual(attempts, [[4048, 80, false], [16, 80, false], [4048, 80, true]]);
    assert.strictEqual(client.status().state, 'signed_in');
    progressive = true;
    const mp4 = await client.streams(id, 1080);
    assert.deepStrictEqual(mp4.progressive, [akamai]);
    assert.strictEqual(mp4.maxHeight, 480);
    assert.strictEqual(await client.cover(id), 'https://i0.hdslb.com/cover.jpg');
    assert.strictEqual(views, 1);
    signedLow = true;
    assert.strictEqual((await client.streams(id, 1080)).sourceQuality, 80);
    const beforeAuto = attempts.length;
    assert.strictEqual((await client.streams(id, 'auto')).sourceQuality, 32);
    assert.deepStrictEqual(attempts.slice(beforeAuto), [[4048, 32, false]]);
    const beforeWarm = attempts.length;
    assert.strictEqual((await client.streams(id, 'auto', false, 6000000)).sourceQuality, 32);
    assert.deepStrictEqual(attempts.slice(beforeWarm), [[4048, 32, false]]);
    signedLow = false;
    progressive = false;
    const hd = await client.streams(id, 720, true);
    assert.strictEqual(hd.sourceQuality, 64);
    assert.deepStrictEqual(hd.qualities, [64, 32]);
    const tileId = 'BV1EWxd6sExz';
    client.rows([{ bvid: tileId, videos: 1, cid: 2345, duration: 80, title: 'known CID' }]);
    assert.strictEqual((await client.streams(tileId, 480)).title, 'known CID');
    assert.strictEqual(views, 1, 'single-part feed with CID skips /view');

    const sent = [];
    const model = new Model((m) => { sent.push(m); return true; });
    model.setConnected(true);
    model.onMsg({ ev: 'results', items: [{ id }] });
    assert(model.wantThumb(id));
    model.onMsg({ ev: 'thumb_error', id });
    assert(!model.wantThumb(id));
    assert.strictEqual(model.error, null);
    model.thumbFailures.set(id, Date.now() - 1);
    assert(model.wantThumb(id));
    model.onMsg({ ev: 'thumb', id, w: 160, h: 90, rgba: Buffer.alloc(57600).toString('base64') });
    assert(model.thumbs[id] && !model.pending.has(id));
    console.log('ok 1080p, alternate CDN and metadata, signed-in playback fallback, cover recovery');
}

async function keywordSearch(dir) {
    const video = { bvid: id, title: '搜索样本', duration: '1:02' };
    const attempts = [];
    let primary = { result: [video] };
    const client = new Account({ accountFile: path.join(dir, 'search-session.json'), ytRequest: async (_, url, h, body, timeout) => {
        const u = new (require('url').URL)(url);
        let data;
        if (u.pathname.endsWith('/spi')) data = { b_3: 'device' };
        else if (u.pathname.endsWith('/nav')) {
            const key = 'https://i0.hdslb.com/bfs/wbi/' + '1'.repeat(32) + '.png';
            data = { isLogin: true, wbi_img: { img_url: key, sub_url: key } };
        } else {
            attempts.push(u.pathname);
            assert.strictEqual(u.searchParams.get('keyword'), '成都 美食');
            if (u.pathname.endsWith('/search/type')) {
                assert(u.searchParams.has('w_rid'));
                assert(h.Cookie.includes('SESSDATA=search-test'));
                assert(timeout > 0 && timeout <= 7000);
                if (primary instanceof Error) throw primary;
                data = primary;
            } else {
                assert(u.pathname.endsWith('/search/all/v2'));
                assert.strictEqual(h.Cookie, undefined);
                assert.strictEqual(timeout, 5000);
                data = { result: [{ result_type: 'bili_user', data: [video] }, { result_type: 'video', data: [video] }] };
            }
        }
        return { status: 200, body: JSON.stringify({ code: 0, data }) };
    } }, () => {});
    client.saved = { cookies: { SESSDATA: 'search-test' } };
    for (const [reply, expected, calls] of [[primary, 1, 1], [{ result: [], numResults: 0 }, 0, 1],
        [{ v_voucher: 'challenge' }, 1, 2], [new Error('timeout'), 1, 2]]) {
        attempts.length = 0;
        primary = reply;
        assert.strictEqual((await client.search('成都 美食')).length, expected);
        assert.strictEqual(attempts.length, calls);
        assert(client.saved);
    }
    attempts.length = 0;
    await client.api('/x/web-interface/wbi/search/type', { keyword: '成都 美食' }, { wbi: true, deadline: Date.now() - 1 })
        .then(() => assert.fail('expired search must not send'), (e) => assert.strictEqual(e.message, 'timeout'));
    assert.deepStrictEqual(attempts, []);
    console.log('ok WBI search, genuine empty results, bounded public fallback and intact account');
}

async function audioHandoff(dir) {
    const root = path.join(dir, 'cache'), privateDir = path.join(root, 'private');
    fs.mkdirSync(root, 0o711); fs.mkdirSync(privateDir, 0o700);
    const src = path.join(privateDir, 'audio.mp3');
    fs.writeFileSync(src, 'finished audio', { mode: 0o600 });
    const a = new Audio({ cacheDir: root, log() {} }, {});
    const calls = [];
    a.cc = { isAvailable: async () => true, callMethod: async (name) => {
        calls.push(name);
        return { amError: 'E_OK', mainConnectionID: 1 };
    } };
    let exposed = null;
    a.mp = { callMethod: async (name, args) => {
        calls.push(name);
        if (name === 'playFile') {
            exposed = args.path;
            assert(exposed.startsWith(path.join(root, 'player-audio') + path.sep));
            assert.strictEqual(fs.readFileSync(exposed, 'utf8'), 'finished audio');
            if (process.platform !== 'win32') {
                assert.strictEqual(fs.statSync(exposed).mode & 0o777, 0o644);
                assert.strictEqual(fs.statSync(path.dirname(exposed)).mode & 0o777, 0o711);
                assert.strictEqual(fs.statSync(privateDir).mode & 0o777, 0o700);
            }
        }
        return { EntError: 'OK' };
    } };
    await a.play(src);
    assert(fs.existsSync(exposed));
    await Promise.all([a.release(), a.release()]);
    assert.deepStrictEqual(calls, ['connect', 'playFile', 'sendButtonEvent', 'disconnect']);
    assert(!fs.existsSync(exposed));
    assert(fs.existsSync(src));
    console.log('ok BMW audio handoff, file access and cleanup');
}

async function qualitySwitch(dir) {
    const daemon = new Daemon({ cacheDir: dir, log() {} });
    daemon.videoLink = () => 'old-link';
    const route = { ev: 'cdn_sample', kind: 'video', host: 'fast.bilivideo.com', first_ms: 240, ms: 420, bytes: 131072 };
    daemon.observeCdn('old-link', route);
    daemon.observeCdn('old-link', Object.assign({}, route, { kind: 'audio', first_ms: 1500, ms: 2000 }));
    assert.deepStrictEqual(daemon.cdnPreferences('old-link'), { video: route.host });
    assert.deepStrictEqual(daemon.cdnPreferences('new-link'), {});
    daemon.cdnRoutes.tracks.video.at -= 91000;
    assert.deepStrictEqual(daemon.cdnPreferences('old-link'), {});
    daemon.observeCdn('old-link', route);
    daemon.observeCdn('old-link', Object.assign({}, route, { ev: 'cdn_fault' }));
    assert.deepStrictEqual(daemon.cdnPreferences('old-link'), {});
    const cursor = { link: 'old-link', bytes: 0, ms: 0 };
    daemon.observeVideoRate(cursor, { wire_bytes: 500000, wire_ms: 500 });
    assert.strictEqual(daemon.recentVideoRate('old-link'), 8000000);
    assert.strictEqual(daemon.recentVideoRate('new-link'), 0);
    daemon.observeVideoRate(cursor, { wire_bytes: 750000, wire_ms: 1500 });
    assert.strictEqual(daemon.recentVideoRate('old-link'), 2000000);
    daemon.videoRate.at -= 91000;
    assert.strictEqual(daemon.recentVideoRate('old-link'), 0);
    daemon.cur = { id, gen: 3, height: 1080, sourceQuality: 32, qualities: [32, 16], dir: path.join(dir, 'quality'), usePcm: true };
    daemon.gen = 3;
    daemon.state = 'paused'; daemon.paused = true; daemon.elapsed = 3100;
    let prepared = { sourceQuality: 32, qualities: [32, 16] }, starts = 0, stops = 0;
    daemon.account.streams = async (key, height, preferMp4) => {
        assert.strictEqual(key, id); assert(preferMp4); return prepared;
    };
    daemon.stop = async () => { stops++; daemon.gen++; };
    daemon.play = async (key, rect, fill, at, q, pcm, restart) => {
        starts++;
        assert.strictEqual(q, '720'); assert(pcm);
        assert.deepStrictEqual(restart, { at: 3100, paused: true, streams: prepared });
    };
    await daemon.requality('1080');
    assert.strictEqual(stops, 0);
    prepared = { sourceQuality: 64, qualities: [64, 32], progressive: ['hd'] };
    await daemon.requality('720');
    assert.strictEqual(stops, 1); assert.strictEqual(starts, 1);
    daemon.cur.quality = 'auto';
    daemon.cur.streams = prepared;
    daemon.cur.streamsAt = Date.now();
    daemon.cur.streamLink = daemon.videoLink();
    daemon.pcm = {};
    daemon.play = async (key, rect, fill, at, q, pcm, restart) => {
        assert.strictEqual(q, 'auto'); assert(pcm);
        assert.strictEqual(restart.at, 4100); assert(restart.paused);
        assert.strictEqual(restart.streams, prepared);
    };
    await daemon.seek(4100);
    daemon.cur.restarting = false;
    daemon.cur.streamsAt -= 46000;
    daemon.play = async (key, rect, fill, at, q, pcm, restart) => {
        assert(pcm);
        assert.strictEqual(restart.streams, undefined);
    };
    await daemon.restartPcm(3100);
    console.log('ok quality change and seek retain PCM and pause');
}

async function shortAudio(dir) {
    const d = new Daemon({ cacheDir: dir, log() {}, ytRequest() {} });
    const calls = [], clip = { id, dir, durationMs: 240000 };
    const reset = () => {
        Object.assign(d, { cur: clip, state: 'playing', ticking: true, fullReady: false, switching: false,
            head: { ms: 30000 }, headWait: false, headStop: null, elapsed: 7000, total: 240000, paused: false });
        calls.length = 0;
    };
    d.toYtdec = (c) => calls.push(c);
    d.failPlayback = async (e) => { throw new Error(e); };
    const markAudio = () => d.onTime({ elapsed: 0, total: 240000 });
    d.audio = {
        replay: async (file) => { calls.push('replay ' + path.basename(file)); markAudio(); },
        play: async (file) => { calls.push('play ' + path.basename(file)); markAudio(); },
        seek: async (t) => calls.push('audio seek ' + t),
        button: async (b) => calls.push('audio ' + b),
        release: async () => calls.push('release')
    };
    reset();
    await d.onFullAudio();
    assert.deepStrictEqual(calls, ['pause', 'replay audio.mp3', 'audio seek 7000', 'seek 7000', 'resume']);
    assert.strictEqual(d.elapsed, 7000);
    assert.strictEqual(d.head, null);

    reset();
    let stop;
    d.audio.button = () => new Promise((r) => { stop = r; calls.push('audio STOP'); });
    const seek = d.seek(90000);
    const full = d.onFullAudio();
    await sleep(1);
    assert(!calls.includes('play audio.mp3'), 'full audio waits for STOP of the excerpt');
    await d.seek(105000);
    stop();
    await seek; await full;
    assert(calls.includes('audio seek 105000'));
    assert(!calls.includes('replay audio.mp3'), 'resume from buffering reconnects');
    assert(!d.headWait && d.state === 'playing');

    reset();
    d.audio.replay = async () => { calls.push('refused'); d.onPlaybackError({ event: 'ITEM_UNPLAYABLE' }); };
    await d.onFullAudio();
    assert(calls.includes('refused') && calls.includes('release') && calls.includes('play audio.mp3'));
    assert(calls.includes('audio seek 7000'));

    reset();
    d.paused = true; d.state = 'paused';
    await d.onFullAudio();
    assert.strictEqual(d.stoppedAt, 7000);
    assert(!calls.length && !d.head);

    reset();
    let finishReplay;
    d.audio.replay = () => new Promise((r) => { finishReplay = () => { markAudio(); r(); }; });
    const handoff = d.onFullAudio();
    await d.pause();
    await d.resume();
    assert(d.switching && d.state === 'playing' && !calls.includes('release'));
    finishReplay();
    await handoff;
    assert(calls.includes('audio seek 7000') && calls.includes('resume'));
    console.log('ok short MP3 handoff, seek beyond buffered audio, paused handoff');

    reset();
    d.head = null; d.state = 'paused'; d.paused = true; d.stoppedAt = 90000; d.elapsed = 90000;
    d.settle = null;
    let release, play;
    d.audio.release = () => new Promise((r) => { release = r; });
    d.audio.play = () => new Promise((r) => { play = r; });
    const resumed = d.resume();
    markAudio();
    assert.strictEqual(d.elapsed, 90000, 'release-time ticks must not reset saved progress');
    release(); await until(() => play, 'MP3 replay starts');
    markAudio();
    assert.strictEqual(d.elapsed, 90000, 'new file ticks before play resolves are temporary');
    play(); await until(() => d.tickWaiter, 'restarted clock waiter');
    markAudio(); await resumed;
    assert(calls.includes('audio seek 90000'));
    assert.strictEqual(d.elapsed, 90000);
    assert.strictEqual(d.resuming, null);
    d.onTime({ elapsed: 0, total: 240000 });
    assert.strictEqual(d.elapsed, 90000, 'late old ticks are ignored until the seek settles');

    d.state = 'paused'; d.paused = true; d.stoppedAt = 120000;
    calls.length = 0;
    const releases = [];
    d.audio.release = () => new Promise((r) => releases.push(r));
    const oldResume = d.resume();
    d.state = 'paused'; d.paused = true; d.stoppedAt = 125000;
    const newResume = d.resume();
    releases[0](); await oldResume;
    assert(d.resuming, 'the old resume must not clear the newer owner');
    releases[1](); await sleep(1); play();
    await until(() => d.tickWaiter, 'newer MP3 clock waiter');
    markAudio(); await newResume;
    assert.deepStrictEqual(calls.filter((x) => x.indexOf('audio seek ') === 0), ['audio seek 125000']);
    assert.strictEqual(d.elapsed, 125000);
    console.log('ok MP3 resume ignores temporary clocks and superseded restarts');
}

async function app(dir) {
    const sock = process.platform === 'win32' ? '\\\\.\\pipe\\ridebili-test-' + process.pid : path.join(dir, 'app.sock');
    const stream = path.join(dir, 'render.bin');
    const commands = [], faults = [];
    let conn = null;
    const server = net.createServer((c) => {
        conn = c; let buf = '';
        c.setEncoding('utf8'); c.on('data', (data) => {
            buf += data;
            const lines = buf.split('\n'); buf = lines.pop();
            lines.forEach((l) => commands.push(JSON.parse(l)));
        });
    });
    await new Promise((r, j) => server.once('error', j).listen(sock, r));
    const sent = (cmd, f) => commands.some((m) => m.cmd === cmd && (!f || f(m)));
    const say = (m) => conn.write(JSON.stringify(m) + '\n');
    process.env.MGU_YT_SOCKET = sock;
    process.env.MGU_RENDERD_FILE = stream;
    const frame = process.env.MGU_YT_VIDEO = path.join(dir, 'mgu-video-ridetube');
    const hu = headUnit(path.resolve(__dirname, '../../dist/ride_bili'), {
        dataDir: dir, fresh: true, image: () => Promise.resolve(),
        log: { info() {}, debug() {}, warn() {}, error(...args) { faults.push(args.join(' ')); } }
    });
    assert.strictEqual(hu.spec.title, 'RideBili');
    assert(hu.spec.screens.every((s) => s.title === '小宁兄弟 - ( ゜- ゜)つロ 乾杯~'));
    hu.settings.values.playbackQuality = '1080'; // An older per-app preference.
    assert(!hu.spec.settings.some((s) => s.key === 'playbackQuality'));
    let speedWatch = 0;
    hu.ctx.signals.watch = async () => { speedWatch++; return {}; };
    hu.start();
    await hu.ui.open('VIEW');
    await until(() => sent('auth_status'), 'app connection');
    say({ ev: 'auth', state: 'signed_out' });
    await until(() => sent('feed', (m) => m.which === 'home'), 'guest home');
    say({ ev: 'feed', which: 'home', items: [{ id, title: '汽车测试', duration_s: 96 }] });
    await sleep(120); await hu.loopFn();
    const homes = () => commands.filter((m) => m.cmd === 'feed' && m.which === 'home').length;
    hu.handlers.BTN_HOME();
    hu.handlers.BTN_HOME(); // duplicate callback from one press is ignored
    await sleep(160);
    assert.strictEqual(homes(), 1);
    hu.handlers.BTN_HOME();
    await until(() => homes() === 2, 'two separate Home presses refresh');
    say({ ev: 'feed', which: 'home', items: [{ id, title: '汽车测试', duration_s: 96 }] });
    await sleep(140);
    hu.handlers.BTN_RESULTS();
    hu.handlers.BTN_HOME();
    await sleep(140);
    assert.strictEqual(homes(), 2, 'single press returns to the cached Home');
    const suspends = [];
    const originalSuspend = hu.display.suspend.bind(hu.display);
    hu.display.suspend = (on) => { suspends.push(on); originalSuspend(on); };
    let notify;
    hu.ctx.app = { getUseCaseFactory: async () => ({ create: async () => ({ token: 't', proxy: {
        init: async () => {}, waitUntilAvailable: async () => {},
        notify: { subscribe: async (fn) => { notify = fn; return 1; }, unsubscribe: async () => {} },
        interactionState: { getValue: async () => 'READY' },
        start: async () => {
            assert(hu.display.suspended);
            notify({ interactionState: 'COMPLETED', interactionParameters: new Map([[102, id], [105, true]]) });
        }
    } }) }) };
    await hu.handlers.BTN_SEARCH();
    await until(() => sent('search', (m) => m.q === id), 'system keyboard submits text');
    assert.deepStrictEqual(suspends, [true, false]);
    const own = hu.display.own.bind(hu.display);
    hu.display.own = () => !hu.display.suspended;
    hu.ctx.app = { getUseCaseFactory: async () => { throw new Error('keyboard unavailable'); } };
    await hu.handlers.BTN_SEARCH();
    await hu.loopFn();
    const key = (id) => hu.display.pageTargets.find((t) => t.key === 'key:' + id).run();
    key('0:0'); key('control:5');
    await until(() => sent('search', (m) => m.q === '1'), 'fallback keyboard submits text');
    assert.deepStrictEqual(suspends, [true, false, true, false]);
    hu.display.own = own;
    hu.handlers.BTN_ACCOUNT();
    await until(() => sent('auth'), 'menu opens QR login');
    say({ ev: 'auth', state: 'code', url: scanUrl });
    await sleep(100); await hu.loopFn();
    assert(fs.statSync(stream).size > 10000, 'renderer accepts QR commands');
    hu.handlers.BTN_NOW();
    fs.writeFileSync(frame, 'decoder file');
    say({ ev: 'state', state: 'playing', id, title: '汽车测试', sourceQuality: 32, qualities: [32, 16] });
    await until(() => sent('video', (m) => m.on), 'picture requested without speed telemetry');
    await sleep(350); await hu.loopFn();
    hu.display.own = () => true;
    hu.display.active = () => true;
    Object.assign(hu.display.place, { full: true, w: 1600, h: 520, ox: 0, oy: 0, scale: 1 });
    hu.display.onPageFocus('ov:q');
    await hu.loopFn();
    const target = (key) => hu.display.pageTargets.find((t) => t.key === key);
    target('ov:q').run();
    await hu.loopFn();
    assert.deepStrictEqual(hu.display.pageTargets.map((t) => t.key),
        ['quality:close', 'quality:auto', 'quality:1080', 'quality:720', 'quality:480', 'quality:360']);
    assert(!sent('quality'));
    hu.display.onBack(true);
    await hu.loopFn();
    assert(target('ov:q'));
    target('ov:q').run();
    await hu.loopFn();
    target('quality:720').run();
    await until(() => sent('quality', (m) => m.quality === '720'), 'popup chooses a single quality');
    assert.strictEqual(commands.filter((m) => m.cmd === 'quality').length, 1);
    const nextId = 'BV1EWxd6sExz';
    hu.handlers.BTN_HOME();
    say({ ev: 'feed', which: 'home', items: [{ id: nextId, title: '下一条', duration_s: 96 }] });
    await sleep(100); await hu.loopFn();
    hu.display.pageTargets.find((t) => t.key.endsWith(':' + nextId)).run();
    await until(() => sent('play', (m) => m.id === nextId && m.quality === 'auto' && m.resume === false), 'normal tile starts from the beginning at default quality');
    assert.strictEqual(speedWatch, 0, 'no motion signal subscribed');
    hu.handlers.BTN_HOME(); await sleep(160); hu.handlers.BTN_HOME();
    await sleep(100);
    const beforeRestart = homes(), authRequests = commands.filter((m) => m.cmd === 'auth_status').length;
    conn.destroy();
    await until(() => commands.filter((m) => m.cmd === 'auth_status').length > authRequests, 'daemon reconnect');
    say({ ev: 'auth', state: 'signed_out' });
    await until(() => homes() === beforeRestart + 1, 'interrupted Home request retried after reconnect');
    say({ ev: 'feed', which: 'home', items: [{ id, title: '服务恢复后的首页', duration_s: 96 }] });
    await sleep(100); await hu.loopFn();
    assert(hu.display.pageTargets.some((t) => t.key.endsWith(':' + id)), 'Home targets restored after service restart');
    assert.deepStrictEqual(faults, []);
    conn.end(); server.close();
    console.log('ok staged MGU UI, guest home, login drawing and foreground picture without vehicle signals');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ridebili-'));
account(dir).then(() => keywordSearch(dir)).then(() => playbackAndThumbs(dir)).then(() => audioHandoff(dir)).then(() => qualitySwitch(dir)).then(() => shortAudio(dir)).then(() => app(dir)).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
