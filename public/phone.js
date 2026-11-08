(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.FriendsPhone = api;
})(typeof window === 'object' ? window : globalThis, function() {
    'use strict';
    const SIGNAL = 'https://p2p.mirotalk.com';
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ROOM = /^[A-Za-z0-9_-]{3,100}$/;
    const kinds = ['invite','accepted','joined','declined','busy','cancel','failed'];
    const name = value => String(value || '同学').replace(/[<>&"'\x00-\x1f]/g, '').trim().slice(0,32) || '同学';
    const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const decode = text => Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    const canonical = body => new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.keys(body).sort().map(key => [key,body[key]]))));
    function contactCode(contact) {
        return 'friends-contact:' + encode(new TextEncoder().encode(JSON.stringify(contact)));
    }
    function readContact(code) {
        if (typeof code !== 'string' || code.length > 4096 || !code.trim().startsWith('friends-contact:')) throw new Error('请粘贴对方在新版同屏中复制的好友码');
        let value;
        try { value = JSON.parse(new TextDecoder().decode(decode(code.trim().slice(16)))); } catch { throw new Error('好友码不完整，请重新复制'); }
        const key = value?.key;
        if (value?.v !== 1 || !UUID.test(value.id) || !UUID.test(value.inbox) || key?.kty !== 'EC' || key.crv !== 'P-256' ||
            !/^[A-Za-z0-9_-]{43}$/.test(key.x) || !/^[A-Za-z0-9_-]{43}$/.test(key.y) || key.d) throw new Error('好友码格式不正确');
        return { v:1, id:value.id, inbox:value.inbox, name:name(value.name), key:{kty:'EC',crv:'P-256',x:key.x,y:key.y} };
    }
    const inboxRoom = contact => 'friends-inbox-' + contact.inbox.replace(/-/g,'');

    class Phone extends EventTarget {
        static async create(options) {
            const phone = new Phone(options);
            let stored;
            try { stored = JSON.parse(options.storage.getItem('friendsPhoneIdentity') || 'null'); } catch {}
            try {
                if (!stored || stored.id !== options.identity || !UUID.test(stored.inbox)) throw new Error('new identity');
                phone.privateKey = await crypto.subtle.importKey('jwk', stored.privateKey, {name:'ECDSA',namedCurve:'P-256'}, false, ['sign']);
                phone.self = readContact(contactCode({v:1,id:stored.id,inbox:stored.inbox,name:phone.getName(),key:stored.key}));
            } catch {
                const keys = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify']);
                phone.privateKey = keys.privateKey;
                const key = await crypto.subtle.exportKey('jwk',keys.publicKey);
                phone.self = readContact(contactCode({v:1,id:options.identity,inbox:crypto.randomUUID(),name:phone.getName(),key}));
                options.storage.setItem('friendsPhoneIdentity',JSON.stringify({...phone.self,privateKey:await crypto.subtle.exportKey('jwk',keys.privateKey)}));
            }
            try {
                const contacts = JSON.parse(options.storage.getItem('friendsPhoneContacts') || '[]');
                for (const value of contacts.slice(0,16)) {
                    const contact = readContact(contactCode(value));
                    if (contact.id !== phone.self.id) phone.contacts.set(contact.id,contact);
                }
            } catch {}
            return phone;
        }
        constructor({storage,identity,socketFactory,getName=()=> '同学',context=()=>({room:null,members:1}),join=async()=>{},timeout=45000}) {
            super();
            if (!UUID.test(identity)) throw new Error('呼叫身份无效');
            this.storage=storage;this.socketFactory=socketFactory;this.getName=getName;this.context=context;this.join=join;this.timeout=timeout;
            this.contacts=new Map();this.peers=new Map();this.rooms=new Set();this.seen=new Map();this.keys=new Map();
            this.socket=null;this.pending=null;this.connected=false;this.sendQueue=Promise.resolve();
        }
        emit(type,detail={}) { this.dispatchEvent(new CustomEvent(type,{detail})); }
        code() { return contactCode({...this.self,name:name(this.getName())}); }
        saveContacts() { this.storage.setItem('friendsPhoneContacts',JSON.stringify([...this.contacts.values()])); }
        async add(code,alias) {
            const contact=readContact(code);
            if (contact.id===this.self.id) throw new Error('这是你自己的好友码');
            await this.publicKey(contact);
            if (!this.contacts.has(contact.id) && this.contacts.size>=16) throw new Error('联系人已满，最多保存 16 人');
            if (alias?.trim()) contact.name=name(alias);
            this.contacts.set(contact.id,contact);this.saveContacts();
            if (this.socket?.connected) this.joinInbox(contact);
            this.emit('state');return contact;
        }
        async remove(id) {
            if (this.pending?.friend.id===id) await this.cancel();
            this.contacts.delete(id);this.saveContacts();
            this.stop();this.start();
        }
        online(id) { return this.connected && [...this.peers.values()].some(peer=>peer.id===id); }
        owner(id) { return [...this.peers].find(([,peer])=>peer.id===id)?.[0]; }
        start() {
            if (this.socket) return;
            const socket=this.socketFactory(SIGNAL,{transports:['websocket'],timeout:15000,reconnection:true,reconnectionDelayMax:4000,forceNew:true});
            this.socket=socket;
            socket.on('connect',()=>{
                this.connected=true;this.peers.clear();this.rooms.clear();
                this.joinInbox(this.self);for(const contact of this.contacts.values())this.joinInbox(contact);this.emit('state');
            });
            socket.on('disconnect',()=>{this.connected=false;this.peers.clear();this.abort('呼叫信令已断开');this.emit('state');});
            socket.on('connect_error',()=>{this.connected=false;this.emit('state');});
            socket.on('addPeer',config=>{
                const id=config.peers?.[config.peer_id]?.extras?.friends_phone_id;
                if (UUID.test(id||'') && id!==this.self.id) this.peers.set(config.peer_id,{id});
                this.emit('state');
            });
            socket.on('removePeer',({peer_id})=>{
                this.peers.delete(peer_id);
                if (this.pending?.transport.peer===peer_id) this.abort('对方已离线');
                this.emit('state');
            });
            socket.on('cmd',config=>{this.receive(config).catch(()=>{});});
        }
        joinInbox(contact) {
            const room=inboxRoom(contact);
            if (this.rooms.has(room)) return;
            this.rooms.add(room);
            this.socket.emit('join',{channel:room,channel_password:'',peer_uuid:this.self.id,peer_name:name(this.getName()),
                peer_info:{extras:{friends_phone_id:this.self.id}},peer_video:false,peer_audio:false,peer_screen_status:false,peer_audio_status:false,peer_video_status:false});
        }
        async publicKey(contact) {
            const encoded=JSON.stringify(contact.key);
            if (!this.keys.has(encoded)) this.keys.set(encoded,await crypto.subtle.importKey('jwk',contact.key,{name:'ECDSA',namedCurve:'P-256'},false,['verify']));
            return this.keys.get(encoded);
        }
        send(friend,transport,kind,id,room,extra={}) {
            const socket=this.socket;
            const send=async()=>{
                if (!socket?.connected || socket!==this.socket) return false;
                const body={v:1,kind,id,from:this.self.id,to:friend.id,room,expires:Date.now()+60000,replyTo:socket.id,code:this.code(),...extra};
                const signature=encode(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},this.privateKey,canonical(body))));
                if (!socket.connected || socket!==this.socket) return false;
                socket.emit('cmd',{action:'friends-phone-v1',send_to_all:false,data:{room_id:transport.room,to_peer_id:transport.peer,packet:{body,signature}}});
                return true;
            };
            const result=this.sendQueue.catch(()=>{}).then(send);
            this.sendQueue=result.catch(()=>{});return result;
        }
        setPending(value) {
            value.controller=new AbortController();
            value.timer=setTimeout(()=>this.cancel('无人接听').catch(()=>{}),this.timeout);
            this.pending=value;this.emit('state');
        }
        clear(value) {
            if (this.pending!==value) return;
            clearTimeout(value.timer);this.pending=null;this.emit('state');
        }
        abort(message) {
            const pending=this.pending;
            if (!pending) return;
            pending.controller.abort();this.clear(pending);
            if (message) this.emit('notice',{message});
        }
        async dial(id) {
            if (this.pending) throw new Error('请先处理当前呼叫');
            const friend=this.contacts.get(id),peer=this.owner(id),context=this.context();
            if (!friend || !peer || !this.connected) throw new Error('对方暂不在线，请让对方打开同屏');
            if (context.members>=4) throw new Error('当前房间已满');
            const room=context.room || 'friends-' + crypto.randomUUID();
            const pending={id:crypto.randomUUID(),friend,room,phase:'outgoing',transport:{room:inboxRoom(friend),peer}};
            this.setPending(pending);
            try { await this.send(friend,pending.transport,'invite',pending.id,room,{code:this.code(),inRoom:!!context.room}); }
            catch(error) {this.abort('呼叫发送失败');throw error;}
        }
        async receive(config) {
            if (config?.action!=='friends-phone-v1' || !this.rooms.has(config.data?.room_id)) return;
            const packet=config.data.packet,body=packet?.body;
            if (!body || JSON.stringify(packet).length>8000 || body.v!==1 || !kinds.includes(body.kind) || !UUID.test(body.id||'') ||
                body.to!==this.self.id || !ROOM.test(body.room||'') || !Number.isFinite(body.expires) || body.expires<Date.now()-5000 || body.expires>Date.now()+120000 ||
                this.peers.get(body.replyTo)?.id!==body.from || typeof packet.signature!=='string' || packet.signature.length>100) return;
            let candidate=this.contacts.get(body.from);
            if (body.kind==='invite' || !candidate) {
                const supplied=readContact(body.code);
                if (supplied.id!==body.from) return;
                if (candidate && JSON.stringify(candidate.key)!==JSON.stringify(supplied.key)) return;
                candidate=candidate||supplied;
            }
            if (!candidate || !await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},await this.publicKey(candidate),decode(packet.signature),canonical(body))) return;
            const transport={room:config.data.room_id,peer:body.replyTo};
            if (body.kind==='cancel') this.seen.set(body.id,Date.now());
            if (body.kind==='invite') {
                if (config.data.room_id!==inboxRoom(this.self) || this.seen.has(body.id)) return;
                this.seen.set(body.id,Date.now());
                for(const [id,at] of this.seen)if(Date.now()-at>120000)this.seen.delete(id);
                const context=this.context();
                if (this.pending || context.members>=4 || (context.room && body.inRoom && context.room!==body.room)) {
                    await this.send(candidate,transport,'busy',body.id,body.room);return;
                }
                this.setPending({id:body.id,friend:candidate,room:body.room,phase:'incoming',unknown:!this.contacts.has(candidate.id),transport});
                return;
            }
            const pending=this.pending;
            if (!pending || pending.id!==body.id || pending.friend.id!==body.from) return;
            if (['declined','busy','cancel','failed'].includes(body.kind)) {
                this.abort({declined:'对方拒绝了通话',busy:'对方忙线或房间已满',cancel:'对方取消了呼叫',failed:'对方未能进入房间'}[body.kind]);return;
            }
            if (body.kind==='accepted' && pending.phase==='outgoing') {
                const context=this.context();
                if (context.room && context.room!==body.room) {await this.cancel('当前正在其他房间通话');return;}
                pending.phase='connecting';pending.room=body.room;this.emit('state');
                try {
                    await this.join(body.room,pending.controller.signal);
                    if (this.pending!==pending) return;
                    await this.send(candidate,transport,'joined',pending.id,body.room);
                    this.clear(pending);this.emit('connected',{friend:candidate,room:body.room});
                } catch(error) { if(this.pending===pending)await this.cancel(error.message||'进入房间失败，请重试'); }
            } else if (body.kind==='joined' && pending.phase==='waiting' && body.room===pending.room) {
                this.clear(pending);this.emit('connected',{friend:candidate,room:body.room});
            }
        }
        async accept() {
            const pending=this.pending;
            if (!pending || pending.phase!=='incoming') return;
            const context=this.context();
            if (context.members>=4) {await this.cancel('当前房间已满');return;}
            if (pending.unknown) {
                if(this.contacts.size>=16)throw new Error('联系人已满，请先删除一个联系人');
                this.contacts.set(pending.friend.id,pending.friend);this.saveContacts();this.joinInbox(pending.friend);
            }
            pending.room=context.room || pending.room;pending.phase='connecting';this.emit('state');
            try {
                await this.join(pending.room,pending.controller.signal);
                if (this.pending!==pending) return;
                pending.phase='waiting';this.emit('state');
                await this.send(pending.friend,pending.transport,'accepted',pending.id,pending.room);
            } catch(error) { if(this.pending===pending)await this.cancel(error.message||'进入房间失败，请重试'); }
        }
        async cancel(message) {
            const pending=this.pending;
            if (!pending) return;
            const kind=pending.phase==='incoming'?'declined':'cancel';
            this.abort(message);
            await this.send(pending.friend,pending.transport,kind,pending.id,pending.room);
        }
        stop() {
            this.abort();const socket=this.socket;this.socket=null;this.connected=false;this.peers.clear();this.rooms.clear();
            socket?.removeAllListeners();socket?.disconnect();this.emit('state');
        }
    }
    return {Phone,readContact,contactCode,inboxRoom};
});
