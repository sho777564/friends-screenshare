'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validRoom,inviteRoom,roomFromArgs}=require('../desktop/links.cjs');
test('invite links and launcher arguments select only a room',()=>{
    assert.equal(inviteRoom('friends-screen://join/friends-Abc_123'),'friends-Abc_123');
    assert.equal(roomFromArgs(['app','friends-screen://join/friends-Abc_123']),'friends-Abc_123');
    assert.equal(roomFromArgs(['app','--room=my-friends']),'my-friends');
});
test('external links cannot inject file paths, commands or another host',()=>{
    for(const value of ['file:///C:/secret','https://join/friends-Abc','friends-screen://evil/friends-Abc','friends-screen://join/a%2Fb','friends-screen://join/abc?command=evil','friends-screen://user@join/abc','friends-screen://join/abc#fragment','friends-screen://join/%22%20--no-sandbox'])assert.equal(inviteRoom(value),null,value);
    assert.equal(validRoom('a;calc.exe'),false);assert.equal(roomFromArgs(['--room=..\\secret']),null);
});
