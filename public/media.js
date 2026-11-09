/* Friends Screen Share, AGPL-3.0-only. Public MiroTalk signaling protocol compatible.
 * Microphone and screen audio MUST remain separate throughout the media path.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.FriendsMedia = api;
})(typeof window === 'object' ? window : globalThis, function () {
    'use strict';
    const SIGNAL = 'https://p2p.mirotalk.com';
    const KINDS = ['voice', 'sound', 'screen'];
    const MAX_PARTICIPANTS=4;
    const VOICE_BITRATE = 64_000;
    const SOUND_BITRATE = 256_000;
    const MIN_VIDEO_BITRATE = 50_000;
    const peerVideoBudget=(quality,peers)=>({...quality,bitrate:quality.bitrate/Math.max(1,peers)});
    function videoFrameTarget(quality, bitrate) {
        if (!quality.adaptive || quality.fps <= 30) return quality.fps;
        const motionBudget = quality.width * quality.height * quality.fps * .05;
        return bitrate < motionBudget ? 30 : quality.fps;
    }
    const limitedVideoProfiles = [
        { bitrate: 1_400_000, height: 720, fps: 30 },
        { bitrate: 800_000, height: 540, fps: 30 },
        { bitrate: 390_000, height: 360, fps: 30 },
        { bitrate: 150_000, height: 270, fps: 20 },
        { bitrate: 0, height: 180, fps: 15 },
    ];
    function videoProfile(quality, bitrate, capture = {}) {
        const width = capture.width || quality.width;
        const height = capture.height || quality.height;
        const fps = Math.min(quality.fps, capture.frameRate || quality.fps);
        const full = { ...quality, width, height, fps };
        if (!quality.adaptive || bitrate >= width * height * Math.min(fps, 30) * .05) {
            return { width, height, fps: videoFrameTarget(full, bitrate), scale: 1, degradation: degradationFor(quality.mode) };
        }
        const profile = limitedVideoProfiles.find(level => bitrate >= level.bitrate);
        const scale = Math.max(1, Math.max(width, height) / Math.round(profile.height * 16 / 9), Math.min(width, height) / profile.height);
        return {
            width: Math.floor(width / scale / 2) * 2,
            height: Math.floor(height / scale / 2) * 2,
            fps: Math.min(fps, profile.fps),
            scale,
            degradation: 'maintain-framerate',
        };
    }
    class VideoBudget {
        constructor() {
            this.bps = null;
            this.rtts = [];
            this.estimates = [];
            this.goodSince = null;
            this.lastCut = -Infinity;
            this.reason = 'starting';
            this.lastIncrease = -Infinity;
            this.audioReserve = 0;
        }
        ceiling(maximum, enabled) {
            if (!enabled) return maximum;
            this.bps = Math.min(this.bps ?? 8_000_000, maximum);
            return this.bps;
        }
        update(sample, maximum, now = Date.now()) {
            const current = this.ceiling(maximum, true);
            const floor = Math.min(MIN_VIDEO_BITRATE, maximum);
            const rtt = sample.rttMs;
            if (Number.isFinite(rtt) && rtt > 0) this.rtts.push(rtt);
            if (this.rtts.length > 30) this.rtts.shift();
            const baseline = this.rtts.length ? Math.min(...this.rtts) : null;
            const available = sample.availableMbps;
            this.audioReserve = sample.audioReserve ?? 0;
            const fresh = Number.isFinite(available) && available >= 0 ? available * 1_000_000 : null;
            this.estimates.push(fresh);
            if (this.estimates.length > 3) this.estimates.shift();
            const recent = this.estimates.filter(value => value !== null).sort((a, b) => a - b);
            const median = recent[Math.floor((recent.length - 1) / 2)];
            const videoRoom = estimate => estimate === undefined || estimate === null
                ? maximum : Math.max(floor, estimate * .88 - this.audioReserve);
            const networkBudget = Math.min(maximum, videoRoom(median));
            let target = current;
            const delayed = baseline !== null && rtt > baseline + 80;
            const losing = Number.isFinite(sample.remoteLoss) && sample.remoteLoss > 3;
            if (delayed || losing) {
                this.goodSince = null;
                if (now - this.lastCut >= 4000) {
                    const severe = rtt >= Math.max(350, baseline * 3);
                    target = Math.min(current, networkBudget, videoRoom(fresh), current * (severe ? .55 : .8));
                    this.lastCut = now;
                }
                this.reason = delayed ? 'delay' : 'loss';
            } else if (networkBudget < current * .9) {
                target = networkBudget;
                this.goodSince = null;
                this.lastCut = now;
                this.reason = 'bandwidth';
            } else {
                const healthy = baseline !== null && Number.isFinite(rtt) && rtt <= baseline + 30;
                if (!healthy) this.goodSince = null;
                else if (this.goodSince === null) this.goodSince = now;
                if (this.goodSince !== null && now - this.goodSince >= 8000 && now - this.lastIncrease >= 4000) {
                    // Leave a small probe margin when the current cap limits the estimate.
                    const probe = sample.sentVideoBps >= current * .8 ? Math.min(150_000, current * .15) : 0;
                    const step = current + Math.max(80_000, current * .35, Math.min(1_500_000, (networkBudget - current) * .3));
                    target = Math.min(maximum, Math.max(current, Math.min(networkBudget + probe, step)));
                    this.lastIncrease = now;
                    this.reason = target > current ? 'recovering' : 'stable';
                } else {
                    this.reason = 'stable';
                }
            }
            this.bps = Math.round(Math.max(floor, target));
            return this.bps;
        }
    }
    function counterDelta(value, previous) {
        return Number.isFinite(value) && Number.isFinite(previous) && value >= previous ? value - previous : null;
    }
    function intervalMs(value, previous, count) {
        const delta = counterDelta(value, previous);
        return delta !== null && count > 0 ? 1000 * delta / count : null;
    }
    const defaults = { width: 1920, height: 1080, fps: 60, bitrate: 12, mode: 'balanced', codec: 'auto', adaptive: true };
    const videoHint=mode=>mode==='detail'?'detail':'motion';
    const degradationFor=mode=>mode==='detail'?'maintain-resolution':mode==='motion'?'maintain-framerate':'balanced';
    function directIceServers(servers){return servers.flatMap(server=>{const urls=(Array.isArray(server.urls)?server.urls:[server.urls]).filter(url=>typeof url==='string'&&/^stuns?:/i.test(url));return urls.length?[{...server,urls}]:[];});}

    // These fmtp values advertise this endpoint's receiving preferences. Both
    // endpoints run this code, so each sender receives the matching preferences.
    function tuneSdp(sdp, quality = defaults) {
        let audioIndex = 0;
        return sdp.split(/(?=^m=)/m).map(section => {
            if (section.startsWith('m=video ')) {
                // Chromium otherwise ramps from a conferencing-sized starting
                // budget and can aggressively shrink a moving 1080p screen.
                // This is only a start estimate; congestion control remains on.
                const codecs = [...section.matchAll(/^a=rtpmap:(\d+) (?:VP8|VP9|H264|AV1)\/90000(?=\r?$)/gmi)];
                for (const codec of codecs) {
                    const pt = codec[1];
                    const re = new RegExp('^a=fmtp:' + pt + ' ([^\\r\\n]*)', 'm');
                    const current = section.match(re);
                    const entries = current ? current[1].split(';').map(s => s.trim()).filter(s => s && !s.startsWith('x-google-start-bitrate=')) : [];
                    entries.push('x-google-start-bitrate=' + Math.max(1, Math.round(Math.min(quality.adaptive ? 2500 : 12000, quality.bitrate * 1000))));
                    const line = 'a=fmtp:' + pt + ' ' + entries.join(';');
                    section = current ? section.replace(re, line) : section.replace(codec[0], codec[0] + '\r\n' + line);
                }
                return section;
            }
            if (!section.startsWith('m=audio ')) return section;
            const stereo = audioIndex++ === 1;
            const match = section.match(/^a=rtpmap:(\d+) opus\/48000\/2(?=\r?$)/mi);
            if (!match) return section;
            const pt = match[1];
            const params = new Map();
            const line = new RegExp('^a=fmtp:' + pt + ' ([^\\r\\n]*)', 'm');
            const existing = section.match(line);
            if (existing) for (const entry of existing[1].split(';')) {
                const [key, ...rest] = entry.trim().split('=');
                if (key) params.set(key, rest.join('='));
            }
            for (const [key, value] of Object.entries({
                stereo: stereo ? 1 : 0, 'sprop-stereo': stereo ? 1 : 0,
                maxaveragebitrate: stereo ? SOUND_BITRATE : VOICE_BITRATE,
                maxplaybackrate: 48000, useinbandfec: 1, usedtx: 0,
            })) params.set(key, String(value));
            const replacement = 'a=fmtp:' + pt + ' ' + [...params].map(([k, v]) => k + '=' + v).join(';');
            return existing ? section.replace(line, replacement) : section.replace(match[0], match[0] + '\r\n' + replacement);
        }).join('');
    }

    function displayConstraints(quality = defaults) {
        return {
            video: {
                width: { ideal: quality.width, max: quality.width },
                height: { ideal: quality.height, max: quality.height },
                frameRate: { ideal: quality.fps, max: quality.fps },
            },
            // Processing appropriate for speech damages music; apply it only to mic.
            audio: { channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true, suppressLocalAudioPlayback: false },
            systemAudio: 'include',
            selfBrowserSurface: 'exclude',
            surfaceSwitching: 'include',
            windowAudio: 'system',
        };
    }

    function codecOrder(codecs, preference) {
        if (preference === 'auto') return codecs;
        const mime = 'video/' + preference.toLowerCase();
        if (!codecs.some(c => c.mimeType.toLowerCase() === mime)) return codecs;
        return [...codecs.filter(c => c.mimeType.toLowerCase() === mime), ...codecs.filter(c => c.mimeType.toLowerCase() !== mime)];
    }

    class Conference extends EventTarget {
        constructor(options = {}) {
            super();
            this.socketFactory = options.socketFactory || window.io;
            this.quality = { ...defaults, ...options.quality };
            this.name = options.name || '同学';
            this.uuid = /^[0-9a-f-]{36}$/i.test(options.identity || '') ? options.identity : crypto.randomUUID();
            this.peers = new Map();
            this.tracks = { voice: null, sound: null, screen: null };
            this.streams = { voice: null, sound: null, screen: null };
            this.previous = new Map();
            this.socket = null;
            this.iceFallbackDelay=options.iceFallbackDelay??6000;
            this.iceTransportPolicy=options.iceTransportPolicy||'all';
        }
        emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
        log(message) { this.emit('status', { message }); }
        async join(room) {
            if (this.socket) throw new Error('已经在房间中，请先离开。');
            if (!/^[A-Za-z0-9_-]{3,100}$/.test(room)) throw new Error('房间号请用 3–100 位英文字母、数字、短横线。');
            this.room = room;
            const socket = this.socketFactory(SIGNAL, { transports: ['websocket'], timeout: 15000, reconnection: true, reconnectionDelayMax: 4000 });
            this.socket = socket;
            socket.on('connect', () => {
                this.emit('signal', { state: 'connected' });
                this.resetPeers();
                this.log('信令已连接，正在加入房间…');
                socket.emit('join', {
                    channel: room, channel_password: '', peer_uuid: this.uuid, peer_name: this.name,
                    peer_avatar: '', peer_info: { friends_client: '2.5.0' }, peer_video: false, peer_audio: true,
                    peer_video_status: false, peer_audio_status: !!this.tracks.voice?.enabled,
                    peer_screen_status: !!this.tracks.screen, peer_hand_status: false,
                    peer_rec_status: false, peer_privacy_status: false, userAgent: navigator.userAgent,
                });
            });
            socket.on('serverInfo', () => { this.log('已进入房间，等待同学加入'); this.emit('joined', { room }); });
            socket.on('addPeer', config => this.addPeer(config).catch(e => this.fail(e)));
            socket.on('removePeer', ({ peer_id }) => this.removePeer(peer_id));
            socket.on('sessionDescription', data => this.receiveDescription(data).catch(e => this.fail(e)));
            socket.on('iceCandidate', data => this.receiveIce(data).catch(e => this.fail(e)));
            socket.on('disconnect', () => {
                this.emit('signal', { state: 'disconnected' });
                this.log('信令暂时断开，正在重连；已有媒体连接保留');
            });
            socket.on('connect_error', error => {
                this.emit('signal', { state: 'error', error });
                this.log('无法连接公共信令，请检查网络；不会自动改动代理。');
            });
            for (const event of ['unauthorized', 'roomNotAllowed', 'roomIsLocked', 'roomIsJoinLocked', 'roomTimeLimitReached', 'kickOut']) {
                socket.on(event, () => {
                    const locked = event === 'roomIsLocked' || event === 'roomIsJoinLocked';
                    this.emit('join-failure', { reason: locked ? 'room-locked' : 'room-rejected',
                        message: locked ? '房间已锁定，请让房主解锁或换一个房间。' : '信令服务拒绝加入房间或房间已结束，请重新邀请。' });
                    this.leave();
                });
            }
            socket.on('lobby', () => this.emit('join-failure', { reason: 'lobby', message: '该房间开启了等候室，请换一个房间。' }));
        }
        fail(error) { console.error(error); this.emit('error', { message: error.message || String(error), error }); }
        async addPeer(config) {
            const id = config.peer_id;
            if (this.peers.has(id)) return;
            if(config.should_create_offer&&Object.keys(config.peers||{}).length>MAX_PARTICIPANTS){this.emit('warning',{message:'房间已满，最多 4 人（包含自己），请使用其他房间'});this.leave();return;}
            if (this.peers.size >= MAX_PARTICIPANTS-1) { this.log('房间已满，最多 4 人'); return; }
            const allIce=config.iceServers||[];
            const pc = new RTCPeerConnection({ iceServers: directIceServers(allIce), bundlePolicy: 'max-bundle',iceTransportPolicy:this.iceTransportPolicy });
            const p = {
                id, pc, name: config.peers?.[id]?.peer_name || '同学',
                polite: !config.should_create_offer, makingOffer: false, ignoreOffer: false,
                settingAnswer: false, ice: [], incoming: {}, tx: {}, queue: Promise.resolve(),allIce,wantsIceRestart:false,
                videoBudget: new VideoBudget(), recoveryAttempts: 0,
            };
            const identity = config.peers?.[id]?.peer_uuid;
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity || '')) p.identity = identity;
            this.peers.set(id, p);
            for(const other of this.peers.values())if(other!==p)this.applySenderQuality(other).catch(error=>this.fail(error));
            this.emit('peer', { id, name: p.name });
            pc.onicecandidate = event => {
                if (event.candidate) this.socket?.emit('relayICE', { peer_id: id, ice_candidate: event.candidate.toJSON() });
            };
            pc.ontrack = event => {
                const kind = KINDS.find(key => p.tx[key] === event.transceiver) || KINDS[Number(event.transceiver.mid)];
                if (!kind) return;
                const stream = new MediaStream([event.track]);
                p.incoming[kind] = stream;
                this.emit('track', { id, name: p.name, kind, stream, track: event.track });
            };
            pc.onconnectionstatechange = () => {
                this.emit('connection', { id, state: pc.connectionState });
                if (pc.connectionState === 'connected') {
                    clearTimeout(p.fallbackTimer);
                    clearTimeout(p.recoveryTimer);
                    p.recoveryTimer = null;
                    p.recoveryAttempts = 0;
                    p.wantsIceRestart = false;
                    this.log('已连接同学');
                } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                    this.scheduleRecovery(p, pc.connectionState === 'failed' ? 0 : 4000);
                }
            };
            pc.ondatachannel = event => this.attachData(p, event.channel);
            if (config.should_create_offer) this.attachData(p, pc.createDataChannel('friends-chat'));
            p.fallbackTimer=setTimeout(()=>this.enableRelayFallback(p).catch(error=>this.fail(error)),this.iceFallbackDelay);
            // Fixed slots avoid screen restarts causing a second copy of mic audio,
            // screen/camera sender-index confusion, and simultaneous renegotiation.
            if (config.should_create_offer) {
                for (const kind of KINDS) {
                    const track = this.tracks[kind];
                    p.tx[kind] = pc.addTransceiver(track || (kind === 'screen' ? 'video' : 'audio'), {
                        direction: 'sendrecv', streams: track ? [this.streams[kind]] : [],
                    });
                }
                this.setCodecs(p);
                await this.negotiate(p);
            }
        }
        setCodecs(p) {
            const caps = RTCRtpReceiver.getCapabilities?.('video');
            if (caps && p.tx.screen?.setCodecPreferences) {
                // H.264 is commonly hardware-accelerated on Windows; retain all
                // other codecs and RTX as fallbacks when it is unavailable.
                const preference = this.quality.codec === 'auto' ? 'H264' : this.quality.codec;
                p.tx.screen.setCodecPreferences(codecOrder(caps.codecs, preference));
            }
        }
        async enableRelayFallback(p){
            if(!this.peers.has(p.id)||p.pc.connectionState==='closed'||['connected','completed'].includes(p.pc.iceConnectionState))return;
            p.pc.setConfiguration({...p.pc.getConfiguration(),iceServers:p.allIce});
            if(!p.polite){p.wantsIceRestart=true;await this.restartForRelay(p);}
        }
        async restartForRelay(p){
            if(!p.wantsIceRestart||p.makingOffer||p.pc.signalingState!=='stable'||!this.socket?.connected)return;
            p.wantsIceRestart=false;p.pc.restartIce();await this.negotiate(p);
        }
        scheduleRecovery(p, delay) {
            if (this.peers.get(p.id) !== p) return;
            if (p.polite) {
                p.pc.setConfiguration({ ...p.pc.getConfiguration(), iceServers: p.allIce });
                return;
            }
            if (p.recoveryTimer || p.recoveryAttempts >= 4) return;
            p.recoveryTimer = setTimeout(() => {
                p.recoveryTimer = null;
                this.recoverPeer(p).catch(error => this.fail(error));
            }, delay);
        }
        async recoverPeer(p) {
            if (this.peers.get(p.id) !== p || !['disconnected', 'failed', 'connecting'].includes(p.pc.connectionState)) return;
            if (p.polite || p.recoveryAttempts >= 4) return;
            if (!this.socket?.connected || p.pc.signalingState !== 'stable' || p.makingOffer) {
                this.scheduleRecovery(p, 2000);
                return;
            }
            p.recoveryAttempts++;
            p.pc.setConfiguration({ ...p.pc.getConfiguration(), iceServers: p.allIce });
            p.wantsIceRestart = true;
            this.emit('connection', { id: p.id, state: 'recovering' });
            this.log('连接中断，正在自动恢复（' + p.recoveryAttempts + '/4）');
            try {
                await this.restartForRelay(p);
            } finally {
                if (p.pc.connectionState !== 'connected') this.scheduleRecovery(p, Math.min(20000, 4000 * p.recoveryAttempts));
            }
        }
        encodingQuality(p) {
            const quality = peerVideoBudget(this.quality, this.peers.size);
            const maximum = quality.bitrate * 1_000_000;
            const bitrate = p.videoBudget.ceiling(maximum, this.quality.adaptive);
            return { ...quality, ...videoProfile(quality, bitrate, this.tracks.screen?.getSettings()), bitrate: bitrate / 1_000_000 };
        }
        async adaptVideo(stats) {
            const screen = this.tracks.screen;
            if (!this.quality.adaptive || !screen) return;
            for (const sample of stats) {
                const p = this.peers.get(sample.id);
                if (this.tracks.screen !== screen) break;
                if (!p || p.pc.connectionState !== 'connected' || !sample.protocol) continue;
                const sent = sample.media.filter(m => m.direction === 'send');
                const outgoing = sent.find(m => m.kind === 'screen');
                if (!outgoing) continue;
                const maximum = peerVideoBudget(this.quality, this.peers.size).bitrate * 1_000_000;
                const soundRate = sent.find(m => m.kind === 'sound')?.bitrate ?? SOUND_BITRATE;
                const audioReserve = (this.tracks.voice?.enabled ? VOICE_BITRATE : 0)
                    + (this.tracks.sound?.enabled ? Math.min(SOUND_BITRATE, Math.max(128_000, soundRate * 1.15)) : 0);
                const remoteLoss = Math.max(0, ...sent.map(m => m.remoteLossFresh ? m.remoteLoss : 0));
                p.videoBudget.update({ ...sample, remoteLoss, audioReserve, sentVideoBps: outgoing.bitrate }, maximum);
                await this.applySenderQuality(p, 'screen');
                const profile = this.encodingQuality(p);
                sample.videoCeilingMbps = profile.bitrate;
                sample.videoBudgetReason = p.videoBudget.reason;
                sample.videoTargetFps = profile.fps;
                sample.videoTargetWidth = profile.width;
                sample.videoTargetHeight = profile.height;
                sample.audioReserveKbps = p.videoBudget.audioReserve / 1000;
            }
        }
        attachData(p, channel) {
            if(/^friends-file-v1:[a-f0-9-]{36}$/.test(channel.label)){this.emit('filechannel',{id:p.id,name:p.name,channel});return;}
            if(channel.label!=='friends-chat')return;
            p.channel=channel;
            channel.onopen=()=>{channel.send(JSON.stringify({type:'hello',version:'2.5.0',identity:this.uuid,participants:MAX_PARTICIPANTS,control:2}));this.emit('dataready',{id:p.id});};
            channel.onmessage=event=>{
                if(typeof event.data!=='string'||event.data.length>10000)return;
                try{const data=JSON.parse(event.data);if(data.type==='hello'&&typeof data.version==='string'&&data.version.length<32){p.clientVersion=data.version;p.controlProtocol=data.control;if(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.identity||''))p.identity=data.identity;this.emit('compatibility',{id:p.id,version:data.version,control:data.control});}else if(['chat','state','control'].includes(data.type))this.emit('data',{id:p.id,name:p.name,data});}catch{}
            };
        }
        sendData(data) {
            const value=JSON.stringify(data);if(value.length>10000)throw new Error('消息过长');
            let sent=false;for(const p of this.peers.values())if(p.channel?.readyState==='open'){p.channel.send(value);sent=true;}return sent;
        }
        sendControl(peer,payload){const c=this.peers.get(peer)?.channel;if(c?.readyState!=='open'||c.bufferedAmount>16384)return false;const value=JSON.stringify({type:'control',payload});if(value.length>2000)return false;c.send(value);return true;}
        openFileChannel(peer,id){
            const p=this.peers.get(peer);if(!p||p.pc.connectionState!=='connected')throw new Error('请等朋友连接成功后再发送文件');
            if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('无效的文件编号');
            return p.pc.createDataChannel('friends-file-v1:'+id,{ordered:true});
        }
        async negotiate(p) {
            try {
                p.makingOffer = true;
                const offer = await p.pc.createOffer();
                await p.pc.setLocalDescription({ type: offer.type, sdp: tuneSdp(offer.sdp, this.encodingQuality(p)) });
                this.socket?.emit('relaySDP', { peer_id: p.id, session_description: p.pc.localDescription.toJSON() });
            } finally { p.makingOffer = false; }
        }
        receiveDescription({ peer_id, session_description }) {
            const p = this.peers.get(peer_id);
            if (!p) return Promise.resolve();
            p.queue = p.queue.catch(() => {}).then(async () => {
                const pc = p.pc, d = session_description;
                if (!d || !['offer', 'answer'].includes(d.type)) return;
                const ready = !p.makingOffer && (pc.signalingState === 'stable' || p.settingAnswer);
                const collision = d.type === 'offer' && !ready;
                p.ignoreOffer = !p.polite && collision;
                if (p.ignoreOffer) return;
                p.settingAnswer = d.type === 'answer';
                await pc.setRemoteDescription(d);
                p.settingAnswer = false;
                for (const candidate of p.ice.splice(0)) await pc.addIceCandidate(candidate);
                if (d.type === 'offer') {
                    // Reuse the offer's transceivers on the answerer. Preallocating
                    // addTransceiver() slots here would produce extra m-lines.
                    const slots = pc.getTransceivers();
                    for (let i = 0; i < KINDS.length; i++) {
                        const kind = KINDS[i];
                        p.tx[kind] = slots.find(t => t.mid === String(i));
                        if (!p.tx[kind]) throw new Error('音轨布局不兼容，请双方都使用增强版。');
                        p.tx[kind].direction = 'sendrecv';
                        await p.tx[kind].sender.replaceTrack(this.tracks[kind]);
                        if (this.streams[kind]) p.tx[kind].sender.setStreams(this.streams[kind]);
                    }
                    this.setCodecs(p);
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription({ type: answer.type, sdp: tuneSdp(answer.sdp, this.encodingQuality(p)) });
                    this.socket?.emit('relaySDP', { peer_id: p.id, session_description: pc.localDescription.toJSON() });
                }
                await this.applySenderQuality(p);
                await this.restartForRelay(p);
            });
            return p.queue;
        }
        async receiveIce({ peer_id, ice_candidate }) {
            const p = this.peers.get(peer_id);
            if (!p || p.ignoreOffer) return;
            if (!p.pc.remoteDescription) { p.ice.push(ice_candidate); return; }
            await p.pc.addIceCandidate(ice_candidate);
        }
        async setTrack(kind, track, stream = null) {
            if (!KINDS.includes(kind)) throw new Error('Unknown media kind');
            this.tracks[kind] = track || null;
            this.streams[kind] = track ? (stream || new MediaStream([track])) : null;
            if (track && 'contentHint' in track) track.contentHint = kind === 'screen' ? videoHint(this.quality.mode) : kind === 'sound' ? 'music' : 'speech';
            await Promise.all([...this.peers.values()].map(async p => {
                if (!p.tx[kind]) return;
                await p.tx[kind].sender.replaceTrack(track || null);
                if (track) await this.applySenderQuality(p);
            }));
        }
        applySenderQuality(p, onlyKind) {
            p.qualityQueue = (p.qualityQueue || Promise.resolve()).catch(() => {}).then(() => this.setSenderQuality(p, onlyKind));
            return p.qualityQueue;
        }
        async setSenderQuality(p, onlyKind) {
            if (this.peers.get(p.id) !== p || p.pc.connectionState === 'closed') return;
            for (const kind of onlyKind ? [onlyKind] : KINDS) {
                const sender = p.tx[kind]?.sender;
                if (!sender) continue;
                if (!sender.track || p.pc.signalingState !== 'stable') continue;
                const params = sender.getParameters();
                if (!params.encodings?.length) continue;
                const profile = kind === 'screen' ? this.encodingQuality(p) : null;
                const bitrate = profile ? Math.round(profile.bitrate * 1_000_000) : kind === 'sound' ? SOUND_BITRATE : VOICE_BITRATE;
                const sameEncodings = params.encodings.every(enc => enc.maxBitrate === bitrate
                    && (!profile || (enc.maxFramerate === profile.fps && enc.scaleResolutionDownBy === profile.scale)));
                if (sameEncodings && (!profile || params.degradationPreference === profile.degradation)) continue;
                for (const enc of params.encodings) {
                    enc.maxBitrate = bitrate;
                    if (profile) { enc.maxFramerate = profile.fps; enc.scaleResolutionDownBy = profile.scale; }
                }
                if (profile) params.degradationPreference = profile.degradation;
                try { await sender.setParameters(params); }
                catch (error) { this.emit('warning', { message: '浏览器未接受部分编码参数：' + error.message }); }
            }
        }
        async updateQuality(quality) {
            const codecChanged = quality.codec && quality.codec !== this.quality.codec;
            this.quality = { ...this.quality, ...quality };
            const screen = this.tracks.screen;
            if (screen) {
                screen.contentHint = videoHint(this.quality.mode);
                await screen.applyConstraints(displayConstraints(this.quality).video);
            }
            for (const p of this.peers.values()) {
                await this.applySenderQuality(p);
                // Only renegotiate when changing codec, not on every bitrate change.
                if (codecChanged) { this.setCodecs(p); if (p.pc.signalingState === 'stable') await this.negotiate(p); }
            }
        }
        removePeer(id) {
            const p = this.peers.get(id); if (!p) return;
            clearTimeout(p.fallbackTimer);
            clearTimeout(p.recoveryTimer);
            p.pc.onconnectionstatechange = null;
            p.pc.close(); this.peers.delete(id); this.previous.delete(id);
            for(const other of this.peers.values())this.applySenderQuality(other).catch(error=>this.fail(error));
            this.emit('peerleft', { id });
        }
        resetPeers() { for (const id of [...this.peers.keys()]) this.removePeer(id); }
        leave() {
            const socket = this.socket; this.socket = null;
            socket?.removeAllListeners(); socket?.disconnect();
            this.resetPeers(); this.emit('left', {});
        }
        async stats() {
            const output = [];
            for (const p of this.peers.values()) {
                let reports;
                try { reports = await p.pc.getStats(); }
                catch (error) { if (this.peers.get(p.id) !== p) continue; throw error; }
                if (this.peers.get(p.id) !== p) continue;
                const now = new Map();
                const prev = this.previous.get(p.id) || new Map();
                const media = [];
                let pair = null;
                for (const r of reports.values()) {
                    if (r.type === 'transport' && r.selectedCandidatePairId) pair = reports.get(r.selectedCandidatePairId);
                }
                if (!pair) pair = [...reports.values()].find(r => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
                for (const r of reports.values()) {
                    if (!['inbound-rtp', 'outbound-rtp'].includes(r.type) || r.isRemote) continue;
                    const old = prev.get(r.id), outgoing = r.type === 'outbound-rtp';
                    const bytes = outgoing ? r.bytesSent : r.bytesReceived;
                    const elapsed = old ? (r.timestamp - old.timestamp) / 1000 : 0;
                    const bitrate = old && elapsed > 0 ? Math.max(0, (bytes - old.bytes) * 8 / elapsed) : null;
                    const codec = reports.get(r.codecId);
                    const source=reports.get(r.mediaSourceId);
                    let kind = KINDS.find(k => p.tx[k]?.mid === r.mid);
                    if (!kind && r.kind === 'video') kind = 'screen';
                    const frames = outgoing ? (r.framesSent ?? r.framesEncoded) : r.framesDecoded;
                    const frameDelta = counterDelta(frames, old?.frames);
                    const fps = frameDelta !== null && elapsed > 0 ? frameDelta / elapsed : r.framesPerSecond ?? null;
                    const packets = r.packetsReceived || 0, lost = Math.max(0, r.packetsLost || 0);
                    const intervalPackets = old ? Math.max(0, packets - old.packets) : packets;
                    const intervalLost = old ? Math.max(0, lost - old.lost) : lost;
                    const total = intervalPackets + intervalLost;
                    const emitted = counterDelta(r.jitterBufferEmittedCount, old?.jitterBufferEmittedCount);
                    const freezeSeconds = counterDelta(r.totalFreezesDuration, old?.totalFreezesDuration);
                    const feedback = outgoing && r.remoteId ? reports.get(r.remoteId) : null;
                    media.push({ kind, direction: outgoing ? 'send' : 'receive', width: r.frameWidth, height: r.frameHeight,
                        fps, bitrate, codec: codec?.mimeType, fmtp: codec?.sdpFmtpLine,
                        limitation: r.qualityLimitationReason || '', loss: !outgoing && total ? intervalLost / total * 100 : 0,
                        jitterMs: r.jitter === undefined ? null : r.jitter * 1000,
                        remoteLoss: Number.isFinite(feedback?.fractionLost) ? Math.max(0, feedback.fractionLost * 100) : undefined,
                        remoteLossFresh: Number.isFinite(feedback?.fractionLost) && feedback.timestamp !== old?.feedbackTimestamp,
                        encoderTargetBps: r.targetBitrate,
                        captureFps:source?.framesPerSecond,captureWidth:source?.width,captureHeight:source?.height,
                        encoder:r.encoderImplementation,decoder:r.decoderImplementation,powerEfficient:r.powerEfficientEncoder,
                        encodeMs: outgoing ? intervalMs(r.totalEncodeTime, old?.totalEncodeTime, counterDelta(r.framesEncoded, old?.framesEncoded)) : null,
                        decodeMs: outgoing ? null : intervalMs(r.totalDecodeTime, old?.totalDecodeTime, frameDelta),
                        jitterBufferMs: intervalMs(r.jitterBufferDelay, old?.jitterBufferDelay, emitted),
                        freezeCount: counterDelta(r.freezeCount, old?.freezeCount),
                        freezeMs: freezeSeconds === null ? null : freezeSeconds * 1000,
                        droppedFrames: counterDelta(r.framesDropped, old?.framesDropped),
                        concealedSamples: counterDelta(r.concealedSamples, old?.concealedSamples),
                    });
                    now.set(r.id, { ...r, bytes, frames, lost, packets, feedbackTimestamp: feedback?.timestamp });
                }
                this.previous.set(p.id, now);
                const local = pair && reports.get(pair.localCandidateId), remote = pair && reports.get(pair.remoteCandidateId);
                if (p.selectedPair && pair?.id && p.selectedPair !== pair.id) p.videoBudget = new VideoBudget();
                p.selectedPair = pair?.id;
                output.push({ id: p.id, name: p.name, state: p.pc.connectionState,
                    iceState: p.pc.iceConnectionState, relayProtocol: local?.relayProtocol || remote?.relayProtocol,
                    path: !pair ? '等待连接' : local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN 中继' : 'P2P 直连',
                    protocol: local?.protocol || '', rttMs: pair?.currentRoundTripTime === undefined ? null : pair.currentRoundTripTime * 1000,
                    availableMbps: pair?.availableOutgoingBitrate === undefined ? null : pair.availableOutgoingBitrate / 1000000,
                    videoCeilingMbps: p.videoBudget?.bps / 1_000_000,
                    videoBudgetReason: p.videoBudget?.reason,
                    media });
            }
            return output;
        }
    }
    return { Conference, tuneSdp, displayConstraints, codecOrder, defaults, KINDS,videoHint,degradationFor,directIceServers,MAX_PARTICIPANTS,peerVideoBudget,VideoBudget,videoFrameTarget,videoProfile };
});
