/* P2P file protocol v1. Ordered, reliable SCTP; bounded window and disk ACKs. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FriendsFiles=api;})(typeof window==='object'?window:globalThis,function(){
    'use strict';
    const PREFIX='friends-file-v1:',CHUNK=16384,WINDOW=262144;
    const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
    const validMeta=m=>m?.type==='offer'&&m.version===1&&validId(m.id)&&typeof m.name==='string'&&m.name.length>0&&m.name.length<=255&&Number.isSafeInteger(m.size)&&m.size>=0&&m.size<=2**40;
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    class Transfers extends EventTarget{
        constructor(call,io,options={}){super();this.call=call;this.io=io;this.items=new Map();this.queues=new Map();this.options=options;
            call.addEventListener('filechannel',e=>this.incoming(e.detail));
            call.addEventListener('peerleft',e=>{for(const t of this.items.values())if(t.peer===e.detail.id&&!t.terminal)this.abort(t,'对方已离开，传输已中断');});
        }
        update(t){const now=Date.now();if(t.lastBytes!==t.bytes){const elapsed=(now-(t.lastProgress||now))/1000;t.speed=elapsed>0?(t.bytes-(t.lastBytes||0))/elapsed:0;t.lastBytes=t.bytes;t.lastProgress=now;}
            this.dispatchEvent(new CustomEvent('update',{detail:t}));}
        add(t){if(this.items.size>=60){for(const old of this.items.values())if(old.terminal){this.items.delete(old.id);this.dispatchEvent(new CustomEvent('removed',{detail:old}));break;}}
            Object.assign(t,{bytes:0,status:t.direction==='send'?'queued':'waiting',terminal:false,queue:Promise.resolve(),lastActivity:Date.now(),lastProgress:Date.now()});this.items.set(t.id,t);this.update(t);return t;}
        send(peer,sources){
            if(!this.call.peers.has(peer))throw new Error('朋友尚未连接');
            if([...this.items.values()].filter(t=>!t.terminal).length+sources.length>16)throw new Error('一次最多排队 16 个文件');
            const jobs=sources.map(source=>this.add({id:crypto.randomUUID(),peer,name:source.name,size:source.size,source,direction:'send'}));
            let tail=this.queues.get(peer)||Promise.resolve();
            for(const t of jobs)tail=tail.catch(()=>{}).then(()=>this.start(t));this.queues.set(peer,tail);tail.finally(()=>{if(this.queues.get(peer)===tail)this.queues.delete(peer);});return jobs;
        }
        async start(t){if(t.terminal)return;return new Promise(resolve=>{t.resolve=resolve;
            try{t.channel=this.call.openFileChannel(t.peer,t.id);this.bind(t);t.status='offering';this.update(t);
                t.channel.onopen=()=>this.control(t,{type:'offer',version:1,id:t.id,name:t.name,size:t.size});this.arm(t,120000,'对方未确认接收，请确认双方都已更新到 2.2');
            }catch(e){this.abort(t,e.message);}
        });}
        incoming({id:peer,channel}){
            const id=channel.label.slice(PREFIX.length);
            if(!validId(id)||this.items.has(id)||[...this.items.values()].filter(t=>!t.terminal).length>=16){channel.close();return;}
            const t=this.add({id,peer,channel,name:'等待文件信息',size:0,direction:'receive'});this.bind(t);this.arm(t,15000,'未收到文件信息');
        }
        bind(t){const c=t.channel;c.binaryType='arraybuffer';t.queuedBytes=0;
            c.onmessage=e=>{if(t.terminal)return;t.lastActivity=Date.now();const binary=typeof e.data!=='string';
                if(binary){const length=e.data?.byteLength;if(!(e.data instanceof ArrayBuffer)||!length||length>CHUNK||(t.queuedBytes+=length)>WINDOW+CHUNK){this.abort(t,'文件分块异常');return;}}
                t.queue=t.queue.then(async()=>{if(t.terminal)return;if(binary){try{await this.block(t,new Uint8Array(e.data));}finally{t.queuedBytes-=e.data.byteLength;}}
                    else{if(e.data.length>4096)throw new Error('文件信息过长');await this.message(t,JSON.parse(e.data));}}).catch(e=>this.abort(t,e.message));
            };
            c.onclose=()=>{if(!t.terminal)this.abort(t,'连接已断开，文件未传完',false);};c.onerror=()=>{if(!t.terminal)this.abort(t,'文件通道出错',false);};
        }
        arm(t,ms,message){clearTimeout(t.timer);t.timer=setTimeout(()=>this.abort(t,message),ms);}
        control(t,data){if(t.channel?.readyState==='open')t.channel.send(JSON.stringify(data));}
        async message(t,m){
            if(m.type==='cancel'){await this.abort(t,m.reason==='declined'?'对方拒绝接收':'对方取消了传输',false);return;}
            if(t.direction==='receive'){
                if(m.type==='offer'&&t.status==='waiting'){
                    if(!validMeta(m)||m.id!==t.id)throw new Error('无效的文件信息');Object.assign(t,{name:m.name,size:m.size,status:'offered'});this.arm(t,120000,'接收请求已过期');this.update(t);
                }else if(m.type==='end'&&t.status==='transferring'){
                    t.status='verifying';this.update(t);const receipt=await this.io.finish(t.sink.token,m.sha256);t.receipt=receipt.receipt;t.savedName=receipt.name;t.sink=null;
                    this.control(t,{type:'complete',sha256:m.sha256});this.done(t);
                }else throw new Error('文件传输状态不匹配');
            }else{
                if(m.type==='accept'&&t.status==='offering'){
                    clearTimeout(t.timer);t.status='transferring';t.ack=0;this.update(t);this.arm(t,60000,'对方长时间没有响应，传输已停止');this.pump(t).catch(e=>this.abort(t,e.message));
                }else if(m.type==='ack'&&['transferring','verifying'].includes(t.status)){
                    if(!Number.isSafeInteger(m.bytes)||m.bytes<t.ack||m.bytes>(t.sent||0))throw new Error('文件进度异常');t.ack=m.bytes;t.bytes=m.bytes;this.arm(t,60000,'接收写入超时，传输已停止');if(!t.lastPaint||Date.now()-t.lastPaint>180||t.bytes===t.size){t.lastPaint=Date.now();this.update(t);}
                }else if(m.type==='complete'&&t.status==='verifying'){
                    if(m.sha256!==t.digest)throw new Error('接收校验结果不匹配');t.bytes=t.size;this.done(t);t.channel.close();
                }else throw new Error('文件传输状态不匹配');
            }
        }
        async accept(id){const t=this.items.get(id);if(!t||t.status!=='offered')return;t.status='choosing';this.update(t);
            try{const sink=await this.io.accept({name:t.name,size:t.size});if(t.terminal){if(sink)await this.io.cancel(sink.token);return;}if(!sink){await this.cancel(id);return;}
                t.sink=sink;t.status='transferring';this.arm(t,60000,'发送方长时间没有响应');this.control(t,{type:'accept'});this.update(t);
            }catch(e){await this.abort(t,e.message);}
        }
        async block(t,bytes){if(t.direction!=='receive'||t.status!=='transferring'||!t.sink||t.bytes+bytes.length>t.size)throw new Error('收到意外的文件数据');
            await this.io.write(t.sink.token,bytes);t.bytes+=bytes.length;this.control(t,{type:'ack',bytes:t.bytes});this.arm(t,60000,'发送方长时间没有响应');
            if(!t.lastPaint||Date.now()-t.lastPaint>180||t.bytes===t.size){t.lastPaint=Date.now();this.update(t);}
        }
        async pump(t){let sent=0,nextAt=Date.now();t.sent=0;
            while(sent<t.size&&!t.terminal){
                while(!t.terminal&&(t.channel.bufferedAmount>WINDOW||sent-t.ack>=WINDOW))await sleep(12);if(t.terminal)return;
                const chunk=await this.io.read(t.source.token);if(t.terminal)return;
                const bytes=chunk instanceof Uint8Array?chunk:new Uint8Array(chunk);if(!bytes.length||bytes.length>CHUNK||sent+bytes.length>t.size)throw new Error('无法继续读取文件');
                t.channel.send(bytes);sent+=bytes.length;t.sent=sent;
                const rate=Math.max(16384,this.options.rate?.(t.peer)||2*1024*1024);nextAt=Math.max(nextAt,Date.now())+bytes.length*1000/rate;
                await sleep(Math.max(0,nextAt-Date.now()));
            }
            if(t.terminal)return;t.digest=await this.io.sourceEnd(t.source.token);t.source=null;if(t.terminal)return;
            t.status='verifying';this.update(t);this.control(t,{type:'end',sha256:t.digest});
        }
        done(t){clearTimeout(t.timer);t.status='complete';t.terminal=true;t.bytes=t.size;this.update(t);t.resolve?.();}
        async abort(t,message,notify=true){if(t.terminal)return;clearTimeout(t.timer);t.terminal=true;t.status='failed';t.error=message;if(notify)this.control(t,{type:'cancel'});t.channel?.close();
            // Wait for any in-flight disk operation before closing its handle.
            const cleanup=async()=>{if(t.source){await this.io.sourceClose(t.source.token);t.source=null;}if(t.sink){await this.io.cancel(t.sink.token);t.sink=null;}};
            // The I/O implementation serializes close behind read/write.
            try{await cleanup();}catch{}this.update(t);t.resolve?.();
        }
        async cancel(id){const t=this.items.get(id);if(!t||t.terminal)return;this.control(t,{type:'cancel',reason:t.status==='offered'?'declined':'cancelled'});await this.abort(t,t.status==='offered'?'已拒绝':'已取消',false);t.status='cancelled';this.update(t);}
        dismiss(id){const t=this.items.get(id);if(t?.terminal){this.items.delete(id);this.dispatchEvent(new CustomEvent('removed',{detail:t}));}}
        async close(){await Promise.all([...this.items.values()].filter(t=>!t.terminal).map(t=>this.cancel(t.id)));}
    }
    return {Transfers,PREFIX,validMeta,validId,CHUNK,WINDOW};
});
