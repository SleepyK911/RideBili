'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
const cp = require('child_process');
const readline = require('readline');

class Realtime {
    constructor(opts, token, send, onEvent, startMs) {
        this.token = token;
        this.send = send;
        this.log = opts.log;
        this.requested = false;
        this.ready = false;
        this.waiting = false;
        this.holding = true;
        this.child = cp.spawn(opts.pcmOut[0], opts.pcmOut.slice(1).concat(String(startMs || 0)), {
            stdio: ['pipe', 'pipe', 'pipe', 'pipe']
        });
        const child = this.child;
        child.stdin.on('error', () => {});
        child.stdio[3].on('error', (e) => {
            if (!this.closed && e.code !== 'ENOTCONN') this.log('SmartX PCM pipe: ' + e.message);
        });
        const fault = (msg, incomplete) => {
            if (this.error || this.closed) return;
            this.error = msg;
            onEvent({ ev: 'error', msg, incomplete });
        };
        child.on('error', (e) => fault(e.message));
        child.on('close', (code, sig) => {
            if (!this.ended) fault('PCM output closed (' + (sig || code) + ')');
        });
        readline.createInterface({ input: child.stderr }).on('line', (l) => this.log('pcmout: ' + l));
        readline.createInterface({ input: child.stdout }).on('line', (l) => {
            if (this.closed || this.error) return;
            let m;
            try { m = JSON.parse(l); } catch (e) { return; }
            if (m.ev === 'error') return fault(m.msg, m.incomplete);
            if (m.ev === 'opened') this.opened = true;
            if (m.ev === 'ready') this.ready = true;
            if (m.ev === 'ended') this.ended = true;
            if (m.ev === 'buffer') this.waiting = !!m.on;
            onEvent(m);
        });
    }
    pipe(source) {
        this.source = source;
        source.on('error', (e) => this.log('AAC PCM pipe: ' + e.message));
        source.pipe(this.child.stdio[3]);
    }
    route() {
        if (this.closed || this.error) return Promise.resolve(false);
        if (this.routing) return this.routing;
        this.requested = true;
        this.routing = this.waitReply('routeReply', 'pcm_route', 5600);
        return this.routing;
    }
    waitReply(key, event, ms) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => this[key](false), ms);
            this[key] = (ok) => { clearTimeout(timeout); this[key] = null; resolve(ok); };
            this.send({ ev: event, token: this.token });
        });
    }
    hold(holding) {
        if (this.closed || this.holding === holding) return;
        this.holding = holding;
        this.child.stdin.write(holding ? 'hold\n' : 'start\n');
    }
    close() {
        if (this.closing) return this.closing;
        this.closed = true;
        if (this.routeReply) this.routeReply(false);
        const child = this.child;
        if (this.source) this.source.unpipe(child.stdio[3]);
        child.stdio[3].destroy();
        child.stdin.end('quit\n');
        const exit = new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
            const timer = setTimeout(() => child.kill('SIGKILL'), 500);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        const route = this.requested ? this.waitReply('releaseReply', 'pcm_release', 2400) : Promise.resolve();
        this.closing = Promise.all([exit, route]);
        return this.closing;
    }
}

module.exports = Realtime;
