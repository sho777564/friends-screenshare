'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {FileStore,safeName,CHUNK}=require('../desktop/file-store.cjs');
const {validMeta}=require('../public/files.js');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'friends-file-test-'));const store=new FileStore();t.after(async()=>{await store.close();assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'friends-file-test-'));await fs.rm(dir,{recursive:true,force:true});});return {dir,store};}
test('chunked binary and empty files keep exact SHA256 and never appear complete before finish',async t=>{
    const {dir,store}=await fixture(t);
    for(const size of [0,CHUNK-1,CHUNK,CHUNK*130+7]){
        const bytes=crypto.randomBytes(size),src=path.join(dir,'source-'+size),dst=path.join(dir,'received-'+size);await fs.writeFile(src,bytes);
        const source=await store.source(src),sink=await store.receive(dst,size);let n=0;
        while(n<size){const chunk=await store.read(source.token);assert(chunk.length<=CHUNK);n+=chunk.length;await store.write(sink.token,chunk);}
        await assert.rejects(fs.stat(dst),{code:'ENOENT'});const digest=await store.sourceEnd(source.token);assert.equal(digest,hash(bytes));
        const receipt=await store.finish(sink.token,digest);assert(store.receipts.has(receipt.receipt));assert.deepEqual(await fs.readFile(dst),bytes);
    }
});
test('cancel cleans partial file and preserves pre-existing destination',async t=>{
    const {dir,store}=await fixture(t),dst=path.join(dir,'keep.txt');await fs.writeFile(dst,'original');const sink=await store.receive(dst,8);await store.write(sink.token,Buffer.from('new'));
    await store.cancel(sink.token);assert.equal(await fs.readFile(dst,'utf8'),'original');assert.equal((await fs.readdir(dir)).length,1);
});
test('corrupt, truncated and oversized data cannot replace an existing file',async t=>{
    const {dir,store}=await fixture(t),dst=path.join(dir,'keep.txt');await fs.writeFile(dst,'original');const sink=await store.receive(dst,4);
    await assert.rejects(store.write(sink.token,Buffer.alloc(5)));await assert.rejects(store.finish(sink.token,hash(Buffer.from('data'))));await store.write(sink.token,Buffer.from('oops'));
    await assert.rejects(store.finish(sink.token,hash(Buffer.from('data'))),/校验失败/);await store.cancel(sink.token);assert.equal(await fs.readFile(dst,'utf8'),'original');
});
test('destination changes and source changes are detected',async t=>{
    const {dir,store}=await fixture(t),src=path.join(dir,'s'),dst=path.join(dir,'d');await fs.writeFile(src,'abc');const source=await store.source(src);await store.read(source.token);await fs.writeFile(src,'changed');await assert.rejects(store.sourceEnd(source.token),/发生变化/);
    const sink=await store.receive(dst,3);await store.write(sink.token,Buffer.from('abc'));await fs.writeFile(dst,'new user file');await assert.rejects(store.finish(sink.token,hash(Buffer.from('abc'))),/已改变/);assert.equal(await fs.readFile(dst,'utf8'),'new user file');
});
test('untrusted filename is a basename; invalid file metadata is rejected',()=>{
    assert.equal(safeName('../../evil.exe'),'evil.exe');assert.equal(safeName('C:\\secret\\CON.txt'),'_CON.txt');assert.equal(safeName('nul'),'_nul');
    assert.equal(validMeta({type:'offer',version:1,id:crypto.randomUUID(),name:'中文报告.pdf',size:1}),true);
    for(const size of [-1,NaN,Infinity,2**41,'7'])assert.equal(validMeta({type:'offer',version:1,id:crypto.randomUUID(),name:'a',size}),false);
});
test('folder and stale token are refused without opening arbitrary targets',async t=>{const {dir,store}=await fixture(t);await assert.rejects(store.source(dir));await assert.rejects(store.read('missing'));await assert.rejects(store.write('missing',new Uint8Array(3)));});
