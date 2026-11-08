'use strict';
const fileIO=native?.files,transferRows=new Map();
function transferRate(peer){
    const sends=Math.max(1,[...transfers.items.values()].filter(t=>t.direction==='send'&&t.status==='transferring').length);
    if($('fileSpeed').value==='fast')return 4*1024*1024/sends;
    const sharing=!!display||[...peerState.values()].some(p=>p.screen);
    let rate=sharing?128*1024:2*1024*1024;
    rate/=sends;const p=recentStats.find(p=>p.id===peer&&p.state==='connected');
    if(p?.availableMbps){const media=p.media.filter(m=>m.direction==='send').reduce((n,m)=>n+(m.bitrate||0),0);rate=Math.min(rate,Math.max(32*1024,(p.availableMbps*1e6-media)*.3/8));}
    return rate;
}
const transfers=new FriendsFiles.Transfers(call,fileIO,{rate:transferRate});
function fileSize(n){if(n<1024)return n+' B';const u=['KB','MB','GB','TB'];let i=-1;do{n/=1024;i++;}while(n>=1024&&i<3);return n.toFixed(n>=100?0:1)+' '+u[i];}
function openTransfers(){document.querySelector('.shell').classList.remove('no-right');$('fileTransfers').hidden=false;$('fileTransfers').scrollIntoView({block:'nearest'});}
function bindFileTarget(el,peer,name,clickable=false){
    el.dataset.filePeer=peer;el.title='拖文件到这里，发送给 '+name;
    if(clickable){el.classList.add('file-avatar');el.tabIndex=0;el.setAttribute('role','button');el.setAttribute('aria-label','给 '+name+' 发送文件');el.onclick=e=>{e.stopPropagation();pickPeerFiles(peer);};el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();pickPeerFiles(peer);}};}
}
let filePickPeer=null;
function pickPeerFiles(peer){if(!fileIO)return toast('文件传输需要双方使用 2.2 桌面版');if(!call.peers.has(peer))return toast('朋友尚未连接');filePickPeer=peer;$('filePicker').click();}
async function sendPeerFiles(peer,files){
    if(!fileIO)throw new Error('文件传输需要双方使用 2.2 桌面版');
    if(!files.length)return;if(files.length>16)throw new Error('一次最多发送 16 个文件；文件夹请先压缩');
    const sources=[];try{for(const file of files)sources.push(await fileIO.add(file));transfers.send(peer,sources);openTransfers();}
    catch(e){await Promise.all(sources.map(s=>fileIO.sourceClose(s.token)));throw e;}
}
$('filePicker').onchange=e=>{const files=Array.from(e.target.files);e.target.value='';if(filePickPeer)run(()=>sendPeerFiles(filePickPeer,files));};
const hasFiles=e=>Array.from(e.dataTransfer?.types||[]).includes('Files');
function clearFileDrag(){document.querySelectorAll('.file-drag-over').forEach(el=>el.classList.remove('file-drag-over'));}
document.addEventListener('dragover',e=>{if(!hasFiles(e))return;e.preventDefault();const target=e.target.closest('[data-file-peer]');clearFileDrag();if(target&&call.peers.has(target.dataset.filePeer)){e.dataTransfer.dropEffect='copy';target.classList.add('file-drag-over');}else e.dataTransfer.dropEffect='none';});
document.addEventListener('dragleave',e=>{if(!e.relatedTarget)clearFileDrag();});
document.addEventListener('drop',e=>{if(!hasFiles(e))return;e.preventDefault();clearFileDrag();const target=e.target.closest('[data-file-peer]');if(!target)return toast('把文件拖到对方头像或共享卡片上即可发送');const files=Array.from(e.dataTransfer.files);run(()=>sendPeerFiles(target.dataset.filePeer,files));});
$('filesToggle').onclick=openTransfers;
$('clearTransfers').onclick=()=>{for(const t of [...transfers.items.values()])if(t.terminal)transfers.dismiss(t.id);};
const transferLabels={queued:'排队中',offering:'等待对方接收',waiting:'正在连接',offered:'等待你接收',choosing:'选择保存位置',transferring:'传输中',verifying:'正在校验文件',complete:'已完成 · 校验通过',cancelled:'已取消',failed:'传输失败'};
transfers.addEventListener('update',e=>{
    const t=e.detail;let row=transferRows.get(t.id);
    if(!row){const box=document.createElement('article');box.className='file-transfer';const name=document.createElement('strong'),info=document.createElement('span'),progress=document.createElement('progress'),actions=document.createElement('div');progress.max=100;box.append(name,info,progress,actions);row={box,name,info,progress,actions};transferRows.set(t.id,row);$('transferList').append(box);if(t.direction==='receive')openTransfers();}
    row.name.textContent=(t.direction==='send'?'↑ ':'↓ ')+t.name;row.name.title=t.name;
    const other=call.peers.get(t.peer)?.name||'朋友';
    row.info.textContent=(t.direction==='send'?'发给 ':'来自 ')+other+' · '+(t.error||transferLabels[t.status])+' · '+fileSize(t.bytes)+' / '+fileSize(t.size)+(t.status==='transferring'&&t.speed?' · '+fileSize(t.speed)+'/s':'');
    if(t.status==='failed'&&row.box.dataset.status!=='failed')diagnostic('file','error',t.error||'传输失败');
    row.progress.value=t.size?Math.min(100,t.bytes/t.size*100):t.status==='complete'?100:0;row.box.dataset.status=t.status;row.actions.replaceChildren();
    function action(label,fn,primary=false){const button=document.createElement('button');button.textContent=label;if(primary)button.className='primary';button.onclick=()=>run(fn);row.actions.append(button);}
    if(t.status==='offered')action('接收并另存为',()=>transfers.accept(t.id),true);
    if(!t.terminal)action(t.status==='offered'?'拒绝':'取消',()=>transfers.cancel(t.id));
    else if(t.receipt)action('打开所在文件夹',()=>fileIO.reveal(t.receipt));
    $('fileEmpty').hidden=transfers.items.size>0;$('transferCount').textContent=String([...transfers.items.values()].filter(t=>!t.terminal).length);
});
transfers.addEventListener('removed',e=>{transferRows.get(e.detail.id)?.box.remove();transferRows.delete(e.detail.id);$('fileEmpty').hidden=transfers.items.size>0;});
window.addEventListener('pagehide',()=>transfers.close());
