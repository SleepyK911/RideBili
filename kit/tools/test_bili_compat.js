'use strict';
// Linux / Node 8: real Unix sockets, renderer updates and daemon restarts.
const assert = require('assert'), fs = require('fs'), net = require('net'), os = require('os'), path = require('path');
const { RenderClient, SOCKETS } = require('../runtime/renderd');
const { Ctl } = require('../../apps/ride_bili/yt');
const { Audio } = require('../../native/ride-bili-d/ytd');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-compat-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = { info() {}, warn() {}, error() {} };
const u32 = (...a) => Buffer.from(new Uint32Array(a).buffer);
const packet = (t, b) => Buffer.concat([u32(t, b.length), b]);
const ready = (s) => s.write(Buffer.concat([packet(0x4d520101, u32(1, 1, 31)), packet(101, u32(4, 1920, 720, 1))]));
async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await sleep(10); } throw Error('timeout'); }
let seq = 0;
async function rendererCase(first, check, alias) {
    const paths = ['community', 'store'].map((n) => path.join(tmp, n + (++seq) + '.sock'));
    const conns = [], counts = [0, 0];
    const servers = paths.map((p, i) => net.createServer((s) => {
        conns.push(s); counts[i]++; s.on('error', () => {}); s.resume();
        if (!i) first(s, counts[i]); else ready(s);
    }));
    const active = alias ? [1] : [0, 1];
    for (const i of active) await new Promise((r, j) => servers[i].once('error', j).listen(paths[i], r));
    if (alias) fs.symlinkSync(paths[1], paths[0]);
    const g = new RenderClient('ride_bili', log, { native: true, requireNative: true, sockets: paths.slice().reverse(), handshakeMs: 90, retryMs: 20 });
    let n = 0; g.on('ready', () => n++);
    try { g.connect(); g.connect(); await check(g, counts, () => n, conns); }
    finally { g.close(); conns.forEach((s) => s.destroy()); await Promise.all(active.map((i) => new Promise((r) => servers[i].close(r)))); }
}
async function audioConfigs() {
    const names = ['org_genivi_am_commandinterface_CommandControl.json', 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json'];
    for (const sub of ['', 'someip']) {
        const root = path.join(tmp, 'cfg' + (++seq)); fs.mkdirSync(root);
        const dir = sub ? path.join(root, sub) : root; if (sub) fs.mkdirSync(dir);
        names.forEach((n, i) => fs.writeFileSync(path.join(dir, n), JSON.stringify({ fixture: i })));
        const seen = [];
        const a = new Audio({ srcGen: root, cacheDir: root, log() {}, someip: { buildProxy: async (c, instance) => {
            seen.push([c.fixture, instance]); return { init: async () => {}, subscribe() {} };
        } } }, {});
        await a.init();
        assert.deepStrictEqual(seen, [[0, '1'], [1, 'OapGenericMedia']]);
    }
}
(async () => {
    assert.strictEqual(SOCKETS[0], '/run/mgu-render/render.sock');
    await rendererCase(ready, async (g, count, n) => {
        await until(() => n()); assert(g.native && g.info.controller); assert.deepStrictEqual(count, [1, 0]);
    });
    console.log('ok compatible community renderer preferred when independently listening');
    await rendererCase(ready, async (g, count, n) => {
        await until(() => n()); assert(g.path.includes('store')); assert.deepStrictEqual(count, [0, 1]);
    }, true);
    console.log('ok community symlink does not change the Store renderer connection');
    await rendererCase((s) => s.write(packet(101, u32(4, 1920, 720, 1))), async (g, count, n) => {
        await until(() => n()); assert(g.native); assert.deepStrictEqual(count, [1, 1]);
    });
    console.log('ok legacy READY alone is not accepted for RideBili pictures/video/input');
    await rendererCase((s) => s.write(Buffer.concat([packet(0x4d520101, u32(1, 1, 30)), packet(101, u32(4, 1920, 720, 0))])), async (g, count, n) => {
        await until(() => n()); assert(g.native && g.touch); assert.deepStrictEqual(count, [1, 1]);
    });
    console.log('ok renderer with no touch falls back to a capable renderer');
    await rendererCase((s) => s.write(packet(0x4d520101, u32(1, 1, 31))), async (g, count, n) => {
        await until(() => n()); assert(g.native); assert.deepStrictEqual(count, [1, 1]);
    });
    console.log('ok stalled READY handshake falls back instead of leaving a blank page');
    await rendererCase((s) => s.write(packet(101, u32(4))), async (g, count, n) => {
        await until(() => n()); assert(g.native); assert.deepStrictEqual(count, [1, 1]);
    });
    console.log('ok malformed renderer handshake reconnects without an uncaught exception');
    await rendererCase((s, n) => { if (n === 1) ready(s); else { s.write(u32(102, 8, 1)); setTimeout(() => s.destroy(), 10); } }, async (g, count, n, conns) => {
        await until(() => n()); g.grab(true); g.show(true); conns[0].destroy();
        await until(() => n() === 2); assert(g.path.includes('store'));
        assert(g.visible && g.grabbing); assert(g.native); assert.deepStrictEqual(count, [2, 1]);
    });
    console.log('ok renderer restart and partial packet recover with visibility and controller intent');
    const sock = path.join(tmp, 'control.sock'), events = [];
    const c = new Ctl(sock, log); let peer;
    c.on('down', (e) => events.push(e)); c.on('up', () => events.push('up')); c.on('msg', (m) => events.push(m.ev));
    const server = net.createServer((s) => { peer = s; s.on('error', () => {}); s.resume(); s.write('{"ev":"state"}\n'); });
    try {
        c.connect(); c.connect(); await until(() => events.indexOf('ENOENT') >= 0);
        await new Promise((r, j) => server.once('error', j).listen(sock, r));
        await until(() => events.indexOf('state') >= 0);
        assert(c.up && c.failure === null); assert.strictEqual(events.filter((x) => x === 'up').length, 1);
    } finally { c.close(); if (peer) peer.destroy(); await new Promise((r) => server.close(r)); }
    console.log('ok daemon missing at app startup, then available: reconnects automatically');
    await audioConfigs(); console.log('ok both MainApp SOME/IP description layouts');
})().then(() => process.exit(0), (e) => { console.error(e.stack); process.exit(1); });
