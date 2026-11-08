'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {RemoteGate,validInput}=require('../desktop/remote-gate.cjs');
const {Remote,point,keyCode}=require('../public/remote.js');
test('control needs a shared full screen, a live token and increasing sequence',()=>{
 let now=0;const g=new RemoteGate(()=>now);assert.throws(()=>g.grant('peer'));g.setShare({id:'window:1:0'});assert.throws(()=>g.grant('peer'));
 g.setShare({id:'screen:0:0'});const token=g.grant('peer');assert(!g.accept('wrong',1,{type:'ping'}));assert(g.accept(token,1,{type:'move',x:.3,y:.6}));assert(!g.accept(token,1,{type:'key',vk:65,action:'down'}));
 assert(!g.accept(token,2,{type:'button',x:-1,y:.3,button:0,action:'down'}));assert(g.accept(token,2,{type:'release'}));g.setShare(null);assert(!g.accept(token,3,{type:'ping'}));
 g.setShare({id:'screen:0:0'});const next=g.grant('peer');now=30*60*1000;assert(!g.accept(next,1,{type:'ping'}));
});
test('input is finite, bounded and limited to supported keyboard and mouse events',()=>{
 for(const m of [{type:'shell',command:'x'},{type:'move',x:NaN,y:0},{type:'wheel',x:0,y:0,delta:99999},{type:'button',x:0,y:0,button:8,action:'down'},{type:'key',vk:91,action:'down'}])assert(!validInput(m));
 assert(validInput({type:'key',vk:65,action:'up'}));assert(validInput({type:'wheel',x:1,y:1,delta:-120}));
 const g=new RemoteGate(()=>0);g.setShare({id:'screen:0:0'});const t=g.grant('p');for(let i=0;i<180;i++)assert(g.accept(t,i,{type:'ping'}));assert(!g.accept(t,180,{type:'ping'}));
});
test('letterbox mapping supports scaled video and ignores black borders',()=>{
 const r={left:10,top:20,width:800,height:800};assert.deepEqual(point(r,1920,1080,410,420),{x:.5,y:.5});assert.equal(point(r,1920,1080,410,30),null);assert.equal(point(r,0,0,410,420),null);
 assert.equal(keyCode('KeyA'),65);assert.equal(keyCode('Digit7'),55);assert.equal(keyCode('F12'),123);assert.equal(keyCode('MetaLeft'),null);
});
class FakeCall extends EventTarget{constructor(){super();this.peers=new Map([['p',{}]]);this.sent=[];}sendControl(peer,payload){this.sent.push({peer,payload});return true;}receive(payload){this.dispatchEvent(new CustomEvent('data',{detail:{id:'p',name:'test',data:{type:'control',payload:{v:2,...payload}}}}));}}
const tick=()=>new Promise(r=>setImmediate(r));
test('unsolicited input or grant never controls native input; approved session stops on disconnect',async()=>{
 const call=new FakeCall(),injected=[];const native={onEvent(){},grant:async()=>({token:'local-only-token'}),input:async(...args)=>{injected.push(args);return true;},stop:async()=>{}};
 const r=new Remote(call,native);call.receive({action:'input',id:'fake',seq:1,input:{type:'key',vk:65,action:'down'}});call.receive({action:'granted',id:'fake'});await tick();assert.equal(injected.length,0);assert.equal(r.control,null);
 const id=crypto.randomUUID();call.receive({action:'request',id});await tick();assert(r.pending);assert.equal(injected.length,0);await r.allow();assert(r.host);assert(!JSON.stringify(call.sent).includes('local-only-token'));
 call.receive({action:'input',id,seq:1,input:{type:'move',x:.1,y:.2}});await tick();assert.equal(injected.length,1);
 call.dispatchEvent(new CustomEvent('peerleft',{detail:{id:'p'}}));await tick();assert.equal(r.host,null);call.receive({action:'input',id,seq:2,input:{type:'key',vk:65,action:'down'}});await tick();assert.equal(injected.length,1);await r.close();
});
test('declining a session never invokes native grant',async()=>{
 const c=new FakeCall();let grants=0;const r=new Remote(c,{onEvent(){},grant:async()=>{grants++;},stop:async()=>{}});c.receive({action:'request',id:crypto.randomUUID()});await tick();r.deny();assert.equal(grants,0);assert.equal(c.sent.at(-1).payload.action,'denied');await r.close();
});
