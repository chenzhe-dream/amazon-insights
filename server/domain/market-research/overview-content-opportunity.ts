import type {SellerSpriteDistRow} from './original-overview/sellersprite-market-niche';

/** Only four disjoint content buckets support combined coverage estimates. */
export function overviewContentOpportunity(rows:readonly SellerSpriteDistRow[]){
 const labels=['有A+有视频','有A+无视频','无A+有视频','无A+无视频'];
 const groups=labels.map(label=>rows.find(r=>r.label.replace(/\s/g,'')===label));
 const missing=labels.filter((_,i)=>!groups[i]).map(label=>`内容分组“${label}”缺失`);
 const hasProducts=groups.every(r=>typeof r?.products==='number'&&Number.isFinite(r.products)&&r.products>=0);
 const hasShares=groups.every(r=>typeof r?.unitsShare==='number'&&Number.isFinite(r.unitsShare)&&r.unitsShare>=0&&r.unitsShare<=100);
 if(!hasProducts)missing.push('内容分组商品数不完整');
 if(!hasShares)missing.push('内容分组销量份额不完整');
 const total=hasProducts?groups.reduce((n,r)=>n+r!.products!,0):0;
 if(hasProducts&&total===0)missing.push('内容分组商品数合计为0');
 const aplus=total>0?(groups[0]!.products!+groups[1]!.products!)/total*100:null;
 const video=total>0?(groups[0]!.products!+groups[2]!.products!)/total*100:null;
 const both=total>0?groups[0]!.products!/total*100:null;
 const lowShare=hasShares?groups.slice(1).reduce((n,r)=>n+r!.unitsShare!,0):null;
 const coverage=aplus===null||video===null?'A+与视频覆盖率待验证。':`A+覆盖率 ${aplus.toFixed(1)}%，视频覆盖率 ${video.toFixed(1)}%，两者都有的商品占比 ${both!.toFixed(1)}%。`;
 const conclusion=`${coverage}${lowShare===null?'低内容配置的销量份额待验证。':`低内容配置（非同时具备A+和视频）仍贡献 ${lowShare.toFixed(1)}% 销量。`} 内容与销量的相关性不代表因果关系。`;
 const opportunity=missing.length?'内容开发建议：已知分组继续展示；补齐独立分组、商品数和销量份额后，再判断内容补位机会。':aplus!<60||video!<60?`内容补位方向：优先验证${aplus!<60?'A+场景与尺寸说明':''}${aplus!<60&&video!<60?'及':''}${video!<60?'使用演示视频':''}；${lowShare!>=12?'低内容配置仍有成交，可做同类产品对照测试。':'低内容配置成交较少，不能仅凭覆盖率低断言强机会。'}`:'A+和视频覆盖均不低于60%，内容已是基础配置；开发重点应转向内容质量、场景证据和差异化表达。';
 return {conclusion,opportunity,missing};
}
