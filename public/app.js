'use strict';
const $=id=>document.getElementById(id), native=window.friendsDesktop;
const call=new FriendsMedia.Conference({identity:FriendsPeerAudio.identity(localStorage)}), voice=new FriendsAudio.VoicePipeline(), mixer=new FriendsAudio.OutputMixer();
const cards=new Map(), peerState=new Map();
const peerVolumes = new FriendsPeerAudio.Preferences(localStorage, () => toast('音量记忆保存失败，请检查可用空间。'));
const volumeWidgets = new Map();
let miniPeer = null;
const initial={micGain:150,master:100,noiseMode:'rnnoise',aec:true,autoGain:false,inputMode:'voice',shareAudioDefault:true,quality:'1920,1080,60,12',bitrate:12,mode:'balanced',codec:'auto',adaptive:true,input:'',output:''};
let saved={};try{saved=JSON.parse(localStorage.getItem('friendsV2Settings')||'{}');}catch{}
const settings={...initial,...saved};
let changedVideoPreset = false;
if (!localStorage.getItem('friends25VideoPreset')) {
    if (typeof settings.quality === 'string' && settings.quality.startsWith('2560,1440')) {
        settings.quality = '1920,1080,60,12';
        changedVideoPreset = true;
    }
    localStorage.setItem('friends25VideoPreset', '1');
    localStorage.setItem('friendsV2Settings', JSON.stringify(settings));
}
if(!localStorage.getItem('friendsV21VideoProfile')){if(settings.mode==='motion')settings.mode='balanced';localStorage.setItem('friendsV21VideoProfile','1');localStorage.setItem('friendsV2Settings',JSON.stringify(settings));}
let joined=false,rawMic=null,display=null,currentSource=null,micMuted=true,deafened=false,soundEnabled=true,pttPressed=false,statsBusy=false,toastTimer,sourceType='screen',sourceList=[],selectedSource=null,desktopInfo=null,fullscreenArea=null,recentStats=[];
let mediaCleanup=Promise.resolve();
let microphoneRequest=null;
let roomJoinInProgress=false;
let restartForUpdate=false;
let roomAttempt=0;
let roomJoinFailure='';
const lastVoiceSample = new Map();
const shareLog = new ShareLog(native?.shareLogs, error => {
    console.warn(error);
    toast('共享日志写入失败，请检查客户端目录的写入权限和磁盘空间。');
});
let localShareId = null;
const query=new URLSearchParams(location.search);
$('room').value=query.get('room')||localStorage.getItem('friendsPinnedRoom')||'';
$('name').value=localStorage.getItem('friendsV2Name')||'同学';
let roomDefaults=null;
const roomBoot=fetch('room-defaults.json').then(r=>{if(!r.ok)throw new Error('无法读取常用房间');return r.json();}).then(data=>{
    if(data.id===''){
        let id=localStorage.getItem('friendsGeneratedRoom');
        if(!FriendsRooms.valid(id)){
            id='friends-'+crypto.randomUUID();
            localStorage.setItem('friendsGeneratedRoom',id);
        }
        data={id};
    }
    if(!FriendsRooms.valid(data.id))throw new Error('常用房间配置无效');roomDefaults=data;
    $('room').value=FriendsRooms.chooseRoom(query.get('room'),localStorage.getItem('friendsPinnedRoom'),data.id);
    $('roomLabel').textContent=roomName($('room').value)+' / 好友的放映室';return data;
});
function roomName(room){return room===roomDefaults?.id?'好友房间':'常用房间';}
function save(){localStorage.setItem('friendsV2Settings',JSON.stringify(settings));}
const diagnostic=(area,event,error,context)=>window.FriendsDiagnostics?.record(area,event,error,context);
function toast(message,offerLog=false){
    $('toastMessage').textContent=message;
    $('toastExportDiagnostic').hidden=!offerLog||!native?.diagnostics;
    $('toast').hidden=false;clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>$('toast').hidden=true,offerLog?18000:6500);
}
function reportError(area,error,message=typeof error==='string'?error:error?.message,context){
    diagnostic(area,'error',error,context);
    toast(message||'操作失败，请导出诊断日志。',true);
}
async function run(fn,area='ui'){try{await fn();}catch(error){console.error(error);reportError(area,error,error?.name==='NotAllowedError'?'操作已取消，请检查设备权限后重试。':undefined);}}
async function exportDiagnostic(){
    if(await native?.diagnostics?.export())toast('诊断日志已导出，可以发送给协助排查的人。');
}
for(const id of ['exportDiagnostic','toastExportDiagnostic']){
    $(id).hidden=!native?.diagnostics||id==='toastExportDiagnostic';
    $(id).onclick=()=>run(exportDiagnostic);
}
function quality(){const [width,height,fps]=$('quality').value.split(',').map(Number);return{width,height,fps,bitrate:Number($('bitrate').value),mode:$('mode').value,codec:$('codec').value,adaptive:$('adaptive').checked};}
function shareCapture() {
    const track = display?.getVideoTracks()[0];
    if (!track) return undefined;
    const { width, height, frameRate } = track.getSettings();
    return { width, height, configuredFps: frameRate, surface: currentSource?.type, sound: !!display.getAudioTracks()[0]?.enabled };
}
function syncShareLogControls() {
    $('markShareStall').disabled = !shareLog.active.size;
    $('openShareLogs').hidden = !native?.shareLogs;
    $('markShareStall').hidden = !native?.shareLogs;
}
for(const id of Object.keys(initial)){const el=$(id);if(!el)continue;if(el.type==='checkbox')el.checked=!!settings[id];else el.value=String(settings[id]);}
$('micGainValue').textContent=settings.micGain+'%';$('masterValue').textContent=settings.master+'%';mixer.masterVolume(settings.master);
function buttonIcon(id,name){$(id).innerHTML=icon(name);}
function effectiveMuted(){return micMuted||deafened||(settings.inputMode==='ptt'&&!pttPressed);}
function syncControls(){
    const off=!rawMic||effectiveMuted();
    for(const id of ['mic','miniMic']){buttonIcon(id,off?'micOff':'mic');$(id).classList.toggle('muted-button',off);$(id).setAttribute('aria-label',off?'开启麦克风':'静音麦克风');}
    $('micLabel').textContent=!rawMic?'麦克风已关':settings.inputMode==='ptt'&&!micMuted?'按住空格说话':off?'麦克风已静音':'麦克风已开';
    $('myState').textContent=!joined?'离线':deafened?'耳机静音':off?'麦克风静音':'语音已连接';
    for(const id of ['deafen','miniDeafen']){$(id).classList.toggle('muted-button',deafened);$(id).setAttribute('aria-label',deafened?'取消耳机静音':'耳机静音');}
    $('share').classList.toggle('share-on',!!display);$('share').title=display?'停止屏幕共享':'共享屏幕';$('share').setAttribute('aria-label',display?'停止屏幕共享':'共享屏幕');
    $('shareSound').classList.toggle('muted-button',!soundEnabled);$('shareSound').title=soundEnabled?'共享声音：开启':'共享声音：静音';buttonIcon('shareSound',soundEnabled?'speaker':'speakerOff');$('shareSound').setAttribute('aria-label',soundEnabled?'静音共享声音':'开启共享声音');
    $('shareLabel').textContent=display?(soundEnabled?'正在共享画面和声音':'正在共享画面 · 声音静音'):soundEnabled?'共享时默认带声音':'下次共享不发送声音';
    for(const id of ['mic','miniMic','share','shareSound','deafen','miniDeafen','leave'])$(id).disabled=!joined;
    $('joinOpen').hidden=joined;$('joinOpen').textContent='进入好友房间';
    $('localStop').hidden=!display;$('changeShare').hidden=!display;$('localLive').hidden=!display;$('localEmpty').hidden=!!display;
    renderMembers();
}
function publish(speaking = false) {
    const screen = !!display && !!localShareId;
    call.sendData({ type: 'state', mic: !!rawMic && !effectiveMuted(), screen,
        shareId: screen ? localShareId : undefined, sound: screen && soundEnabled,
        deafened, speaking: speaking === true });
}
function applyMute(){voice.setMuted(effectiveMuted());mixer.deafen(deafened);syncControls();publish();}
function makeAvatar(name,small=true,peer=null){const el=document.createElement('span');el.className='avatar '+(small?'small':'large');el.textContent=Array.from(name||'同')[0];if(peer&&typeof bindFileTarget==='function')bindFileTarget(el,peer,name,true);return el;}
function renderMembers(){
    const names=[{id:'me',name:$('name').value||'我',own:true,...{mic:!!rawMic&&!effectiveMuted(),deafened}},...[...call.peers.values()].map(p=>({id:p.id,name:p.name,...peerState.get(p.id)}))];
    $('memberCount').textContent=String(names.length);$('members').replaceChildren();$('channelMembers').replaceChildren();
    for(const person of names){
        const row=document.createElement('div');row.className='member'+(person.speaking?' speaking':'');row.dataset.member=person.id;
        const name=document.createElement('span');name.className='member-name';name.textContent=person.name+(person.own?'（你）':'');
        const state=document.createElement('span');state.className='member-state';state.innerHTML=person.deafened?icon('headphones'):person.mic===false?icon('micOff'):'';
        if(!person.own&&typeof bindFileTarget==='function')bindFileTarget(row,person.id,person.name);
        row.append(makeAvatar(person.name,true,person.own?null:person.id),name,state);$('members').append(row);
        const small=document.createElement('div');small.className='channel-member';if(!person.own&&typeof bindFileTarget==='function')bindFileTarget(small,person.id,person.name);small.append(makeAvatar(person.name,true,person.own?null:person.id));const text=document.createElement('span');text.textContent=person.name;small.append(text);$('channelMembers').append(small);
    }
    $('myName').textContent=$('name').value||'同学';$('myAvatar').textContent=Array.from($('name').value||'我')[0];
}
function joinDialog(advanced=false){$('roomAdvanced').open=advanced;$('roomDialog').showModal();}
async function quickJoin(mode='manual'){await roomBoot;if(!localStorage.getItem('friendsV2Name'))return joinDialog(false);await joinRoom(mode);}
$('joinOpen').onclick=()=>run(quickJoin);$('newRoom').onclick=()=>run(async()=>{await roomBoot;joinDialog(true);});
for(const node of document.querySelectorAll('[data-close]'))node.onclick=()=>$(node.dataset.close).close();
for(const node of document.querySelectorAll('[data-window]'))node.onclick=()=>native?.window(node.dataset.window);
async function configureOutput(socket=call.socket){
    const selected=settings.output;
    const context={attempt:roomAttempt,mode:selected?'saved-device':'default-device'};
    diagnostic('audio-output','start',null,context);
    try { await mixer.sink(selected);diagnostic('audio-output','ready',null,context); }
    catch(error){
        if(call.socket!==socket||settings.output!==selected)return;
        diagnostic('audio-output','error',error,context);
        console.warn('Audio output unavailable',error);
        if(selected){
            settings.output='';
            $('output').value='';
            try { save(); } catch(saveError){ console.warn(saveError); }
            try {
                await mixer.sink('');
                diagnostic('audio-output','fallback',null,{attempt:context.attempt,mode:'default-device'});
                if(call.socket===socket&&!settings.output)toast('原输出设备不可用，已切换到系统默认扬声器。');
                return;
            } catch(fallbackError){
                console.warn('Default audio output unavailable',fallbackError);
                diagnostic('audio-output','error',fallbackError,{attempt:context.attempt,mode:'default-device'});
            }
        }
        if(call.socket===socket&&!settings.output)toast('无法初始化扬声器，请在设置中检查输出设备。',true);
    }
}
async function joinRoom(mode='manual'){
    if(restartForUpdate)throw new Error('正在重启安装更新，请稍候。');
    if(roomJoinInProgress)throw new Error('正在连接房间，请稍候。');
    roomJoinInProgress=true;
    try {
        await roomBoot;
        if(joined){if(call.room===$('room').value.trim()&&call.name===$('name').value.trim()){$('roomDialog').close();return;}await leaveRoom();}
        if(call.socket)throw new Error('正在连接房间，请稍候或先退出。');
        await mediaCleanup;
        call.name=$('name').value.trim()||'同学';await call.updateQuality(quality());
        localStorage.setItem('friendsV2Name',call.name);localStorage.setItem('friendsV2Room',$('room').value.trim());
        if($('pinRoom').checked)localStorage.setItem('friendsPinnedRoom',$('room').value.trim());
        $('join').disabled=true;
        roomJoinFailure='';
        const attempt=++roomAttempt;
        diagnostic('room','start',null,{attempt,mode});
        try { await call.join($('room').value.trim()); }
        catch(error){ $('join').disabled=false;diagnostic('room','error',error,{attempt,mode});throw error; }
        void configureOutput(call.socket);
        $('roomDialog').close();$('leave').disabled=false;
    } finally { roomJoinInProgress=false; }
}
$('roomForm').onsubmit=event=>{event.preventDefault();run(joinRoom,'room');};
call.addEventListener('joined',()=>{diagnostic('room','joined',null,{attempt:roomAttempt});joined=true;$('join').disabled=false;$('roomLabel').textContent=roomName($('room').value)+' / 好友的放映室';$('connectionLabel').textContent='等待朋友加入';$('welcomeTitle').textContent='已加入「一起看」';$('welcomeText').textContent='开麦聊聊，或分享你正在看的内容。';syncControls();});
call.addEventListener('join-failure',({detail})=>{
    roomJoinFailure=detail.message;
    diagnostic('room','error',null,{attempt:roomAttempt,reason:detail.reason});
    toast(detail.message,true);
});
call.addEventListener('signal',({detail})=>{
    if(detail.state==='error')diagnostic('signal','error',detail.error,{attempt:roomAttempt,reason:'network'});
    else diagnostic('signal','state',null,{attempt:roomAttempt,state:detail.state});
});
call.addEventListener('status',event=>{
    const message=event.detail.message;
    if(message.includes('已连接同学')){$('connectionLabel').textContent='语音已连接';}
    else if(message.includes('暂时断开'))$('connectionLabel').textContent='正在重新连接';
    else if(message.includes('无法连接')){$('connectionLabel').textContent='连接失败，可重试';$('join').disabled=false;toast(message,true);}
    document.querySelector('.connection-panel').classList.toggle('connected',message.includes('已连接同学'));
});
call.addEventListener('error',e=>reportError('peer',e.detail.error||e.detail.message,e.detail.message,{attempt:roomAttempt}));
call.addEventListener('warning',e=>reportError('peer',e.detail.message,e.detail.message,{attempt:roomAttempt}));
call.addEventListener('left',()=>{diagnostic('room','left',null,{attempt:roomAttempt});joined=false;$('join').disabled=false;$('connectionLabel').textContent='已断开';document.querySelector('.connection-panel').classList.remove('connected');$('welcomeTitle').textContent='朋友到齐，一起看。';$('welcomeText').textContent='加入同一个房间，边聊边分享游戏、视频和屏幕。';mediaCleanup=releaseMedia();mediaCleanup.catch(error=>reportError('room',error));syncControls();});
async function enumerate(){
    const devices=await navigator.mediaDevices.enumerateDevices();
    for(const [id,kind,label] of [['input','audioinput','系统默认麦克风'],['output','audiooutput','系统默认扬声器']]){
        const select=$(id),current=settings[id];select.replaceChildren(new Option(label,''));
        for(const device of devices.filter(d=>d.kind===kind&&d.deviceId!=='default'))select.add(new Option(device.label||label,device.deviceId));
        if([...select.options].some(o=>o.value===current))select.value=current;
    }
}
async function acquireMic(socket=call.socket){
    if(!joined||!socket||call.socket!==socket)return;
    if(microphoneRequest){
        if(microphoneRequest.socket!==socket)throw new Error('上一次麦克风请求仍在等待，请关闭系统授权提示后重试。');
        return microphoneRequest.promise;
    }
    const attempt=roomAttempt;
    diagnostic('microphone','start',null,{attempt,mode:settings.input?'saved-device':'default-device'});
    const request={socket,promise:openRoomMic(socket)};
    microphoneRequest=request;
    try {
        await request.promise;
        if(call.socket===socket&&rawMic)diagnostic('microphone','ready',null,{attempt});
    } catch(error){ diagnostic('microphone','error',error,{attempt});throw error; }
    finally { if(microphoneRequest===request)microphoneRequest=null; }
}
async function openRoomMic(socket){
    const current=()=>joined&&call.socket===socket;
    const constraints={echoCancellation:settings.aec?{ideal:'all'}:false,noiseSuppression:settings.noiseMode==='browser',autoGainControl:settings.autoGain,channelCount:1,sampleRate:{ideal:48000}};
    if(settings.input)constraints.deviceId={exact:settings.input};
    const next=await navigator.mediaDevices.getUserMedia({audio:constraints,video:false}),previous=rawMic;
    if(!current()){next.getTracks().forEach(track=>track.stop());return;}
    try{
        const output=await voice.start(next,{mode:settings.noiseMode,gain:settings.micGain});
        if(!current()){next.getTracks().forEach(track=>track.stop());await voice.stop();return;}
        rawMic=next;
        await call.setTrack('voice',output.getAudioTracks()[0],output);previous?.getTracks().forEach(t=>t.stop());
        if(!current())return;
        const actual=next.getAudioTracks()[0].getSettings();
        $('aecStatus').textContent='麦克风回声消除：'+(actual.echoCancellation?'已开启':'未确认开启')+'；降噪：'+(voice.mode==='rnnoise'?'RNNoise 神经网络':voice.mode==='browser'?'标准降噪':'关闭')+'。共享声音独立传输。';
        if(voice.fallback)toast('增强降噪初始化失败，已退回标准降噪；共享声音不受影响。');
        await enumerate();if(current())applyMute();
    }catch(error){
        next.getTracks().forEach(t=>t.stop());previous?.getTracks().forEach(t=>t.stop());
        if(rawMic===next||rawMic===previous)rawMic=null;
        await voice.stop();
        if(current())await call.setTrack('voice',null).catch(console.warn);
        throw error;
    }
}
async function toggleMic(){if(!joined)return joinDialog();if(!rawMic){micMuted=false;await acquireMic();}else{micMuted=!micMuted;applyMute();}}
for(const id of ['mic','miniMic'])$(id).onclick=()=>run(toggleMic,'microphone');
function toggleDeafen(){if(!joined)return;deafened=!deafened;applyMute();}
for(const id of ['deafen','miniDeafen'])$(id).onclick=toggleDeafen;
async function stopShare(reason = 'stopped') {
    await native?.remote?.shareEnded();
    if (typeof remoteSession !== 'undefined') await remoteSession.stop('share-stopped');
    const old = display;
    display = null;
    currentSource = null;
    localShareId = null;
    shareLog.end(null, reason);
    syncShareLogControls();
    await call.setTrack('screen', null);
    await call.setTrack('sound', null);
    old?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    $('localVideo').srcObject = null;
    $('captureStats').textContent = '尚未共享';
    $('audioStatus').textContent = '共享声音与语音独立处理；不会因说话自动压低媒体音量。';
    syncControls();
    publish();
}
async function capture(source,withAudio){
    if(!native)throw new Error('整屏与窗口防回音需要独立桌面客户端，请双击新版 Start-Friends.cmd。');
    const build=Number((desktopInfo?.windows||'').split('.')[2]);if(build&&build<20348)throw new Error('此防回音采集方式需要 Windows 11。');
    await native.selectSource(source.id,withAudio);
    const options=FriendsMedia.displayConstraints(quality());if(!withAudio)options.audio=false;
    const next=await navigator.mediaDevices.getDisplayMedia(options),audio=next.getAudioTracks()[0],video=next.getVideoTracks()[0];
    try{
        if(withAudio&&!audio)throw new Error('未能获取系统声音，请重新选择共享内容。');
        if(audio){
            // Own-audio exclusion is chosen when the loopback device is opened.
            // Chromium reports it in settings but cannot reapply it as an exact
            // runtime constraint. Reject an unconfirmed initial device instead.
            if(audio.getSettings().restrictOwnAudio!==true)throw new Error('音频引擎未确认排除客户端声音，本次共享已取消以避免回音。');
            audio.enabled=soundEnabled;
        }
        const old=display;display=next;currentSource=source;
        await call.setTrack('screen',video,new MediaStream([video]));await call.setTrack('sound',audio||null,audio?new MediaStream([audio]):null);await call.updateQuality(quality());
        old?.getTracks().forEach(t=>{t.onended=null;t.stop();});
        $('localVideo').srcObject=new MediaStream([video]);video.onended=()=>run(()=>stopShare('source-ended'));
        localShareId = shareLog.startLocal(shareCapture(), quality());
        syncShareLogControls();
        $('audioStatus').textContent=audio?'防回音已开启：共享声音排除了本客户端；媒体音量不随说话改变。':'当前只共享画面，可用底部声音按钮开启共享声音。';syncControls();publish();
    }catch(error){next.getTracks().forEach(t=>t.stop());throw error;}
}
function renderSources(){
    $('sources').replaceChildren();for(const source of sourceList.filter(s=>s.type===sourceType)){
        const button=document.createElement('button');button.className='source-card'+(source.id===selectedSource?.id?' selected':'');
        const img=document.createElement('img');img.src=source.thumbnail;img.alt='';const title=document.createElement('span');title.textContent=source.name;
        button.append(img,title);button.onclick=()=>{selectedSource=source;$('startShare').disabled=false;renderSources();};$('sources').append(button);
    }
    if(!$('sources').children.length){const text=document.createElement('p');text.className='muted';text.textContent='没有可用的共享来源';$('sources').append(text);}
}
async function openShare(){if(!joined)return joinDialog();if(!native)throw new Error('请在独立桌面版中共享。浏览器预览不能保证整屏声音防回音。');selectedSource=null;$('startShare').disabled=true;$('shareDialog').showModal();sourceList=await native.sources();renderSources();}
$('share').onclick=()=>run(()=>display?stopShare():openShare(),'screen');$('changeShare').onclick=()=>run(openShare,'screen');$('localStop').onclick=()=>run(stopShare,'screen');
for(const button of document.querySelectorAll('[data-type]'))button.onclick=()=>{sourceType=button.dataset.type;for(const tab of document.querySelectorAll('[data-type]'))tab.classList.toggle('selected',tab===button);renderSources();};
$('startShare').onclick=()=>run(async()=>{if(!selectedSource)return;const source=selectedSource;soundEnabled=$('shareAudioDefault').checked;settings.shareAudioDefault=soundEnabled;save();$('shareDialog').close();await capture(source,soundEnabled);},'screen');
$('shareSound').onclick=()=>run(async()=>{
    const previous=soundEnabled;soundEnabled=!soundEnabled;
    try{
        if(display){const track=display.getAudioTracks()[0];if(track)track.enabled=soundEnabled;else if(soundEnabled&&currentSource)await capture(currentSource,true);}
        else{settings.shareAudioDefault=soundEnabled;$('shareAudioDefault').checked=soundEnabled;save();toast(soundEnabled?'下次共享将带声音':'共享声音已静音');}
    }catch(error){soundEnabled=previous;syncControls();throw error;}
    syncControls();publish();
});
async function releaseMedia(){
    shareLog.endAll('room-left');
    localShareId = null;
    syncShareLogControls();
    await native?.remote?.shareEnded();
    const old=display;display=null;currentSource=null;old?.getTracks().forEach(t=>{t.onended=null;t.stop();});
    rawMic?.getTracks().forEach(t=>t.stop());rawMic=null;await voice.stop();await mixer.stop();
    micMuted=true;deafened=false;pttPressed=false;$('localVideo').srcObject=null;
    for(const kind of FriendsMedia.KINDS){call.tracks[kind]=null;call.streams[kind]=null;}
    syncControls();
}
async function leaveRoom(){await stopShare();await call.setTrack('voice',null);call.leave();await mediaCleanup;}
$('leave').onclick=()=>run(leaveRoom);
async function invite(){await roomBoot;const room=$('room').value.trim();const text=FriendsRooms.inviteUrl(room);if(native)await native.clipboard(text);else await navigator.clipboard.writeText(text);toast('已复制邀请链接。发给朋友打开，就会带入同一个房间号。');}
for(const id of ['invite','headerInvite','emptyInvite'])$(id).onclick=()=>run(invite);
function openSettings(tab='audio'){$('settingsDialog').showModal();settingsTab(tab);run(enumerate);}
for(const id of ['settingsOpen','headerSettings'])$(id).onclick=()=>openSettings();
function settingsTab(tab){for(const section of document.querySelectorAll('[data-settings]'))section.hidden=section.dataset.settings!==tab;for(const button of document.querySelectorAll('[data-tab]'))button.classList.toggle('selected',button.dataset.tab===tab);}
for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>settingsTab(button.dataset.tab);
$('micGain').oninput=()=>{settings.micGain=Number($('micGain').value);$('micGainValue').textContent=settings.micGain+'%';voice.setGain(settings.micGain);save();};
$('master').oninput=()=>{settings.master=Number($('master').value);$('masterValue').textContent=settings.master+'%';mixer.masterVolume(settings.master);save();};
for(const id of ['noiseMode','aec','autoGain','input'])$(id).onchange=()=>run(async()=>{settings[id]=$(id).type==='checkbox'?$(id).checked:$(id).value;save();if(rawMic)await acquireMic();});
$('output').onchange=()=>run(async()=>{settings.output=$('output').value;save();await configureOutput();});
$('inputMode').onchange=()=>{settings.inputMode=$('inputMode').value;pttPressed=false;save();applyMute();};
for(const id of ['quality','bitrate','mode','codec','adaptive'])$(id).onchange=()=>run(async()=>{if(id==='quality')$('bitrate').value=$('quality').value.split(',')[3];for(const key of ['quality','bitrate','mode','codec'])settings[key]=$(key).value;settings.adaptive=$('adaptive').checked;save();await call.updateQuality(quality());});
function volumeControl(label, peer, kind) {
    const holder = document.createElement('div');
    holder.className = 'volume-control';
    const caption = document.createElement('div');
    caption.className = 'volume-caption';
    const title = document.createElement('span');
    title.textContent = label;
    const mute = document.createElement('button');
    mute.className = 'volume-mute';
    caption.append(title, mute);
    const line = document.createElement('div');
    line.className = 'slider-line';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = kind === 'voice' ? '300' : '100';
    range.setAttribute('aria-label', label);
    const value = document.createElement('output');
    function refresh() {
        const saved = peerVolumes.get(peer, kind);
        range.value = saved.volume;
        value.textContent = saved.muted ? '静音' : saved.volume + '%';
        mute.textContent = saved.muted ? '取消静音' : '静音';
        mute.setAttribute('aria-label', (saved.muted ? '取消静音' : '静音') + label);
        mute.setAttribute('aria-pressed', String(saved.muted));
        mute.classList.toggle('muted-button', saved.muted);
        mixer.volume(peer + ':' + kind, saved.muted ? 0 : saved.volume);
    }
    range.oninput = () => {
        peerVolumes.set(peer, kind, { volume: Number(range.value), muted: false });
        refresh();
    };
    mute.onclick = () => {
        const saved = peerVolumes.get(peer, kind);
        peerVolumes.set(peer, kind, { ...saved, muted: !saved.muted });
        refresh();
    };
    if (!volumeWidgets.has(peer)) volumeWidgets.set(peer, []);
    volumeWidgets.get(peer).push(refresh);
    line.append(range, value);
    holder.append(caption, line);
    refresh();
    return holder;
}
function refreshPeerVolumes(peer) {
    peerVolumes.bind(peer, call.peers.get(peer)?.identity);
    for (const refresh of volumeWidgets.get(peer) || []) refresh();
}
function peerCard({id,name}){
    if(cards.has(id))return cards.get(id);$('emptyPeer').hidden=true;
    const card=document.createElement('article');card.className='media-card';const area=document.createElement('div');area.className='video-area';
    const video=document.createElement('video');video.autoplay=true;video.muted=true;video.playsInline=true;
    const placeholder=document.createElement('div');placeholder.className='avatar-placeholder';placeholder.append(makeAvatar(name,false,id));const title=document.createElement('p');title.textContent=name;placeholder.append(title);
    const live=document.createElement('span');live.className='live-tag';live.textContent='LIVE';live.hidden=true;
    const fullscreen=document.createElement('button');fullscreen.className='tile-action';fullscreen.title='全屏 / Esc 退出';fullscreen.setAttribute('aria-label','全屏查看对方共享');fullscreen.innerHTML=icon('fullscreen');fullscreen.onclick=()=>run(()=>toggleFullscreen(area));
    const mini = document.createElement('button');mini.className='tile-mini';mini.textContent='小窗';mini.setAttribute('aria-label','小窗查看 '+name);mini.onclick=()=>run(()=>enterMini(id));
    area.append(video,placeholder,live,fullscreen,mini);
    const caption=document.createElement('div');caption.className='media-caption';const username=document.createElement('strong');username.textContent=name;const status=document.createElement('span');status.textContent='语音已加入';caption.append(makeAvatar(name,true,id),username,status);
    if(typeof bindFileTarget==='function'){bindFileTarget(card,id,name);const send=document.createElement('button');send.className='send-file';send.textContent='发送文件';send.onclick=()=>pickPeerFiles(id);caption.append(send);}
    const controls=document.createElement('div');controls.className='tile-mixer';controls.append(volumeControl('对方说话音量',id,'voice'),volumeControl('对方共享声音',id,'sound'));
    card.append(area,caption,controls);$('screens').append(card);const item={card,video,placeholder,live,status};cards.set(id,item);
    video.ondblclick=()=>run(()=>toggleFullscreen(area));return item;
}
async function enterMini(peer) {
    if (!native?.mini) throw new Error('请使用 2.5 桌面版的小窗功能');
    if (!cards.has(peer)) return;
    if (fullscreenArea) await exitFullscreen();
    await native.mini(true);
    miniPeer = peer;
    for (const [id, item] of cards) item.card.classList.toggle('mini-target', id === peer);
    document.body.classList.add('mini-mode');
    $('miniReturn').hidden = false;
}
function restoreMiniView() {
    miniPeer = null;
    document.body.classList.remove('mini-mode');
    for (const item of cards.values()) item.card.classList.remove('mini-target');
    $('miniReturn').hidden = true;
}
$('miniReturn').onclick = () => run(async () => { await native.mini(false); restoreMiniView(); });
native?.onMini?.(enabled => { if (!enabled) restoreMiniView(); });
async function exitFullscreen(){const active=fullscreenArea;fullscreenArea=null;active?.classList.remove('fullscreen-media');if(document.fullscreenElement)await document.exitFullscreen();if(native?.fullscreen)await native.fullscreen(false);}
async function toggleFullscreen(area){
    if (miniPeer !== null) { await native.mini(false); restoreMiniView(); }
    if(fullscreenArea===area)return exitFullscreen();fullscreenArea?.classList.remove('fullscreen-media');fullscreenArea=area;area.classList.add('fullscreen-media');
    try{if(native?.fullscreen)await native.fullscreen(true);else await area.requestFullscreen();}
    catch(error){area.classList.remove('fullscreen-media');fullscreenArea=null;throw error;}
}
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&!native){fullscreenArea?.classList.remove('fullscreen-media');fullscreenArea=null;}});
native?.onFullscreen?.(value=>{if(!value){fullscreenArea?.classList.remove('fullscreen-media');fullscreenArea=null;}});
call.addEventListener('peer',event=>{peerVolumes.bind(event.detail.id,call.peers.get(event.detail.id)?.identity);peerCard(event.detail);renderMembers();});
call.addEventListener('compatibility', event => refreshPeerVolumes(event.detail.id));
call.addEventListener('track',event=>{const {id,kind,stream}=event.detail,item=peerCard(event.detail);if(kind==='screen'){item.video.srcObject=stream;item.video.play().catch(()=>{});}else run(async()=>{await mixer.attach(id+':'+kind,stream);refreshPeerVolumes(id);});});
call.addEventListener('peerleft',event=>{const id=event.detail.id;if(miniPeer===id)run(async()=>{await native.mini(false);restoreMiniView();});peerVolumes.forget(id);volumeWidgets.delete(id);});
call.addEventListener('peerleft',event=>{const id=event.detail.id;if(fullscreenArea&&cards.get(id)?.card.contains(fullscreenArea))run(exitFullscreen);cards.get(id)?.card.remove();cards.delete(id);peerState.delete(id);mixer.remove(id+':voice');mixer.remove(id+':sound');$('emptyPeer').hidden=!!cards.size;renderMembers();});
call.addEventListener('dataready',publish);
call.addEventListener('data', ({ detail: { id, data } }) => {
    if (data.type !== 'state' || !call.peers.has(id)) return;
    shareLog.remoteState(id, data);
    syncShareLogControls();
});
call.addEventListener('peer', ({ detail }) => shareLog.connection(detail.id, 'joined'));
call.addEventListener('connection', ({ detail }) => shareLog.connection(detail.id, detail.state));
call.addEventListener('connection', ({ detail }) => diagnostic('peer','state',null,{attempt:roomAttempt,state:detail.state}));
call.addEventListener('peerleft', ({ detail }) => {
    lastVoiceSample.delete(detail.id);
    diagnostic('peer','left',null,{attempt:roomAttempt});
    if(joined&&!call.peers.size){
        $('connectionLabel').textContent='等待朋友加入';
        document.querySelector('.connection-panel').classList.remove('connected');
    }
    shareLog.connection(detail.id, 'left');
    shareLog.end(detail.id, 'peer-left');
    syncShareLogControls();
});
call.addEventListener('signal', ({ detail }) => { void shareLog.event('signal', { state: detail.state }); });
call.addEventListener('data',event=>{const {id,name,data}=event.detail;if(data.type==='state'){peerState.set(id,{mic:!!data.mic,deafened:!!data.deafened,speaking:!!data.speaking,screen:!!data.screen,sound:!!data.sound});const item=cards.get(id);if(item){item.card.classList.toggle('speaking',!!data.speaking);item.placeholder.hidden=!!data.screen;item.live.hidden=!data.screen;item.status.textContent=data.screen?(data.sound?'画面与声音':'画面 · 声音静音'):data.mic?'麦克风已开':'麦克风静音';}renderMembers();}else if(data.type==='chat'&&typeof data.text==='string')appendMessage(name,data.text.slice(0,2000),data.time);});
function appendMessage(name,text,time=Date.now()){const message=document.createElement('article');message.className='message';const title=document.createElement('span');title.className='message-author';title.textContent=name;const when=document.createElement('time');const date=new Date(time);when.textContent=Number.isNaN(date.getTime())?'':date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});const body=document.createElement('p');body.textContent=text;message.append(title,when,body);$('messages').append(message);$('messages').scrollTop=$('messages').scrollHeight;}
$('chatForm').onsubmit=event=>{event.preventDefault();const text=$('chatInput').value.trim();if(!text)return;if(!call.sendData({type:'chat',text,time:Date.now()}))return toast('朋友尚未连上，消息没有发送。');appendMessage(call.name,text);$('chatInput').value='';};
for(const id of ['chatToggle','chatChannel'])$(id).onclick=()=>{document.querySelector('.shell').classList.remove('no-right');$('chatInput').focus();};
$('membersToggle').onclick=()=>document.querySelector('.shell').classList.toggle('no-right');$('voiceChannel').onclick=()=>{if(!joined)run(quickJoin);else document.querySelector('.main-call').classList.remove('focus-screen');};
$('connectionDetails').onclick=()=>{$('statsPanel').hidden=!$('statsPanel').hidden;if(!$('statsPanel').hidden)$('statsPanel').scrollIntoView({behavior:'smooth',block:'nearest'});};
$('diagnosticsOpen').onclick=()=>{location.href='/native-test.html';};
native?.onShortcut(action=>{if(action==='mic')run(toggleMic);else if(action==='deafen')toggleDeafen();});
native?.onInvite?.(room=>run(async()=>{if(!FriendsRooms.valid(room))return;await roomBoot;$('room').value=room;if(joined&&call.room!==room)joinDialog(true);else await quickJoin('invite');},'room'));
roomBoot.then(()=>{if(query.get('invite')==='1')run(quickJoin);}).catch(error=>toast(error.message));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&fullscreenArea){event.preventDefault();run(exitFullscreen);}if(event.code==='Space'&&settings.inputMode==='ptt'&&joined&&!/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)&&!document.querySelector('dialog[open]')){event.preventDefault();if(!pttPressed){pttPressed=true;applyMute();}}});
document.addEventListener('keyup',event=>{if(event.code==='Space'&&pttPressed){pttPressed=false;applyMute();}});window.addEventListener('blur',()=>{if(pttPressed){pttPressed=false;applyMute();}});
let wasSpeaking=false;setInterval(()=>{const level=voice.level();$('inputLevel').style.width=Math.min(100,level*350)+'%';const speaking=!!rawMic&&!effectiveMuted()&&level>.012;document.querySelector('.local-card').classList.toggle('speaking',speaking);if(speaking!==wasSpeaking){wasSpeaking=speaking;publish(speaking);}},120);
const fmt=(value,digits=0)=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(digits):'—';
function recordVoiceQuality(peers) {
    if (!joined || !native?.diagnostics) return;
    const now = Date.now();
    for (const peer of peers) {
        if (peer.state !== 'connected' || !call.peers.has(peer.id)) continue;
        const incoming = peer.media.find(media => media.kind === 'voice' && media.direction === 'receive');
        const outgoing = peer.media.find(media => media.kind === 'voice' && media.direction === 'send');
        if (!incoming && !outgoing) continue;
        const voice = {
            path: peer.path, rttMs: peer.rttMs, jitterMs: incoming?.jitterMs,
            jitterBufferMs: incoming?.jitterBufferMs, receiveLossPct: incoming?.loss,
            concealedSamples: incoming?.concealedSamples,
            sendLossPct: outgoing?.remoteLossFresh ? outgoing.remoteLoss : undefined,
        };
        const impaired = voice.rttMs >= 200 || voice.jitterBufferMs >= 150 ||
            voice.receiveLossPct >= 3 || voice.sendLossPct >= 3;
        if (now - (lastVoiceSample.get(peer.id) ?? 0) < (impaired ? 4000 : 15000)) continue;
        lastVoiceSample.set(peer.id, now);
        diagnostic('peer','quality',null,{attempt:roomAttempt,voice});
    }
}
setInterval(async()=>{
    if(statsBusy)return;statsBusy=true;
    try{
        const captureSettings=display?.getVideoTracks()[0]?.getSettings();if(captureSettings)$('captureStats').textContent=captureSettings.width+'×'+captureSettings.height+' · '+fmt(captureSettings.frameRate)+' fps 采集';
        const peers=await call.stats();recentStats=peers;$('stats').replaceChildren();
        recordVoiceQuality(peers);
        await call.adaptVideo(peers);
        if (shareLog.active.size) {
            const fileTransfers = typeof transfers === 'undefined' ? 0 : [...transfers.items.values()].filter(t => t.status === 'transferring').length;
            void shareLog.sample(peers, {
                roomMembers: call.peers.size + 1, activeShares: shareLog.active.size, fileTransfers,
                signal: call.socket?.connected ? 'connected' : 'disconnected', capture: shareCapture(), quality: quality(),
            });
        }
        const currentPeers=peers.filter(p=>call.peers.has(p.id));
        const connected=currentPeers.filter(p=>p.state==='connected'),relays=connected.filter(p=>p.path==='TURN 中继').length;
        if(joined){
            $('connectionLabel').textContent=connected.length
                ? '已连接 '+connected.length+'/'+currentPeers.length+' 位 · '+(relays?relays+' 路中继':'全部直连')
                : currentPeers.length ? '正在连接朋友' : '等待朋友加入';
            document.querySelector('.connection-panel').classList.toggle('connected',connected.length>0);
        }
        for(const peer of peers){const box=document.createElement('div');box.className='stat-peer';const title=document.createElement('strong');title.textContent=peer.name+' · '+peer.path+' / '+peer.protocol.toUpperCase()+' · RTT '+fmt(peer.rttMs)+' ms';box.append(title);
            if(display){const line=document.createElement('div');line.className='stat-line';
                line.textContent='本端估计上行 '+fmt(peer.availableMbps,2)+' Mbps'
                    +(peer.videoTargetFps?' · 视频目标 '+peer.videoTargetWidth+'×'+peer.videoTargetHeight+' / '+peer.videoTargetFps+' 帧 · 视频上限 '+fmt(peer.videoCeilingMbps,2)+' Mbps':'');
                box.append(line);
            }
            for(const media of peer.media){if(media.kind!=='screen'&&media.direction!=='receive')continue;const line=document.createElement('div');line.className='stat-line';line.textContent=media.kind==='screen'?(media.direction==='send'?'发出 ':'收到 ')+(media.width||'—')+'×'+(media.height||'—')+' · '+fmt(media.fps,1)+' fps · '+fmt(media.bitrate===null?null:media.bitrate/1e6,2)+' Mbps · '+(media.codec||'')+' · '+(media.limitation==='cpu'?'编码负载限制':media.limitation==='bandwidth'?'网络带宽限制':''):(media.kind==='voice'?'语音 ':'共享声音 ')+fmt(media.bitrate===null?null:media.bitrate/1000)+' kbps';box.append(line);}
            $('stats').append(box);
        }
        for(const peer of peers){const rx=peer.media.find(m=>m.kind==='screen'&&m.direction==='receive');const card=cards.get(peer.id);if(card&&rx?.width&&rx.fps)card.status.textContent=rx.width+'×'+rx.height+' · '+fmt(rx.fps)+' fps · '+fmt(rx.bitrate/1e6,1)+' Mbps';}
        const constrained=display&&peers.some(p=>p.videoTargetFps&&Number.isFinite(p.availableMbps)&&p.availableMbps<1);
        $('advice').textContent=constrained?'这一路可用上行偏低，正在降低视频发送目标，给语音和共享声音留出空间。':peers.some(p=>p.path==='TURN 中继')?'当前媒体经过公共中继，其路径和带宽可能限制画质。':'静止画面低帧率可能正常，请在游戏或视频运动时查看实际帧率。';
    }catch(error){console.warn(error);}finally{statsBusy=false;}
},2000);
if(native)native.info().then(info=>{desktopInfo=info;$('nativeBadge').textContent='Windows 桌面版 · '+info.version;$('engineInfo').textContent='Electron '+info.electron+' · Chromium '+info.chrome+' · Windows '+info.windows;});
else{$('nativeBadge').textContent='网页预览 · 防回音共享请用桌面版';$('engineInfo').textContent='当前为浏览器预览。完整的系统声音排除需要桌面版。';}
$('copyVideoDiagnostic').onclick=()=>run(async()=>{
    const captureSettings=display?.getVideoTracks()[0]?.getSettings();
    const report={version:desktopInfo?.version||'2.6.5',quality:quality(),capture:captureSettings?{width:captureSettings.width,height:captureSettings.height,requestedFps:captureSettings.frameRate,surface:captureSettings.displaySurface}:null,peers:recentStats.map(p=>({path:p.path,protocol:p.protocol,rttMs:p.rttMs,availableMbps:p.availableMbps,videoCeilingMbps:p.videoCeilingMbps,videoTargetWidth:p.videoTargetWidth,videoTargetHeight:p.videoTargetHeight,videoTargetFps:p.videoTargetFps,audioReserveKbps:p.audioReserveKbps,videoBudgetReason:p.videoBudgetReason,media:p.media})),engine:desktopInfo?{electron:desktopInfo.electron,chrome:desktopInfo.chrome,gpu:desktopInfo.gpu}:null};
    const text=JSON.stringify(report,null,2);if(native)await native.clipboard(text);else await navigator.clipboard.writeText(text);toast('视频诊断已复制（不含房间号、昵称或 IP 地址）。');
});
$('openShareLogs').onclick = () => run(() => native.shareLogs.open());
$('markShareStall').onclick = () => run(async () => {
    if (await shareLog.event('mark')) toast('已在共享日志中标记卡顿。');
});
window.addEventListener('pagehide',()=>{display?.getTracks().forEach(t=>t.stop());rawMic?.getTracks().forEach(t=>t.stop());call.leave();voice.stop();mixer.stop();});
syncShareLogControls();
syncControls();
if (changedVideoPreset) toast('已启用 1080p60 流畅预设，可在设置中选择其他画质。');
