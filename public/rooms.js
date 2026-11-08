(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FriendsRooms=api;})(typeof window==='object'?window:globalThis,function(){
    'use strict';const valid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{3,100}$/.test(value);
    function chooseRoom(query,pinned,fallback){return [query,pinned,fallback].find(valid)||null;}
    function inviteUrl(room){if(!valid(room))throw new Error('房间号无效');return 'friends-screen://join/'+room;}
    return {valid,chooseRoom,inviteUrl};
});
