'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VideoBudget, Conference, videoFrameTarget, videoProfile, defaults } = require('../public/media.js');

test('video ceiling leaves headroom and cuts quickly at the overnight congestion readings', () => {
    const budget = new VideoBudget();
    assert.equal(budget.ceiling(25_000_000, true), 8_000_000);
    budget.update({ rttMs: 35, availableMbps: 14 }, 25_000_000, 0);
    const limited = budget.update({ rttMs: 1006, availableMbps: .39 }, 25_000_000, 2000);
    assert.equal(limited, 343200);
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
    assert(restored > cut && restored <= cut * 1.5 + 1);
    assert.equal(budget.ceiling(100000, true), 100000);
});

test('sustained low bandwidth reduces video despite stable RTT and no fresh loss', () => {
    const budget = new VideoBudget();
    const maximum = 25_000_000;
    const narrow = { rttMs: 76, availableMbps: .39, audioReserve: 192_000 };
    for (let time = 0; time <= 20000; time += 2000) budget.update(narrow, maximum, time);
    assert.equal(budget.bps, 151200);
    assert.deepEqual(videoProfile(defaults, budget.bps), { width:480, height:270, fps:20, scale:4, degradation:'maintain-framerate' });

    budget.update({ ...narrow, availableMbps: 6.64 }, maximum, 22000);
    budget.update(narrow, maximum, 24000);
    assert.equal(budget.bps, 151200, 'one estimate spike must not raise the profile');
    for (let time = 26000; time <= 64000; time += 2000) budget.update({ ...narrow, availableMbps: 8 }, maximum, time);
    assert.equal(videoProfile(defaults, budget.bps).fps, 60);
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

test('detail mode yields to a viable frame rate under pressure and preserves configured limits', () => {
    assert.equal(videoProfile({ ...defaults, mode:'detail' }, 7_000_000).degradation, 'maintain-resolution');
    assert.deepEqual(videoProfile({ ...defaults, mode:'detail' }, 450_000),
        { width:640, height:360, fps:30, scale:3, degradation:'maintain-framerate' });
    assert.equal(videoProfile({ ...defaults, adaptive:false }, 100_000).width, 1920);
    const portrait = videoProfile(defaults, 900_000, { width:1080, height:1920, frameRate:25 });
    assert.deepEqual(portrait, { width:540, height:960, fps:25, scale:2, degradation:'maintain-framerate' });
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
