import assert from 'node:assert/strict';
import test from 'node:test';
import {parseReviewCalendarDate} from '../../scripts/lib/amazon-review-reference.mjs';
test('Amazon review dates preserve the source calendar day, independent of local timezone',()=>{
 assert.equal(parseReviewCalendarDate('Reviewed in the United States on April 8, 2026'),'2026-04-08');
 assert.equal(parseReviewCalendarDate('Reviewed in Canada on October 26, 2023'),'2023-10-26');
 assert.equal(parseReviewCalendarDate('Reviewed in the United Kingdom on January 1, 2026'),'2026-01-01');
 assert.equal(parseReviewCalendarDate('Reviewed in Germany on February 30, 2026'),null);
 assert.equal(parseReviewCalendarDate('unknown'),null);
});
