import assert from 'node:assert/strict';import test from 'node:test';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {MarketOverviewDistributions} from '../../app/market-overview-distributions';import {overviewDistributionDetails} from './helpers/market-overview-page-fixture';
import {MarketOverviewConcentrationChart} from '../../app/market-overview-concentration-chart';
import {normalizeMarketOverviewDistribution} from '../../server/domain/market-research/overview-distributions';
test('reference distribution block plots only known source shares and preserves full source table',()=>{const entries=overviewDistributionDetails().numbers.distributions!;const html=renderToStaticMarkup(<MarketOverviewDistributions entries={entries}/>);assert.match(html,/ss-report-block/);assert.match(html,/ss-dist-chart/);assert.match(html,/50%/);assert.doesNotMatch(html,/99\.9%/);assert.match(html,/来源分组/);});

test('long provider group names stay within the mobile viewport',async()=>{
 const {readFile}=await import('node:fs/promises'),{chromium}=await import('playwright');
 const entries=overviewDistributionDetails().numbers.distributions!;
 entries[0].distribution!.rows[0].label='VeryLongBrandNameWithoutAnySpaces'.repeat(5);
 const css=await readFile(new URL('../../app/market-ui-reference.css',import.meta.url),'utf8')+'\n'+(await readFile(new URL('../../app/market-research.css',import.meta.url),'utf8')).replace('@import "./market-ui-reference.css";','');
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.setContent(`<style>${css}</style><main class="market-ui-reference">${renderToStaticMarkup(<MarketOverviewDistributions entries={entries}/>)}</main>`);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'long group chips must wrap inside their card');
 }finally{await browser.close();}
});

test('restored concentration chart remains usable on desktop and mobile',async()=>{
 const {readFile,mkdir}=await import('node:fs/promises'),{chromium}=await import('playwright');
 const distribution=normalizeMarketOverviewDistribution('market_brand_concentration',{data:[
  {brand:'VeryLongBrandNameWithoutAnySpaces'.repeat(3),asins:['B000000001'],products:1,totalUnits:20},
  {brand:'Fixture',asins:['B000000002'],products:1,totalUnits:30},
 ]});
 const css=await readFile(new URL('../../app/market-ui-reference.css',import.meta.url),'utf8')+'\n'+(await readFile(new URL('../../app/market-research.css',import.meta.url),'utf8')).replace('@import "./market-ui-reference.css";','');
 const html=renderToStaticMarkup(<MarketOverviewConcentrationChart rows={distribution.rows.filter(row=>row.group==='sample')} kind="brand" headTopN={10} currency={null}/>);
 const browser=await chromium.launch({headless:true});const out='test-results/market-ui-parity';await mkdir(out,{recursive:true});
 try{const page=await browser.newPage({viewport:{width:1440,height:1050}});
  await page.setContent(`<style>${css}</style><main class="market-ui-reference"><section class="ss-report-block">${html}</section></main>`);
  await page.screenshot({path:`${out}/concentration-chart-desktop.png`});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'concentration chart must fit the mobile viewport');
  await page.screenshot({path:`${out}/concentration-chart-mobile.png`});
 }finally{await browser.close();}
});
