'use strict';
let phoneController=null;
let phoneTone=null;
let phoneToneTimer=null;
let alertedPhoneCall=null;
let phoneMicSocket=null;
let lastPhonePhase='idle';

function stopPhoneTone() {
    clearInterval(phoneToneTimer);phoneToneTimer=null;
    const context=phoneTone;phoneTone=null;
    if(context)void context.close().catch(()=>{});
}
async function startPhoneTone(incoming) {
    if(phoneTone)return;
    const context=phoneTone=new AudioContext();
    try {await context.resume();}catch{}
    if(phoneTone!==context||context.state==='closed')return;
    function pulse() {
        if(context.state==='closed')return;
        const oscillator=context.createOscillator(),gain=context.createGain();
        oscillator.frequency.value=incoming?660:440;
        oscillator.type='sine';gain.gain.setValueAtTime(0,context.currentTime);
        gain.gain.linearRampToValueAtTime(.045,context.currentTime+.02);
        gain.gain.setValueAtTime(.045,context.currentTime+.25);
        gain.gain.linearRampToValueAtTime(0,context.currentTime+.3);
        oscillator.connect(gain).connect(context.destination);oscillator.start();oscillator.stop(context.currentTime+.32);
    }
    pulse();phoneToneTimer=setInterval(pulse,incoming?1600:2400);
}
function renderPhone() {
    const phone=phoneController;
    $('phoneStatus').textContent=!phone?'正在准备呼叫…':phone.connected?'待机已连接':'呼叫信令重连中';
    $('phoneContacts').replaceChildren();
    $('phoneAdd').disabled=!phone;$('phoneCopy').disabled=!phone;
    if(!phone)return;
    if(!phone.contacts.size){const hint=document.createElement('p');hint.className='phone-hint';hint.textContent='添加朋友的好友码，以后点名字旁的呼叫即可。';$('phoneContacts').append(hint);}
    for(const contact of phone.contacts.values()) {
        const row=document.createElement('div');row.className='phone-contact';
        const label=document.createElement('div');const title=document.createElement('strong');title.textContent=contact.name;
        const status=document.createElement('small');status.textContent=phone.online(contact.id)?'在线':'离线';label.append(title,status);
        const dial=document.createElement('button');dial.textContent='呼叫';dial.title='呼叫 '+contact.name;
        dial.disabled=!phone.online(contact.id)||!!phone.pending;
        dial.onclick=()=>run(()=>phone.dial(contact.id));
        const remove=document.createElement('button');remove.textContent='×';remove.title='移除 '+contact.name;remove.className='phone-remove';
        remove.disabled=!!phone.pending;remove.onclick=()=>run(()=>phone.remove(contact.id));
        row.append(label,dial,remove);$('phoneContacts').append(row);
    }
    const pending=phone.pending;
    const phase=pending?.phase||'idle';
    if(phase!==lastPhonePhase){lastPhonePhase=phase;diagnostic('phone','state',null,{state:phase});}
    if(!pending) {
        if($('phoneCallDialog').open)$('phoneCallDialog').close();
        stopPhoneTone();
        if(alertedPhoneCall){void native?.callAlert?.(false,'');alertedPhoneCall=null;}
        return;
    }
    const incoming=pending.phase==='incoming';
    $('phoneCallTitle').textContent=incoming?pending.friend.name+' 正在呼叫你':pending.phase==='outgoing'?'正在呼叫 '+pending.friend.name:'正在连接通话…';
    $('phoneCallText').textContent=incoming?(pending.unknown?'这是新联系人。添加并接听后，对方会保存在你的联系人中。':'接听后自动进入同一个房间并开启语音。'):pending.phase==='outgoing'?'等待对方接听…':'正在加入房间，请稍候。';
    $('phoneAccept').hidden=!incoming;$('phoneAccept').textContent=pending.unknown?'添加并接听':'接听';
    $('phoneCancel').textContent=incoming?'拒绝':'取消';
    if(!$('phoneCallDialog').open)$('phoneCallDialog').showModal();
    if(incoming||pending.phase==='outgoing')void startPhoneTone(incoming);else stopPhoneTone();
    if(incoming&&alertedPhoneCall!==pending.id){alertedPhoneCall=pending.id;void native?.callAlert?.(true,pending.friend.name);}
}

async function joinPhoneRoom(room,signal) {
    if(signal.aborted)throw new Error('呼叫已取消');
    if(joined){if(call.room===room)return;throw new Error('正在其他房间通话');}
    if(call.socket)throw new Error('正在连接房间，请稍后再试');
    await mediaCleanup;await roomBoot;
    if(signal.aborted)throw new Error('呼叫已取消');
    const cleanup=()=>{
        if(call.room!==room||!call.socket)return;
        if(phoneMicSocket===call.socket)phoneMicSocket=null;
        void leaveRoom().catch(error=>console.warn(error));
    };
    signal.addEventListener('abort',cleanup,{once:true});
    try {
        $('room').value=room;
        const pin=$('pinRoom').checked;$('pinRoom').checked=false;
        try {await joinRoom('contact-call');}finally{$('pinRoom').checked=pin;}
        await new Promise((resolve,reject)=>{
            const started=Date.now();
            const timer=setInterval(()=>{
                if(signal.aborted){clearInterval(timer);reject(new Error('呼叫已取消'));}
                else if(joined&&call.room===room){clearInterval(timer);resolve();}
                else if(roomJoinFailure||!call.socket){clearInterval(timer);reject(new Error(roomJoinFailure||'已退出房间，请重试。'));}
                else if(Date.now()-started>20000){clearInterval(timer);reject(new Error('连接房间超时'));}
            },50);
        });
        if(signal.aborted)throw new Error('呼叫已取消');
        if(!rawMic)phoneMicSocket=call.socket;
    } catch(error) {
        signal.removeEventListener('abort',cleanup);
        if(call.room===room&&call.socket)await leaveRoom();
        throw error;
    }
}

function phoneConnected(){
    const socket=phoneMicSocket;
    phoneMicSocket=null;
    toast('通话已接通，可以开始共享屏幕。');
    if(!socket||call.socket!==socket||!joined||rawMic)return;
    micMuted=false;
    void acquireMic(socket).catch(error=>{
        if(call.socket!==socket||!joined)return;
        console.warn('Phone microphone unavailable',error);
        micMuted=true;
        applyMute();
        const detail=error.name==='NotAllowedError'?'麦克风权限未开启。':'麦克风暂时不可用。';
        toast('已加入房间。'+detail+'请检查权限和输入设备，再点开麦。',true);
    });
}

$('phoneAdd').onclick=()=>{$('contactCode').value='';$('contactAlias').value='';$('phoneAddDialog').showModal();};
$('contactForm').onsubmit=event=>{event.preventDefault();run(async()=>{await phoneController.add($('contactCode').value,$('contactAlias').value);$('phoneAddDialog').close();toast('联系人已保存。在线时可以呼叫，对方首次接听会把你添加为联系人。');});};
$('phoneCopy').onclick=()=>run(async()=>{await native.clipboard(phoneController.code());toast('好友码已复制，发给朋友添加一次即可。');});
$('phoneAccept').onclick=()=>run(()=>phoneController.accept());
$('phoneCancel').onclick=()=>run(()=>phoneController.cancel());
$('phoneCallDialog').addEventListener('cancel',event=>{event.preventDefault();run(()=>phoneController.cancel());});
window.addEventListener('pagehide',()=>{stopPhoneTone();phoneController?.stop();});

async function startPhone() {
    try {
        phoneController=await FriendsPhone.Phone.create({storage:localStorage,identity:call.uuid,socketFactory:window.io,
            getName:()=>$('name').value||'同学',context:()=>({room:joined?call.room:null,members:joined?call.peers.size+1:1}),join:joinPhoneRoom});
        phoneController.addEventListener('state',renderPhone);
        phoneController.addEventListener('notice',event=>reportError('phone',event.detail.message));
        phoneController.addEventListener('connected',phoneConnected);
        if(!restartForUpdate)phoneController.start();
        renderPhone();
    } catch(error){$('phoneStatus').textContent='呼叫初始化失败';reportError('phone',error);}
}
if(native&&location.pathname==='/')void startPhone();
else { $('phoneStatus').textContent='呼叫功能请使用桌面版';$('phoneAdd').disabled=true;$('phoneCopy').disabled=true; }
