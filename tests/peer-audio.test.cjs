'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Preferences, identity } = require('../public/peer-audio.js');

test('peer gains and mute states restore across restarts and connection IDs without mixing people', () => {
    const data = new Map();
    const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    const first = new Preferences(storage);
    first.bind('old-a', a);first.bind('old-b', b);
    first.set('old-a', 'voice', { volume: 205, muted: true });
    first.set('old-a', 'sound', { volume: 35, muted: false });
    const restarted = new Preferences(storage);
    restarted.bind('new-a', a);restarted.bind('new-b', b);
    assert.deepEqual(restarted.get('new-a', 'voice'), { volume: 205, muted: true });
    assert.deepEqual(restarted.get('new-a', 'sound'), { volume: 35, muted: false });
    assert.deepEqual(restarted.get('new-b', 'voice'), { volume: 100, muted: false });
    assert.equal(identity(storage), identity(storage));
    first.set('old-a', 'sound', { volume: 200, muted: false });
    assert.equal(first.get('old-a', 'sound').volume, 100);
});

test('editing before the identity handshake persists when that identity arrives', () => {
    const data = new Map();
    const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
    const id = crypto.randomUUID();
    const prefs = new Preferences(storage);
    prefs.set('pending', 'sound', { volume: 80, muted: true });
    prefs.bind('pending', id);
    const restarted = new Preferences(storage);restarted.bind('other-socket', id);
    assert.deepEqual(restarted.get('other-socket', 'sound'), { volume: 80, muted: true });
});
