"use client";

import { useEffect, useId, type ClipboardEvent, type DragEvent } from "react";
import type { FeedbackImageDraft } from "./feedback-types";

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FEEDBACK_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FEEDBACK_IMAGES = 3;

function sameFile(left: File, right: File) {
  return left.name === right.name
    && left.size === right.size
    && left.lastModified === right.lastModified;
}

export function addFeedbackImages(
  current: readonly FeedbackImageDraft[],
  incoming: readonly File[],
  createPreviewUrl: (file: File) => string = (file) => URL.createObjectURL(file),
) {
  const images = [...current];
  const errors: string[] = [];
  for (const file of incoming) {
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      errors.push(`${file.name}：仅支持 PNG、JPEG 或 WebP`);
      continue;
    }
    if (file.size > MAX_FEEDBACK_IMAGE_BYTES) {
      errors.push(`${file.name}：单张图片不能超过 5MB`);
      continue;
    }
    if (images.length >= MAX_FEEDBACK_IMAGES) {
      errors.push(`${file.name}：最多只能添加 3 张图片`);
      continue;
    }
    if (images.some((candidate) => sameFile(candidate.file, file))) continue;
    images.push({
      id: `${file.name}-${file.size}-${file.lastModified}-${images.length}`,
      file,
      previewUrl: createPreviewUrl(file),
    });
  }
  return { images, errors } as const;
}

export function removeFeedbackImage(images: readonly FeedbackImageDraft[], imageId: string) {
  return images.filter((image) => image.id !== imageId);
}

function FeedbackImagePreview({ image, onRemove }: { image: FeedbackImageDraft; onRemove: () => void }) {
  useEffect(() => () => URL.revokeObjectURL(image.previewUrl), [image.previewUrl]);
  return <li>
    {/* Blob previews are local-only object URLs and cannot use the Next image optimizer. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={image.previewUrl} alt={`${image.file.name} 缩略图`} />
    <span>{image.file.name}</span>
    <button type="button" onClick={onRemove}>删除</button>
  </li>;
}

export function FeedbackImageInput({
  images,
  errors,
  onChange,
  onErrors,
}: {
  images: readonly FeedbackImageDraft[];
  errors: readonly string[];
  onChange: (images: FeedbackImageDraft[]) => void;
  onErrors: (errors: string[]) => void;
}) {
  const inputId = useId();
  const add = (files: FileList | readonly File[]) => {
    const result = addFeedbackImages(images, Array.from(files));
    onErrors([...result.errors]);
    onChange([...result.images]);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    add(event.dataTransfer.files);
  };
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length > 0) {
      event.preventDefault();
      add(files);
    }
  };
  return <div
    className="feedback-image-input"
    onDragOver={(event) => event.preventDefault()}
    onDrop={onDrop}
    onPaste={onPaste}
    tabIndex={0}
    aria-label="反馈图片上传区域"
  >
    <input
      id={inputId}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple
      hidden
      onChange={(event) => {
        if (event.target.files) add(event.target.files);
        event.target.value = "";
      }}
    />
    <label htmlFor={inputId}>选择截图</label>
    <span>也可拖放或粘贴 · 最多 3 张 · 单张 5MB</span>
    {errors.length > 0 ? <ul className="feedback-image-errors" role="alert">
      {errors.map((error) => <li key={error}>{error}</li>)}
    </ul> : null}
    {images.length > 0 ? <ul className="feedback-image-previews">
      {images.map((image) => <FeedbackImagePreview
        key={image.id}
        image={image}
        onRemove={() => onChange(removeFeedbackImage(images, image.id))}
      />)}
    </ul> : null}
  </div>;
}
