'use strict';
const publicSignal=new URLSearchParams(location.search).has('public');
const report={started:new Date().toISOString(),scope:'Four native WebRTC endpoints on ONE PC; local signaling, generated files/audio/video, simulated OS input sink. Not a four-PC WAN quality test.',checks:[]};
const $=id=>document.getElementById(id),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,pass,detail={})=>{report.checks.push({name,pass:!!pass,...detail});$('results').textContent=JSON.stringify(report,null,2);if(!pass)throw new Error(name);};
async function until(fn,what,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await sleep(25);}throw new Error('Timeout: '+what);}
async function run(){const clients=[],managers=[],remotes=[],tracks=[],timers=[];let ctx;
 try{
  if(publicSignal)report.scope=report.scope.replace('local signaling','PUBLIC MiroTalk signaling in a generated random test room');
  const ids=['a','b','c','d'],names=['共享方','同学乙','同学丙','围观丁'],errors=[];
  for(let i=0;i<4;i++){const c=new FriendsMedia.Conference({name:names[i]});clients.push(c);c.addEventListener('error',e=>errors.push(e.detail.message));if(!publicSignal)c.socket={id:ids[i],connected:true,emit(type,data){const to=clients[ids.indexOf(data.peer_id)];if(type==='relaySDP')queueMicrotask(()=>to.receiveDescription({peer_id:ids[i],session_description:data.session_description}).catch(e=>errors.push(e.message)));if(type==='relayICE')queueMicrotask(()=>to.receiveIce({peer_id:ids[i],ice_candidate:data.ice_candidate}).catch(e=>errors.push(e.message)));}};}
  ctx=new AudioContext();await ctx.resume();
  for(let i=0;i<4;i++){
   for(const [kind,hz] of [['voice',220+i*40],['sound',660+i*60]]){const osc=ctx.createOscillator(),gain=ctx.createGain(),dest=ctx.createMediaStreamDestination();gain.gain.value=.1;osc.frequency.value=hz;osc.connect(gain).connect(dest);osc.start();tracks.push(...dest.stream.getTracks());await clients[i].setTrack(kind,dest.stream.getAudioTracks()[0],dest.stream);}
   const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;$('surface').append(canvas);const g=canvas.getContext('2d');const draw=()=>{g.fillStyle=['#123','#213','#132','#321'][i];g.fillRect(0,0,640,360);g.fillStyle='#9af';g.fillRect((Date.now()/9+i*40)%600,20,40,300);};draw();timers.push(setInterval(draw,33));const stream=canvas.captureStream(30);tracks.push(...stream.getTracks());await clients[i].setTrack('screen',stream.getVideoTracks()[0],stream);
  }
  if(publicSignal){const room='group-test-'+crypto.randomUUID();for(let i=0;i<4;i++){await clients[i].join(room);await until(()=>clients[i].socket?.connected,'public signaling '+i);ids[i]=clients[i].socket.id;await sleep(250);}}
  else for(let i=0;i<4;i++)for(let j=i+1;j<4;j++){const peers=Object.fromEntries(ids.map((id,k)=>[id,{peer_name:names[k]}]));await clients[j].addPeer({peer_id:ids[i],peers,should_create_offer:false});await clients[i].addPeer({peer_id:ids[j],peers,should_create_offer:true});}
  await until(()=>clients.every(c=>c.peers.size===3&&[...c.peers.values()].every(p=>p.pc.connectionState==='connected'&&p.channel?.readyState==='open'&&p.controlProtocol===2)),'all six links');
  check('Four clients, six bidirectional WebRTC links, each with three separate media slots',clients.every(c=>[...c.peers.values()].every(p=>p.pc.getTransceivers().length===3)));
  check('Stable participant identities cross the real peer hello handshake', clients.every(c => [...c.peers.values()].every(p => p.identity === clients[ids.indexOf(p.id)].uuid)));
  await until(() => clients.every(c => [...c.peers.values()].every(p => p.tx.screen.sender.getParameters().encodings.every(e => e.maxBitrate === 4000000))), 'four-member sender budget');
  check('Total 12 Mbps video budget divides to 4 Mbps per remote member',clients.every(c=>[...c.peers.values()].every(p=>p.tx.screen.sender.getParameters().encodings.every(e=>e.maxBitrate===4000000))));
  const guarded = clients[0];
  const guardedPeer = guarded.peers.get(ids[1]);
  await guarded.adaptVideo([{ id: ids[1], rttMs: 35, availableMbps: 10 }]);
  await guarded.adaptVideo([{ id: ids[1], rttMs: 1006, availableMbps: .39 }]);
  check('Real video sender accepts congestion ceiling while the two audio senders retain their bitrates',
   guardedPeer.tx.screen.sender.getParameters().encodings[0].maxBitrate === 150000 &&
   guardedPeer.tx.voice.sender.getParameters().encodings[0].maxBitrate === 64000 &&
   guardedPeer.tx.sound.sender.getParameters().encodings[0].maxBitrate === 256000);
  for (const peer of guarded.peers.values()) { peer.videoBudget = new FriendsMedia.VideoBudget(); await guarded.applySenderQuality(peer); }
  const messages=clients.map(()=>[]);clients.forEach((c,i)=>c.addEventListener('data',e=>{if(e.detail.data.type==='chat')messages[i].push(e.detail.data.text);}));clients.forEach((c,i)=>c.sendData({type:'chat',text:ids[i]}));await until(()=>messages.every(m=>m.length===3),'group chat');check('Every group chat reaches exactly the other three members',messages.every((m,i)=>m.sort().join('')===ids.filter((_,j)=>i!==j).sort().join('')));
  const io=window.friendsDesktop.files;for(const c of clients){const m=new FriendsFiles.Transfers(c,io,{rate:()=>1024*1024});managers.push(m);m.addEventListener('update',e=>{if(e.detail.direction==='receive'&&e.detail.status==='offered')m.accept(e.detail.id);});}
  const baseline=await Promise.all(clients.flatMap(c=>[...c.peers.values()].map(p=>p.pc.getStats())));
  const logErrors = [];
  const logs = clients.slice(0, 2).map(() => new ShareLog(window.friendsDesktop.shareLogs, error => logErrors.push(error.message)));
  const [sender, receiver] = logs;
  clients[1].addEventListener('data', ({ detail }) => {
   if (detail.id === ids[0] && detail.data.type === 'state') receiver.remoteState(detail.id, detail.data);
  });
  const capture = { surface: 'window', width: 640, height: 360, configuredFps: 30, sound: true };
  const firstShare = sender.startLocal(capture, FriendsMedia.defaults);
  clients[0].sendData({ type: 'state', screen: true, shareId: firstShare });
  await until(() => receiver.active.get(ids[0])?.shareId === firstShare, 'receive share start');
  await Promise.all(clients.slice(0, 2).map(c => c.stats()));
  const fixture=await io.fixture(2*1024*1024+13),outB=managers[0].send(ids[1],[await io.fixtureSource(fixture.file)])[0],outC=managers[0].send(ids[2],[await io.fixtureSource(fixture.file)])[0];await until(()=>outB.terminal&&outC.terminal,'two targeted files',45000);
  check('Two simultaneous targeted files complete with SHA256; unrelated member receives nothing',outB.status==='complete'&&outC.status==='complete'&&outB.digest===fixture.sha256&&outC.digest===fixture.sha256&&managers[3].items.size===0);
  await sleep(1000);const after=await Promise.all(clients.flatMap(c=>[...c.peers.values()].map(p=>p.pc.getStats())));const mediaCounts=after.map((stats,i)=>[...stats.values()].filter(r=>r.type==='inbound-rtp'&&(r.bytesReceived||0)>(baseline[i].get(r.id)?.bytesReceived||0)).length);
  check('All 12 receiving directions keep microphone, system sound and video flowing during transfers',mediaCounts.every(n=>n===3),{mediaCounts});
  const context = { capture, quality: FriendsMedia.defaults, roomMembers: 4, activeShares: 4, fileTransfers: 0, signal: 'connected' };
  await Promise.all(logs.map(async (log, index) => log.sample(await clients[index].stats(), context)));
  const marked = await receiver.event('mark');
  const secondShare = sender.startLocal(capture, FriendsMedia.defaults);
  clients[0].sendData({ type: 'state', screen: true, shareId: secondShare });
  await until(() => receiver.active.get(ids[0])?.shareId === secondShare, 'receive source change');
  await Promise.all(logs.map(async (log, index) => log.sample(await clients[index].stats(), context)));
  clients[0].sendData({ type: 'state', screen: false });
  await until(() => !receiver.active.size, 'receive share end');
  sender.end(null, 'stopped');
  check('Native share-log IPC records both sides of a share, a stall mark, and a source change', marked && logErrors.length === 0, { firstShare, secondShare });
  const granted=new Map(),inputs=[];let hostEvents;const palette=['#ffac42','#bf8bff','#6cdd8b'];
  const hostNative={onEvent(fn){hostEvents=fn;},async grant(peer,name){const grant={token:crypto.randomUUID(),actor:peer,color:palette[granted.size],name};granted.set(peer,grant);return grant;},async input(token,seq,input){const entry=[...granted.entries()].find(([,g])=>g.token===token);if(!entry)return false;if(input.type!=='ping')inputs.push({peer:entry[0],seq,input});return true;},async stop(peer){if(peer)granted.delete(peer);else granted.clear();}};
  clients.forEach((c,i)=>remotes.push(new FriendsRemote.Remote(c,i===0?hostNative:{onEvent(){},stop:async()=>{}})));
  remotes[1].request(ids[0]);remotes[2].request(ids[0]);await until(()=>remotes[0].requests.size===2,'two pending requests');check('Two independent requests inject no input before owner approval',inputs.length===0&&granted.size===0);await remotes[0].allow(ids[1]);await until(()=>remotes[1].control,'first grant');check('First approval does not approve the second participant',!remotes[2].control&&remotes[0].requests.size===1);await remotes[0].allow(ids[2]);await until(()=>remotes[2].control,'second grant');
  remotes[1].sendInput({type:'move',x:.2,y:.3});remotes[2].sendInput({type:'move',x:.7,y:.6});await until(()=>inputs.length===2,'authorized inputs');clients[3].sendControl(ids[0],{v:2,action:'input',id:remotes[0].hosts.get(ids[1]).id,seq:1,input:{type:'key',vk:65,action:'down'}});await sleep(150);check('Only the two separately approved members can send input',inputs.length===2&&granted.size===2);
  let watcher;remotes[3].addEventListener('cursors',e=>watcher=e.detail);hostEvents({type:'cursor',x:.5,y:.5,participants:[...granted].map(([id,g],i)=>({id,name:g.name,color:g.color,x:.2+i*.3,y:.3})),ownerPeer:ids[1]});await until(()=>watcher?.cursors.length===3,'watcher cursor snapshot');check('Unapproved viewer sees distinct named cursors without receiving permission tokens',new Set(watcher.cursors.map(c=>c.color)).size===3&&!JSON.stringify(watcher).includes(granted.get(ids[1]).token));
  await remotes[0].stopHost(ids[1]);await until(()=>!remotes[1].control,'individual revoke');check('Revoking one member preserves the other controller',!!remotes[2].control&&remotes[0].hosts.size===1&&granted.has(ids[2]));
  for(let i=0;i<3;i++)clients[i].removePeer(ids[3]);clients[3].resetPeers();await until(()=>clients.slice(0,3).every(c=>c.peers.size===2),'fourth leaves');clients[0].sendData({type:'chat',text:'after leave'});await until(()=>messages[1].includes('after leave')&&messages[2].includes('after leave'),'chat after leave');remotes[2].sendInput({type:'move',x:.4,y:.4});await until(()=>inputs.length===3,'controller after unrelated leave');
  await sleep(200);check('Three remaining members retain media, chat and collaboration after fourth leaves',clients.slice(0,3).every(c=>[...c.peers.values()].every(p=>p.pc.connectionState==='connected'))&&!!remotes[2].control);
  check('No media or signaling errors',errors.length===0,{errors});report.passed=true;
 }catch(error){report.passed=false;report.error=error.stack;}
 finally{for(const r of remotes)await r.close();for(const m of managers)await m.close();for(const c of clients){if(publicSignal)c.leave();else c.resetPeers();}tracks.forEach(t=>t.stop());timers.forEach(clearInterval);await ctx?.close();report.finished=new Date().toISOString();$('results').textContent=JSON.stringify(report,null,2);$('progress').textContent=report.passed?'全部通过':'测试失败';await window.friendsDesktop.saveTest(report);}
}
run();
