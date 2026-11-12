'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { clean, errorFields } = require('../public/diagnostics.js');
const { DiagnosticLog } = require('../desktop/diagnostic-log.cjs');

test('records the failed audio device and fallback without retaining private error text, including on export', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'friends-diagnostics-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const log = new DiagnosticLog(directory, '2.6.1');
    const error = new Error('AudioContext.setSinkId failed: the device private-device-id is not found');
    error.name = 'NotFoundError';
    error.stack = 'NotFoundError: private-device-id\n at configureOutput (C:/Users/private-user/app.js:124:8)';
    await Promise.all([
        log.write({ area: 'room', event: 'start', attempt: 1, mode: 'manual', room: 'private-room' }),
        log.write({ area: 'audio-output', event: 'error', attempt: 1, ...errorFields(error), message: 'private-message' }),
        log.write({ area: 'audio-output', event: 'fallback', attempt: 1, mode: 'default-device' }),
        log.write({ area: 'room', event: 'joined', attempt: 1 }),
    ]);
    const file = path.join(directory, (await log.list())[0]);
    const raw = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(raw, /private-/);
    const row = JSON.parse(raw.split('\n')[1]);
    assert.equal(row.source, 'app.js:124:8');
    assert.equal(row.reason, 'device-not-found');
    await fs.appendFile(file, JSON.stringify({ ...row, message: 'private-extra', source: 'C:/Users/private-user/app.js:124:8' }) + '\n');
    await fs.appendFile(file, '{interrupted');
    const report = await log.report({ windows: '10.0.26200', electron: '45.2.1', chrome: 'not a version' });
    assert.equal(report.records.length, 5);
    assert.deepEqual(report.records.slice(0, 4).map(entry => entry.event), ['start', 'error', 'fallback', 'joined']);
    assert.doesNotMatch(JSON.stringify(report), /private-|not a version/);
});

test('rotates diagnostics and exports only bounded recent files', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'friends-diagnostics-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const log = new DiagnosticLog(directory, '2.6.1', { maxBytes: 300, maxFiles: 2 });
    await fs.writeFile(path.join(directory, 'unrelated.jsonl'), 'leave untouched');
    for (let attempt = 1; attempt <= 8; attempt++) await log.write({ area: 'room', event: 'error', reason: 'room-timeout', attempt });
    assert.equal((await log.list()).length, 2);
    assert.deepEqual((await log.report({})).records.map(entry => entry.attempt), [7, 8]);
    assert.equal(await fs.readFile(path.join(directory, 'unrelated.jsonl'), 'utf8'), 'leave untouched');
});

test('voice diagnostics retain only bounded anonymous transport measurements', () => {
    const row = clean({ area:'peer', event:'quality', attempt:2, voice:{
        path:'P2P 直连', rttMs:27.345, receiveLossPct:2, concealedSamples:960,
        sendLossPct:101, jitterBufferMs:Infinity, name:'private-contact', ip:'192.0.2.1',
    } });
    assert.deepEqual(row, { area:'peer', event:'quality', attempt:2,
        voice:{path:'P2P 直连', rttMs:27.35, receiveLossPct:2, concealedSamples:960} });
    assert.equal(errorFields(new Error('对方未能进入房间')).reason, 'remote-room-failed');
    assert.equal(errorFields(new Error('对方取消了呼叫')).reason, 'cancelled');
});
