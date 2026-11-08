'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VideoBudget, Conference, videoFrameTarget, defaults } = require('../public/media.js');

test('video ceiling leaves headroom and cuts quickly at the overnight congestion readings', () => {
    const budget = new VideoBudget();
    assert.equal(budget.ceiling(25_000_000, true), 8_000_000);
    budget.update({ rttMs: 35, availableMbps: 14 }, 25_000_000, 0);
    const limited = budget.update({ rttMs: 1006, availableMbps: .39 }, 25_000_000, 2000);
    assert.equal(limited, 150000);
    assert.equal(budget.reason, 'delay');
    assert.equal(budget.ceiling(4_000_000, false), 4_000_000);
});

test('brief good samples cannot immediately restore a high video rate', () => {
    const budget = new VideoBudget();
    budget.update({ rttMs: 35, availableMbps: 20 }, 12_000_000, 0);
    budget.update({ rttMs: 800, availableMbps: 20 }, 12_000_000, 2000);
    const cut = budget.bps;
    for (let time = 4000; time <= 10000; time += 2000) {
        assert.equal(budget.update({ rttMs: 35, availableMbps: 20 }, 12_000_000, time), cut);
    }
    const restored = budget.update({ rttMs: 35, availableMbps: 20 }, 12_000_000, 12000);
    assert(restored > cut && restored <= cut * 1.15 + 1);
    assert.equal(budget.ceiling(100000, true), 100000);
});

test('a stale low bandwidth estimate cannot lock a healthy link at blurry video rates', () => {
    const budget = new VideoBudget();
    for (let time = 0; time <= 60000; time += 2000) budget.update({ rttMs: 63, availableMbps: 2 }, 12_000_000, time);
    assert(budget.bps > 8_000_000);
    budget.update({ rttMs: 63, availableMbps: 2, remoteLoss: 10 }, 12_000_000, 62000);
    assert(budget.bps <= 1_200_000);
    assert.equal(budget.reason, 'loss');
});

test('adaptive frame targets use 30 under a limited video budget and 60 when it fits', () => {
    assert.equal(videoFrameTarget(defaults, 4_000_000), 30);
    assert.equal(videoFrameTarget(defaults, 8_000_000), 60);
    assert.equal(videoFrameTarget({ ...defaults, adaptive: false }, 1_000_000), 60);
    assert.equal(videoFrameTarget({ ...defaults, fps: 30 }, 8_000_000), 30);
});

test('stable low-traffic screens do not cause repeated cuts from quality-limitation flags', () => {
    const budget = new VideoBudget();
    for (let time = 0; time < 60000; time += 2000) {
        budget.update({ rttMs: 31, availableMbps: 20, limitation: 'bandwidth' }, 6_000_000, time);
        assert.equal(budget.bps, 6_000_000);
    }
});

test('recovery restarts only the failed peer and stops retrying after removal', async t => {
    const call = new Conference({ socketFactory: () => {} });
    let restarts = 0;
    const p = { id: 'failed-peer', polite: false, recoveryAttempts: 0, allIce: [], pc: {
        connectionState: 'failed', signalingState: 'stable',
        getConfiguration: () => ({}), setConfiguration() {}, restartIce() { restarts++; },
    } };
    call.peers.set(p.id, p);
    call.peers.set('healthy-peer', { pc: { connectionState: 'connected' } });
    call.socket = { connected: true };
    call.negotiate = async () => {};
    t.after(() => clearTimeout(p.recoveryTimer));
    await call.recoverPeer(p);
    assert.equal(restarts, 1);
    assert.equal(call.peers.get('healthy-peer').pc.connectionState, 'connected');
    clearTimeout(p.recoveryTimer);
    p.recoveryTimer = null;
    call.peers.delete(p.id);
    await call.recoverPeer(p);
    assert.equal(restarts, 1);
});

test('recovery waits for signaling and limits actual ICE restart attempts', async () => {
    const call = new Conference({ socketFactory: () => {} });
    let restarts = 0;
    const p = { id: 'peer', polite: false, recoveryAttempts: 0, allIce: [], pc: {
        connectionState: 'failed', signalingState: 'stable',
        getConfiguration: () => ({}), setConfiguration() {}, restartIce() { restarts++; },
    } };
    call.peers.set(p.id, p);
    call.socket = { connected: false };
    call.scheduleRecovery = () => {};
    call.negotiate = async () => {};
    await call.recoverPeer(p);
    assert.equal(restarts, 0);
    call.socket.connected = true;
    for (let i = 0; i < 6; i++) await call.recoverPeer(p);
    assert.equal(restarts, 4);
});
