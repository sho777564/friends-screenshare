'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/update-ui.js'), 'utf8');
function fixture({ disabled = false, rejectInstall = false } = {}) {
    const effects = [];
    const timers = new Map();
    const nodes = new Map();
    const values = new Map(disabled ? [['friendsAutoUpdate', 'off']] : []);
    let sequence = 0;
    const context = vm.createContext({
        $: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
        localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
        location: { pathname: '/' }, document: { querySelector: () => context.openDialog },
        setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
        clearTimeout: id => timers.delete(id), setInterval: () => {},
        restartForUpdate: false, roomJoinInProgress: false, joined: false, call: { socket: null },
        display: null, rawMic: null, microphoneRequest: null,
        transfers: { items: new Map() }, remoteSession: { hosts: new Map(), requests: new Map() },
        phoneController: { stop: () => effects.push('phone-stop'), start: () => effects.push('phone-start'), cancel: () => effects.push('phone-cancel') },
        toast: () => {}, leaveRoom: () => effects.push('leave-room'), run: fn => fn().catch(() => {}),
        native: { updates: {
            status: async () => ({ state: 'idle' }), onStatus: () => {},
            check: async () => { effects.push('check'); return { state: 'available', version: '2.6.3' }; },
            download: async automatic => { effects.push(automatic ? 'auto-download' : 'manual-download'); return { state: 'ready', version: '2.6.3', automatic }; },
            install: async () => { effects.push('install'); if (rejectInstall) throw new Error('helper failure'); return { state: 'installing' }; },
        } },
    });
    vm.runInContext(script, context);
    const invoke = code => vm.runInContext(code, context);
    const fire = delay => {
        const timer = [...timers].find(([, task]) => task.delay === delay);
        if (!timer) return false;
        timers.delete(timer[0]);
        timer[1].fn();
        return true;
    };
    return { context, effects, invoke, fire };
}

test('startup checks and downloads, and only applies after calls and transfers are idle', async () => {
    const { context, effects, invoke, fire } = fixture();
    await Promise.resolve();
    assert.ok(fire(1000));
    await new Promise(setImmediate);
    assert.deepEqual(effects, ['check', 'auto-download']);

    context.call.socket = {};
    invoke('scheduleAutomaticInstall()');
    assert.equal(fire(4000), false);
    context.call.socket = null;
    context.transfers.items.set('transfer', { terminal: false });
    invoke('scheduleAutomaticInstall()');
    assert.equal(fire(4000), false);
    context.transfers.items.clear();
    invoke('scheduleAutomaticInstall()');
    context.roomJoinInProgress = true;
    assert.ok(fire(4000));
    assert.equal(effects.includes('install'), false);
    context.roomJoinInProgress = false;
    invoke('scheduleAutomaticInstall()');
    assert.ok(fire(4000));
    assert.deepEqual(effects, ['check', 'auto-download', 'phone-stop', 'install']);
});

test('turning automatic installation off still checks, and manually selected packages wait for confirmation', async () => {
    const { effects, invoke, fire } = fixture({ disabled: true });
    await Promise.resolve();
    await invoke('checkAutomaticUpdate()');
    assert.deepEqual(effects, ['check']);
    invoke("localStorage.setItem('friendsAutoUpdate', 'on'); renderUpdate({ state: 'ready', version: '2.6.3', automatic: false }); scheduleAutomaticInstall();");
    assert.equal(fire(4000), false);
});

test('a helper failure restores call reception and stops repeated automatic restart attempts', async () => {
    const { effects, invoke, fire } = fixture({ rejectInstall: true });
    await Promise.resolve();
    await invoke('checkAutomaticUpdate()');
    invoke('scheduleAutomaticInstall()');
    assert.ok(fire(4000));
    await new Promise(setImmediate);
    assert.equal(invoke('restartForUpdate'), false);
    assert.deepEqual(effects, ['check', 'auto-download', 'phone-stop', 'install', 'phone-start']);
    invoke('scheduleAutomaticInstall()');
    assert.equal(fire(4000), false);
});
