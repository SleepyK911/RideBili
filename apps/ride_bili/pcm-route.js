'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Moonride's ID7 SmartX route. Only release the connection this app opened.
const COMMAND = 'org.genivi.am.commandinterface.CommandControl';
const ROUTING = 'org.genivi.am.routinginterface.RoutingControlObserver';
const SOURCE = 287, SINK = 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PcmRoute {
    constructor(signals, send, log) {
        this.signals = signals;
        this.send = send;
        this.log = log;
        this.q = Promise.resolve();
        this.wanted = null;
        this.id = null;
        this.marked = false;
    }
    async proxy(iface) {
        const p = await this.signals.proxy(iface, '1');
        const until = Date.now() + 1500;
        while (!await p.isAvailable()) {
            if (Date.now() >= until) throw new Error('AudioManager unavailable');
            await sleep(75);
        }
        return p;
    }
    prime() {
        if (!this.proxies) {
            this.proxies = Promise.all([this.proxy(COMMAND), this.proxy(ROUTING)])
                .then((p) => { [this.command, this.routing] = p; })
                .catch((e) => { this.proxies = null; throw e; });
        }
        return this.proxies;
    }
    async list() {
        const r = await this.signals.call(this.command, 'getListMainConnections', {}, 1000);
        const list = Array.isArray(r) ? r : r && (r.listConnections || Object.values(r).find(Array.isArray));
        if (!Array.isArray(list)) throw new Error('AudioManager connection list unavailable');
        return list;
    }
    availability(on) {
        return this.signals.call(this.routing, 'hookSourceAvailablityStatusChange',
            { sourceID: SOURCE, availability: { availability: on ? 'A_AVAILABLE' : 'A_UNAVAILABLE', availabilityReason: 0 } }, 1000);
    }
    async open(token) {
        if (this.wanted !== token) return;
        if (!this.command || !this.routing) {
            await this.prime();
        }
        if ((await this.list()).some((c) => c && c.sourceID === SOURCE)) throw new Error('SmartX source occupied');
        if (this.wanted !== token) return;
        this.marked = true;
        await this.availability(true);
        if (this.wanted !== token) return;
        const r = await this.signals.call(this.command, 'connect', { sourceID: SOURCE, sinkID: SINK }, 1500);
        if (!r || (r.amError !== 'E_OK' && r.amError !== 0) || r.mainConnectionID == null) throw new Error('SmartX connect refused');
        this.id = r.mainConnectionID;
        const until = Date.now() + 1500;
        while (this.wanted === token) {
            const c = (await this.list()).find((x) => x && x.mainConnectionID === this.id && x.sourceID === SOURCE);
            if (c && (c.connectionState === 'CS_CONNECTED' || c.connectionState === 2)) {
                this.send({ cmd: 'pcm_route_result', token, ok: true });
                return;
            }
            if (Date.now() >= until) throw new Error('SmartX route did not connect');
            await sleep(100);
        }
    }
    async close() {
        const id = this.id;
        if (this.id !== null) {
            const r = await this.signals.call(this.command, 'disconnect', { mainConnectionID: this.id }, 1000);
            if (r && r.amError !== 'E_OK' && r.amError !== 'E_NON_EXISTENT' && r.amError !== 0) throw new Error('SmartX disconnect refused');
            this.id = null;
        }
        if (this.marked) {
            if (!(await this.list()).some((c) => c && c.sourceID === SOURCE && c.mainConnectionID !== id)) {
                await this.availability(false);
            }
            this.marked = false;
        }
    }
    request(token, on) {
        if (on) this.wanted = token;
        else if (token == null || this.wanted === token) this.wanted = null;
        this.q = this.q.then(async () => {
            if (on) {
                if (this.wanted !== token) return;
                try { await this.close(); await this.open(token); }
                catch (e) {
                    this.log.warn('SmartX: ' + e.message);
                    await this.close().catch((err) => this.log.warn('SmartX release: ' + err.message));
                    if (this.wanted === token) {
                        const reason = e.message === 'SmartX source occupied' ? 'busy' :
                            e.message === 'AudioManager unavailable' ? 'unavailable' : 'route';
                        this.send({ cmd: 'pcm_route_result', token, ok: false, reason });
                    }
                }
            } else {
                await this.close().catch((e) => this.log.warn('SmartX release: ' + e.message));
                if (token != null) this.send({ cmd: 'pcm_released', token });
            }
        }).catch((e) => this.log.warn('SmartX: ' + e.message));
        return this.q;
    }
}

module.exports = PcmRoute;
