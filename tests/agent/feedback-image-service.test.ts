import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import sharp from "sharp";

import {
  FeedbackImageValidationError,
  MAX_FEEDBACK_IMAGE_BYTES,
  sanitizeFeedbackImage,
  sanitizeFeedbackImages,
} from "../../server/services/feedback-image-service";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=",
  "base64",
);
const WEBP_1X1 = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
  "base64",
);

test("sanitizes decoded PNG, JPEG, and WebP and hashes the stored bytes", async () => {
  for (const fixture of [
    { name: "shot.png", declared: "image/png", content: PNG_1X1, expected: "image/png", extension: ".png" },
    { name: "photo.jpeg", declared: "image/jpeg", content: JPEG_1X1, expected: "image/jpeg", extension: ".jpg" },
    { name: "capture.webp", declared: "image/webp", content: WEBP_1X1, expected: "image/webp", extension: ".webp" },
  ] as const) {
    const result = await sanitizeFeedbackImage({
      fileName: fixture.name,
      declaredMediaType: fixture.declared,
      content: fixture.content,
    });
    assert.equal(result.mediaType, fixture.expected);
    assert.equal(result.byteSize, result.imageContent.byteLength);
    assert.equal(result.sha256, createHash("sha256").update(result.imageContent).digest("hex"));
    assert.ok(result.byteSize <= MAX_FEEDBACK_IMAGE_BYTES);
    assert.ok(result.fileName.endsWith(fixture.extension));
  }
});

test("normalizes unsafe filenames and strips metadata while applying orientation", async () => {
  const source = await sharp({
    create: { width: 2, height: 3, channels: 3, background: "#cf493f" },
  }).jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Artist: "must-not-survive" } } }).toBuffer();

  const result = await sanitizeFeedbackImage({
    fileName: "../nested/\u0000 camera.final.exe",
    declaredMediaType: "image/jpeg",
    content: source,
  });
  const metadata = await sharp(result.imageContent).metadata();

  assert.equal(result.fileName, "camera.final.jpg");
  assert.equal(metadata.width, 3);
  assert.equal(metadata.height, 2);
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
  assert.equal(result.imageContent.includes(Buffer.from("must-not-survive")), false);
});

test("rejects excess count, oversized input/output, forged declarations, corruption, and excessive pixels", async () => {
  const input = { fileName: "shot.png", declaredMediaType: "image/png", content: PNG_1X1 };
  await assert.rejects(sanitizeFeedbackImages([input, input, input, input]), FeedbackImageValidationError);
  await assert.rejects(
    sanitizeFeedbackImage({ ...input, content: Buffer.concat([PNG_1X1, Buffer.alloc(MAX_FEEDBACK_IMAGE_BYTES)]) }),
    FeedbackImageValidationError,
  );
  await assert.rejects(sanitizeFeedbackImage({ ...input, declaredMediaType: "image/jpeg" }), FeedbackImageValidationError);
  await assert.rejects(sanitizeFeedbackImage({ ...input, content: PNG_1X1.subarray(0, 24) }), FeedbackImageValidationError);

  const forgedPixels = Buffer.from(PNG_1X1);
  forgedPixels.writeUInt32BE(50_000, 16);
  forgedPixels.writeUInt32BE(50_000, 20);
  await assert.rejects(sanitizeFeedbackImage({ ...input, content: forgedPixels }), FeedbackImageValidationError);

  const noisy = randomBytes(3_000 * 3_000 * 3);
  const compressed = await sharp(noisy, { raw: { width: 3_000, height: 3_000, channels: 3 } })
    .jpeg({ quality: 70 })
    .toBuffer();
  assert.ok(compressed.byteLength < MAX_FEEDBACK_IMAGE_BYTES);
  await assert.rejects(
    sanitizeFeedbackImage({ fileName: "noisy.jpg", declaredMediaType: "image/jpeg", content: compressed }),
    FeedbackImageValidationError,
  );
});
