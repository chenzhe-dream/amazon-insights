// Throwaway prototype of the approved category > module > history hierarchy.
// Run: node app/prototypes/category-favorites/serve.cjs
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const source='C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/verification/20261013-market-favorites-v2/duplicate-audit/audit.json';
const audit=JSON.parse(fs.readFileSync(source,'utf8'));
const names={'1063294':'Floor Lamps','3405881':'后院投斧游戏','166423011':'儿童健身器材','16184244011':'儿童游乐场健身器材','3413711':'标靶和配件'};
const records=audit.groups.flatMap(g=>g.rows).map(r=>({id:r.id,category:r.leaf,name:names[r.leaf]||'类目 '+r.leaf,site:r.scope.marketplace,module:r.module,from:r.scope.fromMonth,to:r.scope.toMonth,period:r.scope.overviewPeriod,status:r.status,created:r.created_at,pool:r.params.poolSize??r.params.sampleSize,head:r.params.headTopN,newMonths:r.params.newProductMonths,flow:r.params.flow,candidate:audit.candidates.some(c=>c.runId===r.id),keep:audit.candidates.find(c=>c.runId===r.id)?.keepRunId,linked:r.linked}));
for(const f of audit.favorites.filter(f=>f.group_name==='旧版收藏')){const s=f.context_json.overview;records.push({id:f.id,category:s.nodeIdPath.split(':').at(-1),name:names[s.nodeIdPath.split(':').at(-1)]||f.title,site:s.marketplace,module:'overview',from:s.fromMonth,to:s.toMonth,status:'conditions',created:f.created_at,condition:true,candidate:false});}
const data=JSON.stringify(records).replace(/</g,'\\u003c');
http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/data.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'});return res.end('window.RECORDS='+data+';');}
 if(url.pathname==='/'||url.pathname==='/category-favorites-prototype.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(fs.readFileSync(path.join(__dirname,'category-favorites-prototype.html')));}
 res.writeHead(404);res.end('Not found');
}).listen(32910,'127.0.0.1',()=>console.log('Prototype: http://127.0.0.1:32910/category-favorites-prototype.html'));
