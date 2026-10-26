// Offline only: replay saved provider envelopes through the real collector and projection.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runSellerSpriteReviewAnalysis } from '../build-sellersprite-review-analysis.mjs';
import { fetchSellerSpriteReviews } from '../lib/sellersprite-mcp-client.mjs';
import { readCachedDataExport, hasCompleteReviewRecord } from '../lib/sync-cache.mjs';
import { selectReviewEvidence, selectReviewFallbackAsins } from '../lib/uk-review-fallback.mjs';
import { projectStageOutput } from '../lib/sync-stage-output.mjs';

const evidence = path.resolve(process.argv[2]);
const destination = path.resolve(process.argv[3]);
assert.notEqual(evidence, destination);
assert.equal(fs.existsSync(destination), false, 'Use a fresh output directory to preserve prior evidence');
fs.mkdirSync(destination, {recursive:true});
const hashes = new Map();
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const track = file => { hashes.set(file, hash(file)); return file; };
function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
    const file=path.join(dir,entry.name);
    if (entry.isFile() && entry.name===name) return file;
    if (entry.isDirectory()) { const nested=findFile(file,name); if(nested) return nested; }
  }
}
const results=[];
for (const marketplace of ['US','UK','DE','CA']) {
  const prior=JSON.parse(fs.readFileSync(track(path.join(evidence,`${marketplace}-summary.json`)),'utf8'));
  const scope=path.join(evidence,marketplace,'data');
  const primary=readCachedDataExport(track(findFile(scope,'sorftime-review-analysis-data.ts')),'sorftimeReviewAnalysisData');
  const savedSecondary=readCachedDataExport(track(findFile(scope,'seller-sprite-mcp-review-analysis-data.ts')),'sellerSpriteMcpReviewAnalysisData');
  const asins=prior.rows.map(row=>row.asin);
  const selected=selectReviewFallbackAsins(asins,primary,{marketplace,enabled:true});
  const secondary={};
  const replayCalls=[];
  for(const asin of selected) {
    if (!fs.existsSync(path.join(evidence,`${marketplace}-${asin}-1.json`))) {
      assert.equal(savedSecondary[asin]?.asin,asin);
      assert.equal(savedSecondary[asin]?.marketplace,marketplace);
      assert.ok(hasCompleteReviewRecord(savedSecondary[asin]));
      secondary[asin]=savedSecondary[asin];
      continue;
    }
    const generated=await runSellerSpriteReviewAnalysis({
      key:'offline-replay-no-network',env:{AGENT_SYNC_MARKETPLACE:marketplace},asins:[asin],existing:{},
      fetchedAt:savedSecondary[asin].fetchedAt,writeFileSync:()=>{},wait:async()=>{},
      fetchReviews:(key,site,id,opts)=>fetchSellerSpriteReviews(key,site,id,{...opts,callTool:async(_key,tool,args)=>{
        const file=track(path.join(evidence,`${marketplace}-${id}-${args.page}.json`));
        const saved=JSON.parse(fs.readFileSync(file,'utf8'));
        assert.equal(saved.site,site);assert.equal(saved.asin,id);assert.equal(saved.tool,tool);assert.deepEqual(saved.args,args);
        replayCalls.push({asin:id,page:args.page});return saved.payload;
      }}),
    });
    assert.notEqual(generated[asin].status,'error');
    secondary[asin]=generated[asin];
  }
  const usable=asins.filter(asin=>hasCompleteReviewRecord(selectReviewEvidence(asin,marketplace,primary[asin],secondary[asin])));
  const output=projectStageOutput('reviews',asins,{marketplace,sellerSpriteReviewFallback:true,
    stageStatus:usable.length===asins.length?'done':'partial',dataAsins:usable,
    readExport:(_file,name)=>name==='sorftimeReviewAnalysisData'?primary:name==='sellerSpriteMcpReviewAnalysisData'?secondary:{},
  });
  const rows=asins.map(asin=>{const record=output.data.analysisByAsin[asin];return {asin,provider:record?.sourceProvider??'sorftime',samples:record?.sampledReviews??null,hasThemes:usable.includes(asin),dimensions:record?.blocks.filter(block=>block.rows.length).map(block=>block.key)??[],terminalReason:record?.terminalReason??null};});
  fs.writeFileSync(path.join(destination,`${marketplace}-stage-output.json`),JSON.stringify(output,null,2));
  results.push({marketplace,ready:usable.length,total:asins.length,replayedPages:replayCalls.length,newNetworkCalls:0,rows});
}
for(const [file,before] of hashes) assert.equal(hash(file),before);
const audit={createdAt:new Date().toISOString(),mode:'offline-saved-response-replay',newNetworkCalls:0,databaseWrites:0,originalEvidenceUnchanged:true,results,sourceHashes:Object.fromEntries(hashes)};
fs.writeFileSync(path.join(destination,'audit.json'),JSON.stringify(audit,null,2));
console.log(JSON.stringify({destination,results}));
