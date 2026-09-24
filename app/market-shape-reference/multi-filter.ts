export type TopSalesMultiSelectFilterState = string[] | null;

export function toggleTopSalesMultiSelectFilter(current: TopSalesMultiSelectFilterState, allOptions: readonly string[], option: string): TopSalesMultiSelectFilterState {
  if (current === null || current.length === 0) return [option];
  if (current.includes(option)) {
    const next = current.filter(item => item !== option);
    return next.length === 0 ? null : next;
  }
  const next = [...current, option];
  return next.length === allOptions.length ? null : next;
}
