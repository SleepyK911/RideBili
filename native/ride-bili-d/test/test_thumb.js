'use strict';
// node test/test_thumb.js: decodes JPEGs made by ffmpeg (baseline, resampled, progressive via jpegtran),
// then one real thumbnail when online.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { thumbRgba, fetchCover } = require('../thumb.js');

const bin = (n) => ['/opt/homebrew/bin/' + n, '/usr/local/bin/' + n].find((p) => fs.existsSync(p)) || n;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-'));
// left half red, right half blue
function jpeg(w, h, name) {
    const f = path.join(tmp, name);
    execFileSync(bin('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', `color=c=red:s=${w / 2}x${h}`, '-f', 'lavfi', '-i', `color=c=blue:s=${w / 2}x${h}`,
        '-filter_complex', 'hstack', '-frames:v', '1', '-q:v', '3', '-huffman', 'optimal', '-y', f]);
    return f;
}
function px(b, x, y) { const i = (y * 320 + x) * 4; return [b[i], b[i + 1], b[i + 2], b[i + 3]]; }
function near(got, want, what) {
    want.forEach((v, i) => assert(Math.abs(got[i] - v) <= 40, `${what}: ${got} not near ${want}`));
}
function check(file, what) {
    const b = thumbRgba(fs.readFileSync(file));
    assert.strictEqual(b.length, 230400, what + ' length');
    near(px(b, 40, 90), [255, 0, 0, 255], what + ' left');
    near(px(b, 280, 90), [0, 0, 255, 255], what + ' right');
    near(px(b, 0, 0), [255, 0, 0, 255], what + ' corner');
    near(px(b, 319, 179), [0, 0, 255, 255], what + ' far corner');
    for (let i = 3; i < b.length; i += 4) assert.strictEqual(b[i], 255, what + ' alpha');
    console.log('ok', what);
}

const fixture = jpeg(320, 180, 'a.jpg');
check(fixture, 'baseline 320x180');
check(jpeg(480, 360, 'b.jpg'), 'baseline 480x360 resampled');
const jt = bin('jpegtran');
if (fs.existsSync(jt)) {
    const p = path.join(tmp, 'p.jpg');
    execFileSync(jt, ['-progressive', '-outfile', p, jpeg(480, 360, 'c.jpg')]);
    assert(fs.readFileSync(p).includes(Buffer.from([0xff, 0xc2])), 'jpegtran made no SOF2');
    check(p, 'progressive 480x360');
} else console.log('skip progressive (no jpegtran)');
assert.throws(() => thumbRgba(Buffer.from('<html>not a jpeg</html>')));

const cli = (args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'thumb.js')].concat(args), { env: {}, cwd: '/', maxBuffer: 1 << 22 });
const r = cli(['https://example.com/cover.jpg']);
assert.strictEqual(r.status, 1); assert.strictEqual(r.stdout.length, 0); assert.match(r.stderr.toString(), /^thumb: bad cover URL\n$/);
console.log('ok disallowed cover host');
if (process.env.RIDEBILI_TEST_COVER) {
    const online = cli([process.env.RIDEBILI_TEST_COVER, '--lease', path.join(tmp, 'none.json')]);
    assert.strictEqual(online.status, 0, online.stderr.toString());
    assert.strictEqual(online.stdout.length, 230400);
    console.log('ok Bilibili CDN JPEG');
}
const seen = [];
fetchCover('https://i0.hdslb.com/image.jpg?test=1', null, async (url) => {
    seen.push(url);
    if (seen.length === 1) throw new Error('CDN resize failed');
    return fs.readFileSync(fixture);
}).then((rgba) => {
    assert.strictEqual(rgba.length, 230400);
    assert.deepStrictEqual(seen, ['https://i0.hdslb.com/image.jpg@320w_180h_1c.jpg?test=1',
        'https://i0.hdslb.com/image.jpg@320w.jpg?test=1']);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('ok cover URL fallback');
}, (e) => { console.error(e); process.exitCode = 1; });

