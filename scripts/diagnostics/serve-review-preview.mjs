import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const file=path.resolve(process.argv[2]);
assert.equal(path.basename(file),'ca-review-acceptance.html');
const html=fs.readFileSync(file);
http.createServer((request,response)=>{
  if(request.method!=='GET'&&request.method!=='HEAD'){response.writeHead(405);response.end();return;}
  const pathname=new URL(request.url,'http://127.0.0.1').pathname;
  if(pathname!=='/'&&pathname!=='/ca-review-acceptance.html'){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
    'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"});
  response.end(request.method==='HEAD'?undefined:html);
}).listen(33900,'127.0.0.1',()=>console.log(JSON.stringify({mode:'read-only-review-preview',port:33900,pid:process.pid,file})));
