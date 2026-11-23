'use strict';
// RideBili uses the RideTube OAP canvas and its native playback service.
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const QR = require('./kit/qr');
const { setImage } = require('./kit/record');
const { HMI } = require('./kit/display');
const { Ctl, Model, clock, SOCKET, FEEDS, SHELF_MAX } = require('./yt');
const { spell } = require('./speller');
const PcmRoute = require('./pcm-route');

const W = 1600, H = 520;
const BOX = { x: 12, y: 38, w: 1576, h: 432 };          // the video, in the page's visible part (y 38..520)
const VID = 1, VPATH = process.env.MGU_YT_VIDEO || '/dev/shm/mgu-video-ridetube';     // (env: tests)
const POOL0 = 8, POOL = 56;                               // picture ids POOL0.. for the thumbs drawn (a pool, by video)
const TOP = 38;                                          // the page shows from here down (the kit: y 38..520 + extra)
const RAIL_W = 116;                                      // the icon rail, x 12..116
const X0 = 136, TW = 320, TH = 180, PITCH = 348, PER_ROW = 4;   // tiles: 16:9 thumbs, four a row, the fifth peeking
const TILE_H = TH + 98, HEAD_H = 50, SHELF_GAP = 30, GRID_GAP = 22;   // a tile with its text; a shelf's title row
const OVERLAY_MS = 4000;                                 // the player's controls hide this long after a tap (playing)
const QUALITY_QN = { '1080': 80, '720': 64, '480': 32, '360': 16 };
const QUALITY_LABEL = { 80: '1080P', 64: '720P', 32: '480P', 16: '360P' };
const SEARCH_MS = 16000;                                 // the service has time for its search and one fallback
const SUGGEST = ['汽车', '音乐', '科技', '美食', '旅行', '知识'];
const SLOTS = ['BTN_S1', 'BTN_S2', 'BTN_S3', 'BTN_S4', 'BTN_S5', 'BTN_S6'];
const TABS = ['home', 'subs', 'wl'];
const NAMES = { home: '首页', subs: '关注', wl: '稍后再看', results: '搜索结果', account: '账号' };
const FEED_MS = 15000;                                   // a feed with no answer by then is an error on screen

process.on('uncaughtException', (e) => { try { mgu.log.error('uncaught', e); } catch (x) { /* nothing left to log with */ } });

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        /* ---------- the daemon ---------- */
        const ctl = new Ctl(process.env.MGU_YT_SOCKET || SOCKET, log);
        const model = new Model((o) => ctl.send(o));
        const pcm = new PcmRoute(ctx.signals, (o) => ctl.send(o), log);
        let mode = 'home', browse = 'home', dirty = true;   // browse: the list the player goes back to
        let drawLoop = null, backgroundPlaying = null;
        let quitting = false, playbackStopped = null;
        ctx.settingActions = { quitApp: async () => {
            if (quitting) return;
            quitting = true;
            queue = []; nextAt = 0;
            clearTimeout(pendT);
            const stopped = new Promise((resolve) => {
                playbackStopped = resolve;
                if (!ctl.send({ cmd: 'stop' })) resolve();
            });
            // Keep the control socket open until the daemon has released audio.
            let timer;
            try {
                await Promise.race([stopped, new Promise((resolve) => { timer = setTimeout(resolve, 6000); })]);
                await Promise.race([pcm.request(null, false), new Promise((resolve) => {
                    clearTimeout(timer);
                    timer = setTimeout(resolve, 1500);
                })]);
            } finally { clearTimeout(timer); }
            if (drawLoop) drawLoop.stop();
            const display = ctx.display;
            if (display && display.gpu) { display.gpu.show(false); display.gpu.close(); }
            ctl.close();
            if (ctx.background) ctx.background('playing', false);
            const closeScreens = async () => {
                for (const name of ['SETTINGS', 'MAIN', 'VIEW']) {
                    if (ui.isVisible(name)) await ui.close(name);
                }
            };
            await Promise.race([closeScreens().catch((e) => log.warn('quit: ' + e.message)), new Promise((resolve) => {
                timer = setTimeout(resolve, 600);
            })]);
            clearTimeout(timer);
            process.exit(0);
        } };
        const redraw = () => { dirty = true; if (drawLoop && drawLoop.kick) drawLoop.kick(); };
        const changed = () => {
            redraw();
            const active = model.active();
            if (ctx.background && active !== backgroundPlaying) ctx.background('playing', active);
            backgroundPlaying = active;
            labels();
        };
        let homePress = null;
        function pressHome() {
            const now = Date.now();
            const interval = homePress === null ? Infinity : now - homePress;
            if (interval >= 0 && interval < 120) return; // duplicate action from a single press
            const refresh = interval <= 900 && !!model.feeds.home;
            show('home');
            homePress = refresh ? null : now;
            if (refresh && model.connected) model.feed('home');
        }

        const isFeed = (m) => FEEDS.indexOf(m) >= 0;
        const openFeed = () => {
            if (!model.connected) return;
            if (mode === 'account') { model.authStart(); return; }
            if (!isFeed(mode)) return;
            if (mode !== 'home' && model.auth.state !== 'signed_in') { model.authStart(); return; }
            if (mode !== 'home' || !model.feeds.home || model.feeds.home.error) model.feed(mode);
            if (mode === 'home' && model.auth.state === 'signed_in' && !model.feeds.wl) model.feed('wl');
            if (mode === 'subs') model.loadChannels();
        };
        const backKey = {};                              // page -> the tile the controller was on when it was left
        function show(m) {
            if (m !== 'player') qualityOpen = false;
            if (m !== mode) { dirty = true; if (laid.mode === mode && laid.where[focusKey]) backKey[mode] = focusKey; }   // (a tile of this page)
            if (mode === 'keyboard' && m !== 'keyboard') typing = null;
            mode = m;
            if (m !== 'home') homePress = null;
            if (m === 'player') wake(); else if (m !== 'keyboard') browse = m;
            openFeed(); sync(); labels();
        }
        function goBack(m) {
            show(m);
            if (backKey[m] && ctx.focus) ctx.focus(backKey[m]);
        }
        ctl.on('up', () => { model.setConnected(true); changed(); });
        let offlineDetail = '正在连接播放服务…';
        ctl.on('down', (code) => {
            offlineDetail = code === 'EACCES' || code === 'EPERM' ? '播放服务连接权限异常，请在 MGU Store 更新播放服务' :
                code === 'ENOENT' || code === 'ECONNREFUSED' ? '播放服务尚未启动，请在 MGU Store 更新播放服务并按提示重启' :
                '播放服务连接中断，正在自动重连' + (code ? '（' + code + '）' : '');
            pcm.request(null, false); model.setConnected(false); changed();
            if (playbackStopped) playbackStopped();
        });
        ctl.on('msg', (m) => {
            if (m.ev === 'pcm_route' || m.ev === 'pcm_release') {
                pcm.request(m.token, m.ev === 'pcm_route');
                return;
            }
            if (m.ev === 'state' && m.state === 'idle' && playbackStopped) playbackStopped();
            const rev = model.rev, hadPreview = model.preview;
            model.onMsg(m);
            if (hadPreview !== model.preview) sync();
            if (m.ev === 'quality_done') {
                qualityPending = 0;
                qualityNotice = Date.now() + 3200;
                wake();
                return;
            }
            if (m.ev === 'error') log.warn('ride-bili-d: ' + m.msg);
            if (m.ev === 'state' && (m.state !== 'playing' && m.state !== 'paused')) {
                qualityOpen = false;
                qualityPending = 0;
            }
            if (m.ev === 'auth') { log.info('ride-bili-d: account ' + m.state); if (m.state === 'signed_in' || (m.state === 'signed_out' && mode === 'home')) openFeed(); }
            if (model.rev !== rev) changed();
        });
        ctl.connect();

        /* ---------- hidden channels (a channel page's Hide) ---------- */
        const HIDDEN = path.join(ctx.dataDir, 'hidden.json');
        let hidden = [];
        try { hidden = JSON.parse(fs.readFileSync(HIDDEN, 'utf8')).filter((s) => typeof s === 'string'); } catch (e) { /* none yet */ }
        function toggleHidden(name) {
            hidden = hidden.indexOf(name) >= 0 ? hidden.filter((x) => x !== name) : hidden.concat(name);
            try { fs.writeFileSync(HIDDEN, JSON.stringify(hidden)); } catch (e) { log.warn('hidden: ' + e.message); }
            dirty = true;
        }
        // what Home, Subscriptions, Watch later and Search show (a channel's own page shows all)
        const shown = (items) => items.filter((r) => hidden.indexOf(r.channel) < 0);

        /* ---------- searches: recent first, then suggestions ---------- */
        const RECENT = path.join(ctx.dataDir, 'recent.json');
        let recent = [];
        try { recent = JSON.parse(fs.readFileSync(RECENT, 'utf8')).filter((s) => typeof s === 'string').slice(0, SLOTS.length); } catch (e) { /* none yet */ }
        const slots = () => recent.concat(SUGGEST.filter((s) => recent.indexOf(s) < 0)).slice(0, SLOTS.length);
        const showSlots = () => slots().forEach((s, i) => ui.text(SLOTS[i], s));
        function search(q) {
            q = String(q || '').trim().slice(0, 150);
            if (!q) return;
            recent = [q].concat(recent.filter((s) => s.toLowerCase() !== q.toLowerCase())).slice(0, SLOTS.length);
            try { fs.writeFileSync(RECENT, JSON.stringify(recent)); } catch (e) { log.warn('recent: ' + e.message); }
            showSlots();
            model.search(q);               // (not sent: the results screen says why)
            show('results');
            ensureView();
        }
        let nativeTyping = false, typing = null;
        const ensureView = () => (!ui.isVisible('VIEW') || (ui.hasFocus && !ui.hasFocus('VIEW'))) ? ui.open('VIEW') : Promise.resolve();
        async function requestText(title, apply) {
            if (nativeTyping || typing) return;
            homePress = null;
            const previous = mode;
            const d = ctx.display;
            nativeTyping = true;
            if (ctx.background) ctx.background('keyboard', true);
            if (d && d.suspend) d.suspend(true);
            let text, failed = false;
            try {
                text = await spell(ctx.app, title);
                await new Promise((r) => setTimeout(r, 180)); // keep control with the HMI until its keyboard closes
            } catch (e) { failed = true; log.warn('system keyboard: ' + (e.message || e)); }
            finally {
                if (d && d.suspend) d.suspend(false);
                if (ctx.background) ctx.background('keyboard', false);
                nativeTyping = false;
                dirty = true;
            }
            if (failed) {
                if (!d || !d.own || !d.own()) {
                    ui.text('MAIN_INFO', '系统键盘暂不可用，可从下方选词搜索');
                    return;
                }
                typing = { previous, apply, text: '', shift: false, symbols: false };
                show('keyboard');
                await ensureView();
                return;
            }
            if (typeof text === 'string' && text.trim()) apply(text);
        }
        const openSearch = () => requestText('Search Bilibili', search);
        ui.onClick('BTN_SEARCH', openSearch);
        SLOTS.forEach((b, i) => ui.onClick(b, () => search(slots()[i])));
        ui.onClick('BTN_NOW', () => { show('player'); ui.open('VIEW'); });
        ui.onClick('BTN_RESULTS', () => { show('results'); ui.open('VIEW'); });
        ui.onClick('BTN_HOME', () => { pressHome(); ensureView(); });
        [['BTN_SUBS', 'subs'], ['BTN_WL', 'wl']].forEach(([b, m]) => ui.onClick(b, () => { show(m); ui.open('VIEW'); }));
        // Sign in: the Home tab shows how (after a failed try, asks again). Sign out: pressed twice within 5 s
        let signOutArmed = null;
        ui.onClick('BTN_ACCOUNT', () => {
            if (model.auth.state !== 'signed_in') { show('account'); model.authStart(true); ui.open('VIEW'); return; }
            if (!signOutArmed) { signOutArmed = setTimeout(() => { signOutArmed = null; labels(); }, 5000); labels(); return; }
            clearTimeout(signOutArmed); signOutArmed = null;
            model.signOut();
            labels();
        });
        showSlots();

        function info() {
            let s;
            if (!model.connected) s = '播放服务：' + offlineDetail;
            else if (model.searchError) s = '搜索 ' + model.searchError;
            else if (model.error) s = '播放错误 ' + model.error;
            else if (model.active()) s = (model.state === 'preparing' ? '正在加载 ' + Math.round(model.pct) + ' %: ' : model.state === 'paused' ? '已暂停 ' : '播放中 ') + model.title;
            else s = '输入关键词或选择下方的搜索项';
            ui.text('MAIN_INFO', s);
        }
        info();
        setInterval(() => { try { model.checkSearch(Date.now(), SEARCH_MS); model.checkFeeds(Date.now(), FEED_MS); if (ui.isVisible('MAIN')) info(); } catch (e) { log.error('info', e); } }, 1000);

        /* ---------- playing ---------- */
        // the decoder's picture size. Full-screen layout: the whole screen, for the full view (ytdec fits, or
        // fills when that crops at most 15 %; the fill setting, on by default, always crops); the player draws the same frame
        // smaller (op 19 fits it into its box). The daemon has no rect change, so the size is the full view's
        // from the start. Else the box in screen pixels.
        function rect() {
            const pl = ctx.display && ctx.display.place, s = (pl && pl.scale) || 1;
            const even = (v, max) => Math.min(max, Math.max(16, Math.round(v / 2) * 2));
            if (pl && pl.full) return even(pl.w, 2048) + 'x' + even(pl.h, 2048);
            return even(BOX.w * s, 1920) + 'x' + even(BOX.h * s, 720);
        }
        // it: the tile tapped (its title and channel show while the video is prepared)
        // list: the row it was picked from; the videos after it play next when one ends (autoplay)
        const QUALITIES = ['auto', '1080', '720', '480', '360'];
        let preferredQuality = 'auto', queue = [], nextAt = 0, resumePlayback = false;
        function play(id, it, list, resume, useMp3) {
            if (quitting) return;
            show('player');
            if (list) { const i = list.findIndex((r) => r.id === id); queue = list.slice(i + 1).filter((r) => r && !r.act && /^BV[0-9A-Za-z]{10}(?:_p[1-9][0-9]{0,3})?$/.test(r.id)); }
            nextAt = 0;
            if (model.id === id && model.active()) return;
            resumePlayback = !!resume;
            const quality = settings.get('defaultQuality');
            preferredQuality = QUALITIES.includes(quality) ? quality : 'auto';
            qualityOpen = false; qualityPending = 0; qualityNotice = 0;
            const realtime = !useMp3 && settings.get('audioMode') !== 'mp3';
            if (realtime && ctx.signals) pcm.prime().catch(() => {});
            model.play(id, rect(), settings.get('fill') !== false, it, {
                quality: preferredQuality, pcm: realtime, resume: resumePlayback
            });
            sync();
            changed();
        }
        // from render: ended with a next one -> 5 s to see what comes, then it plays (back to the list cancels)
        function autoNext() {
            if (model.state !== 'ended' || !queue.length || mode !== 'player') { nextAt = 0; return null; }
            if (!nextAt) { nextAt = Date.now() + 5000; wake(); }
            if (Date.now() < nextAt) return queue[0];
            const r = queue.shift();
            play(r.id, r);
            return null;
        }
        let lastPlay = null, lastList = null, lastAcct = null;
        function labels() {
            const p = model.state === 'playing' ? '暂停' : '播放';
            if (p !== lastPlay) { lastPlay = p; ui.text('BTN_PLAY', p); }
            const l = mode === 'player' ? NAMES[browse] : model.active() ? '正在播放' : '播放器';
            if (l !== lastList) { lastList = l; ui.text('BTN_LIST', l); }
            const a = model.auth.state !== 'signed_in' ? '扫码登录' : signOutArmed ? '再按一次退出登录' : '退出登录';
            if (a !== lastAcct) { lastAcct = a; ui.text('BTN_ACCOUNT', a); }
        }
        ui.onClick('BTN_PLAY', () => model.toggle());
        ui.onClick('BTN_RW', () => model.skip(-10000));
        ui.onClick('BTN_FF', () => model.skip(10000));
        ui.onClick('BTN_LIST', () => show(mode === 'player' ? browse : 'player'));
        if (ctx.onTab) ctx.onTab((i) => { if (TABS[i] === 'home') pressHome(); else if (TABS[i]) show(TABS[i]); });
        ui.onClick('BTN_FIND', () => ui.open('MAIN'));
        // where the kit runs the screen: no bar at all (the rail and the player's overlay do its jobs), so the
        // pages reach the screen's bottom; the HMI's own screen keeps all five
        if (ctx.hideButton) ['BTN_PLAY', 'BTN_RW', 'BTN_FF', 'BTN_LIST', 'BTN_FIND'].forEach((b) => ctx.hideButton(b, true));
        labels();

        /* ---------- the player's overlay (where the kit runs the screen): shown on a tap or the controller ---------- */
        // the knob turned on the progress bar: 10 s a detent, one seek once it rests 350 ms (the bar moves at once)
        let pend = 0, pendT = null;
        function turnSeek(d) {
            if (model.state !== 'playing' && model.state !== 'paused') return;
            pend += d * 10000; wake();
            clearTimeout(pendT);
            pendT = setTimeout(() => { const ms = pend; pend = 0; model.skip(ms); dirty = true; }, 350);
        }
        const shownAt = () => Math.max(0, Math.min(model.total > 0 ? model.total : Infinity, model.elapsed + pend));
        // preparing: its percentage, or the network lost and the daemon trying again
        const prepText = () => model.retry ? '正在重试' : ({ source: '正在获取播放地址', audio: '正在缓冲音频', route: '正在接通车机声音' }[model.phase] || '正在缓冲画面');
        function drawLoading(cv, cx, y) {
            const p = Math.max(0, Math.min(100, model.pct || 0));
            cv.roundRect(cx - 210, y, 420, 66, 12, '#000000c8');
            cv.text(prepText(), cx, y + 29, 25, '#ffffff', { literal: true, align: 'center' });
            cv.roundRect(cx - 164, y + 45, 328, 5, 2, '#ffffff48');
            if (p > 0) cv.roundRect(cx - 164, y + 45, 328 * p / 100, 5, 2, C.red);
        }
        // a failed play: Try again (the same video, the queue kept)
        const again = () => { if (model.id) play(model.id, model.item(model.id), null, resumePlayback); };
        const canRetryMp3 = () => model.connected && model.state === 'error' && model.id && /^实时音频未能播放/.test(model.error || '');
        const retryMp3 = () => { if (canRetryMp3()) play(model.id, model.item(model.id), null, resumePlayback, true); };
        let ovUntil = 0, qrUntil = 0;   // qrUntil: the On phone QR card shows until then
        let qualityOpen = false, qualityPending = 0, qualityNotice = 0, nextFocus = null;
        function wake() { ovUntil = Date.now() + OVERLAY_MS; redraw(); }
        function openQuality() {
            if (Date.now() < qualityPending) return;
            qualityOpen = true;
            nextFocus = 'quality:' + preferredQuality;
            wake();
        }
        function closeQuality() {
            qualityOpen = false;
            nextFocus = 'ov:q';
            wake();
        }
        function chooseQuality(q) {
            preferredQuality = q;
            closeQuality();
            qualityNotice = 0;
            if (model.quality(q) && (q === 'auto' ? 32 : QUALITY_QN[q]) !== model.sourceQuality) qualityPending = Date.now() + 20000;
        }
        // it stays while there is no moving picture to look at
        const pinned = () => model.state !== 'playing' || !videoShown;
        const overlay = () => qualityOpen || pinned() || Date.now() < ovUntil || Date.now() < qrUntil;
        // a tap beside the controls (no target): hides them
        if (ctx.onTap) ctx.onTap(() => {
            if (qualityOpen) return closeQuality();
            if (mode === 'player' && !pinned() && overlay()) { ovUntil = 0; redraw(); }
        });
        // the controller pushed left in the player: back to the list it came from; pushed left at a channel's
        // edge (the rail): back to Subscriptions. Both put the controller back on the tile it left from
        if (ctx.onBack) ctx.onBack((edge) => {
            if (qualityOpen) { closeQuality(); return true; }
            if (mode === 'keyboard') { finishTyping(false); return true; }
            if (mode === 'player') { goBack(browse); return true; }
            if (mode === 'channel' && edge) { goBack(chanFrom); return true; }
            return false;
        });

        /* ---------- attach the decoder frame to the visible player ---------- */
        let ino = null, videoShown = false;
        const gpu = () => (ctx.display && ctx.display.gpu && ctx.display.gpu.native ? ctx.display.gpu : null);
        function sync() {
            const shown = ui.isVisible('VIEW') && (!ui.hasFocus || ui.hasFocus('VIEW'));
            const want = mode === 'player' && shown && !nativeTyping;
            model.setWantVideo(want);
            // the file ytdec writes; a new one (ytdec restarted) is named to the renderer again
            let cur = null;
            if (want && (model.state === 'playing' || model.state === 'paused' || model.state === 'preparing' && model.preview)) {
                try { const st = fs.statSync(VPATH); cur = st.isFile() ? st.ino : null; } catch (e) { cur = null; }
            }
            const g = gpu();
            if (g) {
                if (!cur || cur !== ino) g.dropVideo(VID);
                if (cur) g.video(VID, VPATH);
            }
            ino = cur;
            const on = !!(cur && g);
            if (on !== videoShown) { videoShown = on; redraw(); }
        }
        setInterval(() => { try { sync(); } catch (e) { log.error('sync', e); } }, 125);
        ui.onVisible((name, v) => { if (name === 'VIEW') { if (!v) { homePress = null; qualityOpen = false; if (typing) finishTyping(false); } sync(); redraw(); } });
        if (ui.onFocus) ui.onFocus(() => sync());
        if (ctx.onLayout) ctx.onLayout(() => { dirty = true; });

        /* ---------- drawing ---------- */
        const fit = (cv, s, size, w, opts) => {
            s = String(s || '');
            if (cv.textWidth(s, size, opts) <= w) return s;
            let lo = 0, hi = s.length;
            while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cv.textWidth(s.slice(0, m) + '…', size, opts) <= w) lo = m; else hi = m - 1; }
            return s.slice(0, lo).replace(/\s+$/, '') + '…';     // (no trimEnd on the unit's Node 8)
        };
        const LIT = { literal: true }, LITB = { literal: true, font: 'bold' };
        const C = { bg: '#0b0f1e', card: '#1a2038', ph: '#232a46', text: '#f1f3ff', dim: '#a4abc8', red: '#ff3f8e', cyan: '#3ad6ff', amber: '#ffd36b' };   // red: the accent (neon pink)
        const browsing = () => mode !== 'player';

        // thumbs: a pool of picture ids by video, least recently drawn reused (the renderer holds 64 pictures an app)
        const pool = new Map(), free = Array.from({ length: POOL }, (_, i) => POOL0 + i);
        let frameNo = 0;
        function slot(id, th) {
            let e = pool.get(id);
            if (!e) {
                let pid = free.pop();
                if (pid === undefined) {
                    let old = null;
                    pool.forEach((x, k) => { if (x.t < frameNo && (!old || x.t < pool.get(old).t)) old = k; });
                    if (!old) return null;                 // all drawn in this frame already
                    pid = pool.get(old).pid; pool.delete(old);
                }
                pool.set(id, e = { pid, th: null, t: 0 });
            }
            if (e.th !== th) { e.th = th; setImage(e.pid, th.w, th.h, th.buf); }
            e.t = frameNo;
            return e.pid;
        }

        // a title in at most two lines of TW px (the second one ellipsised), cached by title
        const wraps = new Map();
        function wrap(cv, s) {
            let v = wraps.get(s);
            if (v) return v;
            const words = s.split(/\s+/).filter(Boolean);
            let l1 = '', i = 0;
            for (; i < words.length; i++) { const t = l1 ? l1 + ' ' + words[i] : words[i]; if (cv.textWidth(t, 24, LITB) > TW) break; l1 = t; }
            let rest = words.slice(i).join(' ');
            if (!l1 && rest) {                           // one word wider than the tile: cut it
                let n = rest.length;
                while (n > 1 && cv.textWidth(rest.slice(0, n), 24, LITB) > TW) n--;
                l1 = rest.slice(0, n); rest = rest.slice(n);
            }
            v = rest ? [l1, fit(cv, rest, 24, TW, LITB)] : [l1];
            if (wraps.size > 400) wraps.clear();
            wraps.set(s, v);
            return v;
        }
        if (ctx.onLayout) ctx.onLayout(() => wraps.clear());          // (text widths follow the scale)

        // a play triangle pointing right, centred on cx, cy, s px tall
        const tri = (cv, cx, cy, s, c) => cv.quad([[cx - s * 0.38, cy - s / 2], [cx + s * 0.5, cy], [cx - s * 0.38, cy + s / 2], [cx - s * 0.38, cy - s / 2]], c);
        // Try again: a circle arrow (cv.arc's ring, its head at the top)
        const retryGlyph = (cv, cx, cy, r, c) => { cv.arc(cx, cy, r - 5, r, 40, 340, c); cv.quad([[cx - 4, cy - r - 9], [cx + 10, cy - r + 2], [cx - 4, cy - r + 12], [cx - 4, cy - r - 9]], c); };
        // RideBili's mark: a cyan screen outline with the pink play mark in it
        const logo = (cv, cx, cy, w) => { cv.strokeRoundRect(cx - w / 2, cy - w * 0.33, w, w * 0.66, w * 0.16, Math.max(3, Math.round(w * 0.06)), C.cyan); tri(cv, cx + w * 0.04, cy, w * 0.32, C.red); };

        /* the left rail: Search, Home, Subscriptions, Watch later */
        const RAIL = [
            ['search', '搜索', (cv, x, y, c) => { cv.arc(x - 4, y - 4, 9, 12.5, 0, 360, c); cv.line(x + 4.5, y + 4.5, x + 14, y + 14, 4.5, c); }],
            ['home', '首页', (cv, x, y, c, bg) => {
                cv.quad([[x, y - 18], [x + 19, y - 1], [x - 19, y - 1], [x, y - 18]], c);
                cv.fillRect(x - 13, y - 3, 26, 19, c); cv.fillRect(x - 4, y + 6, 8, 10, bg);
            }],
            ['subs', '关注', (cv, x, y, c, bg) => {
                cv.roundRect(x - 11, y - 18, 22, 3, 1.5, c); cv.roundRect(x - 15, y - 12, 30, 3, 1.5, c);
                cv.roundRect(x - 18, y - 6, 36, 24, 5, c); tri(cv, x + 1, y + 6, 12, bg);
            }],
            ['wl', '稍后再看', (cv, x, y, c) => { cv.arc(x, y, 14, 17.5, 0, 360, c); cv.line(x, y + 1, x, y - 9, 3.5, c); cv.line(x, y, x + 7, y + 5, 3.5, c); }],
            ['account', '账号', (cv, x, y, c) => { cv.circle(x, y - 8, 8, c); cv.roundRect(x - 14, y + 3, 28, 15, 7, c); }],
        ];
        // while something plays: back to the player (the bar's Now playing, where the kit runs the screen)
        const PLAYING = ['player', '播放中', (cv, x, y, c) => { [10, 20, 14].forEach((h, k) => cv.roundRect(x - 15 + k * 11, y + 8 - h, 8, h + 8, 2, c)); }];
        function drawRail(cv) {
            const sel = mode === 'results' ? 'search' : mode === 'channel' ? 'subs' : mode, bottom = H + (cv.own ? cv.extra : 0);
            const items = cv.own && model.active() ? RAIL.concat([PLAYING]) : RAIL;
            const pitch = Math.min(100, (bottom - 148) / (items.length - 1));   // (the page down to the screen's bottom where it reaches)
            items.forEach(([m, name, glyph], i) => {
                const cx = 62, cy = 86 + Math.round(i * pitch), on = m === sel, bg = on ? '#2c2c2c' : C.bg, c = on ? '#ffffff' : C.dim;
                if (on) { cv.roundRect(18, cy - 38, 90, 84, 16, bg); cv.roundRect(18, cy - 14, 5, 28, 2.5, C.red); }
                glyph(cv, cx, cy - 8, c, bg);
                cv.text(name, cx, cy + 34, 18, c, { literal: true, align: 'center', font: on ? 'bold' : 'label' });
                if (cv.own) cv.target(16, cy - 38, 92, Math.min(84, pitch), () => (m === 'search' ? openSearch() : m === 'home' ? pressHome() : show(m)), 'rail:' + m, 16);
            });
        }

        /* a tile: the 16:9 thumb, its length, two lines of title, the channel and the tile's meta (views, age) */
        function drawTile(cv, r, x, y, key) {
            const cur = r.id === model.id && model.active();
            if (key === focusKey) cv.roundRect(x - 10, y - 10, TW + 20, TILE_H + 16, 18, C.card);
            const th = model.thumbs[r.id];
            if (!th) model.wantThumb(r.id);
            const pid = th && cv.place ? slot(r.id, th) : null;
            if (pid) cv.picture(pid, x, y, TW, TH, 12);
            else { cv.roundRect(x, y, TW, TH, 12, C.ph); cv.circle(x + TW / 2, y + TH / 2, 30, '#ffffff10'); tri(cv, x + TW / 2 + 2, y + TH / 2, 24, '#ffffff38'); }
            const p = model.pos[r.id];   // watched (here, else on the account): a bar along the thumbnail's foot
            const frac = p ? (p.done ? 1 : Math.min(1, p.ms / p.total)) : r.watched_pct > 0 ? r.watched_pct / 100 : 0;
            if (frac > 0) {
                const pw = Math.max(8, Math.round(TW * frac));
                cv.fillRect(x, y + TH - 5, TW, 5, '#ffffff55');
                cv.fillRect(x, y + TH - 5, pw, 5, C.red);
            }
            if (r.duration_s > 0) {
                const d = clock(r.duration_s * 1000), dw = cv.textWidth(d, 20, LITB) + 16;
                cv.roundRect(x + TW - 8 - dw, y + TH - 36, dw, 28, 6, '#000000cc');
                cv.text(d, x + TW - 16, y + TH - 15, 20, '#ffffff', { literal: true, font: 'bold', align: 'right' });
            }
            if (cur) {
                cv.strokeRoundRect(x - 2, y - 2, TW + 4, TH + 4, 14, 3, C.red);
                const pw = cv.textWidth('播放中', 16, { literal: true, font: 'bold', spacing: 1 }) + 20;
                cv.roundRect(x + 10, y + 10, pw, 28, 6, C.red);
                cv.text('播放中', x + 20, y + 30, 16, '#ffffff', { literal: true, font: 'bold', spacing: 1 });
            }
            const lines = wrap(cv, String(r.title || r.id));
            lines.forEach((l, k) => cv.text(l, x, y + TH + 32 + k * 30, 24, C.text, LITB));
            const my = y + TH + 32 + lines.length * 30 - 2;
            const meta = [r.channel].concat(Array.isArray(r.meta) ? r.meta : []).filter((m) => typeof m === 'string' && m).join(' · ');
            if (meta) cv.text(fit(cv, meta, 20, TW, LIT), x, my, 20, C.dim, LIT);
        }

        /* a channel: a round mark with its initial, its name, its @handle; or an action (r.act: Search channels, All) */
        const HUES = ['#c62828', '#ad1457', '#6a1b9a', '#283593', '#1565c0', '#00838f', '#2e7d32', '#9e9d24', '#ef6c00', '#4e342e'];
        function drawChan(cv, r, x, y, key) {
            if (key === focusKey) cv.roundRect(x - 10, y - 10, TW + 20, TILE_H + 16, 18, C.card);
            const cx = x + TW / 2, cy = y + TH / 2, name = String(r.title || r.id);
            let h = 0;
            for (const ch of r.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
            if (r.act) {
                cv.roundRect(x, y, TW, TH, 12, C.ph);
                r.glyph(cv, cx, cy, '#ffffff');
            } else {
                cv.circle(cx, cy, 78, HUES[h % HUES.length]);
                const ini = (Array.from(name).find((ch) => /[0-9]/.test(ch) || ch.toLowerCase() !== ch.toUpperCase()) || name.charAt(0) || '?').toUpperCase();   // (Node 8: no \p{L})
                cv.text(ini, cx, cy + 26, 72, '#ffffff', { literal: true, font: 'bold', align: 'center' });
            }
            cv.text(fit(cv, name, 24, TW, LITB), cx, y + TH + 36, 24, C.text, { literal: true, font: 'bold', align: 'center' });
            if (r.sub || r.handle) cv.text(fit(cv, r.sub || r.handle, 20, TW, LIT), cx, y + TH + 66, 20, C.dim, { literal: true, align: 'center' });
        }
        const KEYS = (cv, cx, cy, c) => {                 // a keyboard
            cv.strokeRoundRect(cx - 46, cy - 30, 92, 60, 10, 4, c);
            for (let k = 0; k < 5; k++) { cv.roundRect(cx - 34 + k * 15, cy - 18, 9, 9, 2, c); cv.roundRect(cx - 34 + k * 15, cy - 3, 9, 9, 2, c); }
            cv.roundRect(cx - 24, cy + 12, 48, 8, 3, c);
        };
        const BLOCK = (cv, cx, cy, c) => { cv.arc(cx, cy, 30, 36, 0, 360, c); cv.line(cx - 22, cy + 22, cx + 22, cy - 22, 6, c); };   // hide
        const SHOW = (cv, cx, cy, c) => { cv.arc(cx, cy, 30, 36, 0, 360, c); cv.polyline([[cx - 15, cy], [cx - 4, cy + 12], [cx + 16, cy - 12]], 6, c); };
        const ALL = (cv, cx, cy, c) => { [-20, 0, 20].forEach((d) => cv.roundRect(cx - 34, cy + d - 4, 68, 8, 4, c)); };
        // the channels, filtered by chanQ (the keyboard: one letter = names starting with it, else names holding it)
        let chanQ = '';
        function findChannel() {
            return requestText('Find a channel', (text) => {
                chanQ = text.trim(); vs('subs').sy = 0; vs('subs').off = {}; dirty = true;
                show('subs'); ensureView();
            });
        }
        let chanFrom = 'subs';
        function openChannel(c) { if (mode !== 'channel') chanFrom = mode; model.openChannel(c.id, c.title); show('channel'); vs('channel').sy = 0; vs('channel').off = {}; }
        function chanSections() {
            const ch = model.chans;
            if (!ch || (!ch.items.length && ch.loading)) return [{ title: 'Channels', sub: 'Loading...', items: [], chan: true }];
            if (!ch.items.length) return ch.error ? [{ title: 'Channels', sub: ch.error, items: [], chan: true }] : [];
            const find = { id: '::find', title: chanQ ? 'Search again' : 'Search channels', sub: 'A letter, or a word', act: findChannel, glyph: KEYS };
            if (!chanQ) return [{ title: 'Channels', sub: ch.items.length + ' subscriptions, A-Z', items: [find].concat(ch.items), chan: true }];
            const hits = model.findChannels(chanQ);
            const all = { id: '::all', title: 'All channels', sub: ch.items.length + ' subscriptions', act: () => { chanQ = ''; vs('subs').off = {}; dirty = true; }, glyph: ALL };
            return [{ title: (chanQ.length === 1 ? 'Channels starting with “' : 'Channels matching “') + chanQ + '”',
                sub: hits.length ? hits.length + (hits.length === 1 ? ' channel' : ' channels') : 'none', items: [find, all].concat(hits), chan: true, grid: true }];
        }
        function drawChannel(cv) {
            const c = model.chan;
            if (!model.connected) return say(cv, OFF, offlineDetail);
            if (!c) return say(cv, 'Pick a channel in Subscriptions');
            if (!c.items.length) return say(cv, c.loading ? '正在加载 ' + (c.title || 'the channel') + '...' : c.error === 'feed offline' ? '请检查车机网络' : c.error || 'No videos on this channel', c.title || null);
            const hid = hidden.indexOf(c.title) >= 0;
            const tog = { id: '::hide', title: hid ? 'Show this channel' : 'Hide this channel', sub: hid ? 'Hidden from Home, Subscriptions, Search' : 'From Home, Subscriptions and Search',
                act: () => toggleHidden(c.title), glyph: hid ? SHOW : BLOCK };
            drawPage(cv, (c.shelves && c.shelves.length ? c.shelves : [{ title: 'Videos', items: c.items, grid: true }])
                .map((s, i) => (i === 0 ? Object.assign({}, s, { title: c.title + (s.title ? ' · ' + s.title : ''), items: [tog].concat(s.items) }) : s)));
        }

        // a shelf's arrow for touch: shifts it by four tiles. Its target goes before the tiles' (a tap on it is not
        // the tile under it), the drawing after them (returned: drawn by the caller once the tiles are)
        function chevron(cv, cx, cy, dir, run, key) {
            cv.target(cx - 32, cy - 32, 64, 64, run, key, 32);
            return () => {
                cv.circle(cx, cy, 32, '#00000099'); cv.circle(cx, cy, 29, key === focusKey ? '#ffffff' : '#303030');
                cv.polyline([[cx - 5 * dir, cy - 11], [cx + 6 * dir, cy], [cx - 5 * dir, cy + 11]], 4.5, key === focusKey ? '#0f0f0f' : '#ffffff');
            };
        }

        /*
         * A browsing page: rows of tiles, each a shelf (its own sideways offset, a title) or a grid's row of four.
         * sections [{ title, items, grid }]. Scrolls up and down (a finger, the controller); targets for the tiles
         * shown, one more past each edge of a shelf and the rows next to the ones shown (the controller moves
         * there, onPageFocus brings it into view). Keys: <mode letter>:<row>:<video id>.
         */
        const view = {};                                  // mode -> { sy, off: { row: first tile shown } }
        const vs = (m) => view[m] || (view[m] = { sy: 0, max: 0, off: {} });
        let laid = { mode: null, rows: [], viewH: 0, where: {} }, focusKey = null;
        function layout(sections) {
            const rows = [];
            let y = 10;
            sections.forEach((sc) => {
                const chunks = sc.grid ? [] : [sc.items];
                if (sc.grid) for (let i = 0; i < sc.items.length; i += PER_ROW) chunks.push(sc.items.slice(i, i + PER_ROW));
                chunks.forEach((items, k) => {
                    const title = k === 0 ? sc.title : null, h = (title ? HEAD_H : 0) + TILE_H + (sc.grid && k < chunks.length - 1 ? GRID_GAP : SHELF_GAP);
                    rows.push({ title, sub: k === 0 ? sc.sub : null, items, y, h, hs: !sc.grid && items.length > PER_ROW, chan: !!sc.chan, resume: !!sc.resume });
                    y += h;
                });
            });
            return { rows, h: y };
        }
        function drawPage(cv, sections) {
            const st = vs(mode), bottom = H + (cv.own ? cv.extra : 0), viewH = bottom - TOP, L = layout(sections);
            st.max = Math.max(0, L.h - viewH);
            st.sy = Math.max(0, Math.min(st.max, st.sy));
            const where = {}, letter = mode[0];
            const ys = L.rows.map((r) => TOP + r.y - st.sy);
            const vis = L.rows.map((r, i) => ys[i] + r.h > TOP && ys[i] < bottom);
            const first = vis.indexOf(true), lastV = vis.lastIndexOf(true), after = [];
            cv.clip(RAIL_W, TOP, W - RAIL_W, bottom - TOP);
            L.rows.forEach((row, ri) => {
                if (ri < first - 1 || ri > lastV + 1) return;
                const y = ys[ri], shown = vis[ri], n = row.items.length, ty = y + (row.title ? HEAD_H : 0);
                if (row.title && shown) {
                    const tw = cv.text(fit(cv, row.title, 30, 1100, LITB), X0, y + 34, 30, '#ffffff', LITB);
                    if (row.sub) cv.text(row.sub, X0 + tw + 18, y + 34, 22, C.dim, LIT);
                }
                const max = row.hs ? n - PER_ROW : 0, off = Math.max(0, Math.min(max, st.off[ri] || 0));
                st.off[ri] = off;
                // touch: arrows where tiles are hidden (recorded first: a tap on one is not the tile under it)
                if (cv.own && shown && row.hs) {
                    if (off > 0) after.push(chevron(cv, X0 + 4, ty + TH / 2, -1, () => { st.off[ri] = Math.max(0, off - PER_ROW); dirty = true; }, letter + ':' + ri + ':<'));
                    if (off < max) {
                        after.push(() => { for (let k = 0; k < 6; k++) cv.fillRect(W - 108 + k * 16, ty - 10, 16, TILE_H + 16, [15, 15, 15, Math.round(255 * (0.3 + k * 0.14))]); });
                        after.push(chevron(cv, W - 48, ty + TH / 2, 1, () => { st.off[ri] = Math.min(max, off + PER_ROW); dirty = true; }, letter + ':' + ri + ':>'));
                    }
                }
                for (let i = Math.max(0, off - 1); i <= Math.min(n - 1, off + PER_ROW); i++) {
                    const r = row.items[i], x = X0 + (i - off) * PITCH, key = letter + ':' + ri + ':' + r.id;
                    if (shown && x + TW > RAIL_W && x < W) (row.chan || r.act ? drawChan : drawTile)(cv, r, x, ty, key);
                    const run = r.act ? () => r.act() : row.chan ? () => openChannel(r) : () => play(r.id, r, row.items, row.resume);
                    if (cv.own) { cv.target(x - 10, ty - 10, TW + 20, TILE_H + 16, run, key, 18); where[key] = { ri, i }; }
                }
            });
            after.forEach((fn) => fn());
            cv.noclip();
            laid = { mode, rows: L.rows, viewH, where };
            if (cv.own && st.max > 0) cv.scroll = true;
        }
        // the controller on a tile: its shelf turned and the page scrolled so that it shows whole
        if (ctx.onPageFocus) ctx.onPageFocus((key) => {
            if (key !== focusKey) redraw();
            focusKey = key;
            if (key && key.indexOf('ov:') === 0) { wake(); return; }      // the controller in the player: its overlay
            const w = key && laid.mode === mode && laid.where[key];
            if (!w) return;
            const st = vs(mode), row = laid.rows[w.ri];
            if (row.hs) {
                const off = st.off[w.ri] || 0;
                if (w.i < off) st.off[w.ri] = w.i; else if (w.i > off + PER_ROW - 1) st.off[w.ri] = w.i - PER_ROW + 1;
            }
            const top = row.y - 8, bot = row.y + row.h;
            if (top < st.sy) st.sy = Math.max(0, top); else if (bot > st.sy + laid.viewH) st.sy = Math.min(st.max, bot - laid.viewH);
            dirty = true;
        });
        if (ctx.onScroll) ctx.onScroll((dy) => {
            if (!browsing()) return false;
            const st = vs(mode), y = Math.max(0, Math.min(st.max, st.sy + dy)), moved = y !== st.sy;
            st.sy = y;
            if (moved) redraw();
            return moved;
        });

        // a message in the middle of the page (RideBili's mark over it), a grey line under it
        const MID = (RAIL_W + W) / 2;
        function say(cv, msg, sub) {
            if (browsing()) logo(cv, MID, 200, 76);
            cv.text(fit(cv, msg, 34, 1360, LIT), browsing() ? MID : W / 2, 290, 34, '#ffffff', { literal: true, align: 'center' });
            if (sub) cv.text(fit(cv, sub, 24, 1360, LIT), browsing() ? MID : W / 2, 336, 24, C.dim, { literal: true, align: 'center' });
        }
        const OFF = '暂未连接到 RideBili 播放服务';
        function drawResults(cv) {
            if (!model.connected) return say(cv, OFF, offlineDetail);
            if (model.searching) return say(cv, '正在搜索「' + model.q + '」');
            if (model.searchError) return say(cv, '搜索失败 · ' + model.searchError, '可返回搜索重试');
            if (!model.results.length) return say(cv, model.q ? '未找到「' + model.q + '」' : '点击搜索查找视频', model.q ? '换个关键词试试' : null);
            drawPage(cv, [{ title: '搜索结果 · ' + model.q, items: shown(model.results), grid: true }]);
        }
        function drawFeed(cv, which) {
            const f = model.feeds[which], a = model.auth.state;
            if (!model.connected) return say(cv, OFF, offlineDetail);
            if (a === 'unsupported') return say(cv, 'Signing in needs a newer ride-bili-d tool on the car');
            if (which !== 'home' && a !== 'signed_in') return drawSignIn(cv);
            const chans = which === 'subs' && model.chans && model.chans.items.length;   // the channels show without the videos
            if ((!f || !f.items.length) && !chans) {
                return say(cv, !f || f.loading ? '正在加载 ' + NAMES[which] + '...' : f.error === 'feed offline' ? '请检查车机网络'
                    : f.error ? NAMES[which] + ': ' + f.error : which === 'wl' ? '暂无稍后再看的视频' : '暂无视频', which === 'wl' && f && !f.loading && !f.error ? '在哔哩哔哩加入稍后再看的视频会显示在这里' : null);
            }
            let secs;
            if (which === 'home') {
                const wl = model.feeds.wl;
                secs = (model.resume.length ? [{ title: '继续观看', items: model.resume, resume: true }] : [])
                    .concat(f.shelves || [{ title: '推荐视频', items: f.items, grid: true }])
                    .concat(wl && wl.items.length ? [{ title: '稍后再看', items: wl.items.slice(0, SHELF_MAX) }] : []);
            } else secs = !f ? [] : f.shelves && which !== 'wl' ? f.shelves : [{ title: NAMES[which], sub: f.items.length + ' videos', items: f.items, grid: true }];
            if (which === 'subs') secs = chanSections().concat(chanQ || !f || !f.items.length ? [] : secs);
            drawPage(cv, secs.map((sc) => (sc.chan ? sc : Object.assign({}, sc, { items: shown(sc.items) }))).filter((sc) => sc.chan || sc.items.length));
        }
        let loginUrl = null, loginQr = null;
        function drawSignIn(cv) {
            if (!model.connected) return say(cv, OFF, offlineDetail);
            const a = model.auth;
            if (a.state === 'signed_in') return say(cv, '已登录哔哩哔哩', '退出登录请打开菜单');
            if (a.state === 'error' || a.state === 'signed_out') {
                say(cv, a.msg || '点击获取登录二维码', '请使用手机哔哩哔哩 App 扫码');
                if (cv.own) cv.target(MID - 520, 160, 1040, 200, () => model.authStart(true), 'signin', 16);
                return;
            }
            if (a.state !== 'code' || !a.url) return say(cv, '正在获取登录二维码');
            if (loginUrl !== a.url) {
                try { loginQr = QR.encode(a.url); loginUrl = a.url; }
                catch (e) { return say(cv, '二维码无法显示，请重新打开应用'); }
            }
            const side = (loginQr.length + 8) * 6, ch = 396, cw = 1000;
            const cx = Math.round(MID - cw / 2), cy = TOP + 35, qx = cx + 42, qy = cy + Math.round((ch - side) / 2);
            cv.roundRect(cx, cy, cw, ch, 24, C.card);
            QR.draw(cv, loginQr, qx, qy, 6);
            const tx = qx + side + 66;
            cv.text('哔哩哔哩扫码登录', tx, cy + 112, 40, '#ffffff', LITB);
            cv.text(a.scanned ? '已扫码，请在手机上确认登录' : '打开手机哔哩哔哩 App 扫码', tx, cy + 204, 28, C.dim, LIT);
            cv.text('请在手机上完成确认', tx, cy + 278, 24, C.dim, LIT);
        }
        function finishTyping(confirm) {
            const state = typing;
            if (!state) return;
            typing = null;
            show(state.previous);
            if (confirm && state.text.trim()) state.apply(state.text);
        }

        function drawKeyboard(cv) {
            const k = typing;
            cv.text('搜索输入', 800, 88, 33, C.text, { literal: true, align: 'center' });
            cv.roundRect(244, 105, 1112, 55, 12, C.card);
            cv.text(fit(cv, k.text.slice(-68) || '输入关键词拼音或 BV 号', 27, 1040, LIT),
                270, 142, 27, C.text, LIT);
            const key = (label, x, y, w, fn, id) => {
                const target = 'key:' + id, selected = focusKey === target;
                cv.roundRect(x, y, w, 50, 8, selected ? '#ffffff' : C.card);
                cv.text(label, x + w / 2, y + 34, 25, selected ? C.bg : C.text, { literal: true, align: 'center' });
                if (cv.own) cv.target(x, y, w, 50, () => { fn(); dirty = true; }, target, 8);
            };
            const rows = k.symbols ? ['1234567890', './:-_?=&@%', '!()+,[]~'] : ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
            rows.forEach((row, j) => Array.from(row).forEach((ch, i) => {
                const c = k.shift ? ch.toUpperCase() : ch;
                key(c, 800 - row.length * 54 + i * 108, 174 + j * 62, 96,
                    () => { if (k.text.length < 150) k.text += c; }, j + ':' + i);
            }));
            [['取消', 150, () => finishTyping(false)], [k.symbols ? '字母' : '符号', 150, () => { k.symbols = !k.symbols; }],
                [k.shift ? '小写' : '大写', 150, () => { k.shift = !k.shift; }], ['空格', 225, () => { if (k.text.length < 150) k.text += ' '; }],
                ['删除', 150, () => { k.text = k.text.slice(0, -1); }], ['确认', 180, () => finishTyping(true)]
            ].reduce((x, [label, w, fn], i) => { key(label, x, 424, w, fn, 'control:' + i); return x + w + 12; }, 264);
        }
        function drawPlayer(cv) {
            cv.fillRect(0, TOP, W, H - TOP, '#000000');
            cv.fillRect(BOX.x, BOX.y, BOX.w, BOX.h, '#000000');
            if (videoShown) cv.video(VID, BOX.x, BOX.y, BOX.w, BOX.h, 0);
            const cx = BOX.x + BOX.w / 2, cy = BOX.y + BOX.h / 2 - 10, bot = BOX.y + BOX.h;
            // the title and channel over a scrim at the top
            if (model.title) {
                cv.gradientRect(BOX.x, BOX.y, BOX.w, 130, [[0, '#000000d0'], [1, '#00000000']]);
                const it = model.item(model.id);
                cv.text(fit(cv, model.title, 30, BOX.w - 60, LITB), BOX.x + 30, BOX.y + 48, 30, '#ffffff', LITB);
                if (it && it.channel) cv.text(fit(cv, it.channel, 22, BOX.w - 60, LIT), BOX.x + 30, BOX.y + 82, 22, '#cccccc', LIT);
            }
            let mid = null;
            if (!model.connected) mid = 'RideBili 播放服务未运行';
            else if (model.state === 'preparing') {
                drawLoading(cv, cx, BOX.y + BOX.h - 77);
            } else if (model.state === 'error') mid = '播放错误 ' + (model.error || 'playback stopped');
            else if (!model.active()) mid = model.state === 'ended' ? '播放结束' : '请从首页或搜索选择视频';
            else if (!cv.place || !gpu()) mid = '画面需要 MGU Store 的渲染组件';
            else if (!videoShown) mid = '正在打开画面';
            if (model.state === 'paused' && !mid) { cv.circle(cx, cy, 60, '#000000a0'); cv.arc(cx, cy, 57, 60, 0, 360, '#ffffff50'); tri(cv, cx + 5, cy, 46, '#ffffff'); }
            if (mid) {
                if (model.state === 'paused') { cv.circle(cx, cy - 40, 46, '#000000a0'); tri(cv, cx + 4, cy - 40, 36, '#ffffff'); }
                cv.text(fit(cv, mid, 34, 1500, LIT), W / 2, BOX.y + BOX.h / 2 + (model.state === 'paused' ? 50 : 12), 34, '#ffffff', { literal: true, align: 'center' });
            }
            if (canRetryMp3()) {
                const y = cy + 47;
                cv.roundRect(cx - 150, y, 300, 50, 14, C.card);
                cv.text('用兼容 MP3 重试', cx, y + 34, 26, C.text, { literal: true, align: 'center' });
                cv.target(cx - 150, y, 300, 50, retryMp3, 'retry:mp3', 14);
            }
            // the progress bar at the bottom: the track, the part played, the scrubber; the times under it
            if (model.total > 0 && model.active() && model.state !== 'preparing') {
                cv.gradientRect(BOX.x, bot - 120, BOX.w, 120, [[0, '#00000000'], [1, '#000000d8']]);
                const tx = BOX.x + 30, tw = BOX.w - 60, ty = bot - 62, k = Math.min(1, model.elapsed / model.total), fx = tx + Math.round(tw * k);
                cv.roundRect(tx, ty, tw, 6, 3, '#ffffff55');
                cv.roundRect(tx, ty, fx - tx, 6, 3, C.red);
                cv.circle(fx, ty + 3, 9, C.red);
                cv.text(clock(model.elapsed), tx, bot - 20, 24, '#ffffff', LITB);
                cv.text(clock(model.total), tx + tw, bot - 20, 24, '#dddddd', { literal: true, font: 'bold', align: 'right' });
            }
        }
        /*
         * The player where the kit runs the screen: the video over the whole surface (no header, no bar), the
         * overlay over it, drawn in screen px / scale (sharp text) at the screen's origin. Its targets go back into
         * the page's px (dx, dy). Hidden, the same keys cover the whole screen and only show it again (the
         * controller stays on its key, so a turn or a press wakes it; a tap anywhere too).
         */
        const OVK = ['ov:back', 'ov:qr', 'ov:rw', 'ov:play', 'ov:ff', 'ov:q', 'ov:zoom', 'ov:bar'];
        function drawQuality(cv, tg, SW, SH) {
            const w = 550, h = 424, x = (SW - w) / 2, y = (SH - h) / 2;
            const actual = QUALITY_LABEL[model.sourceQuality] || '—';
            const preferred = preferredQuality;
            cv.fillRect(0, 0, SW, SH, '#00000070');
            cv.roundRect(x, y, w, h, 24, C.bg);
            cv.text('选择画质', x + 28, y + 48, 32, C.text, LITB);
            cv.text('正在播放 ' + actual, x + 28, y + 87, 24, C.cyan, LIT);
            const close = focusKey === 'quality:close';
            cv.roundRect(x + w - 110, y + 18, 86, 46, 14, close ? C.cyan : C.card);
            cv.text('关闭', x + w - 67, y + 49, 23, close ? C.bg : C.text, { literal: true, align: 'center' });
            tg(x + w - 110, y + 18, 86, 46, closeQuality, 'quality:close', 14);
            QUALITIES.forEach((q, i) => {
                const key = 'quality:' + q, ry = y + 106 + i * 57, qn = QUALITY_QN[q];
                const focused = focusKey === key, current = q !== 'auto' && qn === model.sourceQuality;
                cv.roundRect(x + 22, ry, w - 44, 50, 12, focused ? '#2d4660' : C.card);
                if (focused) cv.strokeRoundRect(x + 22, ry, w - 44, 50, 12, 2, C.cyan);
                const label = q === 'auto' ? '自动（优先 480P）' : q + 'P';
                cv.text(label + (q === preferred ? '  ·  偏好' : ''), x + 40, ry + 33, 25, current ? C.cyan : C.text, LITB);
                const status = q === 'auto' ? '推荐' : current ? '当前' : model.qualities.includes(qn) ? '可选' : q === '720' ? '尝试高清' : '未返回 · 可试';
                cv.text(status, x + w - 42, ry + 32, 22, current ? C.cyan : C.dim, { literal: true, align: 'right' });
                tg(x + 22, ry, w - 44, 50, () => chooseQuality(q), key, 12);
            });
        }
        function drawFull(cv) {
            const pl = cv.place, s = pl.scale, SW = pl.w / s, SH = pl.h / s, dx = pl.ox / s, dy = pl.oy / s;
            cv.chrome = null;              // no header or bar composed over it (display.js present)
            // read: the page stays placed as the browsing pages (reaching down), so oy, and the targets with it, hold
            void cv.extra;
            const tg = (x, y, w, h, run, key, r, turn) => cv.target(x - dx, y - dy, w, h, run, key, r, turn);
            cv.xf(1, 0, 0).fillRect(0, 0, pl.w, pl.h, '#000000');
            if (videoShown) cv.video(VID, 0, 0, pl.w, pl.h, 0);
            if (!overlay()) { cv.xf(); OVK.forEach((k) => tg(0, 0, SW, SH, wake, k, 0, k === 'ov:bar' ? turnSeek : undefined)); return; }
            cv.xf(s, 0, 0);
            if (qualityOpen) { drawQuality(cv, tg, SW, SH); hmiIcons(cv); return; }
            const LX = HMI.left / s, act = model.active(), live = model.state === 'playing' || model.state === 'paused';
            const cx = SW / 2, cy = SH / 2 - 6, run = (fn) => () => { fn(); wake(); };
            // a round control: dark, white when the controller is on it (its glyph dark then)
            const ctl = (key, x, y, r, fn, glyph) => {
                const f = focusKey === key;
                cv.circle(x, y, r, f ? '#ffffff' : '#00000099');
                glyph(f ? '#0f0f0f' : '#ffffff');
                tg(x - r - 6, y - r - 6, 2 * r + 12, 2 * r + 12, run(fn), key, r + 6);
            };
            // top: back to the list, the title and channel over a scrim
            cv.gradientRect(0, 0, SW, 160, [[0, '#000000d8'], [1, '#00000000']]);
            const bx = LX + 44, by = 52;
            ctl('ov:back', bx, by, 30, () => goBack(browse), (c) => cv.polyline([[bx + 5, by - 12], [bx - 7, by], [bx + 5, by + 12]], 5, c));
            const ch = model.channel || (model.item(model.id) || {}).channel;
            if (model.title) cv.text(fit(cv, model.title, 30, SW - LX - 160, LITB), LX + 96, by - 4, 30, '#ffffff', LITB);
            if (ch) cv.text(fit(cv, ch, 22, SW - LX - 300, LIT), LX + 96, by + 30, 22, '#cccccc', LIT);
            // top right, On phone: a QR code of the video's public link at this second (nothing is kept on the car)
            if (model.id) {
                const px = SW - 150;
                ctl('ov:qr', px, by, 30, () => { qrUntil = qrUntil > Date.now() ? 0 : Date.now() + 30000; }, (c) => {
                    cv.strokeRoundRect(px - 10, by - 17, 20, 34, 4, 3, c); cv.fillRect(px - 4, by + 10, 8, 3, c);
                });
                cv.text('手机观看', px - 42, by + 9, 24, '#ffffff', Object.assign({}, LIT, { align: 'right' }));
            }
            if (model.id && qrUntil > Date.now()) {
                const parts = model.id.split('_p'), q = [];
                if (parts[1]) q.push('p=' + parts[1]);
                if (model.elapsed > 5000) q.push('t=' + Math.floor(model.elapsed / 1000));
                const url = 'https://www.bilibili.com/video/' + parts[0] + (q.length ? '?' + q.join('&') : ''), mod = 7;
                const qrcode = QR.encode(url), n = qrcode.length, side = (n + 8) * mod, cw = side + 520, chh = side + 60, qx0 = cx - cw / 2, qy0 = cy - chh / 2;
                cv.roundRect(qx0, qy0, cw, chh, 24, '#212121f2');
                cv.roundRect(qx0 + 30 - 6, qy0 + 30 - 6, side + 12, side + 12, 18, '#ffffff');
                QR.draw(cv, qrcode, qx0 + 30, qy0 + 30, mod);
                cv.text('用手机继续观看', qx0 + side + 80, qy0 + chh / 2 - 20, 34, '#ffffff', LITB);
                cv.text('扫码跳转到 ' + clock(model.elapsed), qx0 + side + 80, qy0 + chh / 2 + 24, 22, '#cccccc', LIT);
                tg(qx0, qy0, cw, chh, () => { qrUntil = 0; wake(); }, 'ov:qrcard', 24);
                cv.xf();
                return;
            }
            // middle: -10 s, play / pause, +10 s; preparing: the ring with the percentage
            let mid = null;
            if (!model.connected) mid = OFF;
            else if (model.state === 'error') mid = '播放错误 ' + (model.error || 'playback stopped');
            const up = upNext;
            if (up) {
                mid = Math.max(1, Math.ceil((nextAt - Date.now()) / 1000)) + ' 秒后播放 ' + String(up.title || up.id);
                ctl('ov:play', cx, cy, 58, () => { nextAt = 1; }, (c) => tri(cv, cx + 5, cy, 46, c));
            } else if (!act && model.state !== 'error') mid = model.state === 'ended' ? '播放结束' : '请从首页或搜索选择视频';
            else if (!gpu()) mid = '画面需要 MGU Store 的渲染组件';
            else if (live && !videoShown) mid = '正在打开画面';
            if (model.state === 'preparing') {
                drawLoading(cv, cx, SH - 84);
            } else if (live) {
                const skip = (key, x, dir, ms) => ctl(key, x, cy, 42, () => model.skip(ms), (c) => {
                    cv.arc(x, cy, 19, 23.5, dir < 0 ? 0 : 60, dir < 0 ? 300 : 360, c);
                    cv.quad([[x - 1 * dir, cy - 29], [x + 9 * dir, cy - 21], [x - 1 * dir, cy - 13], [x - 1 * dir, cy - 29]], c);
                    cv.text('10', x, cy + 7, 18, c, { literal: true, font: 'bold', align: 'center' });
                });
                skip('ov:rw', cx - 210, -1, -10000);
                ctl('ov:play', cx, cy, 58, () => model.toggle(), (c) => {
                    if (model.state === 'paused') tri(cv, cx + 5, cy, 46, c);
                    else { cv.roundRect(cx - 17, cy - 22, 12, 44, 3, c); cv.roundRect(cx + 5, cy - 22, 12, 44, 3, c); }
                });
                skip('ov:ff', cx + 210, 1, 10000);
                // right: choose quality without cycling through other streams
                const qv = preferredQuality, fl = settings.get('fill') !== false, qx = SW - 330, zx = SW - 150;
                const actual = QUALITY_LABEL[model.sourceQuality];
                ctl('ov:q', qx, cy, 42, openQuality,
                    (c) => cv.text(actual || (qv === 'auto' ? '自动' : qv + 'P'), qx, cy + 8, 22, c, { literal: true, font: 'bold', align: 'center' }));
                cv.text(Date.now() < qualityPending ? '检查画质中' : Date.now() < qualityNotice ? '保持当前画质' : '画质',
                    qx, cy + 76, 22, '#dddddd', { literal: true, align: 'center' });
                ctl('ov:zoom', zx, cy, 42, () => { settings.set('fill', !fl); model.fill(!fl); }, (c) => {
                    cv.strokeRoundRect(zx - 22, cy - 15, 44, 30, 4, 3, c);
                    if (fl) cv.fillRect(zx - 22, cy - 15, 44, 30, c); else cv.fillRect(zx - 12, cy - 15, 24, 30, c);
                });
                cv.text(fl ? '原比例' : '填满', zx, cy + 76, 22, '#dddddd', { literal: true, align: 'center' });
            } else if (model.state === 'error' && model.id && model.connected) {
                const mp3 = canRetryMp3(), rx = mp3 ? cx - 172 : cx;
                ctl('ov:play', rx, cy, 58, again, (c) => retryGlyph(cv, rx, cy, 26, c));
                cv.text('重试', rx, cy + 100, 26, '#dddddd', { literal: true, align: 'center' });
                if (mp3) {
                    const x = cx - 76, y = cy - 30;
                    cv.roundRect(x, y, 316, 60, 16, focusKey === 'retry:mp3' ? C.cyan : C.card);
                    cv.text('用兼容 MP3 重试', x + 158, y + 40, 26, focusKey === 'retry:mp3' ? C.bg : C.text, { literal: true, align: 'center' });
                    tg(x, y, 316, 60, retryMp3, 'retry:mp3', 16);
                }
            }
            if (mid) cv.text(fit(cv, mid, 30, SW - 2 * LX, LIT), cx, model.state === 'preparing' || live || up || (model.state === 'error' && model.id) ? cy + 150 : cy + 10, 30, '#ffffff', { literal: true, align: 'center' });
            // bottom: the progress bar (the track, the part played, the scrubber) and the times
            if (model.total > 0 && live) {
                cv.gradientRect(0, SH - 150, SW, 150, [[0, '#00000000'], [1, '#000000d8']]);
                const x0 = LX + 40, w = SW - x0 - 40, y = SH - 66, el = shownAt(), fx = x0 + Math.round(w * Math.min(1, el / model.total)), bf = focusKey === 'ov:bar';
                const at = (ms) => x0 + Math.round(w * Math.min(1, ms / model.total)), ex = model.extras && model.extras.id === model.id ? model.extras : null;
                cv.roundRect(x0, y, w, 6, 3, '#ffffff55');
                cv.roundRect(x0, y, fx - x0, 6, 3, C.red);
                if (ex) ex.chapters.forEach((c) => { if (c[0] > 0) cv.fillRect(at(c[0]) - 2, y, 4, 6, '#000000'); });
                if (bf) cv.circle(fx, y + 3, 18, '#ffffff');
                cv.circle(fx, y + 3, bf ? 14 : 10, C.red);
                tg(x0 - 10, y - 34, w + 20, 70, run(() => model.toggle()), 'ov:bar', 0, turnSeek);
                const tt0 = clock(el) + ' / ' + clock(model.total), tw = cv.textWidth(tt0, 24, LITB), chap = model.chapter();
                cv.text(tt0, x0, SH - 22, 24, '#ffffff', LITB);
                if (chap) cv.text(fit(cv, '·  ' + chap, 24, w - tw - 20, LIT), x0 + tw + 14, SH - 22, 24, '#dddddd', LIT);
            }
            hmiIcons(cv);
        }
        // the HMI's home and back arrow column: its taps stay the HMI's, but no black hole over the video;
        // the same two icons where the HMI has them (screen px), on the scrim
        function hmiIcons(cv) {
            cv.xf(1, 0, 0);
            cv.circle(44, 42, 30, '#00000099');
            RAIL[1][2](cv, 44, 44, '#ffffff', '#1a1a1a');
            cv.circle(52, 398, 30, '#00000099');
            cv.polyline([[60, 384], [46, 398], [60, 412]], 5, '#ffffff');
            cv.xf();
        }
        let last = null, lastRev = -1, lastPaint = 0, lastSend = 0, lastMotion = '', upNext = null;
        function render() {
            const now = Date.now();
            upNext = autoNext();
            const shown = mode === 'player' && overlay();
            const motion = mode === 'player' ? [shown, shown && model.timeRev, qrUntil > now, qualityPending > now,
                qualityNotice > now, upNext && Math.ceil((nextAt - now) / 1000)].join(':') : String(model.thumbRev);
            // Static pages reuse their display list. Browsing also checks thumbnail retry timers.
            const refresh = !last || dirty || model.rev !== lastRev || motion !== lastMotion || (browsing() && now - lastPaint >= 1000);
            if (refresh) {
                dirty = false; lastRev = model.rev; lastPaint = now; lastMotion = motion;
                const cv = ctx.canvas(W, H).clear(C.bg);
                frameNo++;
                const d = ctx.display, g = d && d.gpu;
                if (d && (!g || !g.ready || !g.native || !g.touch || d.blocked) && !process.env.MGU_RENDERD_FILE) {
                    const title = d.blocked ? '正在恢复页面显示' : g && g.ready && !g.touch ? '显示组件的触控尚未就绪' : '正在连接完整显示界面';
                    say(cv, title);
                }
                else if (mode === 'player' && cv.own && cv.place && cv.place.full) drawFull(cv);
                else {
                    if (browsing() && mode !== 'keyboard') drawRail(cv);
                    if (mode === 'keyboard' && typing) drawKeyboard(cv);
                    else if (mode === 'player') drawPlayer(cv); else if (mode === 'channel') drawChannel(cv); else if (mode === 'results') drawResults(cv); else if (mode === 'account') drawSignIn(cv); else drawFeed(cv, isFeed(mode) ? mode : 'home');
                    // where the kit runs the screen the rail has the pages: the header shows just the name
                    if (cv.own) G.frame(cv, ctx.theme(), [], -1); else G.frame(cv, ctx.theme(), TABS.map((m) => NAMES[m]), TABS.indexOf(mode));
                }
                last = cv;
            }
            if (!refresh && (!last.own || now - lastSend < 500)) return undefined;
            lastSend = now;
            const draw = ui.image('VIEW_GFX', last);
            if (nextFocus && ctx.focus) { const key = nextFocus; nextFocus = null; ctx.focus(key); }
            return draw;
        }
        drawLoop = ctx.loop('VIEW', 10, render);
        log.info('RideBili app started');
    },
});
