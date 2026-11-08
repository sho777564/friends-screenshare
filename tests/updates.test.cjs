'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {Updates,canonical}=require('../desktop/updates.cjs');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const pair=crypto.generateKeyPairSync('ed25519');
function signed(release){return {release,signature:crypto.sign(null,canonical(release),pair.privateKey).toString('base64')};}
async function fixture(t){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'Friends update test '));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const contents={};const server=http.createServer((req,res)=>{const value=contents[req.url];res.writeHead(value?200:404,{'Content-Type':'application/json'});res.end(value||'');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
    return {root,contents,source:'http://127.0.0.1:'+server.address().port+'/latest.json',engine:new Updates({appRoot:root,version:'2.6.0',publicKey:pair.publicKey,fetch})};
}
test('real HTTP checks accept signed releases and refuse tampering, unsafe URLs and incompatible versions',async t=>{
    const {contents,source,engine}=await fixture(t);
    const release={version:'2.7.0',minimumVersion:'2.6.0',url:'patch.zip',bytes:100,sha256:'a'.repeat(64),notes:'Upgrade'};
    await engine.configure(source);contents['/latest.json']=JSON.stringify(signed(release));assert.equal((await engine.check()).state,'available');
    const tampered=signed(release);tampered.release.version='9.9.9';contents['/latest.json']=JSON.stringify(tampered);assert.match((await engine.check()).message,/签名/);
    contents['/latest.json']=JSON.stringify(signed({...release,url:'http://public.invalid/patch.zip'}));assert.match((await engine.check()).message,/HTTPS/);
    contents['/latest.json']=JSON.stringify(signed({...release,minimumVersion:'2.6.1'}));assert.match((await engine.check()).message,/全量/);
    contents['/latest.json']=JSON.stringify(signed({...release,version:'2.6.0'}));assert.equal((await engine.check()).state,'latest');
    await assert.rejects(engine.configure('https://user:password@example.org/latest.json'),/HTTPS/);
});
test('incorrect download size or hash never produces an installable update',async t=>{
    const {contents,source,engine}=await fixture(t);const zip=Buffer.from('broken zip');
    contents['/patch.zip']=zip;contents['/latest.json']=JSON.stringify(signed({version:'2.7.0',minimumVersion:'2.6.0',url:'patch.zip',bytes:zip.length,sha256:'0'.repeat(64)}));
    await engine.configure(source);await engine.check();assert.match((await engine.download()).message,/校验/);assert.equal(engine.ready,null);
    contents['/latest.json']=JSON.stringify(signed({version:'2.7.0',minimumVersion:'2.6.0',url:'patch.zip',bytes:3,sha256:sha(zip)}));
    await engine.check();assert.match((await engine.download()).message,/大小/);assert.equal(engine.ready,null);
});
test('signed stage refuses altered payload and traversal and blocks same-version installation',async t=>{
    const {root,engine}=await fixture(t);const stage=path.join(root,'stage');await fs.mkdir(path.join(stage,'payload'),{recursive:true});
    const pkg=Buffer.from(JSON.stringify({name:'friends-screen-share-desktop',version:'2.7.0'}));await fs.writeFile(path.join(stage,'payload/package.json'),pkg);
    await fs.writeFile(path.join(stage,'Update-Friends.ps1'),'trusted installer');await fs.writeFile(path.join(stage,'Update-Friends.cmd'),'trusted launcher');
    async function seal(entries){
        const manifest=Buffer.from(JSON.stringify({version:'2.7.0',files:entries}));await fs.writeFile(path.join(stage,'update-manifest.json'),manifest);
        await fs.writeFile(path.join(stage,'release-signature.json'),JSON.stringify(signed({version:'2.7.0',manifestSha256:sha(manifest),installerSha256:sha('trusted installer'),launcherSha256:sha('trusted launcher')})));
    }
    await seal([{path:'package.json',sha256:sha(pkg)}]);assert.equal((await engine.validateStage(stage)).version,'2.7.0');
    await fs.writeFile(path.join(stage,'payload/package.json'),'corrupt');await assert.rejects(engine.validateStage(stage),/校验/);
    await seal([{path:'../escape',sha256:'0'.repeat(64)}]);await assert.rejects(engine.validateStage(stage),/校验/);
    engine.version='2.7.0';await assert.rejects(engine.validateStage(stage),/版本/);
});
