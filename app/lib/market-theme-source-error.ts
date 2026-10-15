// Shared wording for saved sample failures and live task steps; no source counts are changed.
const labels:Record<string,string>={
 'unsupported-marketplace':'此站点暂无该补充数据',
 'upstream-temporary':'上游暂时不可用',timeout:'处理超时',interrupted:'执行中断',
 authentication:'来源认证失败',governance:'调用受到额度或治理限制',
 'quota-exhausted':'数据源额度已耗尽，新采集已暂停；已保存报告仍可查看','rate-limit':'数据源限流，请稍后重试','local-admission':'本地调用队列暂满或策略限制', 'invalid-data':'返回数据未通过校验','scope-mismatch':'返回范围不匹配',
 cancelled:'已取消',internal:'内部处理失败',
};
export function themeSourceErrorText(reason:string){return labels[reason]??reason;}
