'use strict';
// A staged app with the real draw scheduler, Unix sockets and visibility events.
// HMI image uploads deliberately never answer. No BMW SDK or hardware is used.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { headUnit } = require('./hu-stub');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-live-'));
process.env.MGU_RENDERD_SOCKET = path.join(dir, 'render.sock');
process.env.MGU_YT_SOCKET = path.join(dir, 'ctl.sock');
delete process.env.MGU_RENDERD_FILE;
const id = 'BV1CmxQ6pEC5', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u32 = (...a) => Buffer.from(new Uint32Array(a).buffer);
function msg(type, p) { return Buffer.concat([u32(type, p.length), p]); }
async function until(fn, why) { for (let i = 0; i < 800; i++) { if (fn()) return; await sleep(10); } throw Error('timeout: ' + why); }
const peers = [], commands = [], renders = [], errors = [];
let ctlPeer;
const renderServer = net.createServer((s) => {
    peers.push(s); const r = { s, frames: 0, pictures: 0 }; renders.push(r);
    let buf = Buffer.alloc(0); s.on('error', () => {});
    s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 8) {
            const t = buf.readUInt32LE(0), n = buf.readUInt32LE(4);
            if (buf.length < 8 + n) break;
            const p = buf.slice(8, 8 + n); buf = buf.slice(8 + n);
            if (t === 1) s.write(Buffer.concat([msg(0x4d520101, u32(1, 1, 31)), msg(101, u32(4, 1920, 720, 1))]));
            if (t === 3) s.write(msg(0x4d520102, u32(1, p.readUInt32LE(0), 1)));
            if (t === 10 && p.length > 12) r.pictures++;
            if (t === 7) { r.frames++; s.write(msg(102, u32(r.frames, 0))); }
        }
    });
});
const ctlServer = net.createServer((s) => {
    ctlPeer = s;
    peers.push(s); let buf = ''; s.setEncoding('utf8'); s.on('error', () => {});
    const say = (o) => s.write(JSON.stringify(o) + '\n');
    s.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); commands.push(m);
            if (m.cmd === 'status') say({ ev: 'state', state: 'idle' });
            if (m.cmd === 'auth_status') say({ ev: 'auth', state: 'signed_out' });
            if (m.cmd === 'positions') say({ ev: 'positions', items: [] });
            if (m.cmd === 'feed') say({ ev: 'feed', which: m.which, items: [{ id, title: '复审测试视频', duration_s: 96 }] });
            if (m.cmd === 'thumb') say({ ev: 'thumb', id, w: 320, h: 180, rgba: Buffer.alloc(320 * 180 * 4, 255).toString('base64') });
        }
    });
});
(async () => {
    await new Promise((r, j) => renderServer.once('error', j).listen(process.env.MGU_RENDERD_SOCKET, r));
    await new Promise((r, j) => ctlServer.once('error', j).listen(process.env.MGU_YT_SOCKET, r));
    let uploads = 0;
    const stage = path.resolve(process.argv[2] || path.join(__dirname, '../../dist/ride_bili'));
    const hu = headUnit(stage, {
        dataDir: dir, fresh: true, live: true,
        image: () => { uploads++; return new Promise(() => {}); },
        log: { info() {}, debug() {}, warn() {}, error(...a) { errors.push(a.join(' ')); } },
    });
    assert.strictEqual(hu.spec.screens[0].requireNative, true);
    assert(hu.spec.screens[0].buttons.some((b) => b[0] === 'BTN_SETTINGS'));
    assert.strictEqual(hu.settings.get('defaultQuality'), 'auto');
    const info = hu.spec.settings.filter((s) => s.type === 'info'), nativeInfo = {};
    const cells = hu.ui.cells;
    hu.ui.cells = async (name, row, value) => { nativeInfo[name] = value; return cells(name, row, value); };
    hu.display.imageTimeoutMs = 100;
    hu.start();
    const target = () => (hu.display.pageTargets || []).find((t) => t.key.endsWith(':' + id));
    await until(() => target() && renders[0].pictures && renders[0].frames >= 2, 'home picture while HMI upload has no answer');
    assert(uploads > 0); assert(hu.display.own() && hu.display.place.full);
    for (let i = 0; i < 10; i++) {
        await hu.ui.close('VIEW'); await sleep(20); await hu.ui.open('VIEW');
        await until(() => hu.display.own() && hu.display.gpu.visible && hu.display.gpu.onScreen && target(), 'reopened Home');
        assert.strictEqual(hu.display.place.w, 1920); assert.strictEqual(hu.display.place.h, 720);
    }
    const old = renders[0]; old.s.destroy();
    await until(() => !hu.display.gpu.ready, 'renderer disconnected');
    let settingsOpened = false;
    hu.once('hmiscreen', (name) => { settingsOpened = name === 'SETTINGS'; });
    hu.ui.comp('BTN_SETTINGS').emit('action', {});
    await until(() => settingsOpened, 'native settings open without the renderer');
    assert.strictEqual(nativeInfo.SET_COPYRIGHT.Text1stRow, '© 2026 Kan Ning');
    assert.strictEqual(nativeInfo.SET_COPYRIGHT.Text2ndRow, '为小宁兄弟呈现');
    assert.strictEqual(nativeInfo.SET_CREDITS.Text2ndRow, '参考 Moonride、BiliPai');
    hu.ui.comp('SET_DEFAULTQUALITY').emit('action', { row: 4 });
    await until(() => hu.settings.get('defaultQuality') === '1080', 'the native default resolution persists');
    await until(() => renders.length === 2 && renders[1].pictures && renders[1].frames, 'renderer restart uploads cached cover again');
    await until(() => hu.display.own() && hu.display.gpu.visible && hu.display.gpu.onScreen && target(), 'restored page targets');
    hu.ui.comp('BTN_SETTINGS').emit('action', {});
    await until(() => hu.display.sheet && hu.display.sheet.settings, 'GPU settings menu');
    assert(hu.display.sheet.rows().some((row) => row.label === '完全退出应用'));
    info.forEach((s) => {
        const sh = hu.display.sheet, index = hu.spec.settings.indexOf(s);
        assert.strictEqual(sh.rows()[index].value, s.text);
        sh.focus = index;
        assert.strictEqual(sh.choose(), null);
        assert.strictEqual(sh.open, null, 'credits cannot open a choice menu');
    });
    hu.display.closeSheet();
    await until(() => target(), 'return from settings');
    const t = target();
    const touch = (phase) => { const b = Buffer.alloc(12); b.writeUInt32LE(phase, 0); b.writeFloatLE(t.x + t.w / 2, 4); b.writeFloatLE(t.y + t.h / 2, 8); return b; };
    renders[1].s.write(Buffer.concat([msg(105, touch(1)), msg(105, touch(3))]));
    await until(() => commands.some((m) => m.cmd === 'play' && m.id === id), 'click works after renderer restart');
    const firstPlay = commands.find((m) => m.cmd === 'play');
    assert.strictEqual(firstPlay.pcm, true);
    assert.strictEqual(firstPlay.quality, '1080');
    ctlPeer.write(JSON.stringify({ ev: 'state', state: 'error', id }) + '\n');
    ctlPeer.write(JSON.stringify({ ev: 'error', msg: '实时音频未能播放 · 车机音频通道被占用' }) + '\n');
    const mp3 = () => (hu.display.pageTargets || []).find((q) => q.key === 'retry:mp3');
    await until(() => mp3(), 'explicit compatibility retry shown');
    mp3().run();
    await until(() => commands.some((m) => m.cmd === 'play' && m.id === id && m.pcm === false), 'one-off MP3 playback request');
    const realExit = process.exit;
    let exitCode;
    try {
        process.exit = (code) => { exitCode = code; };
        hu.ui.comp('SET_QUITAPP').emit('action', {});
        await until(() => commands.some((m) => m.cmd === 'stop'), 'quit requests playback stop');
        assert.strictEqual(exitCode, undefined, 'quit keeps the service socket open for cleanup');
        ctlPeer.write(JSON.stringify({ ev: 'state', state: 'idle' }) + '\n');
        await until(() => exitCode === 0, 'quit exits on the stop acknowledgement');
        assert(hu.display.gpu.closed);
        assert(!hu.ui.isVisible('VIEW'));
    } finally { process.exit = realExit; }
    assert.deepStrictEqual(errors, []);
    console.log('PASS staged app: renderer restart, default 1080P, manual MP3 retry and clean quit');
    hu.display.gpu.close(); peers.forEach((s) => s.destroy()); renderServer.close(); ctlServer.close();
})().then(() => process.exit(0), (e) => { console.error(e.stack); process.exit(1); });
