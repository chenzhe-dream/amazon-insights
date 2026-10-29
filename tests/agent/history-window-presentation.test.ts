import test from 'node:test';
import assert from 'node:assert/strict';
import {shapeSorftimePageRevision} from './helpers/market-shape-sorftime-page-fixture';
import {toShapeReferenceReport} from '../../app/lib/market-shape-reference-adapter';
import {getReferencePeriodTotals} from '../../app/market-shape-reference/rules';
import {themeSourceErrorText} from '../../app/lib/market-theme-source-error';

test('new period policy keeps annual gaps unknown through presentation and summary while recent data participates',()=>{
 const data=shapeSorftimePageRevision(1).data;
 const row=data.productHistory.products[0];
 (row as any).periodPolicy='calendar-windows/v2';
 row.points=['2025-01','2025-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'].map(month=>({month,units:10,issues:[]}));
 data.pool.products[0].listedAt='2025-01-01';
 const report=toShapeReferenceReport(data),p=report.products[0];
 assert.equal(p.sales.last6Months,60);assert.equal(p.sales.last3Months,30);
 assert.equal(p.sales.y2025,null,'Two returned months are not a full year');
 assert.equal(p.sales.y2024,null,'Absent annual data must not become zero');
 assert.equal(getReferencePeriodTotals([p],'shape-all-links/3').y2024,null);
 row.points=row.points.filter(p=>p.month!=='2026-07');
 const gap=toShapeReferenceReport(data).products[0];assert.equal(gap.sales.last3Months,null);assert.equal(gap.sales.last6Months,null);
});
test('old frozen reports keep their original observed-period interpretation',()=>{
 const data=shapeSorftimePageRevision(1).data;
 data.productHistory.products[0].points=[{month:'2025-01',units:10,issues:[]}];
 assert.equal(toShapeReferenceReport(data).products[0].sales.y2025,10);
});
test('confirmed review-source quota has actionable administrator wording without relabeling timeouts',()=>{
 assert.match(themeSourceErrorText('quota-exhausted'),/Sorftime 暂无额度，请联系管理员/);
 assert.doesNotMatch(themeSourceErrorText('timeout'),/暂无额度/);
 assert.doesNotMatch(themeSourceErrorText('saved-source-missing'),/暂无额度/);
});
