(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FriendsRemote=api;})(typeof window==='object'?window:globalThis,function(){
    'use strict';
    function point(rect,width,height,x,y){if(!width||!height||!rect.width||!rect.height)return null;const scale=Math.min(rect.width/width,rect.height/height),w=width*scale,h=height*scale,left=rect.left+(rect.width-w)/2,top=rect.top+(rect.height-h)/2;const px=(x-left)/w,py=(y-top)/h;return px<0||py<0||px>1||py>1?null:{x:px,y:py};}
    function keyCode(code){if(/^Key[A-Z]$/.test(code))return code.charCodeAt(3);if(/^Digit[0-9]$/.test(code))return code.charCodeAt(5);if(/^F(?:[1-9]|1[0-2])$/.test(code))return 111+Number(code.slice(1));if(/^Numpad[0-9]$/.test(code))return 96+Number(code.slice(6));
        return {Backspace:8,Tab:9,Enter:13,NumpadEnter:13,ShiftLeft:160,ShiftRight:161,ControlLeft:162,ControlRight:163,AltLeft:164,AltRight:165,CapsLock:20,Escape:27,Space:32,PageUp:33,PageDown:34,End:35,Home:36,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Insert:45,Delete:46,Semicolon:186,Equal:187,Comma:188,Minus:189,Period:190,Slash:191,Backquote:192,BracketLeft:219,Backslash:220,BracketRight:221,Quote:222,NumpadMultiply:106,NumpadAdd:107,NumpadSubtract:109,NumpadDecimal:110,NumpadDivide:111,NumLock:144,ScrollLock:145}[code]||null;
    }
    function validCursors(list){return Array.isArray(list)&&list.length<=4&&list.every(p=>p&&typeof p.id==='string'&&p.id.length<=100&&typeof p.name==='string'&&p.name.length<=32&&/^#[0-9a-f]{6}$/i.test(p.color)&&[p.x,p.y].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1));}
    class Remote extends EventTarget{
        constructor(call,native){super();this.call=call;this.native=native;this.hosts=new Map();this.requests=new Map();this.control=null;this.requested=null;this.authorizing=null;this.authorizeCancelled=false;
            call.addEventListener('data',e=>{if(e.detail.data.type==='control')this.receive(e.detail).catch(error=>this.emit('error',{message:error.message}));});
            call.addEventListener('peerleft',e=>this.removePeer(e.detail.id));native?.onEvent(e=>this.nativeEvent(e));
            this.timer=setInterval(()=>{if(this.control){if(Date.now()-this.control.lastHost>6500)this.stopControl('host-timeout');else this.sendInput({type:'ping'});}},1000);
        }
        get host(){return this.hosts.values().next().value||null;}
        get pending(){return this.requests.values().next().value||null;}
        emit(type,detail={}){this.dispatchEvent(new CustomEvent(type,{detail}));}
        send(peer,payload){return this.call.sendControl(peer,{v:2,...payload});}
        request(peer){if(this.hosts.size||this.control||this.requested||this.requests.size||this.authorizing)throw new Error('请先结束当前协作或处理请求');
            const id=crypto.randomUUID();if(!this.send(peer,{action:'request',id}))throw new Error('请等待对方连接成功');this.requested={peer,id};this.emit('state');clearTimeout(this.requestTimer);
            this.requestTimer=setTimeout(()=>{this.send(peer,{action:'stop',id});this.requested=null;this.emit('state');},60000);
        }
        async allow(peer=this.pending?.peer){const p=this.requests.get(peer);if(!p||this.authorizing)return;this.requests.delete(peer);this.authorizing=p;this.authorizeCancelled=false;this.emit('state');
            try{const grant=await this.native.grant(p.peer,p.name);if(!grant){this.send(p.peer,{action:'denied',id:p.id});return;}
                if(this.authorizeCancelled||!this.call.peers.has(p.peer)){await this.native.stop(p.peer);return;}
                const color=grant.color||['#ffac42','#bf8bff','#6cdd8b'][this.hosts.size];this.hosts.set(p.peer,{peer:p.peer,name:p.name,id:p.id,token:grant.token,color,actor:grant.actor||p.peer});
                this.send(p.peer,{action:'granted',id:p.id,color,actor:grant.actor||p.peer});this.emit('state');
            }catch(error){this.send(p.peer,{action:'denied',id:p.id});this.emit('error',{message:error.message});}
            finally{this.authorizing=null;this.emit('state');}
        }
        deny(peer=this.pending?.peer){const p=this.requests.get(peer);if(p)this.send(peer,{action:'denied',id:p.id});this.requests.delete(peer);this.emit('state');}
        async receive({id:peer,name,data}){const m=data.payload;if(m?.v!==2||typeof m.action!=='string'||!this.call.peers.has(peer))return;
            if(m.action==='request'){
                if(this.control||this.requested||!this.native||this.hosts.has(peer)||this.requests.has(peer)||this.authorizing?.peer===peer||this.hosts.size+this.requests.size+(this.authorizing?1:0)>=3||typeof m.id!=='string'||!/^[a-f0-9-]{36}$/.test(m.id)){this.send(peer,{action:'denied',id:m.id});return;}
                this.requests.set(peer,{peer,name:String(name).slice(0,32),id:m.id});this.emit('state');return;
            }
            if(m.action==='granted'&&this.requested?.id===m.id&&this.requested.peer===peer){clearTimeout(this.requestTimer);this.control={peer,id:m.id,seq:0,lastHost:Date.now(),actor:typeof m.actor==='string'?m.actor:this.call.socket?.id,color:/^#[0-9a-f]{6}$/i.test(m.color)?m.color:'#ffac42'};this.requested=null;this.emit('state');return;}
            if(m.action==='denied'&&this.requested?.peer===peer&&this.requested.id===m.id){clearTimeout(this.requestTimer);this.requested=null;this.emit('error',{message:'对方未允许协作，请先共享整个屏幕并分别确认请求'});this.emit('state');return;}
            if(m.action==='stop'){
                if(this.hosts.get(peer)?.id===m.id)await this.stopHost(peer,'peer-stopped',false);
                if(this.requests.get(peer)?.id===m.id){this.requests.delete(peer);this.emit('state');}
                if(this.authorizing?.peer===peer&&this.authorizing.id===m.id){this.authorizeCancelled=true;await this.native?.stop(peer);}
                if(this.control?.peer===peer&&this.control.id===m.id)await this.stopControl('peer-stopped',false);
                if(this.requested?.peer===peer&&this.requested.id===m.id){clearTimeout(this.requestTimer);this.requested=null;this.emit('state');}return;
            }
            if(m.action==='input'){
                const h=this.hosts.get(peer);if(h?.id===m.id){if(!await this.native.input(h.token,m.seq,m.input))this.send(peer,{action:'busy',id:h.id});}
                else this.send(peer,{action:'stop',id:m.id});return;
            }
            if(m.action==='pointers'&&validCursors(m.cursors)){
                if(this.control?.peer===peer){if(this.control.actor&&!m.cursors.some(c=>c.id===this.control.actor)){await this.stopControl('permission-removed',false);}else this.control.lastHost=Date.now();}
                this.emit('cursors',{peer,cursors:m.cursors,ownerPeer:m.ownerPeer});return;
            }
            if(m.action==='busy'&&this.control?.peer===peer&&m.id===this.control.id)this.emit('busy',m);
        }
        sendInput(input){const c=this.control;if(c)this.send(c.peer,{action:'input',id:c.id,seq:++c.seq,input});}
        nativeEvent(m){
            if(m.type==='stopped'){
                const list=m.peer?[this.hosts.get(m.peer)].filter(Boolean):[...this.hosts.values()];for(const h of list){this.send(h.peer,{action:'stop',id:h.id});this.hosts.delete(h.peer);}this.emit('state');
                if(!this.hosts.size)for(const peer of this.call.peers.keys())this.send(peer,{action:'pointers',cursors:[],ownerPeer:null});
            }else if(m.type==='cursor'&&this.hosts.size){
                const cursors=[{id:'host',name:'共享方',color:'#31d5e7',x:m.x,y:m.y},...(m.participants||[])];if(!validCursors(cursors))return;
                for(const peer of this.call.peers.keys())this.send(peer,{action:'pointers',cursors,ownerPeer:m.ownerPeer});
            }else if(['busy','blocked'].includes(m.type)){const list=m.peer?[this.hosts.get(m.peer)].filter(Boolean):[...this.hosts.values()];for(const h of list)this.send(h.peer,{action:'busy',id:h.id,reason:m.type==='blocked'?'protected':m.reason,ownerPeer:m.ownerPeer});}
        }
        async stopHost(peer,reason='revoked',notify=true){const h=this.hosts.get(peer);if(!h)return;this.hosts.delete(peer);if(notify)this.send(peer,{action:'stop',id:h.id});await this.native?.stop(peer);this.emit('state',{reason});}
        async stopControl(reason='stopped',notify=true){const c=this.control;this.control=null;if(c&&notify)this.send(c.peer,{action:'stop',id:c.id});this.emit('state',{reason});}
        async removePeer(peer){if(this.hosts.has(peer))await this.stopHost(peer,'peer-left',false);this.requests.delete(peer);
            if(this.authorizing?.peer===peer){this.authorizeCancelled=true;await this.native?.stop(peer);}
            if(this.control?.peer===peer)await this.stopControl('peer-left',false);if(this.requested?.peer===peer){clearTimeout(this.requestTimer);this.requested=null;}this.emit('state');
        }
        async stop(reason='stopped',notify=true){const list=[...this.hosts.values(),...this.requests.values(),this.control,this.requested,this.authorizing].filter(Boolean);this.hosts.clear();this.requests.clear();this.control=null;this.requested=null;this.authorizeCancelled=true;clearTimeout(this.requestTimer);
            if(notify)for(const p of list)this.send(p.peer,{action:'stop',id:p.id});await this.native?.stop();this.emit('state',{reason});
        }
        async close(){clearInterval(this.timer);await this.stop();}
    }
    return {Remote,point,keyCode,validCursors};
});
