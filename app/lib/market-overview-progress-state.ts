import type { MarketOverviewRunResponse } from '../../shared/market-overview-report-contracts';

type Run = MarketOverviewRunResponse['run'];

export type MarketOverviewProgressState =
  | 'active'
  | 'active-with-report'
  | 'partial'
  | 'complete'
  | 'failed-with-report'
  | 'failed'
  | 'cancelled'
  | 'idle';

type ProgressCopy = { tone: 'active' | 'partial' | 'complete' | 'failed'; title: string; detail: string };

const progressCopy: Partial<Record<MarketOverviewProgressState, ProgressCopy>> = {
  'active-with-report': {
    tone: 'active',
    title: '总览分析进行中 · 以下是阶段性结果',
    detail: '后台仍在处理剩余步骤，完成后页面会自动更新；当前综合评分不代表最终结果。',
  },
  partial: {
    tone: 'partial',
    title: '报告已保存，但存在数据缺口',
    detail: '以下为已确认结果，当前不能作为最终评级；可重试或补齐缺失步骤。',
  },
  complete: {
    tone: 'complete',
    title: '分析已完成',
    detail: '六维评分和业务结论已生成，当前内容为本次任务的最终报告。',
  },
  'failed-with-report': {
    tone: 'failed',
    title: '分析未完整完成，已保留阶段性结果',
    detail: '以下结果不代表完整报告，可重试失败步骤。',
  },
};

export function marketOverviewProgressState(run: Run | null): MarketOverviewProgressState {
  if (!run) return 'idle';
  const hasCurrentReport = Boolean(run.currentReport);
  if (run.status === 'running' || run.status === 'queued') return hasCurrentReport ? 'active-with-report' : 'active';
  if (run.status === 'partial') return hasCurrentReport ? 'partial' : 'idle';
  if (run.status === 'succeeded') return hasCurrentReport ? 'complete' : 'idle';
  if (run.status === 'failed') return hasCurrentReport ? 'failed-with-report' : 'failed';
  if (run.status === 'cancelled') return 'cancelled';
  return 'idle';
}

export function marketOverviewProgressCopy(state: MarketOverviewProgressState): ProgressCopy | null {
  return progressCopy[state] ?? null;
}
