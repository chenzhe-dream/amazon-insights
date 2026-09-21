import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileListingImageRemarks } from '../../scripts/lib/listing-image-identity.mjs';

test('reorders remarks by exact trimmed URL rather than image position', () => {
  const front = { description: 'Front view' };
  const back = { description: 'Back view' };
  const result = reconcileListingImageRemarks([' https://images.test/front.jpg ', 'https://images.test/back.jpg'],
    [' https://images.test/back.jpg ', 'https://images.test/front.jpg'], [front, back]);
  assert.deepEqual(result, [back, front]);
  assert.strictEqual(result[0], back);
  assert.strictEqual(result[1], front);
});

test('additions, removals and altered URLs never inherit another image remark', () => {
  const front = { description: 'Front' }, removed = { description: 'Removed' };
  assert.deepEqual(reconcileListingImageRemarks(['https://images.test/front.jpg', 'https://images.test/removed.jpg'],
    ['https://images.test/new.jpg', 'https://images.test/front.jpg', 'https://images.test/front.jpg?size=large', 'https://images.test/FRONT.jpg'],
    [front, removed]), [null, front, null, null]);
  assert.deepEqual(reconcileListingImageRemarks(['old'], [], [removed]), []);
});

test('duplicate old URLs are ambiguous even when their remarks are identical', () => {
  const same = { description: 'Ambiguous' }, unique = { description: 'Unique' };
  assert.deepEqual(reconcileListingImageRemarks(['duplicate', ' duplicate ', 'unique'],
    ['duplicate', 'unique', 'duplicate'], [same, same, unique]), [null, unique, null]);
});

test('duplicate new URLs can reuse one unambiguous old remark', () => {
  const remark = { description: 'Same image' };
  const result = reconcileListingImageRemarks(['image'], ['image', ' image '], [remark]);
  assert.deepEqual(result, [remark, remark]);
  assert.strictEqual(result[0], result[1]);
});

test('nonarray inputs, blank or nonstring URLs and absent remarks yield safe empty values', () => {
  for (const invalid of [undefined, null, {}, 'image', 42]) {
    assert.deepEqual(reconcileListingImageRemarks(invalid, ['image'], [{}]), [null]);
    assert.deepEqual(reconcileListingImageRemarks(['image'], invalid, [{}]), []);
    assert.deepEqual(reconcileListingImageRemarks(['image'], ['image'], invalid), [null]);
  }
  assert.deepEqual(reconcileListingImageRemarks(['', ' ', null, 12, 'image'],
    ['', ' ', null, 12, 'image'], [{}, {}, {}, {}, null]), [null, null, null, null, null]);
  assert.deepEqual(reconcileListingImageRemarks(['image'], ['image'], []), [null]);
  assert.deepEqual(reconcileListingImageRemarks([], new Array(2), []), [null, null]);
});

test('separate ASIN calls never share state even for the same URL', () => {
  const firstAsin = { description: 'First ASIN' }, secondAsin = { description: 'Second ASIN' };
  assert.deepEqual(reconcileListingImageRemarks(['shared'], ['shared'], [firstAsin]), [firstAsin]);
  assert.deepEqual(reconcileListingImageRemarks([], ['shared'], []), [null]);
  assert.deepEqual(reconcileListingImageRemarks(['shared'], ['shared'], [secondAsin]), [secondAsin]);
  assert.deepEqual(reconcileListingImageRemarks(['shared'], ['shared'], [firstAsin]), [firstAsin]);
});

test('does not mutate URL arrays, remarks array or nested remark objects', () => {
  const remark = Object.freeze({ details: Object.freeze(['unchanged']) });
  const previousUrls = Object.freeze([' first ', 'removed']);
  const nextUrls = Object.freeze(['new', 'first']);
  const remarks = Object.freeze([remark, null]);
  assert.deepEqual(reconcileListingImageRemarks(previousUrls, nextUrls, remarks), [null, remark]);
  assert.deepEqual(previousUrls, [' first ', 'removed']);
  assert.deepEqual(nextUrls, ['new', 'first']);
  assert.deepEqual(remarks, [remark, null]);
});
