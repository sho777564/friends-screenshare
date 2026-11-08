'use strict';
const $=id=>document.getElementById(id),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function runVideoTest(){
    $('run').disabled=true;const report={started:new Date().toISOString(),scope:'Native synthetic-window capture; loopback WebRTC only; no microphone or personal screen captured.',samples:[]};let stream,a,b;
    try{
        const native=window.friendsDesktop;if(!native)throw new Error('Native desktop required');report.engine=await native.info();
        try{const saved=JSON.parse(localStorage.getItem('friendsV2Settings')||'{}');report.savedQuality=Object.fromEntries(['quality','bitrate','mode','codec'].map(k=>[k,saved[k]]));}catch{}
        if(new URLSearchParams(location.search).get('prefs')==='1'){report.scope='Video preference inspection only';report.passed=true;return;}
        const source=await native.testSurface('open');await native.selectSource(source.id,false);
        const quality={...FriendsMedia.defaults};if(new URLSearchParams(location.search).get('q')==='720')Object.assign(quality,{width:1280,height:720,bitrate:6});const options=FriendsMedia.displayConstraints(quality);options.audio=false;
        stream=await navigator.mediaDevices.getDisplayMedia(options);const track=stream.getVideoTracks()[0];track.contentHint=FriendsMedia.videoHint(quality.mode);report.captureSettings={...track.getSettings(),deviceId:undefined};
        a=new RTCPeerConnection({iceServers:[]});b=new RTCPeerConnection({iceServers:[]});
        const qa=[],qb=[];a.onicecandidate=({candidate})=>{if(candidate){if(b.remoteDescription)b.addIceCandidate(candidate).catch(()=>{});else qb.push(candidate);}};b.onicecandidate=({candidate})=>{if(candidate){if(a.remoteDescription)a.addIceCandidate(candidate).catch(()=>{});else qa.push(candidate);}};
        b.ontrack=event=>{$('receiver').srcObject=new MediaStream([event.track]);$('receiver').play().catch(()=>{});};
        const sender=a.addTrack(track,stream),tx=a.getTransceivers()[0],caps=RTCRtpReceiver.getCapabilities('video');tx.setCodecPreferences(FriendsMedia.codecOrder(caps.codecs,'H264'));
        const offer=await a.createOffer();await a.setLocalDescription({type:'offer',sdp:FriendsMedia.tuneSdp(offer.sdp,quality)});await b.setRemoteDescription(a.localDescription);for(const c of qb)await b.addIceCandidate(c);const answer=await b.createAnswer();await b.setLocalDescription({type:'answer',sdp:FriendsMedia.tuneSdp(answer.sdp,quality)});await a.setRemoteDescription(b.localDescription);for(const c of qa)await a.addIceCandidate(c);
        const p=sender.getParameters();p.encodings[0].maxBitrate=quality.bitrate*1e6;p.encodings[0].maxFramerate=quality.fps;p.encodings[0].scaleResolutionDownBy=1;p.degradationPreference=FriendsMedia.degradationFor(quality.mode);await sender.setParameters(p);
        $('progress').textContent='正在测量实际采集、编码与接收帧率…';let previous=null;
        for(let i=0;i<12;i++){
            await wait(1000);const stats=await a.getStats(),remote=await b.getStats();const out=[...stats.values()].find(r=>r.type==='outbound-rtp'&&r.kind==='video'),input=out&&stats.get(out.mediaSourceId),rx=[...remote.values()].find(r=>r.type==='inbound-rtp'&&r.kind==='video'),codec=out&&stats.get(out.codecId);
            const seconds=previous&&out?(out.timestamp-previous.timestamp)/1000:0;
            const sample={captureFps:input?.framesPerSecond,captureWidth:input?.width,captureHeight:input?.height,sendFps:out?.framesPerSecond,sendWidth:out?.frameWidth,sendHeight:out?.frameHeight,receivedFps:rx?.framesPerSecond,receivedWidth:rx?.frameWidth,receivedHeight:rx?.frameHeight,limitation:out?.qualityLimitationReason,codec:codec?.mimeType,encoder:out?.encoderImplementation,powerEfficient:out?.powerEfficientEncoder,sendMbps:seconds?(out.bytesSent-previous.bytesSent)*8/seconds/1e6:null,encodeMs:previous&&out.framesEncoded>previous.framesEncoded?(out.totalEncodeTime-previous.totalEncodeTime)*1000/(out.framesEncoded-previous.framesEncoded):null,qp:previous&&out.framesEncoded>previous.framesEncoded?(out.qpSum-previous.qpSum)/(out.framesEncoded-previous.framesEncoded):null};
            report.samples.push(sample);previous=out; $('results').textContent=JSON.stringify(report,null,2);
        }
        report.passed=report.samples.slice(4).some(s=>s.receivedWidth>=1280&&s.receivedFps>=25);$('progress').textContent='采集诊断结束';
    }catch(error){report.passed=false;report.failure=error.message;$('progress').textContent=error.message;}
    finally{stream?.getTracks().forEach(t=>t.stop());a?.close();b?.close();await window.friendsDesktop?.testSurface('close');report.finished=new Date().toISOString();$('results').textContent=JSON.stringify(report,null,2);await window.friendsDesktop?.saveTest(report);$('run').disabled=false;}
}
$('run').onclick=runVideoTest;if(new URLSearchParams(location.search).get('autorun')==='1')setTimeout(runVideoTest,1200);
