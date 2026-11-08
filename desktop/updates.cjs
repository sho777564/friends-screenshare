'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');

const canonical=value=>Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]]))));
function versionParts(value) {
    if(typeof value!=='string'||!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value))throw new Error('版本号无效');
    return value.split('.').map(Number);
}
function compare(a,b){const x=versionParts(a),y=versionParts(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;return 0;}
function sourceURL(value){const url=new URL(value);if(url.username||url.password||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new Error('更新地址需要 HTTPS');return url;}
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function hashFile(file){return sha(await fs.readFile(file));}
function runScript(script,args){return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,...args],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let error='';child.stderr.on('data',data=>{if(error.length<4000)error+=data.toString();});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('更新包准备失败：'+error.slice(-500))));
});}

class Updates {
    constructor({appRoot,version,publicKey,fetch,notify=()=>{}}){
        this.root=appRoot;this.version=version;this.publicKey=publicKey;this.fetch=fetch;this.notify=notify;
        this.directory=path.join(appRoot,'.run','updates');this.config=path.join(appRoot,'.run','update-source.json');
        this.status={state:'idle',currentVersion:version};this.release=null;this.ready=null;this.busy=false;
    }
    set(state,extra={}){this.status={state,currentVersion:this.version,...extra};this.notify(this.status);return this.status;}
    async source(){
        for(const file of [this.config,path.join(this.root,'public','update-channel.json')]){
            try{const data=JSON.parse(await fs.readFile(file,'utf8'));if(data.url)return sourceURL(data.url).href;}catch(error){if(error.code!=='ENOENT')throw error;}
        }
        return '';
    }
    async snapshot(){
        if(this.status.state==='idle'){
            const last=await this.lastInstall();
            if(last?.ok===false)this.set('error',{message:'上次更新失败，已尝试恢复旧文件：'+String(last.message).slice(0,300)});
        }
        return {...this.status,source:await this.source()};
    }
    async lastInstall(){
        try { return JSON.parse((await fs.readFile(path.join(this.directory,'last-install.json'),'utf8')).replace(/^\uFEFF/,'')); }
        catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;return null;}
    }
    async configure(value){
        if(this.busy)throw new Error('正在处理更新，请稍候');
        if(typeof value!=='string'||value.length>2048)throw new Error('更新地址无效');
        const url=value.trim()?sourceURL(value.trim()).href:'';
        await fs.mkdir(path.dirname(this.config),{recursive:true});await fs.writeFile(this.config,JSON.stringify({url}));
        this.ready=null;this.release=null;
        const source=await this.source();
        return this.set(source?'idle':'unconfigured',{source});
    }
    async read(response,limit,progress=()=>{}){
        if(!response.ok)throw new Error('更新服务返回 '+response.status);
        if(response.url)sourceURL(response.url);
        const reader=response.body.getReader(),chunks=[];let total=0;
        try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>limit)throw new Error('更新文件超过大小限制');chunks.push(Buffer.from(value));progress(total);}}
        catch(error){await reader.cancel().catch(()=>{});throw error;}
        return Buffer.concat(chunks,total);
    }
    verify(payload,signature){
        if(typeof signature!=='string'||!crypto.verify(null,canonical(payload),this.publicKey,Buffer.from(signature,'base64')))throw new Error('更新签名校验失败');
    }
    async check(){
        if(this.busy||this.ready)return this.status;
        this.busy=true;
        try{
            const source=await this.source();if(!source)return this.set('unconfigured');
            this.set('checking');
            const response=await this.fetch(source,{signal:AbortSignal.timeout(15000),cache:'no-store'});
            const signed=JSON.parse((await this.read(response,256000)).toString('utf8'));
            this.verify(signed.release,signed.signature);const release=signed.release;
            versionParts(release.version);
            if(compare(release.version,this.version)<=0)return this.set('latest',{version:this.version});
            if(compare(this.version,release.minimumVersion)<0)throw new Error('当前版本需要使用全量安装包升级');
            if(!/^[0-9a-f]{64}$/.test(release.sha256)||!Number.isSafeInteger(release.bytes)||release.bytes<=0||release.bytes>32*1024*1024)throw new Error('更新信息无效');
            const url=sourceURL(new URL(release.url,source).href).href;
            this.release={...release,url};
            return this.set('available',{version:release.version,notes:String(release.notes||'').slice(0,2000),bytes:release.bytes});
        }catch(error){return this.set('error',{message:error.message});}finally{this.busy=false;}
    }
    async validateStage(stage){
        const signed=JSON.parse(await fs.readFile(path.join(stage,'release-signature.json'),'utf8'));
        this.verify(signed.release,signed.signature);const release=signed.release;versionParts(release.version);
        if(compare(release.version,this.version)<=0)throw new Error('更新包版本不高于当前版本');
        const manifestFile=path.join(stage,'update-manifest.json');
        if(await hashFile(manifestFile)!==release.manifestSha256 || await hashFile(path.join(stage,'Update-Friends.ps1'))!==release.installerSha256 || await hashFile(path.join(stage,'Update-Friends.cmd'))!==release.launcherSha256)throw new Error('更新文件校验失败');
        const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
        if(manifest.version!==release.version||!Array.isArray(manifest.files)||manifest.files.length>4000)throw new Error('更新清单无效');
        const base=path.resolve(stage,'payload')+path.sep;
        for(const entry of manifest.files){
            if(typeof entry.path!=='string'||!entry.path||entry.path.includes(':'))throw new Error('更新路径无效');
            const file=path.resolve(base,entry.path);
            if(!file.toLowerCase().startsWith(base.toLowerCase())||await hashFile(file)!==entry.sha256)throw new Error('更新内容校验失败');
        }
        const pkg=JSON.parse(await fs.readFile(path.join(base,'package.json'),'utf8'));
        if(pkg.name!=='friends-screen-share-desktop'||pkg.version!==release.version)throw new Error('更新包不适用于同屏');
        return release;
    }
    async stageArchive(archive,{automatic=false,expectedVersion}={}){
        const stage=path.join(this.directory,'stage-'+crypto.randomUUID());
        await runScript(path.join(this.root,'desktop','stage-update.ps1'),['-Archive',archive,'-Destination',stage]);
        const entries=await fs.readdir(stage,{withFileTypes:true});
        if(entries.length!==1||!entries[0].isDirectory())throw new Error('更新包目录不完整');
        const folder=path.join(stage,entries[0].name);
        const release=await this.validateStage(folder);
        if(expectedVersion&&release.version!==expectedVersion)throw new Error('下载的更新包与版本公告不一致');
        this.ready={stage:folder,release};
        return this.set('ready',{version:release.version,automatic});
    }
    async download(automatic=false){
        if(this.busy||!this.release)return this.status;
        this.busy=true;
        try{
            const release=this.release;
            if(automatic){
                const last=await this.lastInstall();
                if(last?.ok===false&&last.version===release.version){
                    return this.set('available',{version:release.version,notes:'此版本上次安装失败。可在空闲时点「下载并重启更新」手动重试。',bytes:release.bytes});
                }
            }
            this.set('downloading',{version:release.version,received:0,total:release.bytes});
            const response=await this.fetch(release.url,{signal:AbortSignal.timeout(180000),cache:'no-store'});
            const data=await this.read(response,release.bytes,received=>this.set('downloading',{version:release.version,received,total:release.bytes}));
            if(data.length!==release.bytes||sha(data)!==release.sha256)throw new Error('下载的更新包校验失败');
            await fs.mkdir(this.directory,{recursive:true});const file=path.join(this.directory,'download-'+crypto.randomUUID()+'.zip');
            await fs.writeFile(file,data,{flag:'wx'});return await this.stageArchive(file,{automatic,expectedVersion:release.version});
        }catch(error){return this.set('error',{message:error.message});}finally{this.busy=false;}
    }
    async local(file){
        if(this.busy)return this.status;this.busy=true;
        try{if((await fs.stat(file)).size>32*1024*1024)throw new Error('请选择轻量更新包');return await this.stageArchive(file);}
        catch(error){return this.set('error',{message:error.message});}finally{this.busy=false;}
    }
    async install(quit){
        if(!this.ready||this.busy)throw new Error('请先下载并校验更新包');
        this.busy=true;
        try {
        await this.validateStage(this.ready.stage);
        await fs.mkdir(this.directory,{recursive:true});
        const marker=path.join(this.directory,'ready-'+crypto.randomUUID()+'.txt');
        await runScript(path.join(this.root,'desktop','launch-update.ps1'),['-ParentId',String(process.pid),'-Target',this.root,'-Package',this.ready.stage,'-ReadyFile',marker]);
        let ready=false;
        for(let attempt=0;attempt<80;attempt++){
            try{ready=(await fs.readFile(marker,'utf8')).trim()==='ready';}catch(error){if(error.code!=='ENOENT')throw error;}
            if(ready)break;
            await new Promise(resolve=>setTimeout(resolve,100));
        }
        if(!ready)throw new Error('更新程序未能启动，客户端保持打开，请稍后重试');
        this.set('installing',{version:this.ready.release.version});setTimeout(quit,150);return this.status;
        }catch(error){this.busy=false;throw error;}
    }
}
module.exports={Updates,canonical,compare,sourceURL};
