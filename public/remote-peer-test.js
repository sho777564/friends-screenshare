'use strict';
const call=new FriendsMedia.Conference({name:'协作界面测试端'}),remote=new FriendsRemote.Remote(call,null);
document.getElementById('join').onclick=async()=>{const room=new URLSearchParams(location.search).get('room');if(!/^[A-Za-z0-9_-]{3,100}$/.test(room))throw new Error('Use an explicit test room');await call.join(room);document.getElementById('join').disabled=true;};
call.addEventListener('dataready',()=>{document.getElementById('request').disabled=false;call.sendData({type:'state',mic:false,screen:false,sound:false});});
document.getElementById('request').onclick=()=>remote.request([...call.peers.keys()][0]);document.getElementById('stop').onclick=()=>remote.stop();
remote.addEventListener('state',()=>{document.getElementById('status').textContent=JSON.stringify({request:!!remote.requested,control:!!remote.control});});remote.addEventListener('error',e=>{document.getElementById('status').textContent=e.detail.message;});
window.addEventListener('pagehide',()=>{remote.close();call.leave();});
