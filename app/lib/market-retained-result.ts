export type RetainableMarketRun = {
  id: string;
  status?: string;
  scope: { organizationId: string; researchId: string; nodeIdPath: string; [key: string]: unknown };
  params: unknown;
  steps: { current: boolean; status: string; errorCode?: string | null }[];
};
export type MarketRunKey = 'overviewRun' | 'shapeRun' | 'keywordRun' | 'themeRun';
export function needsPreviousMarketResult<T extends RetainableMarketRun>(run: T, usable: (run: T) => boolean): boolean {
  return !usable(run) || run.status === 'failed' || run.steps.some(step => step.current && ['failed', 'interrupted'].includes(step.status));
}
const prefix = 'market-previous-result/v1/';
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function sameRetainedConditions(a: RetainableMarketRun, b: RetainableMarketRun): boolean {
  if (a.scope.nodeIdPath.includes(':') && b.scope.nodeIdPath.includes(':') && a.scope.nodeIdPath !== b.scope.nodeIdPath) return false;
  const scope = ({ researchId: _study, nodeIdPath, ...rest }: RetainableMarketRun['scope']) => ({ ...rest, nodeIdPath: nodeIdPath.split(':').at(-1) });
  return JSON.stringify(canonical(scope(a.scope))) === JSON.stringify(canonical(scope(b.scope))) && JSON.stringify(canonical(a.params)) === JSON.stringify(canonical(b.params));
}
/** Store only a predecessor ID. Every display re-reads the authorized report API. */
export function rememberPreviousMarketRun(key: MarketRunKey, nextId: string, previousId: string | null) {
  if (!previousId || nextId === previousId || !uuid.test(nextId) || !uuid.test(previousId)) return;
  try { const name = `${prefix}${key}/${nextId}`; if (!sessionStorage.getItem(name)) sessionStorage.setItem(name, previousId); } catch { /* Storage is optional. */ }
}
export function previousMarketRun(key: MarketRunKey, id: string): string | null {
  try { const value = sessionStorage.getItem(`${prefix}${key}/${id}`); return value && uuid.test(value) && value !== id ? value : null; } catch { return null; }
}
export async function loadPreviousMarketResult<T extends RetainableMarketRun>(current: T, read: (id: string, signal: AbortSignal) => Promise<T>, previous: (id: string) => string | null, usable: (run: T) => boolean, signal: AbortSignal): Promise<T | null> {
  const visited = new Set([current.id]); let id = previous(current.id);
  for (let depth = 0; id && depth < 8 && !visited.has(id); depth++) {
    signal.throwIfAborted(); visited.add(id);
    const saved = await read(id, signal); signal.throwIfAborted();
    if (saved.id !== id || !sameRetainedConditions(current, saved)) return null;
    if (usable(saved)) return saved;
    id = previous(id);
  }
  return null;
}
