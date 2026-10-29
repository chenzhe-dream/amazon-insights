import {z} from 'zod';
import {PluginSiteSchema} from './plugin-collection-contracts';
const asin=z.string().regex(/^[A-Z0-9]{10}$/);
export const PluginCategoryPoolSourceSchema=z.object({
 snapshotId:z.string().regex(/^plugin-source:[a-f0-9]{64}$/),jobId:z.string().uuid(),node:z.string().regex(/^\d+$/),
 marketplace:PluginSiteSchema,collectedAt:z.string().datetime({offset:true}),
 asins:z.array(asin).length(150),basic:z.record(asin,z.record(z.string(),z.unknown())),
 membershipProvider:z.enum(['amazon-page','sorftime','unknown']),
}).strict().refine(value=>new Set(value.asins).size===150&&Object.keys(value.basic).every(id=>value.asins.includes(id)),'Plugin category members differ');
export type PluginCategoryPoolSource=z.infer<typeof PluginCategoryPoolSourceSchema>;
export const ShapePoolAcquisitionSchema=z.object({
 kind:z.enum(['plugin-category','mcp-fallback']),
 reason:z.enum(['matched','unavailable','unsupported-size','invalid-source']),
 membershipProvider:z.enum(['amazon-page','sorftime','unknown']),
 snapshotId:z.string().regex(/^plugin-source:[a-f0-9]{64}$/).optional(),jobId:z.string().uuid().optional(),
}).strict();
export type ShapePoolAcquisition=z.infer<typeof ShapePoolAcquisitionSchema>;
export const shapePoolFallbackLabels:Record<ShapePoolAcquisition['reason'],string>={matched:'已匹配同站点、同类目插件名单',unavailable:'无满足当前身份和刷新时间的插件名单', 'unsupported-size':'插件名单上限150，当前请求超出范围','invalid-source':'插件名单或币种校验未通过'};
export function describeShapePoolAcquisition(value:ShapePoolAcquisition){
 if(value.kind==='mcp-fallback')return `商品名单使用原 MCP：${shapePoolFallbackLabels[value.reason]}。`;
 const discovery=value.membershipProvider==='amazon-page'?'亚马逊类目页':value.membershipProvider==='sorftime'?'Sorftime 补充名单':'历史名单，发现来源未记录';
 return `商品名单使用当前类目插件快照；名单发现来源：${discovery}；商品字段来源：卖家精灵。缺失字段保持未知。`;
}
