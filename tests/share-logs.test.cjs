'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ShareLogs } = require('../desktop/share-logs.cjs');

test('a share log persists ordered events with only anonymous, allowlisted fields', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'friends-share-log-test-'));
    t.after(async () => {
        for (const name of await fs.readdir(dir)) await fs.unlink(path.join(dir, name));
        await fs.rmdir(dir);
    });
    const logs = new ShareLogs(dir, 'test');
    const id = randomUUID();
    const secret = 'private-window-title@192.0.2.24';
    await Promise.all([
        logs.write([{ type: 'start', id, direction: 'receive', shareId: secret, capture: { surface: 'window', name: secret } }]),
        logs.write([{ type: 'sample', id, roomMembers: 2, peers: [{ peer: 1, name: secret, path: 'TURN 中继', relayProtocol: 'udp', rttMs: 42,
            media: [{ kind: 'screen', direction: 'receive', fps: 59, jitterBufferMs: 38, codec: 'video/H264', fmtp: secret }] }] }]),
        logs.write([{ type: 'mark', id, message: secret }]),
        logs.finishAll('app-quit'),
    ]);
    await logs.write([{ type: 'start', id: '../outside', direction: 'send' }]);
    const files = await fs.readdir(dir);
    assert.equal(files.length, 1);
    const output = await fs.readFile(path.join(dir, files[0]), 'utf8');
    assert(!output.includes(secret));
    const entries = output.trim().split('\n').map(JSON.parse);
    assert.deepEqual(entries.map(entry => entry.type), ['start', 'sample', 'mark', 'end']);
    assert.equal(entries[1].peers[0].media[0].jitterBufferMs, 38);
    assert.equal(entries[1].peers[0].rttMs, 42);
    assert.equal(entries[3].reason, 'app-quit');
});
