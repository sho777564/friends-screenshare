(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.FriendsPeerAudio = api;
})(typeof window === 'object' ? window : globalThis, function () {
    const validIdentity = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
    function identity(storage) {
        let id;
        try { id = storage.getItem('friendsClientIdentity'); } catch {}
        if (!validIdentity(id)) {
            id = crypto.randomUUID();
            try { storage.setItem('friendsClientIdentity', id); } catch {}
        }
        return id;
    }
    function clean(value, kind) {
        const maximum = kind === 'voice' ? 300 : 100;
        const level = Number.isFinite(value?.volume) ? Math.max(0, Math.min(maximum, value.volume)) : 100;
        return { volume: level, muted: value?.muted === true };
    }
    class Preferences {
        constructor(storage, onError = () => {}) {
            this.storage = storage;
            this.onError = onError;
            this.sessions = new Map();
            this.saved = {};
            try {
                const saved = JSON.parse(storage.getItem('friendsPeerAudio') || '{}');
                for (const [id, value] of Object.entries(saved)) {
                    if (validIdentity(id)) this.saved[id] = { voice: clean(value.voice, 'voice'), sound: clean(value.sound, 'sound') };
                }
            } catch {}
        }
        bind(peer, id) {
            let session = this.sessions.get(peer);
            if (!session) {
                session = { identity: null, dirty: false, voice: clean(null, 'voice'), sound: clean(null, 'sound') };
                this.sessions.set(peer, session);
            }
            if (!validIdentity(id) || session.identity === id) return;
            session.identity = id;
            if (session.dirty) this.persist(session);
            else if (this.saved[id]) {
                session.voice = { ...this.saved[id].voice };
                session.sound = { ...this.saved[id].sound };
            }
        }
        get(peer, kind) {
            if (!this.sessions.has(peer)) this.bind(peer);
            return { ...this.sessions.get(peer)[kind] };
        }
        set(peer, kind, value) {
            if (!this.sessions.has(peer)) this.bind(peer);
            const session = this.sessions.get(peer);
            session[kind] = clean(value, kind);
            session.dirty = true;
            this.persist(session);
            return this.get(peer, kind);
        }
        persist(session) {
            if (!session.identity) return;
            this.saved[session.identity] = { voice: { ...session.voice }, sound: { ...session.sound } };
            try { this.storage.setItem('friendsPeerAudio', JSON.stringify(this.saved)); }
            catch (error) { this.onError(error); }
        }
        forget(peer) { this.sessions.delete(peer); }
    }
    return { Preferences, identity, validIdentity };
});
