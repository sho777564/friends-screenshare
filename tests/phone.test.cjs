'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Phone,readContact}=require('../public/phone.js');
function storage(){const data=new Map();return {getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};}
test('contact identity, key and alias survive restarts while copied codes contain no private key',async()=>{
    const saved=storage(),identity=crypto.randomUUID();const options={storage:saved,identity};
    const first=await Phone.create(options),friend=await Phone.create({storage:storage(),identity:crypto.randomUUID()});
    await first.add(friend.code(),'北京同学');
    const copy=readContact(first.code());assert.equal(copy.id,identity);assert.equal(copy.key.d,undefined);
    const second=await Phone.create(options);
    assert.deepEqual(readContact(second.code()),copy);assert.equal(second.contacts.get(friend.self.id).name,'北京同学');
    const packet=new TextEncoder().encode('restart');const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},second.privateKey,packet);
    const key=await crypto.subtle.importKey('jwk',copy.key,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,signature,packet),true);
    assert.throws(()=>readContact('friends-contact:'+Buffer.from(JSON.stringify({...copy,key:{...copy.key,d:'private'}})).toString('base64url')),/格式/);
});
