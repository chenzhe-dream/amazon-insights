import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketSourceQuotaNotice} from '../../app/market-source-quota-notice';
import {marketSourceQuotaNotice,type QuotaStep} from '../../app/lib/market-source-quota';
const step:QuotaStep={current:true,status:'failed',kind:'collect-product-history',errorCode:'quota-exhausted'};
test('business-visible notice covers all four Sorftime research sources and preserves saved results',()=>{
 for(const source of [{kind:'collect-shape-pool'},{kind:'collect-customer-themes'},{kind:'collect-keyword-trend'},{kind:'collect-overview-month',externalStage:'sales'},{kind:'collect-overview-month',industryDemand:true,sourceProvider:'sorftime' as const}]){
  const html=renderToStaticMarkup(<MarketSourceQuotaNotice run={{steps:[{...step,...source}]}}/>);
  assert.match(html,/role="alert"/);assert.match(html,/Sorftime 暂无额度，请联系管理员/);assert.match(html,/已保存的数据和分析结果仍可查看/);
 }
});
test('non-quota and stale attempts do not imply exhausted quota; other providers are not mislabeled Sorftime',()=>{
 for(const patch of [{current:false},{status:'succeeded'},{errorCode:'timeout'},{errorCode:'saved-source-missing'},{errorCode:null}])assert.equal(marketSourceQuotaNotice([{...step,...patch}]),null);
 for(const patch of [{kind:'collect-overview-month',externalStage:'profits'},{kind:'collect-overview-month',industryDemand:true},{kind:'collect-keyword-aba'}]){
  const message=marketSourceQuotaNotice([{...step,...patch}]);assert.match(message!,/请联系管理员/);assert.doesNotMatch(message!,/Sorftime/);
 }
});
