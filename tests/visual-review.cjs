'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const electron = require('electron');
const { app, BrowserWindow } = electron;
app.disableHardwareAcceleration();
app.getVersion = () => require('../package.json').version;
const reviewRoot = path.resolve(__dirname, '../.run/ui-review');
const directory = path.join(reviewRoot, process.argv.includes('--baseline') ? 'before' : 'review');
fs.mkdirSync(directory, { recursive: true });
const profile = fs.mkdtempSync(path.join(reviewRoot, 'visual-profile-'));
const setPath = app.setPath.bind(app);
app.setPath = (name, value) => setPath(name, ['userData', 'sessionData'].includes(name) ? profile : value);
const productionMain = path.resolve(__dirname, '../desktop/main.cjs');
process.argv.push('--test-ui');
const load = Module._load;
Module._load = function (name, parent, ...args) {
    const original = load.call(this, name, parent, ...args);
    if (name !== 'electron' || parent?.filename !== productionMain) return original;
    return { ...original, BrowserWindow: new Proxy(BrowserWindow, {
        construct(Target, [options]) {
            const win = new Target({ ...options, show: false });
            win.webContents.setBackgroundThrottling(false);
            const loadURL = win.loadURL.bind(win);
            win.loadURL = url => loadURL(url.replace(/\/ui-test.html(?:\?[^]*)?$/, '/'));
            return win;
        },
    }) };
};
require(productionMain);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
    await app.whenReady();
    let win;
    for (let i = 0; i < 100; i++) {
        win = BrowserWindow.getAllWindows()[0];
        if (win && !win.webContents.isLoading() &&
            await win.webContents.executeJavaScript("typeof roomBoot !== 'undefined' && typeof phoneController !== 'undefined'").catch(() => false)) break;
        await pause(100);
    }
    const evaluate = code => win.webContents.executeJavaScript(code);
    const checks=[];
    const check=async(name,code)=>{const pass=await evaluate(code);checks.push({name,pass:!!pass});if(!pass)throw new Error(name);};
    await evaluate("localStorage.setItem('friendsAutoUpdate','off')");
    await evaluate("roomBoot.then(() => { phoneController?.stop(); })");
    await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}');
    async function shot(name, width = 1450, height = 940) {
        win.setContentSize(width, height);
        await pause(250);
        fs.writeFileSync(path.join(directory, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    }
    await shot('01-idle');
    await check('Idle primary action and invitation are visible',"!$('joinOpen').hidden && $('emptyInvite').getBoundingClientRect().height>0");
    await evaluate("document.getElementById('settingsOpen').click()");
    await shot('02-settings');
    await check('All four settings destinations remain available',"document.querySelectorAll('.settings-nav [data-tab]').length===4");
    await evaluate("document.getElementById('settingsDialog').close()");
    if (process.argv.includes('--baseline')) { app.quit(); return; }
    await evaluate("openSettings('video')");await shot('03-video-settings');
    await evaluate("settingsTab('shortcuts')");await shot('04-shortcuts');
    await check('Switching settings resets scroll and exposes only the selected section',"[...document.querySelectorAll('[data-settings]')].filter(s=>!s.hidden).length===1 && !document.querySelector('[data-settings=shortcuts]').hidden && document.querySelector('.settings-content').scrollTop===0");
    await evaluate("settingsTab('about')");await shot('05-updates');
    await evaluate("$('settingsDialog').close();joinDialog(true)");await shot('06-join');
    await evaluate("$('roomDialog').close();$('phoneAdd').click()");await shot('07-add-contact');
    await check('Contact form retains code validation',"$('contactCode').required && $('phoneAddDialog').open");
    await evaluate("$('phoneAddDialog').close()");
    await evaluate(`
        call.stats=async()=>[...call.peers.values()].map(p=>({id:p.id,name:p.name,state:'connected',path:'P2P 直连',protocol:'udp',rttMs:32,media:[]}));call.sendData=()=>true;
        phoneController.connected=true;
        phoneController.contacts=new Map([['preview-lin',{id:'preview-lin',name:'小林'}],['preview-qing',{id:'preview-qing',name:'阿青'}],['preview-yuan',{id:'preview-yuan',name:'小远'}]]);
        phoneController.online=id=>id!=='preview-yuan';renderPhone();
        $('name').value='我';joined=true;syncControls();
        $('connectionLabel').textContent='语音已连接';document.querySelector('.connection-panel').classList.add('connected');
        $('welcomeTitle').textContent='好朋友，都在这里。';$('welcomeText').textContent='正在和小林一起看 · 语音与共享声音独立调节';
        window.previewCanvas=document.createElement('canvas');previewCanvas.width=1280;previewCanvas.height=720;
        const paint=previewCanvas.getContext('2d');
        paint.fillStyle='#dfe4e7';paint.fillRect(0,0,1280,720);paint.fillStyle='#f8f9f9';paint.fillRect(24,24,1232,672);
        paint.fillStyle='#232c35';paint.font='600 28px Segoe UI';paint.fillText('A place to build, together.',65,92);
        paint.fillStyle='#8d979f';paint.font='16px Segoe UI';paint.fillText('Project notes  /  Today',65,126);
        paint.fillStyle='#e9edef';paint.fillRect(65,164,1150,1);
        ['01   Collect the ideas','02   Make something useful','03   Share it with friends'].forEach((text,i)=>{paint.fillStyle='#c5ced1';paint.fillRect(65,205+i*135,34,34);paint.fillStyle='#36434b';paint.font='22px Segoe UI';paint.fillText(text,120,231+i*135);paint.fillStyle='#a4afb3';paint.font='15px Segoe UI';paint.fillText('A little progress, every day.',120,266+i*135);});
        paint.fillStyle='#354d47';paint.fillRect(884,203,330,394);paint.fillStyle='#8ca59a';paint.beginPath();paint.arc(1050,398,100,0,Math.PI*2);paint.fill();paint.fillStyle='#d6ded5';paint.font='italic 36px Georgia';paint.fillText('Less, but better.',924,550);
        window.previewStream=previewCanvas.captureStream(30);
        call.peers.set('preview-lin',{id:'preview-lin',name:'小林',identity:'preview-lin',controlProtocol:2,pc:{close(){}}});call.emit('peer',{id:'preview-lin',name:'小林'});
        call.emit('track',{id:'preview-lin',name:'小林',kind:'screen',stream:previewStream});call.emit('data',{id:'preview-lin',name:'小林',data:{type:'state',screen:true,sound:true,mic:true}});
        appendMessage('小林','我把刚刚的资料发给你，等会儿一起看。',Date.now()-80000);appendMessage('我','好，画面和声音都收到了。',Date.now()-40000);
    `);
    await shot('08-call');
    await check('Both volume controls fit above the call dock',"[...cards.get('preview-lin').card.querySelectorAll('.volume-control')].every(el=>el.getBoundingClientRect().bottom<document.querySelector('.call-controls').getBoundingClientRect().top)");
    await evaluate(`(async()=>{
        window.previewAudio=new AudioContext();window.previewDest=previewAudio.createMediaStreamDestination();
        await mixer.attach('preview-lin:voice',previewDest.stream);await mixer.attach('preview-lin:sound',previewDest.stream);refreshPeerVolumes('preview-lin');
        const controls=cards.get('preview-lin').card.querySelectorAll('.volume-control');
        controls[0].querySelector('input').value=175;controls[0].querySelector('input').dispatchEvent(new Event('input'));
        controls[1].querySelector('input').value=40;controls[1].querySelector('input').dispatchEvent(new Event('input'));
        controls[0].querySelector('button').click();
    })()`);
    await check('Independent mute reaches the real audio mixer without changing media volume',"mixer.entries.get('preview-lin:voice').volume===0 && mixer.entries.get('preview-lin:sound').volume===.4");
    await evaluate("cards.get('preview-lin').card.querySelector('.volume-control button').click()");
    await check('Unmute restores the selected voice gain',"mixer.entries.get('preview-lin:voice').volume===1.75");
    await check('Shared audio cannot exceed 100 percent',"cards.get('preview-lin').card.querySelectorAll('input')[1].max==='100'");
    await evaluate("cards.get('preview-lin').card.querySelector('.tile-action').click()");await pause(300);await shot('16-fullscreen');
    await check('Fullscreen uses the original live stream and fills the viewport',"fullscreenArea && cards.get('preview-lin').video.srcObject===previewStream && Math.abs(fullscreenArea.getBoundingClientRect().width-innerWidth)<2 && Math.abs(fullscreenArea.getBoundingClientRect().height-innerHeight)<2");
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await pause(300);
    await check('Escape restores the same video without reconnecting',"!fullscreenArea && cards.get('preview-lin').video.srcObject===previewStream");
    await evaluate(`
        for(const [id,name] of [['preview-qing','阿青'],['preview-yuan','小远']]){call.peers.set(id,{id,name,identity:id,pc:{close(){}}});call.emit('peer',{id,name});call.emit('data',{id,name,data:{type:'state',screen:false,mic:true}});}
        $('welcomeText').textContent='4 位朋友在线 · 拖文件到头像，即可发送';
    `);
    await shot('09-group');
    await check('Four-person member lists stay in sync',"$('memberCount').textContent==='4' && document.querySelectorAll('#members .member').length===4 && cards.size===3");
    await evaluate("for(const id of ['preview-qing','preview-yuan']){call.emit('track',{id,name:call.peers.get(id).name,kind:'screen',stream:previewStream});call.emit('data',{id,name:call.peers.get(id).name,data:{type:'state',screen:true,sound:true,mic:true}});}display=previewStream;currentSource={type:'screen'};$('localVideo').srcObject=previewStream;syncControls()");
    await shot('17-four-shares');
    await check('Four shared screens retain separate controls',"document.querySelectorAll('.media-card.has-screen').length===3 && !$('localLive').hidden && $('screens').classList.contains('self-sharing') && document.querySelectorAll('.volume-control').length===6");
    await evaluate("display=null;currentSource=null;$('localVideo').srcObject=null;for(const id of ['preview-qing','preview-yuan'])call.emit('data',{id,name:call.peers.get(id).name,data:{type:'state',screen:false,mic:true}});syncControls()");
    await shot('10-compact',1000,680);
    await evaluate("$('chatToggle').click()");await shot('11-compact-chat',1000,680);
    await check('Compact window can open chat without covering the call controls',"sidebarVisible() && $('chatToggle').getAttribute('aria-expanded')==='true' && $('rightSidebar').getBoundingClientRect().bottom<=document.querySelector('.call-controls').getBoundingClientRect().top+1");
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await check('Escape dismisses the compact panel',"!sidebarVisible() && $('chatToggle').getAttribute('aria-expanded')==='false'");
    await evaluate("$('filesToggle').click()");
    await evaluate(`
        for(const t of [{id:'preview-file',peer:'preview-lin',direction:'send',name:'项目资料.zip',size:50000000,bytes:32000000,speed:1800000,status:'transferring',terminal:false},{id:'preview-done',peer:'preview-qing',direction:'receive',name:'周末计划.pdf',size:2000000,bytes:2000000,status:'complete',terminal:true}]){transfers.items.set(t.id,t);transfers.dispatchEvent(new CustomEvent('update',{detail:t}));}
    `);
    await shot('12-transfers',1450,940);
    await check('Transfer progress and completed state render from real transfer events',"transferRows.get('preview-file').progress.value===64 && transferRows.get('preview-done').box.dataset.status==='complete'");
    await evaluate("$('closeTransfers').click();remoteSession.requests.set('preview-lin',{peer:'preview-lin',name:'小林'});renderRemote();layoutMedia()");
    await shot('19-collaboration-request');
    await check('Collaboration request requires explicit allow or decline',"!$('remotePanel').hidden && [...$('remoteRequests').querySelectorAll('button')].map(b=>b.textContent).join(',')==='允许,拒绝' && !remoteSession.hosts.size");
    await evaluate("remoteSession.requests.clear();renderRemote();layoutMedia();toast('未找到保存的输出设备，已切换为系统默认设备。',true)");
    await shot('20-device-feedback');
    await evaluate("$('toast').hidden=true;clearTimeout(toastTimer)");
    await evaluate("$('closeTransfers').click();setSidebar(true);alertedPhoneCall='preview-call';startPhoneTone=async()=>{};phoneController.pending={id:'preview-call',phase:'incoming',friend:{id:'preview-lin',name:'小林'},unknown:false};renderPhone()");
    await shot('13-incoming');
    await check('Incoming call exposes a named avatar and accept/decline actions',"$('phoneCallDialog').open && $('phoneCallAvatar').textContent==='小' && !$('phoneAccept').hidden && $('phoneCancel').textContent==='拒绝'");
    await evaluate("phoneController.pending=null;renderPhone();sourceList=[{id:'screen:preview',type:'screen',name:'屏幕 1 · 1920 × 1080',thumbnail:previewCanvas.toDataURL()}];selectedSource=sourceList[0];sourceType='screen';renderSources();$('startShare').disabled=false;$('shareDialog').showModal()");
    await shot('14-share-picker');
    await check('Share source selection retains default audio and pressed state',"$('shareAudioDefault').checked && document.querySelector('.source-card').getAttribute('aria-pressed')==='true' && !$('startShare').disabled");
    await evaluate("document.querySelector('[data-type=window]').click()");
    await evaluate("document.querySelector('[data-type=window]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
    await check('Source tabs support keyboard navigation and clear a stale selection',"document.querySelector('[data-type=screen]').getAttribute('aria-selected')==='true' && sourceType==='screen' && !selectedSource && $('startShare').disabled");
    await evaluate("$('shareDialog').close();cards.get('preview-lin').card.querySelector('.tile-mini').click()");await pause(300);
    await shot('15-mini',640,520);
    const bounds=await evaluate(`JSON.stringify({size:[innerWidth,innerHeight],controls:[...cards.get('preview-lin').card.querySelectorAll('.volume-control')].map(el=>{const r=el.getBoundingClientRect();return {width:r.width,top:r.top,bottom:r.bottom}}),body:document.body.className})`);
    fs.writeFileSync(path.join(directory,'layout-check.json'),bounds);
    await check('Floating viewer keeps both volume controls and original video',"document.body.classList.contains('mini-mode') && cards.get('preview-lin').video.srcObject===previewStream && [...cards.get('preview-lin').card.querySelectorAll('.volume-control')].every(el=>{const r=el.getBoundingClientRect();return r.top>0&&r.bottom<innerHeight;})");
    await evaluate("$('miniReturn').click()");await pause(300);
    await check('Returning from floating view retains the call and selected volumes',"!document.body.classList.contains('mini-mode') && joined && mixer.entries.get('preview-lin:voice').volume===1.75 && mixer.entries.get('preview-lin:sound').volume===.4");
    await check('Messages replace the empty state and remain text nodes',"!document.querySelector('#messages .chat-start') && document.querySelectorAll('#messages .message').length===2");
    await check('No horizontal page overflow after native window transitions',"document.documentElement.scrollWidth===innerWidth");
    fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify({passed:true,checks},null,2));
    await evaluate("previewAudio.close()");
    await evaluate("for(const peer of [...call.peers.values()])call.emit('peerleft',{id:peer.id});call.peers.clear();joined=false;syncControls();previewStream.getTracks().forEach(t=>t.stop())");
    await win.loadURL('http://localhost:3038/native-test.html');
    await shot('18-audio-diagnostics');
    console.log(JSON.stringify({ directory, baseline: false, bounds:JSON.parse(bounds) }));
    app.quit();
}
run().catch(error => { console.error(error); app.exit(1); });
