'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
module.exports = function startServer(port = 3023) {
    const root = path.join(__dirname, 'public');
    const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.wasm':'application/wasm', '.svg':'image/svg+xml','.json':'application/json; charset=utf-8' };
    const server = http.createServer((req,res) => {
        if (!['localhost:'+port,'127.0.0.1:'+port].includes(req.headers.host)) { res.writeHead(403).end(); return; }
        let pathname; try { pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
        if (pathname === '/health') { res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({app:'friends-desktop',version:require('./package.json').version})); return; }
        if (pathname === '/fixture-tone-state') { res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({active:server.fixtureTone===true}));return; }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
        const file = path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
        if (!file.startsWith(root+path.sep)) { res.writeHead(403).end(); return; }
        fs.stat(file,(error,stat) => {
            if (error || !stat.isFile()) { res.writeHead(404).end(); return; }
            res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https://p2p.mirotalk.com wss://p2p.mirotalk.com; media-src 'self' blob:; img-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"});
            if (req.method==='HEAD') res.end(); else fs.createReadStream(file).pipe(res);
        });
    });
    return new Promise((resolve,reject) => { server.once('error',reject); server.listen(port,'127.0.0.1',()=>resolve(server)); });
};
if (require.main === module) module.exports().then(()=>console.log('http://localhost:3023')).catch(error=>{console.error(error.message);process.exitCode=1;});
