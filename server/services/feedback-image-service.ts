import { createHash } from "node:crypto";
import { basename, extname } from "node:path";

import sharp from "sharp";

import {
  MAX_FEEDBACK_IMAGE_BYTES,
  MAX_FEEDBACK_IMAGES,
} from "../../shared/agent-contracts";

export { MAX_FEEDBACK_IMAGE_BYTES, MAX_FEEDBACK_IMAGES };
export const MAX_FEEDBACK_IMAGE_PIXELS = 40_000_000;
export const MAX_FEEDBACK_IMAGE_DIMENSION = 12_000;

export type FeedbackImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface FeedbackImageInput {
  readonly fileName: string;
  readonly declaredMediaType: string;
  readonly content: Uint8Array;
}

export interface SanitizedFeedbackAttachment {
  readonly fileName: string;
  readonly mediaType: FeedbackImageMediaType;
  readonly byteSize: number;
  readonly sha256: string;
  readonly imageContent: Buffer;
}

export class FeedbackImageValidationError extends Error {
  constructor() {
    super("Invalid feedback image");
    this.name = "FeedbackImageValidationError";
  }
}

function detectedMediaType(content: Buffer): FeedbackImageMediaType | null {
  if (
    content.byteLength >= 8 &&
    content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return "image/png";
  if (content.byteLength >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    content.byteLength >= 12 &&
    content.toString("ascii", 0, 4) === "RIFF" &&
    content.toString("ascii", 8, 12) === "WEBP"
  ) return "image/webp";
  return null;
}

function safeFileName(fileName: string, mediaType: FeedbackImageMediaType): string {
  const extension = mediaType === "image/png" ? ".png" : mediaType === "image/jpeg" ? ".jpg" : ".webp";
  const leaf = basename(fileName.replace(/[\u0000-\u001f\u007f]/g, "").replaceAll("\\", "/")).trim();
  const stem = leaf.slice(0, Math.max(0, leaf.length - extname(leaf).length)).trim() || "feedback-image";
  return `${stem.slice(0, 255 - extension.length)}${extension}`;
}

export async function sanitizeFeedbackImage(
  input: FeedbackImageInput,
): Promise<SanitizedFeedbackAttachment> {
  try {
    const source = Buffer.from(input.content);
    if (source.byteLength < 1 || source.byteLength > MAX_FEEDBACK_IMAGE_BYTES) {
      throw new FeedbackImageValidationError();
    }
    const mediaType = detectedMediaType(source);
    if (!mediaType || input.declaredMediaType.trim().toLowerCase() !== mediaType) {
      throw new FeedbackImageValidationError();
    }

    const decoder = sharp(source, {
      failOn: "error",
      limitInputPixels: MAX_FEEDBACK_IMAGE_PIXELS,
      sequentialRead: true,
    });
    const metadata = await decoder.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (
      width < 1 || height < 1 ||
      width > MAX_FEEDBACK_IMAGE_DIMENSION || height > MAX_FEEDBACK_IMAGE_DIMENSION ||
      width * height > MAX_FEEDBACK_IMAGE_PIXELS
    ) {
      throw new FeedbackImageValidationError();
    }

    let pipeline = decoder.rotate();
    if (mediaType === "image/png") pipeline = pipeline.png({ compressionLevel: 9 });
    else if (mediaType === "image/jpeg") pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });
    else pipeline = pipeline.webp({ quality: 90 });
    const imageContent = await pipeline.toBuffer();
    if (imageContent.byteLength < 1 || imageContent.byteLength > MAX_FEEDBACK_IMAGE_BYTES) {
      throw new FeedbackImageValidationError();
    }

    return Object.freeze({
      fileName: safeFileName(input.fileName, mediaType),
      mediaType,
      byteSize: imageContent.byteLength,
      sha256: createHash("sha256").update(imageContent).digest("hex"),
      imageContent,
    });
  } catch (error) {
    if (error instanceof FeedbackImageValidationError) throw error;
    throw new FeedbackImageValidationError();
  }
}

export async function sanitizeFeedbackImages(
  inputs: readonly FeedbackImageInput[],
): Promise<readonly SanitizedFeedbackAttachment[]> {
  if (inputs.length > MAX_FEEDBACK_IMAGES) throw new FeedbackImageValidationError();
  const sanitized: SanitizedFeedbackAttachment[] = [];
  for (const input of inputs) sanitized.push(await sanitizeFeedbackImage(input));
  return Object.freeze(sanitized);
}
