'use strict';
let updateState={state:'idle'};
let automaticCheckRunning=false;
let automaticInstallTimer=null;
let automaticInstallFailed='';
const autoUpdateEnabled=()=>localStorage.getItem('friendsAutoUpdate')!=='off';
const automaticReady=status=>status.state==='ready'&&status.automatic&&autoUpdateEnabled()&&status.version!==automaticInstallFailed;

function renderUpdate(status) {
    updateState=status;
    const busy=['checking','downloading','installing'].includes(status.state);
    const messages={idle:'启动后自动检查更新，也可以手动检查。',unconfigured:'设置更新地址后，启动时会自动检查。也可以直接选择轻量更新包。',
        checking:'正在检查更新…',latest:'已是最新版本',available:'发现新版本 '+status.version,
        downloading:'正在下载 '+Math.round((status.received||0)/(status.total||1)*100)+'%',
        ready:automaticReady(status)?status.version+' 已下载，空闲时自动安装并重启。':status.version+' 已准备好，安装后会重新打开同屏。',
        installing:'正在退出同屏并安装更新…',error:status.message||'检查更新失败，稍后可以重试。'};
    $('updateStatus').textContent=messages[status.state]||'';
    $('updateNotes').textContent=status.notes||'';
    $('updateCheck').disabled=busy;$('updateLocal').disabled=busy;$('updateSourceSave').disabled=busy;
    $('updateDownload').hidden=status.state!=='available';$('updateInstall').hidden=status.state!=='ready';
    $('updateBanner').hidden=!['available','ready'].includes(status.state);
    $('updateBannerText').textContent=automaticReady(status)?'更新已下载，空闲后自动安装':status.state==='ready'?'新版已准备好':'同屏 '+status.version+' 可以更新';
    $('updateBannerAction').textContent=status.state==='ready'?'安装并重启':'更新并重启';
    if(typeof status.source==='string')$('updateSource').value=status.source;
}
function safeToRestart() {
    return !restartForUpdate&&!roomJoinInProgress&&!joined&&!call.socket&&!display&&!rawMic&&!microphoneRequest&&
        !phoneController?.pending&&!document.querySelector('dialog[open]')&&
        ![...transfers.items.values()].some(transfer=>!transfer.terminal)&&
        !remoteSession.control&&!remoteSession.hosts.size&&!remoteSession.requests.size&&!remoteSession.requested&&!remoteSession.authorizing;
}
async function installPreparedUpdate(automatic=false) {
    if(updateState.state!=='ready'||restartForUpdate||(automatic&&(!automaticReady(updateState)||!safeToRestart())))return;
    const version=updateState.version;
    restartForUpdate=true;
    $('updateInstall').disabled=true;
    try {
        if(!automatic){
            await phoneController?.cancel();
            if(joined||call.socket)await leaveRoom();
        }
        phoneController?.stop();
        renderUpdate(await native.updates.install());
    }catch(error){
        if(automatic)automaticInstallFailed=version;
        restartForUpdate=false;
        $('updateInstall').disabled=false;
        phoneController?.start();
        renderUpdate(updateState);
        throw error;
    }
}
async function applyAvailableUpdate() {
    if(updateState.state==='available')renderUpdate(await native.updates.download());
    if(updateState.state==='ready')await installPreparedUpdate();
}
async function checkAutomaticUpdate() {
    if(automaticCheckRunning||restartForUpdate)return;
    automaticCheckRunning=true;
    try {
        const status=await native.updates.check();
        renderUpdate(status);
        if(status.state==='available'&&autoUpdateEnabled())renderUpdate(await native.updates.download(true));
    } finally { automaticCheckRunning=false; }
}
function scheduleAutomaticInstall() {
    if(!automaticReady(updateState)||!safeToRestart()){
        clearTimeout(automaticInstallTimer);
        automaticInstallTimer=null;
        return;
    }
    if(automaticInstallTimer!==null)return;
    toast('新版已下载，同屏将在几秒后重启。');
    automaticInstallTimer=setTimeout(()=>{
        automaticInstallTimer=null;
        void run(()=>installPreparedUpdate(true),'update');
    },4000);
}
$('updateBannerAction').onclick=()=>run(applyAvailableUpdate);
$('updateCheck').onclick=()=>run(async()=>renderUpdate(await native.updates.check()));
$('updateDownload').onclick=()=>run(applyAvailableUpdate);
$('updateLocal').onclick=()=>run(async()=>renderUpdate(await native.updates.local()));
$('updateSourceSave').onclick=()=>run(async()=>{renderUpdate(await native.updates.configure($('updateSource').value));if($('updateSource').value)renderUpdate(await native.updates.check());});
$('updateInstall').onclick=()=>run(()=>installPreparedUpdate());
if(native?.updates){
    $('updateAuto').checked=autoUpdateEnabled();
    $('updateAuto').onchange=()=>{
        localStorage.setItem('friendsAutoUpdate',$('updateAuto').checked?'on':'off');
        renderUpdate(updateState);
        if($('updateAuto').checked)void checkAutomaticUpdate().catch(()=>{});
    };
    native.updates.onStatus(renderUpdate);
    void native.updates.status().then(renderUpdate).catch(error=>renderUpdate({state:'error',message:error.message}));
    if(location.pathname==='/'){
        setTimeout(()=>void checkAutomaticUpdate().catch(()=>{}),1000);
        setInterval(()=>void checkAutomaticUpdate().catch(()=>{}),6*60*60*1000);
        setInterval(scheduleAutomaticInstall,1000);
    }
}else{$('updatePanel').hidden=true;}
