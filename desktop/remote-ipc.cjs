'use strict';
const path=require('node:path'),{spawn}=require('node:child_process');
const {RemoteGate,InputArbiter}=require('./remote-gate.cjs');
module.exports=function remoteIpc({ipcMain,guarded,dialog,screen,app,globalShortcut,window,audioHotkeys,spawnProcess=spawn}){
    const gate=new RemoteGate(),arbiter=new InputArbiter(),peerEpoch=new Map();
    let child=null,readyPromise=null,helperActive=false,buffer='',pending=null,grantBusy=false,serial=0,hotkeyRegistered=false,pointersDirty=false;
    const hotkey='Control+Alt+Shift+F12';
    const notify=data=>{const w=window();try{if(w&&!w.isDestroyed()&&!w.webContents.isDestroyed())w.webContents.send('remote:event',data);}catch{}};
    const write=data=>{if(!child?.stdin.writable||child.stdin.destroyed)return false;try{child.stdin.write(JSON.stringify(data)+'\n','utf8');return true;}catch{return false;}};
    const reasonText=reason=>({'parent-exit':'键鼠组件的输入管道已关闭，请重启同屏','invalid-message':'键鼠消息无法解析，协作已撤销','invalid-utf8':'键鼠消息编码错误，请完整更新','pipe-read-failed':'键鼠组件通信失败','hook-failed':'Windows 未能开启键鼠监听','cursor-overlay-unsupported':'Windows 未能开启协作指针窗口'}[reason]||('协作已停止：'+reason));
    function unregister(){if(hotkeyRegistered)globalShortcut.unregister(hotkey);hotkeyRegistered=false;}
    function participants(){return [...gate.entries.values()].map(a=>({id:a.peer,name:a.name,color:a.color,x:a.x,y:a.y}));}
    function syncPointers(){if(helperActive){write({type:'cursors',participants:participants()});pointersDirty=false;}}
    function revoke(reason='revoked',peer=null){
        if(peer){peerEpoch.set(peer,(peerEpoch.get(peer)||0)+1);const a=gate.forPeer(peer);if(a){gate.revoke(a.token);if(arbiter.release(a.token))write({type:'release'});notify({type:'stopped',reason,peer});pointersDirty=true;}
            if(gate.entries.size){syncPointers();return;}
        }else{serial++;gate.revoke();peerEpoch.clear();arbiter.clear();const waiting=pending;pending=null;waiting?.reject(new Error(reasonText(reason)));notify({type:'stopped',reason});}
        helperActive=false;write({type:'stop',request:'stop:'+serial});unregister();
    }
    function failed(reason){helperActive=false;revoke(reason);}
    async function start(){if(child&&readyPromise)return readyPromise;
        const exe=path.join(__dirname,'../native/CoopInput.exe');buffer='';
        readyPromise=new Promise((resolve,reject)=>{
            let ready=false;const proc=child=spawnProcess(exe,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
            const timer=setTimeout(()=>{proc.kill();reject(new Error('键鼠组件启动超时'));},8000);
            proc.stderr.resume();proc.stdin.on('error',()=>{if(child===proc)failed('helper-pipe');});
            proc.on('error',error=>{clearTimeout(timer);if(child===proc){child=null;readyPromise=null;}reject(error);});
            proc.on('exit',()=>{clearTimeout(timer);if(child!==proc)return;child=null;readyPromise=null;failed('helper-exit');if(!ready)reject(new Error('键鼠组件无法启动'));});
            proc.stdout.setEncoding('utf8');proc.stdout.on('data',chunk=>{if(child!==proc)return;buffer+=chunk;if(buffer.length>65536){buffer='';failed('invalid-helper');return;}let n;
                while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);let event;try{event=JSON.parse(line);}catch{continue;}
                    if(event.type==='ready'){clearTimeout(timer);if(event.protocol!==4||event.encoding!=='utf-8'){proc.kill();reject(new Error('键鼠组件版本不匹配，请完整更新到 2.4'));continue;}ready=true;resolve();}
                    else if(event.type==='granted'){if(pending?.id===event.request){helperActive=true;pending.resolve();pending=null;}}
                    else if(event.type==='stopped'){if(event.request?.startsWith('stop:'))continue;if(event.request&&pending&&event.request!==pending.id)continue;failed(event.reason);}
                    else if(['protocol-error','transport-error'].includes(event.type))failed(event.reason==='invalid-json'?'invalid-message':event.reason);
                    else if(event.type==='cursor'&&gate.entries.size){const owner=gate.entries.get(arbiter.owner);notify({...event,participants:participants(),ownerPeer:event.owner==='local'?'local':owner?.peer||null});}
                    else if(['busy','blocked'].includes(event.type)&&gate.entries.size){const owner=gate.entries.get(arbiter.owner);if(event.reason==='local-takeover')arbiter.clear();notify({...event,peer:owner?.peer});}
                }
            });
        });return readyPromise;
    }
    ipcMain.handle('remote:grant',guarded(async(e,peer,name)=>{
        if(grantBusy||typeof peer!=='string'||peer.length>100||typeof name!=='string')throw new Error('当前无法允许协作');
        if(!gate.share?.id?.startsWith('screen:'))throw new Error('请先共享整个屏幕，再允许协作');
        if(gate.forPeer(peer)||gate.entries.size>=3)throw new Error('此成员已获允许或协作人数已满');
        grantBusy=true;arbiter.clear();write({type:'release'});const attempt=serial,share=gate.share,epoch=(peerEpoch.get(peer)||0)+1;peerEpoch.set(peer,epoch);
        const valid=()=>attempt===serial&&share===gate.share&&epoch===peerEpoch.get(peer);let token;
        try{
            const answer=await dialog.showMessageBox(window(),{type:'question',title:'允许这位成员加入键鼠协作？',message:'允许「'+name.slice(0,32)+'」操作你正在共享的屏幕？',detail:'每位成员单独允许、单独撤销。各人使用不同颜色的协作指针，点击和键盘输入自动轮流使用，本地操作优先。\n此确认框显示期间，已有远程操作者的键鼠输入暂停。\n停止共享、断线或退出后撤销；单次最长 30 分钟。\n随时按 Ctrl+Alt+Shift+F12 结束全部协作。',buttons:['拒绝','允许本次协作'],defaultId:0,cancelId:0,noLink:true});
            if(answer.response!==1)return null;if(!valid())throw new Error('请求或共享已变化，请重新申请');await start();if(!valid())throw new Error('请求已失效');
            if(!hotkeyRegistered){if(!globalShortcut.register(hotkey,()=>revoke('hotkey')))throw new Error('紧急停止热键被其他程序占用');hotkeyRegistered=true;}
            token=gate.grant(peer,name);
            if(!helperActive){await new Promise((resolve,reject)=>{const id='grant:'+attempt+':'+epoch;const timer=setTimeout(()=>{pending=null;reject(new Error('键鼠组件没有确认就绪'));},5000);pending={id,resolve:()=>{clearTimeout(timer);resolve();},reject:error=>{clearTimeout(timer);reject(error);}};if(!write({type:'grant',request:id,...share.bounds,local:'我',remote:name.slice(0,32)})){pending=null;clearTimeout(timer);reject(new Error('键鼠通信管道不可用'));}});}
            if(!valid()||!gate.entries.has(token))throw new Error('协作已撤销');syncPointers();const a=gate.entries.get(token);return {token,expires:a.until,color:a.color,actor:peer};
        }catch(error){if(token)revoke('grant-failed',peer);throw error;}
        finally{grantBusy=false;if(!gate.entries.size){helperActive=false;write({type:'stop',request:'stop:'+serial});unregister();}}
    }));
    ipcMain.handle('remote:input',guarded((e,token,seq,input)=>{
        if(!gate.accept(token,seq,input))return false;const a=gate.entries.get(token);if('x'in input)pointersDirty=true;if(grantBusy)return input.type==='ping'||input.type==='move';
        const result=arbiter.decide(token,input);if(result.busy){notify({type:'busy',reason:result.busy,peer:a.peer,ownerPeer:gate.entries.get(arbiter.owner)?.peer});return false;}
        if(result.release)write({type:'release'});if(result.forward&&!write(input)){failed('helper-pipe');return false;}return true;
    }));
    ipcMain.handle('remote:stop',guarded((e,peer)=>{revoke('revoked',typeof peer==='string'?peer:null);return true;}));
    ipcMain.handle('remote:share-ended',guarded(()=>{revoke('share-ended');gate.setShare(null);return true;}));
    ipcMain.handle('remote:capture',guarded((e,value)=>{audioHotkeys(value!==true);return true;}));
    const pulse=setInterval(()=>{for(const a of gate.expired())revoke('expired',a.peer);if(gate.entries.size&&helperActive)write({type:'ping'});},1000);pulse.unref?.();
    const cursors=setInterval(()=>{if(pointersDirty)syncPointers();},40);cursors.unref?.();
    app.on('before-quit',()=>{clearInterval(pulse);clearInterval(cursors);revoke('quit');child?.stdin.end();});
    return {share(source){revoke('share-changed');let bounds=null;if(source?.id.startsWith('screen:')){const d=screen.getAllDisplays().find(d=>String(d.id)===String(source.display_id));if(d)bounds=screen.dipToScreenRect(null,d.bounds);}gate.setShare(bounds?{id:source.id,bounds:{left:bounds.x,top:bounds.y,width:bounds.width,height:bounds.height}}:null);},stop:revoke,bind(win){const end=reason=>{revoke(reason);gate.setShare(null);child?.stdin.end();};win.webContents.on('render-process-gone',()=>end('renderer-exit'));win.webContents.on('did-start-navigation',()=>{revoke('navigation');gate.setShare(null);});win.on('closed',()=>end('window-closed'));}};
};
