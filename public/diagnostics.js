(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.FriendsDiagnostics = api;
        root.addEventListener('error', event => api.record('renderer', 'error', event.error || event.message));
        root.addEventListener('unhandledrejection', event => api.record('renderer', 'error', event.reason));
    }
})(typeof window === 'object' ? window : globalThis, function () {
    'use strict';

    const areas = new Set(['application', 'renderer', 'native', 'ui', 'room', 'phone', 'signal', 'peer',
        'audio-output', 'microphone', 'screen', 'file', 'remote', 'update']);
    const events = new Set(['start', 'ready', 'error', 'fallback', 'joined', 'left', 'state', 'cancel', 'stop']);
    const modes = new Set(['manual', 'invite', 'contact-call', 'saved-device', 'default-device']);
    const states = new Set(['idle', 'incoming', 'outgoing', 'connecting', 'waiting', 'connected', 'completed',
        'new', 'disconnected', 'failed', 'closed', 'recovering', 'crashed', 'killed', 'oom', 'launch-failed',
        'abnormal-exit', 'integrity-failure', 'clean-exit']);
    const errorNames = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AbortError',
        'NotFoundError', 'NotAllowedError', 'NotReadableError', 'OverconstrainedError', 'InvalidStateError',
        'NotSupportedError', 'OperationError', 'SecurityError', 'TimeoutError', 'TransportError']);
    const codes = new Set(['EADDRINUSE', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EBUSY', 'ECONNRESET',
        'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_TIMED_OUT',
        'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_INTERNET_DISCONNECTED', 'ERR_PROXY_CONNECTION_FAILED',
        'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_NETWORK_CHANGED']);
    const reasons = new Set(['device-not-found', 'device-busy', 'permission-denied', 'room-timeout',
        'room-locked', 'room-full', 'room-rejected', 'lobby', 'already-joining', 'call-timeout', 'cancelled',
        'network', 'timeout', 'disk-full', 'checksum', 'port-in-use', 'unsupported', 'application-error']);
    const sources = new Set(['app.js', 'phone-ui.js', 'phone.js', 'media.js', 'audio.js', 'files.js', 'file-ui.js',
        'remote.js', 'remote-ui.js', 'update-ui.js', 'share-log.js', 'main.cjs', 'updates.cjs', 'remote-ipc.cjs',
        'file-ipc.cjs', 'file-store.cjs', 'server.cjs', 'share-logs.cjs']);
    const locationPattern = /(?:[\\/]|^)([\w.-]+\.(?:js|cjs)):(\d{1,6}):(\d{1,6})(?=[)\s]|$)/g;

    function errorFields(error) {
        if (!error) return {};
        const message = typeof error === 'string' ? error.slice(0, 2048) : String(error.message || '').slice(0, 2048);
        const errorName = errorNames.has(error.name) ? error.name : 'Error';
        const embeddedCode = message.match(/\bERR_[A-Z_]+\b/)?.[0];
        const code = codes.has(error.code) ? error.code : codes.has(embeddedCode) ? embeddedCode : undefined;
        let reason = 'application-error';
        if (errorName === 'NotFoundError' || errorName === 'OverconstrainedError' || /setsinkid[^\n]*not found/i.test(message)) reason = 'device-not-found';
        else if (errorName === 'NotReadableError' || code === 'EBUSY') reason = 'device-busy';
        else if (errorName === 'NotAllowedError' || errorName === 'SecurityError' || ['EACCES', 'EPERM'].includes(code)) reason = 'permission-denied';
        else if (/连接房间超时/.test(message)) reason = 'room-timeout';
        else if (/房间已满|最多 4 人/.test(message)) reason = 'room-full';
        else if (/房间.*锁定|roomIs(?:Join)?Locked/.test(message)) reason = 'room-locked';
        else if (/正在连接房间|已经在房间/.test(message)) reason = 'already-joining';
        else if (/无人接听|通话连接超时/.test(message)) reason = 'call-timeout';
        else if (errorName === 'AbortError' || /呼叫已取消|取消了呼叫/.test(message)) reason = 'cancelled';
        else if (code === 'EADDRINUSE') reason = 'port-in-use';
        else if (code === 'ENOSPC' || /磁盘空间/.test(message)) reason = 'disk-full';
        else if (/校验失败|签名无效|checksum/i.test(message)) reason = 'checksum';
        else if (errorName === 'TimeoutError' || code === 'ETIMEDOUT' || /超时|timeout/i.test(message)) reason = 'timeout';
        else if (errorName === 'NotSupportedError') reason = 'unsupported';
        else if (errorName === 'TransportError' || code?.startsWith('ERR_') || ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND'].includes(code)) reason = 'network';

        const stack = typeof error.stack === 'string' ? error.stack.slice(0, 8192) : '';
        const frame = [...stack.matchAll(locationPattern)].find(match => sources.has(match[1]));
        return { errorName, reason, code, source: frame ? `${frame[1]}:${frame[2]}:${frame[3]}` : undefined };
    }

    function clean(record) {
        if (!record || !areas.has(record.area) || !events.has(record.event)) return null;
        const entry = { area: record.area, event: record.event };
        if (modes.has(record.mode)) entry.mode = record.mode;
        if (states.has(record.state)) entry.state = record.state;
        if (reasons.has(record.reason)) entry.reason = record.reason;
        if (errorNames.has(record.errorName)) entry.errorName = record.errorName;
        if (codes.has(record.code)) entry.code = record.code;
        if (Number.isInteger(record.attempt) && record.attempt > 0 && record.attempt <= 1_000_000) entry.attempt = record.attempt;
        if (Number.isInteger(record.exitCode) && Math.abs(record.exitCode) <= 0xffffffff) entry.exitCode = record.exitCode;
        if (typeof record.source === 'string' && record.source.length <= 64) {
            const frame = /^([\w.-]+\.(?:js|cjs)):\d{1,6}:\d{1,6}$/.exec(record.source);
            if (frame && sources.has(frame[1])) entry.source = record.source;
        }
        return entry;
    }

    function record(area, event, error, context = {}) {
        const entry = clean({ ...errorFields(error), ...context, area, event });
        if (entry && typeof window === 'object') {
            void window.friendsDesktop?.diagnostics?.record(entry).catch(() => {});
        }
    }

    return { clean, errorFields, record };
});
