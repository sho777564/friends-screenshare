'use strict';
// Disk handles stay in the main process. Renderers only receive opaque tokens.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const CHUNK=16384,MAX_SIZE=2**40;
function safeName(value){
    let name=path.win32.basename(String(value||'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,180);
    if(!name||name==='.'||name==='..')name='file';
    if(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))name='_'+name;
    return name;
}
function validSize(size){return Number.isSafeInteger(size)&&size>=0&&size<=MAX_SIZE;}
async function fingerprint(file){try{const s=await fs.stat(file);return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
class FileStore{
    constructor(){this.sources=new Map();this.sinks=new Map();this.receipts=new Map();}
    async source(file){
        if(this.sources.size>=32)throw new Error('待发送文件过多，请先完成或取消当前传输');
        if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('请从资源管理器拖入文件');
        const handle=await fs.open(file,'r');
        try{const stat=await handle.stat();if(!stat.isFile()||!validSize(stat.size))throw new Error('仅支持普通文件；文件夹请先压缩');
            const token=crypto.randomUUID();this.sources.set(token,{handle,size:stat.size,mtime:stat.mtimeMs,offset:0,hash:crypto.createHash('sha256'),busy:false});
            return {token,name:safeName(path.basename(file)),size:stat.size};
        }catch(e){await handle.close();throw e;}
    }
    async read(token){const s=this.sources.get(token);if(!s||s.busy)throw new Error('发送文件已关闭');s.busy=true;
        try{const data=Buffer.alloc(Math.min(CHUNK,s.size-s.offset));const {bytesRead}=await s.handle.read(data,0,data.length,s.offset);if(bytesRead!==data.length)throw new Error('发送中的文件发生变化，请重试');s.offset+=bytesRead;s.hash.update(data);return data;}finally{s.busy=false;}
    }
    async sourceEnd(token){const s=this.sources.get(token);if(!s||s.busy||s.offset!==s.size)throw new Error('文件尚未读完');
        const stat=await s.handle.stat();if(stat.size!==s.size||stat.mtimeMs!==s.mtime)throw new Error('发送中的文件发生变化，请重试');
        const digest=s.hash.digest('hex');this.sources.delete(token);await s.handle.close();return digest;
    }
    async sourceClose(token){const s=this.sources.get(token);if(s){this.sources.delete(token);await s.handle.close().catch(()=>{});}}
    async receive(destination,size){
        if(!validSize(size)||typeof destination!=='string'||!path.isAbsolute(destination))throw new Error('无效的接收文件');
        if(this.sinks.size>=8)throw new Error('同时接收的文件过多');
        const token=crypto.randomUUID(),temporary=path.join(path.dirname(destination),'.'+safeName(path.basename(destination))+'.'+token+'.friends-part');
        const before=await fingerprint(destination),handle=await fs.open(temporary,'wx');
        this.sinks.set(token,{handle,destination,temporary,before,size,offset:0,hash:crypto.createHash('sha256'),busy:false});return {token,name:path.basename(destination)};
    }
    async write(token,bytes){const s=this.sinks.get(token);if(!s||s.busy)throw new Error('接收文件已关闭');
        if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>CHUNK||s.offset+bytes.byteLength>s.size)throw new Error('文件分块大小不正确');
        s.busy=true;try{let n=0;while(n<bytes.byteLength){const r=await s.handle.write(bytes,n,bytes.byteLength-n,s.offset+n);if(!r.bytesWritten)throw new Error('无法写入文件');n+=r.bytesWritten;}s.hash.update(bytes);s.offset+=bytes.byteLength;return s.offset;}finally{s.busy=false;}
    }
    async finish(token,digest){const s=this.sinks.get(token);if(!s||s.busy||s.offset!==s.size)throw new Error('文件接收不完整');
        if(!/^[a-f0-9]{64}$/.test(digest)||s.hash.digest('hex')!==digest)throw new Error('文件校验失败，请重新发送');
        if(await fingerprint(s.destination)!==s.before)throw new Error('保存位置的文件已改变，请重新接收并选择其他文件名');
        await s.handle.sync();await s.handle.close();s.handle=null;
        await fs.rename(s.temporary,s.destination);this.sinks.delete(token);
        const receipt=crypto.randomUUID();this.receipts.set(receipt,s.destination);if(this.receipts.size>100)this.receipts.delete(this.receipts.keys().next().value);
        return {receipt,name:path.basename(s.destination)};
    }
    async cancel(token){const s=this.sinks.get(token);if(s){this.sinks.delete(token);await s.handle?.close().catch(()=>{});await fs.unlink(s.temporary).catch(()=>{});}}
    async close(){await Promise.all([...this.sources.keys()].map(t=>this.sourceClose(t)));await Promise.all([...this.sinks.keys()].map(t=>this.cancel(t)));}
}
module.exports={FileStore,safeName,validSize,CHUNK};
