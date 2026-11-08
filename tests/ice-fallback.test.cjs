'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');const{Conference}=require('../public/media.js');
function fixture({polite=false,ice='checking',state='stable'}={}){
    const call=new Conference({socketFactory:()=>{}});let configured=null,offers=0,restarts=0;
    const p={id:'peer',polite,allIce:[{urls:'turn:relay.example:3478',username:'u',credential:'c'}],wantsIceRestart:false,makingOffer:false,pc:{connectionState:'connecting',iceConnectionState:ice,signalingState:state,getConfiguration:()=>({iceServers:[]}),setConfiguration:c=>configured=c,restartIce:()=>restarts++}};
    call.peers.set(p.id,p);call.socket={connected:true};call.negotiate=async()=>offers++;
    return{call,p,get:()=>({configured,offers,restarts})};
}
test('failed direct path enables TURN and restarts ICE only on the offerer',async()=>{const f=fixture();await f.call.enableRelayFallback(f.p);assert.equal(f.get().configured.iceServers[0].urls,'turn:relay.example:3478');assert.equal(f.get().offers,1);assert.equal(f.get().restarts,1);});
test('an established direct path never restarts or enables relay',async()=>{const f=fixture({ice:'connected'});await f.call.enableRelayFallback(f.p);assert.equal(f.get().configured,null);assert.equal(f.get().offers,0);});
test('responder accepts relay configuration without competing offers',async()=>{const f=fixture({polite:true});await f.call.enableRelayFallback(f.p);assert.ok(f.get().configured);assert.equal(f.get().offers,0);});
test('ICE restart waits for the outstanding answer to finish',async()=>{const f=fixture({state:'have-local-offer'});await f.call.enableRelayFallback(f.p);assert.equal(f.get().offers,0);assert.equal(f.p.wantsIceRestart,true);f.p.pc.signalingState='stable';await f.call.restartForRelay(f.p);assert.equal(f.get().offers,1);});
