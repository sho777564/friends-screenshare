'use strict';
async function runUISmoke() {
    const report = { scope: 'Production UI with generated media, isolated test profile and native window API.', checks: [] };
    const check = (name, ok) => { report.checks.push({ name, pass: !!ok }); if (!ok) throw new Error(name); };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function until(test, timeout=10000) {
        const deadline=performance.now()+timeout;
        while(performance.now()<deadline){if(test())return;await wait(25);}
        throw new Error('UI state timeout');
    }
    const query = new URLSearchParams(location.search);
    const second = query.get('phase') === '2';
    const identities = ['7f1f1d9a-37d7-4cbb-9e21-ea6b7011df00', 'bb5f5c0d-7f35-45a0-8eb7-588caaef19c9'];
    const tracks = [];
    let context;
    try {
        await roomBoot;
        call.stats = async () => [];
        if (!second) {
            const originalInput=navigator.mediaDevices.getUserMedia;
            const previousOutput=settings.output;
            const previousSink=mixer.sink.bind(mixer);
            const outputAttempts=[];
            mixer.sink=async id=>{
                outputAttempts.push(id);
                if(id==='missing-audio-device')throw new DOMException('The device is not found','NotFoundError');
                return previousSink(id);
            };
            try {
                settings.output='missing-audio-device';
                $('room').value='friends-output-test-'+crypto.randomUUID();
                $('pinRoom').checked=false;
                await joinRoom();
                await until(()=>joined&&outputAttempts.includes(''));
                check('An unavailable saved output falls back to default and a manual join still succeeds',
                    outputAttempts[0]==='missing-audio-device'&&settings.output===''&&JSON.parse(localStorage.getItem('friendsV2Settings')).output==='');
                await leaveRoom();

                const controller=new AbortController();
                const room='friends-mic-test-'+crypto.randomUUID();
                let micAttempts=0;
                navigator.mediaDevices.getUserMedia=async()=>{
                    micAttempts++;
                    throw new DOMException('Microphone permission denied','NotAllowedError');
                };
                await joinPhoneRoom(room,controller.signal);
                check('The phone room can finish joining before any microphone request',joined&&call.room===room&&micAttempts===0);
                phoneConnected();
                await until(()=>$('toast').textContent.includes('麦克风权限未开启'));
                check('Microphone denial after a call leaves the joined room open and the microphone off',joined&&!!call.socket&&!rawMic&&micMuted&&micAttempts===1);
                check('A diagnostic export is offered directly on the error message',!$('toastExportDiagnostic').hidden);
                $('toastExportDiagnostic').click();
                await until(()=>$('toastMessage').textContent.includes('诊断日志已导出'));
                await leaveRoom();

                const lateController=new AbortController();
                let resolveMic;
                navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{resolveMic=resolve;});
                await joinPhoneRoom('friends-late-mic-test-'+crypto.randomUUID(),lateController.signal);
                phoneConnected();
                await until(()=>!!resolveMic);
                await leaveRoom();
                const lateContext=new AudioContext();
                try {
                    const lateStream=lateContext.createMediaStreamDestination().stream;
                    const lateTrack=lateStream.getAudioTracks()[0];
                    resolveMic(lateStream);
                    await until(()=>lateTrack.readyState==='ended');
                    check('A microphone request resolved after leaving is stopped and never published',!call.socket&&!call.tracks.voice&&!rawMic);
                } finally { await lateContext.close(); }
            } finally {
                navigator.mediaDevices.getUserMedia=originalInput;
                mixer.sink=previousSink;
                settings.output=previousOutput;
                save();
                if(call.socket)await leaveRoom();
            }
        }
        if(query.has('roomDiagnostics')){report.passed=true;return;}
        context = new AudioContext();
        for (let i = 0; i < 2; i++) {
            const id = (second ? 'restart-' : 'first-') + i;
            const name = ['小林', '阿青'][i];
            call.peers.set(id, { id, name, identity: identities[i], controlProtocol: 2 });
            call.emit('peer', { id, name });
            const canvas = document.createElement('canvas');
            canvas.width = 640; canvas.height = 360;
            const paint = canvas.getContext('2d');paint.fillStyle = i ? '#25483c' : '#24384c';paint.fillRect(0,0,640,360);paint.fillStyle='#eef';paint.font='30px Segoe UI';paint.fillText(name+' 的测试画面',40,80);
            const stream = canvas.captureStream(1);tracks.push(...stream.getTracks());
            call.emit('track', { id, name, kind: 'screen', stream });
            for (const kind of ['voice', 'sound']) {
                const source = context.createOscillator();const silence = context.createGain();silence.gain.value=0;
                const destination=context.createMediaStreamDestination();source.connect(silence).connect(destination);source.start();tracks.push(...destination.stream.getTracks());
                call.emit('track', { id, name, kind, stream: destination.stream });
            }
            call.emit('data', { id, name, data: { type: 'state', screen: true, sound: true, mic: true } });
        }
        await until(() => mixer.entries.size === 4);
        const peer = (second ? 'restart-' : 'first-') + '0';
        const other = (second ? 'restart-' : 'first-') + '1';
        const controls = cards.get(peer).card.querySelectorAll('.volume-control');
        if (!second) {
            for (const [i, volume] of [[0, 205], [1, 35]]) {
                const range=controls[i].querySelector('input');range.value=volume;range.dispatchEvent(new Event('input'));
            }
            if(controls[0].querySelector('button').getAttribute('aria-pressed')!=='true')controls[0].querySelector('button').click();
            const sound = cards.get(other).card.querySelectorAll('.volume-control')[1];
            if(sound.querySelector('button').getAttribute('aria-pressed')!=='true')sound.querySelector('button').click();
        }
        check('Voice gain, sound gain and both mute states survive a changed connection ID',
            controls[0].querySelector('input').value==='205' && controls[1].querySelector('input').value==='35' &&
            controls[0].querySelector('button').getAttribute('aria-pressed')==='true' &&
            cards.get(other).card.querySelectorAll('.volume-control')[1].querySelector('button').getAttribute('aria-pressed')==='true');
        check('Mute is applied to the real output mixer independently for each member and track',
            mixer.entries.get(peer+':voice').volume===0 && mixer.entries.get(peer+':sound').volume===.35 &&
            mixer.entries.get(other+':voice').volume===1 && mixer.entries.get(other+':sound').volume===0);
        check('Shared media volume is limited to 100 while voice keeps its gain control',controls[1].querySelector('input').max==='100'&&controls[0].querySelector('input').max==='300');
        renderUpdate({state:'available',version:'9.0.0',notes:'Test release'});
        check('Update notice provides the download-and-restart action without installing automatically',!$('updateBanner').hidden&&!$('updateDownload').hidden&&$('updateInstall').hidden&&$('updateBannerAction').textContent==='更新并重启');
        renderUpdate({state:'unconfigured'});
        const original = cards.get(peer).video.srcObject;
        cards.get(peer).card.querySelector('.tile-mini').click();
        await until(() => document.body.classList.contains('mini-mode'));
        const mini = await native.testMini();
        await until(() => innerWidth === mini.bounds.width);
        check('Native floating window is on top and keeps both volume controls visible', mini.active && mini.alwaysOnTop && mini.bounds.width===640 &&
            [...controls].every(el => {const r=el.getBoundingClientRect();return r.width>0&&r.top>=0&&r.bottom<=innerHeight;}));
        await native.window('close');
        await until(() => !document.body.classList.contains('mini-mode'));
        const normal = await native.testMini();
        check('Closing the mini window restores the main window and retains the live stream', !normal.active&&!normal.alwaysOnTop&&cards.get(peer).video.srcObject===original);
        controls[0].querySelector('button').click();
        check('One-click unmute restores the remembered gain', mixer.entries.get(peer+':voice').volume===2.05);
        controls[0].querySelector('button').click();
        report.passed = true;
    } catch (error) { report.passed=false;report.error=error.stack; }
    finally { tracks.forEach(track=>track.stop());await context?.close();await mixer.stop();await native.saveTest(report); }
}
runUISmoke();
