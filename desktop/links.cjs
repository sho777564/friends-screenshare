'use strict';
const validRoom=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{3,100}$/.test(value);
function inviteRoom(value){
    if(typeof value!=='string'||value.length>500)return null;
    try{const url=new URL(value);if(url.protocol!=='friends-screen:'||url.hostname!=='join'||url.username||url.password||url.port||url.search||url.hash)return null;
        const room=decodeURIComponent(url.pathname.slice(1));return validRoom(room)?room:null;
    }catch{return null;}
}
function roomFromArgs(args){for(const value of args){if(typeof value!=='string')continue;const linked=inviteRoom(value);if(linked)return linked;if(value.startsWith('--room=')){const room=value.slice(7);if(validRoom(room))return room;}}return null;}
module.exports={validRoom,inviteRoom,roomFromArgs};
