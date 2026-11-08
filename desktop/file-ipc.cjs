'use strict';
const path=require('node:path'),fs=require('node:fs/promises'),crypto=require('node:crypto');
const {FileStore,safeName,validSize}=require('./file-store.cjs');
module.exports=function installFiles({ipcMain,guarded,dialog,shell,app,window,testMode}){
    const store=new FileStore(),pending=new Map();const diagnostic=e=>testMode&&(e.senderFrame.url.includes('/file-test.html')||e.senderFrame.url.includes('/multi-test.html'));
    const serial=(token,work)=>{const task=(pending.get(token)||Promise.resolve()).catch(()=>{}).then(work);pending.set(token,task);task.finally(()=>{if(pending.get(token)===task)pending.delete(token);}).catch(()=>{});return task;};
    ipcMain.handle('files:source',guarded((e,file)=>store.source(file)));
    ipcMain.handle('files:fixture-source',guarded((e,file)=>{
        const dir=path.resolve(__dirname,'../.run/file-test')+path.sep;
        if(!diagnostic(e)||typeof file!=='string'||!path.resolve(file).startsWith(dir))throw new Error('Diagnostics only');
        return store.source(file);
    }));
    ipcMain.handle('files:read',guarded((e,token)=>serial(token,()=>store.read(token))));
    ipcMain.handle('files:source-end',guarded((e,token)=>serial(token,()=>store.sourceEnd(token))));
    ipcMain.handle('files:source-close',guarded((e,token)=>serial(token,()=>store.sourceClose(token))));
    ipcMain.handle('files:accept',guarded(async(e,meta)=>{
        if(!meta||typeof meta.name!=='string'||meta.name.length>255||!validSize(meta.size))throw new Error('文件信息不正确');
        let destination;
        if(diagnostic(e)){
            const dir=path.join(__dirname,'../.run/file-test/received');await fs.mkdir(dir,{recursive:true});destination=path.join(dir,crypto.randomUUID()+'-'+safeName(meta.name));
        }else{
            const result=await dialog.showSaveDialog(window(),{title:'接收文件 · '+safeName(meta.name),defaultPath:path.join(app.getPath('downloads'),safeName(meta.name)),buttonLabel:'接收并保存',properties:['showOverwriteConfirmation','createDirectory','dontAddToRecent']});
            if(result.canceled||!result.filePath)return null;destination=result.filePath;
        }
        return store.receive(destination,meta.size);
    }));
    ipcMain.handle('files:write',guarded((e,token,bytes)=>serial(token,()=>store.write(token,bytes))));
    ipcMain.handle('files:finish',guarded((e,token,digest)=>serial(token,()=>store.finish(token,digest))));
    ipcMain.handle('files:cancel',guarded((e,token)=>serial(token,()=>store.cancel(token))));
    ipcMain.handle('files:reveal',guarded((e,receipt)=>{const file=store.receipts.get(receipt);if(file)shell.showItemInFolder(file);}));
    // Synthetic fixture creation is unavailable to the normal client.
    ipcMain.handle('files:fixture',guarded(async(e,size)=>{
        if(!diagnostic(e)||!Number.isSafeInteger(size)||size<0||size>32*1024*1024)throw new Error('Diagnostics only');
        const dir=path.join(__dirname,'../.run/file-test');await fs.mkdir(dir,{recursive:true});const file=path.join(dir,crypto.randomUUID()+'.bin');
        const bytes=crypto.randomBytes(size);await fs.writeFile(file,bytes);return {file,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size};
    }));
    let closing=false;
    app.on('before-quit',event=>{if(closing)return;event.preventDefault();closing=true;Promise.allSettled([...pending.values()]).then(()=>store.close()).finally(()=>app.quit());});
    return store;
};
