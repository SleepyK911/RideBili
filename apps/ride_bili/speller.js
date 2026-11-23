'use strict';
/**
 * The HMI's own full-screen free-text speller, opened as the Store app opens it: the use case
 * 02076b22-d19b-4aef-9e8c-0d7305d8b88c through the SDK's use case factory (needs the
 * usecasemanagement proxies, which build.py gives every app).
 *
 *   spell(ctx.app, 'Search videos').then((text) => ...)   // text, or null when left without OK
 *
 * Interaction parameters: 4 the title (22 characters show), 102 the text so far (each keystroke),
 * 105 present once the driver pressed OK. Written for this kit (the Store's speller.js is GPL).
 */
const USE_CASE = '02076b22-d19b-4aef-9e8c-0d7305d8b88c';
const P_TITLE = 4, P_INPUT = 102, P_OK = 105;
const FINAL = ['ABORTED', 'COMPLETED'];

function spell(app, title) {
    return new Promise((resolve, reject) => {
        let inst = null, sub = null, text = '', done = false, startedAt = 0, active = false;
        const timer = setTimeout(() => finish(new Error('system keyboard opening timed out')), 9000);
        const finish = (err, v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (inst && sub !== null) Promise.resolve().then(() => inst.proxy.notify.unsubscribe(sub)).catch(() => {});
            if (err) reject(err); else resolve(v);
        };
        Promise.resolve().then(() => app.getUseCaseFactory())
            .then((f) => done ? null : f.create(USE_CASE))
            .then((i) => { if (done) return null; inst = i; return inst.proxy.init(); })
            .then(() => done ? null : inst.proxy.waitUntilAvailable())
            .then(() => done ? null : inst.proxy.notify.subscribe((n) => {
                const p = n && n.interactionParameters;     // Map-like, not always this realm's Map
                const has = (k) => !!p && typeof p.has === 'function' && p.has(k);
                const state = n && n.interactionState;
                if (has(P_INPUT)) { text = String(p.get(P_INPUT)); active = true; }
                if (state && state !== 'READY' && state !== 'ABORTED' && state !== 'FAILED') active = true;
                if (has(P_OK)) finish(null, text);
                else if (state === 'FAILED' || (state === 'ABORTED' && !active && startedAt && Date.now() - startedAt < 500))
                    finish(new Error('system keyboard ' + state));
                else if (FINAL.indexOf(state) >= 0) finish(null, null);
            }))
            .then((id) => {
                if (done) {
                    if (inst && id != null) return Promise.resolve(inst.proxy.notify.unsubscribe(id)).catch(() => {});
                    return null;
                }
                sub = id === undefined ? null : id;
                return Promise.resolve(inst.proxy.interactionState.getValue()).then((st) => {
                    if (done) return null;
                    if (st !== 'READY') throw new Error('speller is ' + st);
                    startedAt = Date.now();
                    return Promise.resolve(inst.proxy.start({ token: inst.token, startParameters: new Map([[P_TITLE, String(title).slice(0, 22)]]) }))
                        .then(() => clearTimeout(timer));
                });
            })
            .catch((e) => finish(e));
    });
}

module.exports = { spell };
