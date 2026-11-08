'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');const{chooseRoom,inviteUrl}=require('../public/rooms.js');
test('both fresh clients use the bundled common room, then remember an explicit choice',()=>{assert.equal(chooseRoom(null,null,'friends-common'),'friends-common');assert.equal(chooseRoom(null,'friends-saved','friends-common'),'friends-saved');assert.equal(chooseRoom('friends-invite','friends-saved','friends-common'),'friends-invite');assert.equal(chooseRoom('../bad',null,'friends-common'),'friends-common');});
test('invitations open only a valid native room',()=>{assert.equal(inviteUrl('friends-Abc'),'friends-screen://join/friends-Abc');assert.throws(()=>inviteUrl('https://attacker/'));});
