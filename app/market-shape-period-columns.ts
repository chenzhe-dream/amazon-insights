import type { MarketShapePublicRevision } from '../shared/market-shape-public-contracts';

/** Original report periods are labels, not an instruction to recompute saved facts. */
export function shapeSavedPeriodColumns(scope: MarketShapePublicRevision['scope'], projection?:MarketShapePublicRevision['periodProjection']) {
  if(projection){
    const study=projection.periods.find(p=>p.id==='study');
    return projection.periods.filter(p=>p.id!=='study'||!projection.periods.some(other=>other.id!=='study'&&other.fromMonth===p.fromMonth&&other.toMonth===p.toMonth))
      .map(period=>({label:period.label,from:period.fromMonth,to:period.toMonth,saved:period.fromMonth===study?.fromMonth&&period.toMonth===study?.toMonth,projection:period}));
  }
  const [year, month] = scope.toMonth.split('-').map(Number);
  const trailingStart = (count: number) => new Date(Date.UTC(year, month - count, 1)).toISOString().slice(0, 7);
  const periods = [
    { label: '近3个月', from: trailingStart(3), to: scope.toMonth },
    { label: '近6个月', from: trailingStart(6), to: scope.toMonth },
    ...[year - 1, year - 2].map(value => ({ label: String(value), from: `${value}-01`, to: `${value}-12` })),
  ].map(period => ({ ...period, saved: period.from === scope.fromMonth && period.to === scope.toMonth }));
  if (!periods.some(period => period.saved)) periods.push({ label: `${scope.fromMonth} 至 ${scope.toMonth}`, from: scope.fromMonth, to: scope.toMonth, saved: true });
  return periods.map(period=>({...period,projection:undefined}));
}
