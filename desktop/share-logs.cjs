'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTION_STATES = ['new', 'connecting', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed', 'recovering'];
const SIGNAL_STATES = ['connected', 'disconnected', 'error'];
const END_REASONS = ['stopped', 'source-ended', 'source-changed', 'peer-left', 'room-left', 'navigation', 'renderer-exit', 'window-closed', 'app-quit'];
const METRICS = ['width', 'height', 'fps', 'bitrate', 'encoderTargetBps', 'loss', 'remoteLoss', 'jitterMs', 'captureFps', 'captureWidth', 'captureHeight', 'encodeMs', 'decodeMs', 'jitterBufferMs', 'freezeCount', 'freezeMs', 'droppedFrames', 'concealedSamples'];

function numbers(source, keys) {
    const result = {};
    for (const key of keys) {
        const value = source?.[key];
        if (Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) result[key] = Math.round(value * 100) / 100;
    }
    return result;
}

const oneOf = (value, options) => options.includes(value) ? value : undefined;
const bounded = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
const validId = value => typeof value === 'string' && UUID.test(value);

function capture(source) {
    if (!source) return undefined;
    return {
        surface: oneOf(source.surface, ['screen', 'window']),
        sound: source.sound === true,
        ...numbers(source, ['width', 'height', 'configuredFps']),
    };
}

function quality(source) {
    if (!source) return undefined;
    return {
        ...numbers(source, ['width', 'height', 'fps', 'bitrate']),
        mode: oneOf(source.mode, ['balanced', 'detail', 'motion']),
        codec: oneOf(source.codec, ['auto', 'H264', 'VP8', 'VP9', 'AV1']),
        adaptive: typeof source.adaptive === 'boolean' ? source.adaptive : undefined,
    };
}

function media(source) {
    if (!source || !['screen', 'voice', 'sound'].includes(source.kind)) return null;
    const direction = oneOf(source.direction, ['send', 'receive']);
    if (!direction) return null;
    const metrics = numbers(source, METRICS);
    if (direction === 'send') delete metrics.loss;
    return {
        kind: source.kind, direction, ...metrics,
        codec: oneOf(source.codec, ['video/H264', 'video/VP8', 'video/VP9', 'video/AV1', 'video/H265', 'audio/opus', 'audio/PCMU', 'audio/PCMA', 'audio/G722']),
        limitation: oneOf(source.limitation, ['none', 'cpu', 'bandwidth', 'other']),
        powerEfficient: typeof source.powerEfficient === 'boolean' ? source.powerEfficient : undefined,
    };
}

function peer(source) {
    if (!source || !bounded(source.peer, 1, 1_000_000)) return null;
    return {
        peer: source.peer,
        state: oneOf(source.state, CONNECTION_STATES),
        iceState: oneOf(source.iceState, CONNECTION_STATES),
        path: oneOf(source.path, ['等待连接', 'P2P 直连', 'TURN 中继']),
        protocol: oneOf(source.protocol, ['udp', 'tcp']),
        relayProtocol: oneOf(source.relayProtocol, ['udp', 'tcp', 'tls']),
        ...numbers(source, ['rttMs', 'availableMbps', 'videoCeilingMbps', 'videoTargetWidth', 'videoTargetHeight', 'videoTargetFps', 'audioReserveKbps']),
        videoBudgetReason: oneOf(source.videoBudgetReason, ['starting', 'stable', 'delay', 'loss', 'bandwidth', 'recovering', 'probing']),
        media: Array.isArray(source.media) ? source.media.slice(0, 8).map(media).filter(Boolean) : [],
    };
}

class ShareLogs {
    constructor(directory, version) {
        this.directory = directory;
        this.version = version;
        this.active = new Map();
        this.queue = Promise.resolve();
    }

    enqueue(write) {
        const result = this.queue.then(write);
        this.queue = result.catch(() => {});
        return result;
    }

    write(entries) {
        if (!Array.isArray(entries) || entries.length > 4) return Promise.reject(new Error('Invalid share log batch'));
        const now = new Date();
        return this.enqueue(async () => {
            for (const entry of entries) await this.writeEntry(entry, now);
        });
    }

    async writeEntry(entry, now = new Date()) {
        if (!entry || !validId(entry.id)) return;
        const at = now.toISOString();
        const current = this.active.get(entry.id);
        if (entry.type === 'start') {
            if (current || this.active.size >= 4) return;
            const direction = oneOf(entry.direction, ['send', 'receive']);
            if (!direction) return;
            const stamp = at.replace(/[:.]/g, '-');
            const file = path.join(this.directory, `share-${stamp}-${direction}-${entry.id}.jsonl`);
            await fs.mkdir(this.directory, { recursive: true });
            const start = {
                type: 'start', at, schema: 1, appVersion: this.version, direction,
                shareId: validId(entry.shareId) ? entry.shareId : undefined,
                capture: capture(entry.capture), quality: quality(entry.quality),
            };
            await fs.writeFile(file, JSON.stringify(start) + '\n', { flag: 'wx' });
            this.active.set(entry.id, { file, lastSample: 0 });
            return;
        }
        if (!current) return;
        const record = { type: entry.type, at };
        switch (entry.type) {
            case 'sample':
                if (now.getTime() - current.lastSample < 1000) return;
                current.lastSample = now.getTime();
                record.peers = Array.isArray(entry.peers) ? entry.peers.slice(0, 3).map(peer).filter(Boolean) : [];
                record.roomMembers = bounded(entry.roomMembers, 1, 4);
                record.activeShares = bounded(entry.activeShares, 1, 4);
                record.fileTransfers = bounded(entry.fileTransfers, 0, 64);
                record.signal = oneOf(entry.signal, SIGNAL_STATES);
                record.capture = capture(entry.capture);
                record.quality = quality(entry.quality);
                break;
            case 'connection':
                record.peer = bounded(entry.peer, 1, 1_000_000);
                record.state = oneOf(entry.state, [...CONNECTION_STATES, 'joined', 'left']);
                if (!record.peer || !record.state) return;
                break;
            case 'signal':
                record.state = oneOf(entry.state, SIGNAL_STATES);
                if (!record.state) return;
                break;
            case 'mark':
                break;
            case 'end':
                record.reason = oneOf(entry.reason, END_REASONS);
                if (!record.reason) return;
                this.active.delete(entry.id);
                break;
            default:
                return;
        }
        await fs.appendFile(current.file, JSON.stringify(record) + '\n');
    }

    finishAll(reason) {
        return this.enqueue(async () => {
            const endings = [...this.active.keys()].map(id => this.writeEntry({ type: 'end', id, reason }));
            await Promise.allSettled(endings);
        });
    }
}

module.exports = { ShareLogs };
