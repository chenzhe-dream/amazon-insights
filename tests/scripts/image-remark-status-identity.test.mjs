import assert from 'node:assert/strict';
import test from 'node:test';
import { countPendingImageRemarks, hasCompleteImageRemarks } from '../../scripts/lib/asin-data-status.mjs';

const oldUrl = 'https://images.test/old.jpg';
const newUrl = 'https://images.test/new.jpg';

test('image remarks are ready only for the listing URL they describe', () => {
  const remark = [{ remark: 'Old image', imageUrl: oldUrl }];
  assert.equal(hasCompleteImageRemarks({ galleryImages: [oldUrl] }, remark), true);
  assert.equal(hasCompleteImageRemarks({ galleryImages: [newUrl] }, remark), false);
  assert.equal(hasCompleteImageRemarks({ galleryImages: [oldUrl] }, [{ remark: 'unbound' }]), false);
});

test('a changed gallery URL counts as pending even when old index has a remark', () => {
  assert.equal(countPendingImageRemarks(['B000000001'], {
    listing: { B000000001: { status: 'ready', galleryImages: [newUrl] } },
    imageRemarks: { B000000001: [{ remark: 'Old image', imageUrl: oldUrl }] },
    imageRemarkUrls: { B000000001: [oldUrl] },
  }), 1);
});
