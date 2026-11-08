'use strict';
const $=id=>document.getElementById(id),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function analyser(context,stream){const source=context.createMediaStreamSource(stream),node=context.createAnalyser(),silent=context.createGain();node.fftSize=8192;node.smoothingTimeConstant=0;silent.gain.value=0;source.connect(node);node.connect(silent);silent.connect(context.destination);return{node,db(hz){const data=new Float32Array(node.frequencyBinCount);node.getFloatFrequencyData(data);const bin=Math.round(hz/context.sampleRate*node.fftSize);return Math.max(...data.slice(bin-2,bin+3));},rms(){const data=new Float32Array(node.fftSize);node.getFloatTimeDomainData(data);return Math.sqrt(data.reduce((s,v)=>s+v*v,0)/data.length);},close(){source.disconnect();node.disconnect();silent.disconnect();}};}
async function runDiagnostics(){
    $('run').disabled=true;const report={started:new Date().toISOString(),checks:[],acousticMicrophoneTested:false};
    const resources=[];let context,ownGain;
    function check(name,pass,data={}){report.checks.push({name,pass:!!pass,...data});$('results').textContent=JSON.stringify(report,null,2);if(!pass)throw new Error(name);}
    try{
        if(!window.friendsDesktop)throw new Error('请在桌面版运行此诊断。');
        const native=window.friendsDesktop;report.engine=await native.info();
        context=new AudioContext({sampleRate:48000});await context.resume();
        const oscillator=context.createOscillator();ownGain=context.createGain();oscillator.frequency.value=660;ownGain.gain.value=.018;oscillator.connect(ownGain);ownGain.connect(context.destination);oscillator.start();resources.push({close(){oscillator.stop();ownGain.disconnect();}});
        await native.testTone(true);const source=await native.testSurface('open');
        async function capture(restrict){await native.selectSource(source.id,true);const stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:5,width:640,height:360},audio:{restrictOwnAudio:restrict,suppressLocalAudioPlayback:false,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});resources.push({close(){stream.getTracks().forEach(t=>t.stop());}});const track=stream.getAudioTracks()[0];if(!track)throw new Error('系统未返回共享声音');return{stream,track,probe:analyser(context,new MediaStream([track]))};}
        $('progress').textContent='播放两个短暂测试音，验证系统采集是否排除通话声音…';
        const baseline=await capture(false);resources.push(baseline.probe);await pause(1000);
        const before={own:baseline.probe.db(660),external:baseline.probe.db(1130)};
        check('客户端测试音能被基线采集',Number.isFinite(before.own)&&before.own>-85,before);
        const externalAvailable=Number.isFinite(before.external)&&before.external>-85;
        baseline.stream.getTracks().forEach(t=>t.stop());baseline.probe.close();
        const filtered=await capture(true);resources.push(filtered.probe);await pause(1000);
        const after={own:filtered.probe.db(660),external:filtered.probe.db(1130),restrictOwnAudio:filtered.track.getSettings().restrictOwnAudio};
        check('系统共享排除客户端自身声音',after.restrictOwnAudio===true&&after.own<before.own-20,{before,after});
        if(externalAvailable)check('外部媒体音量保持不变',Math.abs(after.external-before.external)<3,{differenceDb:after.external-before.external});
        else report.skipped=['未启动独立外部测试音，跳过外部媒体音量验证'];
        ownGain.gain.value=0;await pause(400);const quiet=filtered.probe.db(1130);ownGain.gain.value=.035;await pause(400);const loud=filtered.probe.db(1130);
        if(externalAvailable)check('通话播放强弱不会压低共享媒体',Math.abs(loud-quiet)<2,{differenceDb:loud-quiet});
        ownGain.gain.value=0;await native.testTone(false);filtered.stream.getTracks().forEach(t=>t.stop());
        $('progress').textContent='验证麦克风增益和本地神经网络降噪（仅合成信号）…';
        const tone=context.createOscillator(),small=context.createGain(),input=context.createMediaStreamDestination();tone.frequency.value=330;small.gain.value=.02;tone.connect(small);small.connect(input);tone.start();resources.push({close(){tone.stop();small.disconnect();input.stream.getTracks().forEach(t=>t.stop());}});
        const pipeline=new FriendsAudio.VoicePipeline();resources.push({close(){return pipeline.stop();}});const output=await pipeline.start(input.stream,{mode:'off',gain:100});const meter=analyser(context,output);resources.push(meter);await pause(300);const one=meter.rms();pipeline.setGain(200);await pause(350);const two=meter.rms();
        check('麦克风 200% 增益实际约为 +6 dB',two/one>1.8&&two/one<2.2,{ratio:two/one});
        pipeline.setMuted(true);await pause(250);check('麦克风静音切断语音输出',!output.getAudioTracks()[0].enabled&&meter.rms()<.001);await pipeline.stop();
        const noiseBuffer=context.createBuffer(1,48000,48000),values=noiseBuffer.getChannelData(0);let seed=4;for(let i=0;i<values.length;i++){seed=(seed*1664525+1013904223)>>>0;values[i]=(seed/4294967296*2-1)*.04;}
        const noise=context.createBufferSource();noise.buffer=noiseBuffer;noise.loop=true;const noiseInput=context.createMediaStreamDestination();noise.connect(noiseInput);noise.start();resources.push({close(){noise.stop();noise.disconnect();noiseInput.stream.getTracks().forEach(t=>t.stop());}});
        const noiseRaw=analyser(context,noiseInput.stream);resources.push(noiseRaw);
        const rn=new FriendsAudio.VoicePipeline();resources.push({close(){return rn.stop();}});const cleaned=await rn.start(noiseInput.stream,{mode:'rnnoise',gain:100});const noiseClean=analyser(context,cleaned);resources.push(noiseClean);await pause(1800);
        const reduction=20*Math.log10(Math.max(1e-9,noiseRaw.rms())/Math.max(1e-9,noiseClean.rms()));
        check('RNNoise 本地模型正常初始化并抑制稳定噪声',rn.mode==='rnnoise'&&!rn.fallback&&reduction>6,{reductionDb:reduction});
        report.passed=true;$('progress').textContent='诊断通过。此结果不代表已验证真实扬声器和麦克风的声学回声。';
    }catch(error){report.passed=false;report.failure=error.message;$('progress').textContent='诊断未通过：'+error.message;}
    finally{
        for(const resource of resources.reverse())try{await resource.close();}catch{}
        if(context&&context.state!=='closed')await context.close();
        await window.friendsDesktop?.testTone(false);await window.friendsDesktop?.testSurface('close');report.finished=new Date().toISOString();$('results').textContent=JSON.stringify(report,null,2);await window.friendsDesktop?.saveTest(report);$('run').disabled=false;
    }
}
$('run').onclick=runDiagnostics;
if(new URLSearchParams(location.search).get('autorun')==='1')setTimeout(runDiagnostics,1500);
