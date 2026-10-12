import assert from 'node:assert/strict';
import test from 'node:test';
import { marketOverviewProgressCopy, marketOverviewProgressState } from '../../app/lib/market-overview-progress-state';
import { overviewRun } from './helpers/market-overview-page-fixture';

function fixture(status: 'queued'|'running'|'partial'|'succeeded'|'failed'|'cancelled', currentReport = true) {
  const run = structuredClone(overviewRun(false).run);
  run.status = status;
  if (!currentReport) run.currentReport = null;
  return run;
}

test('active run without a current report stays active', () => {
  assert.equal(marketOverviewProgressState(fixture('running', false)), 'active');
});

test('active run with a current report is stage-result', () => {
  assert.equal(marketOverviewProgressState(fixture('running')), 'active-with-report');
});

test('partial terminal run is incomplete', () => {
  assert.equal(marketOverviewProgressState(fixture('partial')), 'partial');
});

test('succeeded terminal run is complete', () => {
  assert.equal(marketOverviewProgressState(fixture('succeeded')), 'complete');
});

test('failed run with a current report preserves failure state', () => {
  assert.equal(marketOverviewProgressState(fixture('failed')), 'failed-with-report');
});

test('copy tells the business owner whether a result is temporary, incomplete, or final', () => {
  assert.match(marketOverviewProgressCopy('active-with-report')!.title, /阶段性结果/);
  assert.match(marketOverviewProgressCopy('partial')!.title, /存在数据缺口/);
  assert.match(marketOverviewProgressCopy('complete')!.title, /分析已完成/);
});
