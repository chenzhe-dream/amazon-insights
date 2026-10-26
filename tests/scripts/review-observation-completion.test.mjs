import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewAnalysisFromRecords } from '../../scripts/lib/review-analysis-aggregate.mjs';
import { projectStageOutput } from '../../scripts/lib/sync-stage-output.mjs';
import { hasCompleteReviewRecord } from '../../scripts/lib/sync-cache.mjs';
import { projectFinalStageHashes } from '../../scripts/run-asin-sync-job.mjs';

const asin = 'B0GY49HWVP';
const empty = market => ({ asin, marketplace: market, status: 'pending', terminalReason: 'valid-empty', sampledReviews: 0, mentionTopics: 0, fetchedAt: '2026-10-26', blocks: [] });
const projection = (market, primary, secondary, enabled = true) => projectStageOutput('reviews', [asin], {
  marketplace: market, sellerSpriteReviewFallback: enabled, stageStatus: 'partial', dataAsins: [], updatedAt: '2026-10-26T12:00:00.000Z',
  readExport: (_file, name) => name === 'sorftimeReviewAnalysisData' ? {[asin]: primary} : name === 'sellerSpriteMcpReviewAnalysisData' ? {[asin]: secondary} : {},
});

for (const market of ['US', 'UK', 'DE', 'CA']) {
  test(`${market}: final publication retains empty and unclassified observations without promoting readiness`, () => {
    for (const secondary of [empty(market), {...empty(market), status:'ready', terminalReason:undefined, sampledReviews:1}]) {
      const output = projection(market, empty(market), secondary);
      const job = {jobId:'review-observation-publication', jobVersion:1, marketplace:market, asins:[asin],
        stages:[{id:'reviews',status:'partial'}], outputs:[output]};
      const replay = (stage, asins, options) => projectStageOutput(stage,asins,{...options,sellerSpriteReviewFallback:true,
        readExport:(_file,name)=>name==='sorftimeReviewAnalysisData'?{[asin]:empty(market)}:name==='sellerSpriteMcpReviewAnalysisData'?{[asin]:secondary}:{}});
      assert.deepEqual(projectFinalStageHashes(job.jobId,job,replay),{reviews:output.contentHash});
      const changed = {...secondary, sampledReviews:secondary.sampledReviews+1, status:'ready'};
      assert.throws(()=>projectFinalStageHashes(job.jobId,job,(stage,asins,options)=>projectStageOutput(stage,asins,{...options,sellerSpriteReviewFallback:true,
        readExport:(_file,name)=>name==='sorftimeReviewAnalysisData'?{[asin]:empty(market)}:name==='sellerSpriteMcpReviewAnalysisData'?{[asin]:changed}:{}})),/content differs from its source/);
    }
  });
  test(`${market}: samples without matched themes remain visible evidence, not completed analysis`, () => {
    const secondary = {...empty(market), status: 'ready', terminalReason: undefined, sampledReviews: 1};
    const output = projection(market, empty(market), secondary);
    assert.equal(output.data.analysisByAsin[asin]?.sampledReviews, 1);
    assert.equal(output.data.analysisByAsin[asin]?.sourceProvider, 'sellerSprite');
    assert.equal(hasCompleteReviewRecord(output.data.analysisByAsin[asin]), false);
    assert.deepEqual(output.gap.items.map(row => row.asin), [asin]);
  });
  test(`${market}: terminal fallback empty keeps provider attribution and its gap`, () => {
    const output = projection(market, empty(market), empty(market));
    assert.equal(output.data.analysisByAsin[asin]?.sourceProvider, 'sellerSprite');
    assert.equal(output.data.analysisByAsin[asin]?.terminalReason, 'valid-empty');
    assert.equal(hasCompleteReviewRecord(output.data.analysisByAsin[asin]), false);
    assert.equal(output.gap.items.length, 1);
  });
}

test('partial observations reject wrong identity, future dates, failed requests and disabled fallback', () => {
  for (const changes of [{marketplace:'US'}, {asin:'B000000001'}, {fetchedAt:'2026-10-27'}, {fetchedAt:'invalid'}, {status:'error'}, {status:'ready',sampledReviews:-1}]) {
    const output = projection('CA', empty('CA'), {...empty('CA'), ...changes});
    assert.notEqual(output.data.analysisByAsin[asin]?.sourceProvider, 'sellerSprite');
  }
  assert.notEqual(projection('CA', empty('CA'), empty('CA'), false).data.analysisByAsin[asin]?.sourceProvider, 'sellerSprite');
  assert.notEqual(projection('CA', {...empty('CA'),status:'error'}, empty('CA')).data.analysisByAsin[asin]?.sourceProvider, 'sellerSprite');
});

test('a current failed request is not hidden by an older successful empty observation', () => {
  for(const diagnostic of [{gapItems:[{asin,causeCode:'CONNECT_TIMEOUT'}]}, {gapReasonCode:'CONNECTOR_FAILED'}]) {
    const output=projectStageOutput('reviews',[asin],{marketplace:'CA',sellerSpriteReviewFallback:true,stageStatus:'partial',dataAsins:[],updatedAt:'2026-10-26T12:00:00.000Z',...diagnostic,
      readExport:(_file,name)=>name.includes('ReviewAnalysisData')?{[asin]:empty('CA')}:{}});
    assert.equal(output.data.analysisByAsin[asin],undefined);
    assert.equal(output.gap.items.length,1);
  }
});

test('generic review rules retain child and indoor balance usage with the actual sample denominator', () => {
  const record = buildReviewAnalysisFromRecords(asin, 'CA', [
    {star:4, title:'Fun Balance and Maze Challenge', content:"This is a fun twist on a regular balance board. Having the maze built into it gives kids something to focus on while they're balancing. Overall, it's a fun indoor activity that combines a little physical challenge with a puzzle."},
    {star:5, title:'Exercise balance', content:'My child is 4 years old and really likes it. He like to plays with it for a while every day after his bath.'},
  ], '2026-10-26', {family:'generic'});
  const rows = key => record.blocks.find(block => block.key === key).rows;
  assert.equal(rows('consumerProfile').find(row => row.label === '儿童使用')?.numerator, 2);
  assert.equal(rows('scenarios').find(row => row.label === '室内使用')?.sharePct, 50);
  assert.equal(rows('scenarios').find(row => row.label === '平衡活动')?.denominator, 2);
  assert.deepEqual(rows('unmet'), []);
  assert.deepEqual(rows('negatives'), []);
  assert.deepEqual(rows('motives'), []);
});

test('homeschooling breaks are a use scenario and a terse compliment supplies no six-dimension claims', () => {
  const record = buildReviewAnalysisFromRecords('B0H79SDS1R', 'CA', [{star:3,content:'Great for in between homeschooling breaks'}], '2026-10-26', {family:'generic'});
  assert.ok(record.blocks.find(block => block.key === 'scenarios').rows.some(row => row.label === '学习间隙休息'));
  const terse = buildReviewAnalysisFromRecords(asin, 'DE', [{star:5,content:'Super'}], '2026-10-26', {family:'generic'});
  assert.equal(hasCompleteReviewRecord(terse), false);
});

test('a comparison with cheaper versions is not evidence of poor durability', () => {
  const record = buildReviewAnalysisFromRecords('B0H79SDS1R', 'CA', [{star:3, content:'I bought this version even though there are cheaper versions. Great for in between homeschooling breaks.'}], '2026-10-26', {family:'generic'});
  assert.deepEqual(record.blocks.find(block => block.key === 'unmet').rows, []);
  const broken = buildReviewAnalysisFromRecords(asin, 'CA', [{star:2,content:'It broke and fell apart.'}], '2026-10-26', {family:'generic'});
  assert.ok(broken.blocks.find(block => block.key === 'unmet').rows.some(row => row.label === '耐用性'));
});
