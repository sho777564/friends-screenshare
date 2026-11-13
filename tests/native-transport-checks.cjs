'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process'),{EventEmitter}=require('node:events');
const exe=path.join(__dirname,'../native/CoopInputHost.exe');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
class NativeSession{
    constructor(args=['--ipc-test']){this.events=[];this.buffer='';this.waiters=[];this.exit=null;this.stderr='';this.proc=spawn(exe,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});this.attach();}
    attach(){const p=this.proc;p.stdout.setEncoding('utf8');p.stdout.on('data',chunk=>{this.buffer+=chunk;let n;while((n=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,n);this.buffer=this.buffer.slice(n+1);if(!line.trim())continue;const event=JSON.parse(line);this.events.push(event);this.notify();}});p.stderr.on('data',b=>this.stderr+=b.toString());p.stdin.on('error',()=>{});p.on('exit',(code,signal)=>{this.exit={code,signal};this.notify();});p.on('error',error=>{this.error=error;this.notify();});}
    notify(){for(const fn of [...this.waiters])fn();}
    until(predicate,timeout=4000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(new Error('Native timeout: '+JSON.stringify({events:this.events,exit:this.exit,stderr:this.stderr}))),timeout);const check=()=>{try{const value=predicate();if(value)finish(null,value);else if(this.error)finish(this.error);}catch(e){finish(e);}};const finish=(error,value)=>{clearTimeout(timer);this.waiters=this.waiters.filter(w=>w!==check);error?reject(error):resolve(value);};this.waiters.push(check);check();});}
    event(type,after=0,predicate=()=>true){return this.until(()=>this.events.slice(after).find(e=>e.type===type&&predicate(e)));}
    send(data){this.proc.stdin.write(JSON.stringify(data)+'\n','utf8');}
    async probe(value){const marker=this.events.length;this.send({type:'probe',value});return this.event('probe',marker,e=>JSON.stringify(e.value)===JSON.stringify(value));}
    async end(){if(!this.exit)this.proc.stdin.end();await this.until(()=>this.exit);assert.equal(this.exit.code,0);}
    async cleanup(){if(this.exit)return;this.proc.stdin.end();try{await this.until(()=>this.exit,2000);}catch{this.proc.kill();await wait(100);}}
}
async function runChecks(){const checks=[],sessions=[];
    const check=(name,pass)=>{assert(pass,name);checks.push({name,pass:true});};
    const session=args=>{const s=new NativeSession(args);sessions.push(s);return s;};
    try{
        const s=session();const ready=await s.event('ready');check('Native process advertises explicit UTF-8 protocol',ready.protocol===4&&ready.encoding==='utf-8'&&ready.dryRun===true);
        for(const text of ['我','同学','朋友甲','我和朋友😀','单双引号\"\\\n制表\t']){const e=await s.probe(text);check('UTF-8 round trip: '+JSON.stringify(text),e.value===text);}
        const encoded=Buffer.from(JSON.stringify({type:'probe',value:'逐字节-我-😀'})+'\n','utf8'),at=s.events.length;
        for(const byte of encoded)s.proc.stdin.write(Buffer.from([byte]));const split=await s.event('probe',at,e=>e.value==='逐字节-我-😀');check('Split multibyte UTF-8 input is reconstructed',split.value==='逐字节-我-😀');
        let mark=s.events.length;s.send({type:'grant',left:-1920,top:0,width:1920,height:1080,local:'我',remote:'同学😀'});const granted=await s.event('granted',mark);check('Actual grant message with Chinese owner and peer parses',granted.dryRun===true&&granted.local==='我'&&granted.remote==='同学😀');
        s.send({type:'key',vk:65,action:'down'});s.send({type:'button',x:.3,y:.4,button:0,action:'down'});let state=await s.probe('holding');check('Real native command parser reaches dry-run keyboard and mouse sink',state.heldKeys===1&&state.heldButtons===1);
        mark=s.events.length;s.send({type:'stop'});await s.event('stopped',mark,e=>e.reason==='revoked');state=await s.probe('released');check('Stop releases both keyboard and mouse without closing reader',!state.active&&state.heldKeys===0&&state.heldButtons===0);
        mark=s.events.length;s.proc.stdin.write('{"type":\n','utf8');await s.event('protocol-error',mark,e=>e.reason==='invalid-json');await s.event('stopped',mark,e=>e.reason==='invalid-message');const recovered=await s.probe('我');check('Malformed JSON is distinct from parent exit and reader can recover',recovered.value==='我'&&!s.exit);
        mark=s.events.length;s.send({type:'grant',left:0,top:0,width:1280,height:720,local:'我',remote:'再来一次'});await s.event('granted',mark);for(let i=0;i<4;i++){s.send({type:'ping'});await wait(150);}state=await s.probe('still-alive');check('Repeated grant and open pipe stay alive',state.active&&!s.exit&&!s.events.some(e=>e.reason==='parent-exit'));
        await s.end();check('Real EOF alone reports parent-exit',s.events.at(-1)?.reason==='parent-exit');
        const broken=session();await broken.event('ready');broken.proc.stdin.write(Buffer.from([0xff,0x0a]));await broken.event('transport-error',0,e=>e.reason==='invalid-utf8');await broken.until(()=>broken.exit);check('Invalid UTF-8 reports encoding failure rather than parent-exit',broken.events.some(e=>e.reason==='invalid-utf8')&&!broken.events.some(e=>e.reason==='parent-exit'));
        const production=session([]);const normal=await production.event('ready');await wait(150);check('Production launch starts UTF-8 reader without enabling input',normal.protocol===4&&normal.dryRun===false&&!production.exit);await production.end();
        await runBridgeChecks(check,sessions);
        await runGroupBridgeChecks(check,sessions);
        return {passed:true,checks,scope:'Real native executable and production IPC bridge; OS input is replaced only by --ipc-test. No hooks, remote access grant or OS input injection.'};
    }finally{await Promise.all(sessions.map(s=>s.cleanup()));}
}
async function runBridgeChecks(check,sessions){
    const handlers=new Map(),app=new EventEmitter(),events=[],hotkeys=new Set(),processes=[];
    const wc=new EventEmitter();wc.isDestroyed=()=>false;wc.send=(name,data)=>events.push(data);
    const win={isDestroyed:()=>false,webContents:wc};
    const bridge=require('../desktop/remote-ipc.cjs')({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},guarded:fn=>fn,dialog:{showMessageBox:async()=>({response:1})},screen:{getAllDisplays:()=>[{id:42,bounds:{x:0,y:0,width:1920,height:1080}}],dipToScreenRect:(w,r)=>r},app,globalShortcut:{register:key=>{hotkeys.add(key);return true;},unregister:key=>hotkeys.delete(key)},window:()=>win,audioHotkeys:()=>{},spawnProcess:(file,args,options)=>{
        const session=new NativeSession();sessions.push(session);processes.push(session);return session.proc;
    }});
    const invoke=(name,...args)=>handlers.get(name)({},...args);
    try{
        bridge.share({id:'screen:0:0',display_id:'42'});const grant=await invoke('remote:grant','p','同学😀');check('Production Electron IPC bridge completes Chinese grant handshake',typeof grant.token==='string'&&hotkeys.size===1);
        assert(await invoke('remote:input',grant.token,1,{type:'button',x:.3,y:.4,button:0,action:'down'}));assert(await invoke('remote:input',grant.token,2,{type:'button',x:.3,y:.4,button:0,action:'up'}));assert(await invoke('remote:input',grant.token,3,{type:'key',vk:65,action:'down'}));let state=await processes[0].probe('bridge-holding');check('Granted IPC token reaches real native pipe',state.heldKeys===1);
        await invoke('remote:stop', 'p');
        check('Stopping the last controller releases the native process and hotkey',processes[0].exit?.code===0&&hotkeys.size===0);
        const again=await invoke('remote:grant','p','朋友甲');
        check('A later grant starts a fresh helper',!!again.token&&processes.length===2);
        processes[1].proc.stdin.end();await processes[1].until(()=>processes[1].exit);await wait(30);check('Child exit revokes token immediately',!await invoke('remote:input',again.token,2,{type:'ping'}));
        const fresh=await invoke('remote:grant','p','我');check('Bridge can restart helper after EOF',!!fresh.token&&processes.length===3);
        await bridge.stopAll('quit');
        check('Quit waits for the last helper to exit',processes[2].exit?.code===0&&hotkeys.size===0);
    }finally{app.emit('before-quit');}
}
async function runGroupBridgeChecks(check,sessions){
    const handlers=new Map(),app=new EventEmitter(),hotkeys=new Set(),processes=[];let answer=async()=>({response:1});const wc=new EventEmitter();wc.isDestroyed=()=>false;wc.send=()=>{};const win={isDestroyed:()=>false,webContents:wc};
    const bridge=require('../desktop/remote-ipc.cjs')({ipcMain:{handle:(n,f)=>handlers.set(n,f)},guarded:f=>f,dialog:{showMessageBox:()=>answer()},screen:{getAllDisplays:()=>[{id:42,bounds:{x:0,y:0,width:1280,height:720}}],dipToScreenRect:(w,r)=>r},app,globalShortcut:{register:k=>{hotkeys.add(k);return true;},unregister:k=>hotkeys.delete(k)},window:()=>win,audioHotkeys:()=>{},spawnProcess:()=>{const s=new NativeSession();sessions.push(s);processes.push(s);return s.proc;}});
    const invoke=(n,...args)=>handlers.get(n)({},...args),seqs=new Map(),input=(g,m)=>{const n=(seqs.get(g.token)||0)+1;seqs.set(g.token,n);return invoke('remote:input',g.token,n,m);};
    const click=async g=>{assert(await input(g,{type:'button',x:.4,y:.4,button:0,action:'down'}));assert(await input(g,{type:'button',x:.4,y:.4,button:0,action:'up'}));};
    try{bridge.share({id:'screen:0:0',display_id:'42'});const a=await invoke('remote:grant','a','成员甲'),b=await invoke('remote:grant','b','成员乙😀'),c=await invoke('remote:grant','c','成员丙');
        check('Three separately approved controllers have unique colors and share one native helper',new Set([a.color,b.color,c.color]).size===3&&processes.length===1);
        let state=await processes[0].probe('group-cursors');check('Native cursor parser retains all three names and colors',state.pointerCount===3&&state.names.includes('成员乙😀')&&new Set(state.colors).size===3);
        await click(a);assert(await input(a,{type:'key',vk:162,action:'down'}));assert(!await input(b,{type:'button',x:.6,y:.5,button:0,action:'down'}));await input(b,{type:'release'});state=await processes[0].probe('no-mixed-modifiers');check('A second controller cannot alter another controller modifiers',state.heldKeys===1);
        await invoke('remote:stop','a');state=await processes[0].probe('one-member-revoked');check('Individual revoke releases held keys but keeps other controllers and helper active',state.active&&state.heldKeys===0&&state.pointerCount===2&&hotkeys.size===1&&!await input(a,{type:'ping'}));
        await click(b);assert(await input(b,{type:'key',vk:65,action:'down'}));await invoke('remote:stop','c');
        let approve;answer=()=>new Promise(resolve=>approve=resolve);const requesting=invoke('remote:grant','d','新成员丁');await wait(20);assert(!await input(b,{type:'key',vk:66,action:'down'}));state=await processes[0].probe('consent-pause');check('Existing remote input pauses and releases keys while local consent is pending',state.heldKeys===0);approve({response:1});const d=await requesting;check('A new member can join without resetting existing helper',!!d.token&&processes.length===1);
        await invoke('remote:stop','d');let cancelled;answer=()=>new Promise(resolve=>cancelled=resolve);const request=invoke('remote:grant','e','取消申请');await wait(20);await invoke('remote:stop','e');cancelled({response:1});await assert.rejects(request,/变化|失效|撤销/);check('Cancelled approval does not disturb another granted member',await input(b,{type:'ping'}));
    }finally{app.emit('before-quit');}
}
module.exports={runChecks};
