export function childSalesOutcome(parsed) {
  const unavailable = parsed.containerRecognized && parsed.rawRowCount > 0 &&
    parsed.unavailableSalesRowCount === parsed.rawRowCount;
  const verifiedEmpty = parsed.containerRecognized && parsed.rawRowCount === 0;
  return {
    status: parsed.rows.length ? 'ready' : verifiedEmpty || unavailable ? 'empty' : 'schema-error',
    verifiedEmpty,
    ...(unavailable ? { reasonCode: 'SALES_OBSERVATION_UNAVAILABLE' } : {}),
  };
}

export function childSalesResultStatuses(outcomes, asins, scope) {
  const statuses = {}, reasons = {};
  for (const asin of asins) {
    const item = outcomes?.[asin];
    if (!item || item.asin !== asin || item.marketplace !== scope.marketplace ||
      (item.jobId ?? item.provenance?.jobId) !== scope.jobId) continue;
    if (item.status === 'empty') {
      statuses[asin] = 'upstream-empty';
      reasons[asin] = item.reasonCode === 'SALES_OBSERVATION_UNAVAILABLE'
        ? '上游近15日未采集到子体销量，销量未知' : '上游未返回子体销量数据';
    } else if (item.status === 'schema-error') {
      statuses[asin] = 'connector-failed';
      reasons[asin] = '上游子体销量字段格式无效';
    }
  }
  return { statuses, reasons };
}
