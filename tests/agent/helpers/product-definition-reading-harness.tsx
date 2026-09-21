import React from 'react';
import { createRoot } from 'react-dom/client';
import { LocalProductDefinitionSection } from '../../../app/local-product-definition-section';
import { buildProductLaunchAnalysis } from '../../../app/product-launch-analysis';
import { buildFinalProductDefinition } from '../../../app/final-product-definition';
import '../../../app/globals.css';
import '../../../app/warm-theme.css';
import '../../../app/comparison-layout.css';

const asin='B0DDX8MYKQ';
const original='约占25%，居家装饰和日常香氛；代表评论：Perfect addition to my living room。'.repeat(12);
const sources={keywordDemand:null,manualVocByAsin:{[asin]:{asin,attention:[],positives:[],negatives:[],unmet:[],
  audiences:[`居家装饰爱好者｜${original}`,'香氛爱好者｜日常香氛','礼物赠送者｜节日礼物','办公室用户｜桌面装饰','儿童｜不推荐独立操作，须成人监护'],
  scenarios:[`客厅｜${original}`,'浴室｜禁止接触水，使用环境待核对'],motives:[],captureStatus:'dialog' as const,
  alexaReport:{title:'Fixture',asin,captureStatus:'dialog' as const,rating:4,reviewCount:100,prompt:'fixture',overallConclusion:'测试样例'}}}};
const products=[{asin,brand:'测试商品',title:'Candle warmer lamp',rankCategory:'Home & Kitchen',subRankCategory:'Candle Lamps'}];
const analysis=buildProductLaunchAnalysis(products,sources);
const report=buildFinalProductDefinition({categoryLabel:analysis.meta.categoryLabel,productCount:1,dataMonth:analysis.meta.dataMonth,vocPositioning:analysis.vocPositioning,keyword:analysis.keywordConclusions,hasVocData:true});
report.definitionRows.find(row=>row.dimension==='目标人群/年龄')!.action='产品：优化底座；包装：调整内衬；运营：核对图文；质检：复测稳定性；禁止用于冰面；仅限成人监督使用';
report.crossRows=[{theme:'装饰体验',vocEvidence:original,keywordEvidence:'candle warmer lamp',marketDemand:'待验证',userValue:'方便使用',competition:'待核对',judgment:'验证体验',role:'体验优化',priority:'P1'}];
report.featureLayers.mustHave=[{item:'装饰体验',evidence:original}];
report.featureLayers.differentiation=[{item:'调节便利性待验证；先核对实际结构再决定是否承接',evidence:original}];
report.featureLayers.optional=[{item:'外观配色作为可选方案',evidence:'当前样例只展示分层阅读方式，不代表真实产品需求'}];
report.featureLayers.notInV1=[{item:'缺乏来源支持的新增功能暂不进入首版',evidence:'需补充当前商品的实际使用问题'}];
report.featureLayers.p0Avoid=[{item:'禁止将关键词年龄直接作为商品适龄',evidence:'以商品说明、使用条件和可靠测试为准'}];
report.keywordGroups=[{type:'场景词',keywords:'living room decor; candle warmer lamp; office decor; '.repeat(10),productLink:'围绕已有装饰场景验证使用体验；不能单凭搜索词认定浴室适用',listingAngle:'描述已有使用场景；不要承诺未经验证的配置',skuHint:'适用条件待核对'}];
report.priorityRows=[{priority:'P1',direction:'装饰体验',evidence:original,businessImpact:'改善体验',action:'产品：优化底座；包装：调整内衬；运营：核对图文；质检：复测稳定性；验收：记录实测结果',acceptance:'验收条件必须明确；核对实测结果后确认；记录稳定性和温升；没有实测数据时不得标记通过。'}];
report.risks=['搜索人群不等于商品适龄；使用边界需核对商品说明，不能跨产品借用结论。','浴室环境适用性待验证；禁止在证据不足时扩展为防水功能。'];
report.nextValidations=['先核对输入及来源；再对当前商品验证结构；按候选自己的依据确认功能。','补充验收条件；记录测试方法与结果；核对后再决定开发范围。'];
createRoot(document.getElementById('root')!).render(<div style={{padding:24,maxWidth:1540,margin:'auto'}}><p>本地测试样例 · 非真实分析结论</p><LocalProductDefinitionSection products={[]} sources={sources} savedReport={report}/></div>);
