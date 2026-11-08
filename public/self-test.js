'use strict';
const results = document.getElementById('results');
const progress = text => { document.getElementById('progress').textContent = text; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { started: new Date().toISOString(), checks: [], errors: [] };
function check(name, pass, detail = {}) { report.checks.push({ name, pass: !!pass, ...detail }); results.textContent = JSON.stringify(report, null, 2); if (!pass) throw new Error(name); }
async function until(test, message, timeout = 30000) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) { if (await test()) return; await wait(250); }
    throw new Error(message);
}
function tone(ctx, frequency, stereo = false) {
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = stereo ? 2 : 1;
    destination.channelCountMode = 'explicit';
    const oscillators = [];
    const merger = stereo ? ctx.createChannelMerger(2) : null;
    for (let channel = 0; channel < (stereo ? 2 : 1); channel++) {
        const oscillator = ctx.createOscillator(), gain = ctx.createGain();
        oscillator.frequency.value = frequency[channel] || frequency;
        gain.gain.value = 0.1;
        oscillator.connect(gain);
        if (merger) gain.connect(merger, 0, channel); else gain.connect(destination);
        oscillator.start(); oscillators.push(oscillator);
    }
    merger?.connect(destination);
    return { stream: destination.stream, stop: () => { oscillators.forEach(o => o.stop()); destination.stream.getTracks().forEach(t => t.stop()); } };
}
function movingCanvas(container, label) {
    const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
    container.append(canvas); const ctx = canvas.getContext('2d', { alpha: false });
    const draw = () => {
        const t = performance.now();
        ctx.fillStyle = '#123c46'; ctx.fillRect(0, 0, 1920, 1080);
        for (let i = 0; i < 30; i++) { ctx.fillStyle = `hsl(${(i * 19 + t / 40) % 360} 70% 50%)`; ctx.fillRect((t * .22 + i * 131) % 1920, i * 39, 340, 24); }
        ctx.fillStyle = '#fff'; ctx.font = '64px sans-serif'; ctx.fillText(label + '  ' + (t / 1000).toFixed(2), 80, 500);
    };
    draw(); const timer = setInterval(draw, 1000 / 60);
    return { stream: canvas.captureStream(60), stop: () => { clearInterval(timer); canvas.remove(); } };
}
function listenSpectrum(ctx, stream) {
    const source = ctx.createMediaStreamSource(stream), splitter = ctx.createChannelSplitter(2);
    source.connect(splitter); const analysers = [];
    const silent = ctx.createGain(); silent.gain.value = 0; silent.connect(ctx.destination);
    for (let i = 0; i < 2; i++) { const analyser = ctx.createAnalyser(); analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0; splitter.connect(analyser, i); analyser.connect(silent); analysers.push(analyser); }
    return { energy(channel, hz) {
        const analyser = analysers[channel], data = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(data);
        const bin = Math.round(hz / ctx.sampleRate * analyser.fftSize);
        return Math.max(...data.slice(Math.max(0, bin - 2), bin + 3));
    }, stop() { source.disconnect(); splitter.disconnect(); silent.disconnect(); } };
}
document.getElementById('run').onclick = async () => {
    document.getElementById('run').disabled = true;
    const resources = [], clients = [], contexts = [], pending = [], received = [new Map(), new Map()];
    const room = 'friends-check-' + crypto.randomUUID().replaceAll('-', '');
    try {
        progress('准备合成双路声音和 1080p 60 帧画面…');
        const ctx = new AudioContext({ sampleRate: 48000 }); contexts.push(ctx); await ctx.resume();
        for (let i = 0; i < 2; i++) {
            const call = new FriendsMedia.Conference({ name: 'Media-check-' + (i + 1) }); clients.push(call);
            call.addEventListener('track', event => received[i].set(event.detail.kind, event.detail.stream));
            call.addEventListener('error', event => report.errors.push(event.detail.message));
            call.addEventListener('warning', event => report.errors.push(event.detail.message));
            const voice = tone(ctx, 330), sound = tone(ctx, [660, 990], true), video = movingCanvas(document.getElementById('canvas' + (i === 0 ? 'A' : 'B')), i === 0 ? 'A → B' : 'B → A');
            resources.push(voice, sound, video);
            pending.push({ voice, sound, video });
            await call.join(room);
            await until(() => !!call.socket?.connected, '公共信令连接失败');
            // The room join is asynchronous and both clients must see serverInfo.
            await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('公共房间加入超时')), 18000); call.addEventListener('joined', () => { clearTimeout(timer); resolve(); }, { once: true }); });
        }
        check('Both clients joined public signaling from localhost', clients.every(c => c.socket.connected));
        progress('公共信令已加入，建立双向 WebRTC 连接…');
        await until(() => clients.every(c => [...c.peers.values()].some(p => p.pc.connectionState === 'connected')), 'WebRTC 连接超时', 40000);
        check('Both clients connect before mic or screen is enabled', clients.every(c => FriendsMedia.KINDS.every(k => c.tracks[k] === null)));
        for (let i = 0; i < 2; i++) {
            await clients[i].setTrack('voice', pending[i].voice.stream.getAudioTracks()[0], pending[i].voice.stream);
            await clients[i].setTrack('sound', pending[i].sound.stream.getAudioTracks()[0], pending[i].sound.stream);
            await clients[i].setTrack('screen', pending[i].video.stream.getVideoTracks()[0], pending[i].video.stream);
        }
        await until(() => received.every(r => FriendsMedia.KINDS.every(k => r.has(k))), '没有收到全部独立音轨／视频轨');
        check('Two independent audio tracks plus video in each direction', received.every(r => r.size === 3));
        await until(()=>clients.every(c=>[...c.peers.values()].every(p=>p.channel?.readyState==='open')),'文字聊天通道未连接');
        let chat=null;clients[1].addEventListener('data',event=>{if(event.detail.data.type==='chat')chat=event.detail.data.text;});
        clients[0].sendData({type:'chat',text:'Synthetic chat verification'});
        await until(()=>chat==='Synthetic chat verification','文字消息未到达');
        check('Text chat is delivered through the peer data channel',chat==='Synthetic chat verification');
        // Prime Chromium's remote audio renderer exactly as the real UI does.
        for (const streams of received) for (const kind of ['voice', 'sound']) {
            const audio = document.createElement('audio'); audio.autoplay = true; audio.volume = 0; audio.srcObject = streams.get(kind); document.body.append(audio);
            await audio.play(); resources.push({ stop() { audio.pause(); audio.srcObject = null; audio.remove(); } });
        }
        const localProbe = listenSpectrum(ctx, resources[1].stream); resources.push(localProbe);
        const spectra = received.map(r => ({ sound: listenSpectrum(ctx, r.get('sound')), voice: listenSpectrum(ctx, r.get('voice')) }));
        resources.push(...spectra.flatMap(s => [s.sound, s.voice]));
        await wait(10000);
        report.localProbe = { left: localProbe.energy(0, 660), right: localProbe.energy(1, 990) };
        const levels = spectra.map(s => ({ left660: s.sound.energy(0, 660), left990: s.sound.energy(0, 990), right660: s.sound.energy(1, 660), right990: s.sound.energy(1, 990), screenVoiceLeak: s.sound.energy(0, 330), voice330: s.voice.energy(0, 330), voiceMusicLeak: s.voice.energy(0, 660) }));
        check('Screen audio preserves distinct left and right channels', levels.every(l => l.left660 > l.left990 + 12 && l.right990 > l.right660 + 12), { levels });
        check('Voice and screen audio are not mixed', levels.every(l => l.left660 > l.screenVoiceLeak + 18 && l.voice330 > l.voiceMusicLeak + 18));
        for (const call of clients) await call.stats();
        await wait(3000);
        const stats = await Promise.all(clients.map(c => c.stats()));
        check('Bidirectional video and both audio streams carry real RTP', stats.every(list => list[0]?.media.filter(m => m.direction === 'receive' && m.bitrate > 0).length >= 3));
        check('Stereo 256 kbps is negotiated separately from voice', clients.every(c => [...c.peers.values()].every(p => /stereo=1/.test(p.pc.localDescription.sdp) && /maxaveragebitrate=256000/.test(p.pc.localDescription.sdp))));
        report.initialStats = stats;
        const p = [...clients[0].peers.values()][0];
        const params = p.tx.screen.sender.getParameters();
        check('Video sender accepts 60 fps and 12 Mbps ceiling', params.encodings[0].maxFramerate === 60 && params.encodings[0].maxBitrate === 12000000, { parameters: params.encodings });
        const before = clients[0].tracks.voice;
        await clients[0].setTrack('sound', null); await clients[0].setTrack('screen', null);
        check('Stopping screen share leaves microphone intact', p.tx.voice.sender.track === before && before.readyState === 'live' && !p.tx.sound.sender.track && !p.tx.screen.sender.track);
        await clients[0].setTrack('screen', resources[2].stream.getVideoTracks()[0], resources[2].stream);
        await clients[0].setTrack('sound', resources[1].stream.getAudioTracks()[0], resources[1].stream);
        await wait(2000);
        const restarted = await clients[1].stats();
        check('Restarting share reuses three slots without duplicate audio', p.pc.getTransceivers().length === 3 && restarted[0].media.some(m => m.direction === 'receive' && m.kind === 'sound' && m.bitrate > 0));
        await clients[0].updateQuality({ width: 1280, height: 720, fps: 30, bitrate: 6 });
        check('Quality change updates the existing sender', p.tx.screen.sender.getParameters().encodings[0].maxBitrate === 6000000 && p.tx.screen.sender.getParameters().encodings[0].maxFramerate === 30);
        check('No media or negotiation errors', report.errors.length === 0, { errors: report.errors });
        report.passed = true;
        progress('全部通过。真实异地网速和游戏负载仍需双方实测。');
    } catch (error) {
        report.passed = false; report.failure = error.message;
        report.audioContextStates = contexts.map(c => ({ state: c.state, time: c.currentTime }));
        report.statsAtFailure = await Promise.all(clients.map(c => c.stats()));
        report.connectionStates = clients.map(c => [...c.peers.values()].map(p => ({ connection: p.pc.connectionState, ice: p.pc.iceConnectionState, signaling: p.pc.signalingState, gathering: p.pc.iceGatheringState, local: p.pc.localDescription?.type, remote: p.pc.remoteDescription?.type })));
        progress('验证未通过：' + error.message);
    }
    finally {
        report.finished = new Date().toISOString();
        clients.forEach(c => c.leave()); resources.forEach(r => r.stop?.()); await Promise.all(contexts.map(c => c.close()));
        results.textContent = JSON.stringify(report, null, 2);
        document.getElementById('run').disabled = false;
    }
};
