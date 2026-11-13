'use strict';
const {app,BrowserWindow,session,ipcMain,desktopCapturer,globalShortcut,clipboard,dialog,shell,screen,Notification,net,Menu,Tray} = require('electron');
const path = require('node:path'), fs = require('node:fs');
const {roomFromArgs}=require('./links.cjs');
const { ShareLogs } = require('./share-logs.cjs');
const { Updates } = require('./updates.cjs');
const { DiagnosticLog } = require('./diagnostic-log.cjs');
const { errorFields } = require('../public/diagnostics.js');
const fileDiagnostics=process.argv.includes('--test-files'),multiDiagnostics=process.argv.includes('--test-multi');
const inspectVideoSettings=process.argv.includes('--inspect-video-settings');
const videoDiagnostics = process.argv.includes('--test-video')||inspectVideoSettings;
const uiDiagnostics = process.argv.includes('--test-ui');
const roomDiagnostics = uiDiagnostics && process.argv.includes('--test-room-diagnostics');
const phoneDiagnostics = process.argv.includes('--test-phone');
const ORIGIN=phoneDiagnostics?'http://localhost:3039':uiDiagnostics?'http://localhost:3038':videoDiagnostics?'http://localhost:3037':multiDiagnostics?'http://localhost:3036':fileDiagnostics?'http://localhost:3033':'http://localhost:3023';
const fixture = process.argv.includes('--audio-fixture');
const diagnostics = process.argv.includes('--diagnostics');
const autoDiagnostics = process.argv.includes('--test-audio');
app.setName('同屏');
app.setPath('userData',path.join(app.getPath('appData'),phoneDiagnostics?'FriendsScreenShare-phone-test':uiDiagnostics?'FriendsScreenShare-ui-test':videoDiagnostics?'FriendsScreenShare-video-test':multiDiagnostics?'FriendsScreenShare-multi-test':fileDiagnostics?'FriendsScreenShare-file-test':fixture?'FriendsScreenShare-fixture':'FriendsScreenShare-v2'));
fs.mkdirSync(app.getPath('userData'),{recursive:true});
app.setPath('sessionData',app.getPath('userData'));
const primaryInstance=fixture||fileDiagnostics||multiDiagnostics||videoDiagnostics||uiDiagnostics||phoneDiagnostics||app.requestSingleInstanceLock();
if (!primaryInstance) { app.quit(); }
let mainWindow, server, selection = null, testSurface,remoteBridge, tray;
const diagnosticLog = new DiagnosticLog(path.join(__dirname, '..', '.run', 'diagnostics'), app.getVersion());
const recordDiagnostic = record => diagnosticLog.write(record).catch(error => console.warn('Diagnostic write failed', error.code));
const miniWindow = require('./mini-window.cjs')(() => mainWindow, screen);
let quitting = false;
app.on('before-quit', () => { quitting = true; });
let launchRoom=roomFromArgs(process.argv);
const trusted = event => !!mainWindow && event.sender.id===mainWindow.webContents.id && event.senderFrame?.url.startsWith(ORIGIN+'/') && !event.senderFrame.parent;
const guarded = fn => async (event,...args) => { if (!trusted(event)) throw new Error('Untrusted request'); return fn(event,...args); };
function createWindow(url,title='同屏') {
    const win = new BrowserWindow({width:1450,height:940,minWidth:1000,minHeight:680,title,show:!fixture&&!autoDiagnostics&&!videoDiagnostics&&!fileDiagnostics&&!multiDiagnostics&&!uiDiagnostics&&!phoneDiagnostics,frame:false,backgroundColor:'#313338',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(ORIGIN+'/'))event.preventDefault();});
    win.loadURL(url); return win;
}
function showMainWindow() {
    if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}
app.on('second-instance',(event,argv)=>{const room=roomFromArgs(argv);if(room){launchRoom=room;if(mainWindow){if(mainWindow.webContents.isLoading())mainWindow.webContents.once('did-finish-load',()=>mainWindow?.webContents.send('desktop:invite',room));else mainWindow.webContents.send('desktop:invite',room);}}showMainWindow();});
app.on('window-all-closed',()=>app.quit());
app.on('will-quit',()=>{tray?.destroy();globalShortcut.unregisterAll();server?.close();});
app.whenReady().then(async()=>{
    if(!primaryInstance)return;
    if(fixture){mainWindow=createWindow(ORIGIN+'/audio-fixture.html','同屏外部音频测试进程');setTimeout(()=>app.quit(),180000);return;}
    await recordDiagnostic({area:'application',event:'start'});
    try { server=await require('../server.cjs')(phoneDiagnostics?3039:uiDiagnostics?3038:videoDiagnostics?3037:multiDiagnostics?3036:fileDiagnostics?3033:3023); } catch(error){await recordDiagnostic({area:'application',event:'error',...errorFields(error)});dialog.showErrorBox('同屏无法启动','本地端口已被占用。请先关闭另一个版本，原程序不会被强制停止。\n'+error.message);app.quit();return;}
    const ses=session.defaultSession;
    if(!diagnostics&&!autoDiagnostics&&!videoDiagnostics&&!fileDiagnostics&&!multiDiagnostics&&!uiDiagnostics&&!phoneDiagnostics)app.setAsDefaultProtocolClient('friends-screen',process.execPath,[app.getAppPath()]);
    require('./file-ipc.cjs')({ipcMain,guarded,dialog,shell,app,window:()=>mainWindow,testMode:fileDiagnostics||multiDiagnostics});
    const updates = new Updates({appRoot:path.resolve(__dirname,'..'),version:app.getVersion(),
        publicKey:fs.readFileSync(path.join(__dirname,'update-public-key.pem'),'utf8'),fetch:(url,options)=>net.fetch(url,options),
        notify:status=>{
            if(status.state==='error')void recordDiagnostic({area:'update',event:'error',...errorFields(status.message)});
            if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('desktop:update',status);
        }});
    ipcMain.handle('diagnostics:record',guarded((event,record)=>recordDiagnostic(record)));
    ipcMain.handle('diagnostics:export',guarded(async()=>{
        const date=new Date().toISOString().replace(/[:.]/g,'-');
        const destination=uiDiagnostics?{filePath:path.join(__dirname,'..','.run','diagnostic-ui-export.json')}
            :await dialog.showSaveDialog(mainWindow,{title:'导出同屏诊断日志',
                defaultPath:path.join(app.getPath('downloads'),`同屏诊断-${date}.json`),filters:[{name:'诊断日志',extensions:['json']}]});
        if(destination.canceled||!destination.filePath)return false;
        const report=await diagnosticLog.report({windows:require('node:os').release(),electron:process.versions.electron,chrome:process.versions.chrome});
        await fs.promises.writeFile(destination.filePath,JSON.stringify(report,null,2)+'\n','utf8');
        return true;
    }));
    ipcMain.handle('updates:status',guarded(()=>updates.snapshot()));
    ipcMain.handle('updates:configure',guarded((event,url)=>updates.configure(url)));
    ipcMain.handle('updates:check',guarded(()=>updates.check()));
    ipcMain.handle('updates:download',guarded((event,automatic)=>updates.download(automatic===true)));
    ipcMain.handle('updates:local',guarded(async()=>{
        const result=await dialog.showOpenDialog(mainWindow,{title:'选择同屏轻量更新包',properties:['openFile'],filters:[{name:'同屏轻量更新包',extensions:['zip']}]});
        return result.canceled?updates.status:updates.local(result.filePaths[0]);
    }));
    ipcMain.handle('updates:install',guarded(()=>updates.install(()=>app.quit())));
    const logDirectory = path.join(__dirname, '..', '.run', multiDiagnostics ? 'share-logs-test' : 'share-logs');
    const shareLogs = new ShareLogs(logDirectory, app.getVersion());
    let closingLogs = false;
    ipcMain.handle('share-logs:write', guarded((event, entries) => {
        if (!closingLogs) return shareLogs.write(entries);
    }));
    ipcMain.handle('share-logs:open', guarded(async () => {
        await fs.promises.mkdir(logDirectory, { recursive: true });
        const error = await shell.openPath(logDirectory);
        if (error) throw new Error('无法打开共享日志文件夹');
    }));
    app.on('before-quit', event => {
        if (closingLogs) return;
        event.preventDefault();
        closingLogs = true;
        void Promise.allSettled([shareLogs.finishAll('app-quit'),recordDiagnostic({area:'application',event:'stop'})]).then(() => app.quit());
    });
    const audioHotkeys=enabled=>{if(fileDiagnostics||multiDiagnostics||videoDiagnostics||uiDiagnostics||phoneDiagnostics)return;for(const [key,action] of [['CommandOrControl+Shift+M','mic'],['CommandOrControl+Shift+D','deafen']]){globalShortcut.unregister(key);if(enabled)globalShortcut.register(key,()=>mainWindow?.webContents.send('desktop:shortcut',action));}};
    remoteBridge=require('./remote-ipc.cjs')({ipcMain,guarded,dialog,screen,app,globalShortcut,window:()=>mainWindow,audioHotkeys});
    ses.setPermissionCheckHandler((wc,permission,origin,details)=>{
        if(wc?.id!==mainWindow?.webContents.id || !origin.startsWith(ORIGIN))return false;
        return ['media','display-capture','speaker-selection','clipboard-sanitized-write','fullscreen'].includes(permission);
    });
    ses.setPermissionRequestHandler((wc,permission,callback,details)=>{
        const own=wc.id===mainWindow?.webContents.id && wc.getURL().startsWith(ORIGIN+'/');
        const camera=permission==='media' && details.mediaTypes?.includes('video');
        callback(own && !camera && ['media','display-capture','speaker-selection','clipboard-sanitized-write','fullscreen'].includes(permission));
    });
    ses.setDisplayMediaRequestHandler(async(request,callback)=>{
        const chosen=selection; selection=null;
        if(!chosen || request.frame?.top!==mainWindow?.webContents.mainFrame || Date.now()-chosen.at>12000){callback({});return;}
        try{
            const sources=await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:1,height:1}});
            const source=sources.find(s=>s.id===chosen.id);
            if(!source){callback({});return;}
            remoteBridge.share(source);
            callback({video:source,...(chosen.audio&&request.audioRequested?{audio:'loopback'}:{})});
        }catch{callback({});}
    });
    ipcMain.handle('desktop:info',guarded(()=>({version:app.getVersion(),electron:process.versions.electron,chrome:process.versions.chrome,windows:require('node:os').release(),gpu:app.getGPUFeatureStatus(),native:true})));
    ipcMain.handle('desktop:sources',guarded(async()=>{
        const sources=await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:280,height:158},fetchWindowIcons:true});
        return sources.filter(s=>!s.name.startsWith('同屏') || s.name==='同屏音频测试源').map(s=>({id:s.id,name:s.name,type:s.id.startsWith('screen:')?'screen':'window',thumbnail:s.thumbnail.toDataURL()}));
    }));
    ipcMain.handle('desktop:select',guarded((event,id,audio)=>{if(typeof id!=='string'||!/^screen:|^window:/.test(id))throw new Error('请选择共享来源');selection={id,audio:audio===true,at:Date.now()};return true;}));
    ipcMain.handle('desktop:window',guarded((event,action)=>{if(action==='minimize')mainWindow.minimize();else if(action==='maximize')mainWindow.isMaximized()?mainWindow.unmaximize():mainWindow.maximize();else if(action==='close')mainWindow.close();}));
    ipcMain.handle('desktop:mini', guarded((event, enabled) => miniWindow.set(enabled === true)));
    ipcMain.handle('desktop:call-alert', guarded((event, ringing, name) => {
        mainWindow.flashFrame(ringing === true);
        if (ringing === true && !mainWindow.isFocused() && typeof name === 'string' && Notification.isSupported()) {
            const notice = new Notification({ title:'同屏来电', body:name.slice(0,32)+' 正在呼叫你', silent:true });
            notice.on('click',showMainWindow);
            notice.show();
        }
    }));
    ipcMain.handle('desktop:test-mini', guarded(event => {
        if (!uiDiagnostics || !event.senderFrame.url.startsWith(ORIGIN + '/ui-test.html')) throw new Error('Diagnostics only');
        return { active: miniWindow.active, bounds: mainWindow.getBounds(), alwaysOnTop: mainWindow.isAlwaysOnTop() };
    }));
    ipcMain.handle('desktop:fullscreen',guarded((event,value)=>{mainWindow.setFullScreen(value===true);return mainWindow.isFullScreen();}));
    ipcMain.handle('desktop:clipboard',guarded((event,text)=>{if(typeof text==='string'&&text.length<=5000)clipboard.writeText(text);}));
    ipcMain.handle('desktop:save-test',guarded((event,data)=>{
        const isVideo=event.senderFrame.url.startsWith(ORIGIN+'/video-test.html');
        const isFile=fileDiagnostics&&event.senderFrame.url.startsWith(ORIGIN+'/file-test.html');
        const isMulti=multiDiagnostics&&event.senderFrame.url.startsWith(ORIGIN+'/multi-test.html');
        const isUI=uiDiagnostics&&event.senderFrame.url.startsWith(ORIGIN+'/ui-test.html');
        const isPhone=phoneDiagnostics&&event.senderFrame.url.startsWith(ORIGIN+'/phone-test.html');
        if(!isVideo&&!isFile&&!isMulti&&!isUI&&!isPhone&&!event.senderFrame.url.startsWith(ORIGIN+'/native-test.html'))return false;
        const target=path.join(__dirname,'../.run');fs.mkdirSync(target,{recursive:true});
        fs.writeFileSync(path.join(target,isPhone?'phone-test-result.json':isUI?(process.argv.includes('--ui-phase2')?'ui-test-phase2.json':'ui-test-phase1.json'):isMulti?'multi-test-result.json':isFile?'file-test-result.json':isVideo?'video-test-result.json':'native-test-result.json'),JSON.stringify(data,null,2));if(autoDiagnostics||videoDiagnostics||fileDiagnostics||multiDiagnostics||uiDiagnostics||phoneDiagnostics)setTimeout(()=>app.quit(),500);return true;
    }));
    ipcMain.handle('desktop:test-surface',guarded(async(event,action)=>{
        const isVideo=event.senderFrame.url.startsWith(ORIGIN+'/video-test.html');
        if(!isVideo&&!event.senderFrame.url.startsWith(ORIGIN+'/native-test.html'))throw new Error('Diagnostics only');
        if(action==='close'){testSurface?.close();testSurface=null;server.fixtureTone=false;return;}
        if(!testSurface || testSurface.isDestroyed()){
            testSurface=new BrowserWindow({width:isVideo?1920:360,height:isVideo?1080:220,title:isVideo?'同屏视频测试源':'同屏音频测试源',frame:!isVideo,show:false,focusable:false,autoHideMenuBar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
            if(isVideo)testSurface.setContentSize(1920,1080);
            await testSurface.loadURL(ORIGIN+(isVideo?'/video-source.html':'/test-surface.html'));
            testSurface.showInactive();
        }
        return {id:testSurface.getMediaSourceId(),name:'同屏音频测试源'};
    }));
    ipcMain.handle('desktop:test-tone',guarded((event,value)=>{
        if(event.senderFrame.url.startsWith(ORIGIN+'/native-test.html'))server.fixtureTone=value===true;
    }));
    mainWindow=createWindow(ORIGIN+(phoneDiagnostics?'/phone-test.html':uiDiagnostics?'/ui-test.html'+(roomDiagnostics?'?roomDiagnostics=1':process.argv.includes('--ui-phase2')?'?phase=2':''):multiDiagnostics?'/multi-test.html'+(process.argv.includes('--public-signal')?'?public=1':''):fileDiagnostics?'/file-test.html':videoDiagnostics?'/video-test.html?autorun=1'+(inspectVideoSettings?'&prefs=1':'')+(process.argv.includes('--video-720')?'&q=720':''):diagnostics||autoDiagnostics?'/native-test.html'+(autoDiagnostics?'?autorun=1':''):launchRoom?'/?room='+encodeURIComponent(launchRoom)+'&invite=1':'/'));
    mainWindow.on('leave-full-screen',()=>mainWindow?.webContents.send('desktop:fullscreen-changed',false));
    mainWindow.on('close', event => {
        if (quitting) return;
        const hideToTray = tray && !tray.isDestroyed();
        if (!hideToTray && !miniWindow.active) return;
        event.preventDefault();
        if (miniWindow.active) miniWindow.set(false);
        if (hideToTray) mainWindow.hide();
    });
    if (!diagnostics && !autoDiagnostics && !videoDiagnostics && !fileDiagnostics && !multiDiagnostics && !uiDiagnostics && !phoneDiagnostics) {
        try {
            tray = new Tray(path.join(__dirname, 'tray.ico'));
            tray.setToolTip('同屏');
            tray.on('click', showMainWindow);
            tray.setContextMenu(Menu.buildFromTemplate([
                { label: '打开同屏', click: showMainWindow },
                { type: 'separator' },
                { label: '退出同屏', click: () => app.quit() },
            ]));
        } catch (error) {
            tray?.destroy();
            tray = undefined;
            console.warn('Could not create tray icon', error);
        }
    }
    mainWindow.webContents.on('did-navigate', () => { void shareLogs.finishAll('navigation'); });
    mainWindow.webContents.on('did-fail-load', (event,code,message,url,mainFrame) => {
        if(mainFrame&&code!==-3)void recordDiagnostic({area:'renderer',event:'error',exitCode:code});
    });
    mainWindow.webContents.on('render-process-gone', (event,details) => {
        void recordDiagnostic({area:'renderer',event:'error',state:details.reason,exitCode:details.exitCode});
        void shareLogs.finishAll('renderer-exit');
    });
    mainWindow.on('closed', () => { void shareLogs.finishAll('window-closed'); });
    remoteBridge.bind(mainWindow);
    audioHotkeys(true);
    void recordDiagnostic({area:'application',event:'ready'});
}).catch(async error=>{await recordDiagnostic({area:'application',event:'error',...errorFields(error)});dialog.showErrorBox('同屏启动错误',error.message);app.quit();});
