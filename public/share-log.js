'use strict';

class ShareLog {
    constructor(io, onError) {
        this.io = io;
        this.onError = onError;
        this.active = new Map();
        this.samplePending = false;
        this.reportedError = false;
    }

    async write(entries) {
        if (!this.io || !entries.length) return false;
        try {
            await this.io.write(entries);
            return true;
        } catch (error) {
            if (!this.reportedError) this.onError(error);
            this.reportedError = true;
            return false;
        }
    }

    startLocal(capture, quality) {
        this.end(null, 'source-changed');
        const id = crypto.randomUUID();
        this.start(null, id, { shareId: id, capture, quality });
        return id;
    }

    remoteState(peer, state) {
        if (state.screen !== true) {
            this.end(peer, 'stopped');
            return;
        }
        const shareId = typeof state.shareId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state.shareId) ? state.shareId : undefined;
        const current = this.active.get(peer);
        if (current && current.shareId === shareId) return;
        this.end(peer, 'source-changed');
        this.start(peer, crypto.randomUUID(), { shareId });
    }

    start(key, id, details) {
        if (!this.io) return;
        const direction = key === null ? 'send' : 'receive';
        this.active.set(key, { id, direction, shareId: details.shareId, aliases: new Map() });
        void this.write([{ type: 'start', id, direction, ...details }]);
    }

    end(key, reason) {
        const current = this.active.get(key);
        if (!current) return;
        this.active.delete(key);
        void this.write([{ type: 'end', id: current.id, reason }]);
    }

    endAll(reason) {
        for (const key of this.active.keys()) this.end(key, reason);
    }

    alias(log, peer) {
        if (!log.aliases.has(peer)) log.aliases.set(peer, log.aliases.size + 1);
        return log.aliases.get(peer);
    }

    connection(peer, state) {
        const entries = [];
        for (const [key, log] of this.active) {
            if (key === null || key === peer) entries.push({ type: 'connection', id: log.id, peer: this.alias(log, peer), state });
        }
        void this.write(entries);
    }

    event(type, details = {}) {
        return this.write([...this.active.values()].map(log => ({ type, id: log.id, ...details })));
    }

    async sample(stats, context) {
        if (this.samplePending || !this.active.size) return;
        this.samplePending = true;
        try {
            const { capture, quality, ...common } = context;
            const entries = [];
            for (const [key, log] of this.active) {
                const peers = stats.filter(p => key === null || p.id === key).map(p => ({
                    peer: this.alias(log, p.id), state: p.state, iceState: p.iceState,
                    path: p.path, protocol: p.protocol, relayProtocol: p.relayProtocol,
                    rttMs: p.rttMs, availableMbps: p.availableMbps,
                    videoCeilingMbps: p.videoCeilingMbps, videoBudgetReason: p.videoBudgetReason,
                    videoTargetFps: p.videoTargetFps,
                    media: p.media.filter(m => m.kind !== 'screen' || m.direction === log.direction),
                }));
                entries.push({
                    type: 'sample', id: log.id, ...common, peers,
                    capture: key === null ? capture : undefined,
                    quality: key === null ? quality : undefined,
                });
            }
            await this.write(entries);
        } finally {
            this.samplePending = false;
        }
    }
}

if (typeof module === 'object' && module.exports) module.exports = ShareLog;
