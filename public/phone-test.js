'use strict';
(async () => {
    const report={scope:'Three signed phone clients on public signaling with random private inboxes. Simulated room joins, no personal devices.',checks:[]};
    const phones=[],states=[],joins=[],notices=[];
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    async function until(test,what,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(test())return;await wait(25);}throw new Error('Timeout: '+what);}
    const check=(name,ok)=>{report.checks.push({name,pass:!!ok});if(!ok)throw new Error(name);};
    try {
        for(let i=0;i<3;i++) {
            const map=new Map(),state={room:null,members:1};states.push(state);
            const phone=await FriendsPhone.Phone.create({storage:{getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)},identity:crypto.randomUUID(),socketFactory:window.io,
                getName:()=>['测试甲','测试乙','测试丙'][i],context:()=>state,join:async(room,signal)=>{
                    if(signal.aborted)throw new Error('aborted');
                    if(state.joinError)throw state.joinError;
                    if(!state.room){state.room=room;signal.addEventListener('abort',()=>state.room=null,{once:true});}
                    joins.push({i,room});
                }});
            notices[i]=[];
            phone.addEventListener('notice',event=>notices[i].push(event.detail.message));
            phones.push(phone);
        }
        const [a,b,c]=phones;
        await a.add(b.code(),'朋友乙');await c.add(b.code(),'朋友乙');
        phones.forEach(p=>p.start());
        await until(()=>a.online(b.self.id)&&c.online(b.self.id),'online owner');
        check('Saved contact codes identify the online recipient across separate standby inboxes',a.online(b.self.id)&&c.online(b.self.id));
        await a.dial(b.self.id);await until(()=>b.pending?.phase==='incoming','incoming');
        check('Incoming call rings without joining any media room before acceptance',joins.length===0&&b.pending.unknown);
        await c.dial(b.self.id);await until(()=>!c.pending,'busy response');
        check('A second caller gets busy while the first invitation remains pending',!!b.pending&&joins.length===0);
        await b.cancel();await until(()=>!a.pending,'decline');
        check('Declining clears both clients without opening devices',!b.pending&&joins.length===0);
        await a.dial(b.self.id);await until(()=>b.pending?.phase==='incoming','second incoming');
        await b.accept();await until(()=>!a.pending&&!b.pending,'accepted room handshake');
        check('Acceptance joins both people to the same room and saves the new caller',states[0].room===states[1].room&&!!states[0].room&&b.contacts.has(a.self.id));
        states[1].members=2;
        const group=states[1].room;
        await c.dial(b.self.id);await until(()=>b.pending?.phase==='incoming','third participant');
        await b.accept();await until(()=>!b.pending&&!c.pending,'group join');
        check('An idle third participant is invited into the existing room',states.every(s=>s.room===group));
        await a.dial(b.self.id);const cancelled=a.pending.id;await a.cancel();
        await until(()=>!b.pending&&b.seen.has(cancelled),'cancel race');
        check('Immediate cancellation cannot leave a late incoming call ringing',!a.pending&&!b.pending);
        const send=a.socket.emit.bind(a.socket);
        a.socket.emit=(event,data)=>{if(event==='cmd'){data=structuredClone(data);data.data.packet.body.room='tampered-room';}return send(event,data);};
        await a.send(a.contacts.get(b.self.id),{room:FriendsPhone.inboxRoom(b.self),peer:a.owner(b.self.id)},'invite',crypto.randomUUID(),'friends-valid',{inRoom:false});
        a.socket.emit=send;
        await wait(800);
        check('A modified signed invitation is ignored',!b.pending);
        for(const state of states){state.room=null;state.members=1;}
        states[0].joinError=new Error('连接房间超时');
        await a.dial(b.self.id);await until(()=>b.pending?.phase==='incoming','caller join failure invitation');
        await b.accept();await until(()=>!a.pending&&!b.pending,'caller join failure');
        check('Caller join failure reaches the receiver as a failed join and rolls back their new room',
            notices[0].at(-1)==='连接房间超时'&&notices[1].at(-1)==='对方未能进入房间'&&!states[1].room);
        delete states[0].joinError;
        states[1].joinError=new Error('连接房间超时');
        await a.dial(b.self.id);await until(()=>b.pending?.phase==='incoming','receiver join failure invitation');
        await b.accept();await until(()=>!a.pending&&!b.pending,'receiver join failure');
        check('Receiver join failure reaches the caller as a failed join',
            notices[1].at(-1)==='连接房间超时'&&notices[0].at(-1)==='对方未能进入房间');
        delete states[1].joinError;
        a.timeout=350;
        await a.dial(b.self.id);await until(()=>b.pending?.phase==='incoming','timeout incoming');
        await until(()=>!a.pending&&!b.pending,'unanswered timeout');
        check('An unanswered call times out and clears the recipient',!b.pending);
        b.stop();await until(()=>!a.online(b.self.id),'offline contact');
        let refused=false;try{await a.dial(b.self.id);}catch{refused=true;}
        check('Offline contacts cannot start a hanging call',refused&&!a.pending);
        report.passed=true;
    } catch(error){report.passed=false;report.error=error.stack;}
    finally {phones.forEach(p=>p.stop());document.getElementById('results').textContent=JSON.stringify(report,null,2);await window.friendsDesktop.saveTest(report);}
})();
