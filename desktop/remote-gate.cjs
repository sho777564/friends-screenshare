'use strict';
const crypto=require('node:crypto');
function validInput(m){
    if(!m||typeof m!=='object')return false;
    if(['ping','release'].includes(m.type))return true;
    if(m.type==='key')return ['down','up'].includes(m.action)&&Number.isInteger(m.vk)&&m.vk>=8&&m.vk<=254&&![91,92].includes(m.vk);
    if(!['move','button','wheel'].includes(m.type)||![m.x,m.y].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1))return false;
    if(m.type==='button')return ['down','up'].includes(m.action)&&[0,1,2].includes(m.button);
    if(m.type==='wheel')return Number.isInteger(m.delta)&&m.delta!==0&&Math.abs(m.delta)<=1200;
    return true;
}
class RemoteGate{
    constructor(now=()=>Date.now()){this.now=now;this.entries=new Map();this.share=null;}
    get active(){return this.entries.values().next().value||null;}
    setShare(share){this.revoke();this.share=share;}
    grant(peer,name='朋友'){if(!this.share?.id?.startsWith('screen:'))throw new Error('请先共享整个屏幕，再允许协作');
        if(this.forPeer(peer))throw new Error('此成员已获允许');if(this.entries.size>=3)throw new Error('最多允许 3 位远程操作者');
        const colors=['#ffac42','#bf8bff','#6cdd8b'],used=new Set([...this.entries.values()].map(a=>a.color));
        const a={token:crypto.randomUUID(),peer,name:String(name).slice(0,32),color:colors.find(c=>!used.has(c)),x:.5,y:.5,seq:-1,until:this.now()+30*60*1000,lastSeen:this.now(),rateAt:this.now(),count:0};this.entries.set(a.token,a);return a.token;
    }
    forPeer(peer){return [...this.entries.values()].find(a=>a.peer===peer);}
    accept(token,seq,input){const a=this.entries.get(token);if(!a||this.now()>=a.until||!Number.isSafeInteger(seq)||seq<=a.seq||!validInput(input))return false;
        if(this.now()-a.rateAt>=1000){a.rateAt=this.now();a.count=0;}if(++a.count>180)return false;a.seq=seq;a.lastSeen=this.now();if('x'in input){a.x=input.x;a.y=input.y;}return true;
    }
    expired(){return [...this.entries.values()].filter(a=>this.now()>=a.until||this.now()-a.lastSeen>5500);}
    revoke(token){if(token)this.entries.delete(token);else this.entries.clear();}
}
class InputArbiter{
    constructor(now=()=>Date.now()){this.now=now;this.clear();}
    clear(){this.owner=null;this.until=0;this.last=0;this.keys=new Set();this.buttons=new Set();}
    release(actor){if(this.owner!==actor)return false;this.clear();return true;}
    decide(actor,m){const now=this.now();
        if(m.type==='ping')return {forward:false};
        if(m.type==='release')return {forward:this.release(actor)};
        if(m.type==='move'){if(this.owner===actor&&this.buttons.size){this.last=now;this.until=now+900;return {forward:true};}return {forward:false};}
        const up=m.action==='up';
        if(m.type==='key'){
            if(this.owner!==actor)return {forward:false,busy:'focus'};
            if(up){if(!this.keys.delete(m.vk))return {forward:false};}else this.keys.add(m.vk);
        }else if(m.type==='button'||m.type==='wheel'){
            if(up){if(this.owner!==actor||!this.buttons.delete(m.button))return {forward:false};}
            else{
                if(this.owner!==actor&&this.owner&&(now<this.until||((this.keys.size||this.buttons.size)&&now-this.last<2000)))return {forward:false,busy:'remote'};
                const switched=this.owner!==actor;if(switched){this.clear();this.owner=actor;}
                if(m.type==='button')this.buttons.add(m.button);this.last=now;this.until=now+900;return {forward:true,release:switched};
            }
        }
        this.last=now;this.until=now+900;return {forward:true};
    }
}
module.exports={RemoteGate,validInput,InputArbiter};
