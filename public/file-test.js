'use strict';
const report={started:new Date().toISOString(),checks:[],scope:'Two native WebRTC endpoints on this PC; generated files and generated audio/video only.'};
const $=id=>document.getElementById(id),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,pass,detail={})=>{report.checks.push({name,pass:!!pass,...detail});$('results').textContent=JSON.stringify(report,null,2);if(!pass)throw new Error(name);};
async function until(fn,what,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await sleep(25);}throw new Error('Timeout: '+what);}
async function run(){const clients=[],managers=[],tracks=[],remoteClients=[];let ctx,timer;
    try{
        const io=window.friendsDesktop.files;
        const a=new FriendsMedia.Conference(),b=new FriendsMedia.Conference();clients.push(a,b);
        const link=(from,to,id)=>({connected:true,emit(type,data){if(type==='relaySDP')queueMicrotask(()=>to.receiveDescription({peer_id:id,session_description:data.session_description}).catch(e=>console.error(e)));if(type==='relayICE')queueMicrotask(()=>to.receiveIce({peer_id:id,ice_candidate:data.ice_candidate}).catch(()=>{}));}});
        a.socket=link(a,b,'a');b.socket=link(b,a,'b');
        ctx=new AudioContext();await ctx.resume();for(const [kind,hz] of [['voice',330],['sound',660]]){const osc=ctx.createOscillator(),dest=ctx.createMediaStreamDestination();osc.frequency.value=hz;osc.connect(dest);osc.start();tracks.push(...dest.stream.getTracks());await a.setTrack(kind,dest.stream.getAudioTracks()[0],dest.stream);}
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;$('surface').append(canvas);const g=canvas.getContext('2d');timer=setInterval(()=>{g.fillStyle='#213';g.fillRect(0,0,640,360);g.fillStyle='#9af';g.fillRect((Date.now()/10)%600,20,40,300);},33);const stream=canvas.captureStream(30);tracks.push(...stream.getTracks());await a.setTrack('screen',stream.getVideoTracks()[0],stream);
        const ma=new FriendsFiles.Transfers(a,io,{rate:()=>4*1024*1024}),mb=new FriendsFiles.Transfers(b,io,{rate:()=>4*1024*1024});managers.push(ma,mb);
        await b.addPeer({peer_id:'a',should_create_offer:false});await a.addPeer({peer_id:'b',should_create_offer:true});
        await until(()=>a.peers.get('b')?.pc.connectionState==='connected'&&b.peers.get('a')?.pc.connectionState==='connected','connect');
        check('Actual native WebRTC connected with three media slots',a.peers.get('b').pc.getTransceivers().length===3);
        const before=await b.peers.get('a').pc.getStats();let chat='';b.addEventListener('data',e=>{if(e.detail.data.type==='chat')chat=e.detail.data.text;});
        let mode='accept';mb.addEventListener('update',e=>{const t=e.detail;if(t.status==='offered'){if(mode==='decline')mb.cancel(t.id);else mb.accept(t.id);}});ma.addEventListener('update',e=>{if(e.detail.direction==='receive'&&e.detail.status==='offered')ma.accept(e.detail.id);});
        const fixtureA=await io.fixture(4*1024*1024+9),fixtureB=await io.fixture(2*1024*1024+7);
        const [outA]=ma.send('b',[await io.fixtureSource(fixtureA.file)]),[outB]=mb.send('a',[await io.fixtureSource(fixtureB.file)]);
        await until(()=>outA.status==='transferring','transfer start');a.sendData({type:'chat',text:'chat while transferring'});
        await until(()=>outA.terminal&&outB.terminal,'bidirectional complete',45000);
        check('Bidirectional streaming file transfers complete with SHA256',outA.status==='complete'&&outB.status==='complete'&&outA.digest===fixtureA.sha256&&outB.digest===fixtureB.sha256,{bytes:[outA.size,outB.size]});
        check('Chat continues during file transfer',chat==='chat while transferring');
        const after=await b.peers.get('a').pc.getStats();const rx=[...after.values()].filter(r=>r.type==='inbound-rtp');check('Both audio tracks and video continue receiving RTP during files',rx.length===3&&rx.every(r=>(r.bytesReceived||0)>(before.get(r.id)?.bytesReceived||0)));
        const simulatedInputs=[];const fakeNative={onEvent(){},grant:async()=>({token:crypto.randomUUID()}),input:async(token,seq,input)=>{if(input.type!=='ping')simulatedInputs.push(input);return true;},stop:async()=>{}};
        const ra=new FriendsRemote.Remote(a,fakeNative),rb=new FriendsRemote.Remote(b,fakeNative);remoteClients.push(ra,rb);
        ra.request('b');await until(()=>!!rb.pending,'control request');check('P2P control request does not inject anything before approval',simulatedInputs.length===0);rb.deny();await until(()=>!ra.requested,'control declined');check('P2P control decline leaves both endpoints without control',!ra.control&&!rb.host);
        ra.request('b');await until(()=>!!rb.pending,'second control request');await rb.allow();await until(()=>!!ra.control,'simulated test approval');
        for(const input of [{type:'move',x:.2,y:.3},{type:'button',x:.2,y:.3,button:0,action:'down'},{type:'button',x:.2,y:.3,button:0,action:'up'},{type:'key',vk:65,action:'down'},{type:'key',vk:65,action:'up'}])ra.sendInput(input);
        await until(()=>simulatedInputs.length===5,'control messages');check('Ordered mouse and keyboard protocol crosses actual native WebRTC into a simulated input sink',simulatedInputs.map(i=>i.type).join(',')==='move,button,button,key,key');
        await rb.stop();await until(()=>!ra.control,'remote stop');check('P2P revocation clears controller state',!ra.control&&!rb.host);await ra.close();await rb.close();
        const empty=await io.fixture(0),tiny=await io.fixture(29);const queued=ma.send('b',[await io.fixtureSource(empty.file),await io.fixtureSource(tiny.file)]);await until(()=>queued.every(t=>t.terminal),'empty and queued');check('Zero byte file and sequential multi-file queue',queued.every(t=>t.status==='complete'));
        mode='decline';const declined=ma.send('b',[await io.fixtureSource(tiny.file)])[0];await until(()=>declined.terminal,'decline');check('Decline releases sender',declined.status==='failed'&&declined.error.includes('拒绝'));mode='accept';
        const large=await io.fixture(8*1024*1024);const cancelled=ma.send('b',[await io.fixtureSource(large.file)])[0];await until(()=>cancelled.bytes>32768,'cancel progress');await ma.cancel(cancelled.id);await until(()=>mb.items.get(cancelled.id)?.terminal,'remote cancel');check('Cancel stops both sides and cleans temporary sink',cancelled.status==='cancelled'&&mb.items.get(cancelled.id).status==='failed');
        let corrupt=true;const badIO={...io,read:async token=>{const data=await io.read(token);if(corrupt){data[0]^=1;corrupt=false;}return data;}};const badManager=new FriendsFiles.Transfers(a,badIO);managers.push(badManager);const bad=badManager.send('b',[await io.fixtureSource(tiny.file)])[0];await until(()=>bad.terminal,'corruption rejection');check('Corrupted stream never reports successful save',bad.status==='failed'&&mb.items.get(bad.id)?.status==='failed');
        const disconnected=ma.send('b',[await io.fixtureSource(large.file)])[0];await until(()=>disconnected.bytes>32768,'disconnect progress');a.removePeer('b');b.removePeer('a');await until(()=>disconnected.terminal,'disconnect');check('Disconnect ends transfer rather than leaving progress stuck',disconnected.status==='failed');
        report.passed=true;
    }catch(error){report.passed=false;report.error=error.stack;}
    finally{await Promise.all(remoteClients.map(m=>m.close()));await Promise.all(managers.map(m=>m.close()));for(const c of clients)c.resetPeers();tracks.forEach(t=>t.stop());clearInterval(timer);await ctx?.close();report.finished=new Date().toISOString();$('results').textContent=JSON.stringify(report,null,2);$('progress').textContent=report.passed?'全部通过':'测试失败';await window.friendsDesktop.saveTest(report);}
}
run();
