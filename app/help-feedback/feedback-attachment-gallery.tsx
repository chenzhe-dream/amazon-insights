"use client";

import {useEffect, useRef, useState} from 'react';
import type {FeedbackAttachmentMetadata} from './feedback-types';

function AttachmentThumbnail({attachment, src, onPreview}: {
  attachment: FeedbackAttachmentMetadata;
  src: string;
  onPreview: (src: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const imageSrc = revision ? `${src}?previewRetry=${revision}` : src;
  return <button type="button" className="feedback-attachment-card"
    aria-label={`${failed ? '重试加载' : '放大查看'} ${attachment.fileName}`}
    onClick={() => {
      if (failed) {setFailed(false); setRevision(value => value + 1);}
      else onPreview(imageSrc);
    }}>
    {failed ? <span className="feedback-attachment-failed">图片加载失败<br/>点击重试</span>
      : <img key={imageSrc} src={imageSrc} alt={attachment.fileName} decoding="async"
          onError={() => setFailed(true)}/>}
    <span className="feedback-attachment-name" title={attachment.fileName}>{attachment.fileName}</span>
    <small>{Math.ceil(attachment.byteSize / 1024)} KB · {failed ? '重试加载' : '点击放大'}</small>
  </button>;
}

function ZoomableImage({src, name}: {src: string; name: string}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({width: 0, height: 0});
  const [bounds, setBounds] = useState({width: 0, height: 0});
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setBounds({width: element.clientWidth - 24, height: element.clientHeight - 24});
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  const ready = size.width > 0 && bounds.width > 0 && bounds.height > 0;
  const fit = ready ? Math.min(1, bounds.width / size.width, bounds.height / size.height) : 1;
  const scale = zoom ?? fit;
  const changeZoom = (value: number | null) => {
    setZoom(value);
    viewport.current?.scrollTo(0, 0);
  };
  return <>
    <div className="feedback-image-zoom" role="group" aria-label="图片缩放">
      <button type="button" aria-label="缩小图片" disabled={!ready || scale <= 0.1}
        onClick={() => changeZoom(Math.max(0.1, scale - 0.25))}>−</button>
      <output aria-label="当前缩放比例" aria-live="polite">{ready ? `${Math.round(scale * 100)}%` : '加载中'}</output>
      <button type="button" aria-label="放大图片" disabled={!ready || scale >= 4}
        onClick={() => changeZoom(Math.min(4, scale + 0.25))}>＋</button>
      <button type="button" disabled={!ready} onClick={() => changeZoom(null)}>适应窗口</button>
      <button type="button" disabled={!ready} onClick={() => changeZoom(1)}>原始大小</button>
    </div>
    <div ref={viewport} className="feedback-image-preview-body" tabIndex={0} aria-label="图片查看区域，可滚动查看">
      <img src={src} alt={name}
        style={ready ? {width: size.width * scale, height: size.height * scale} : {visibility: 'hidden'}}
        onLoad={event => setSize({width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight})}/>
    </div>
  </>;
}

export function FeedbackAttachmentGallery({attachments, attachmentPrefix}: {
  attachments: readonly FeedbackAttachmentMetadata[];
  attachmentPrefix: string;
}) {
  const [preview, setPreview] = useState<{src: string; name: string} | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (preview && element && !element.open) element.showModal();
    else if (!preview && element?.open) element.close();
  }, [preview]);

  return <>
    <div className="feedback-attachments">
      {attachments.map(attachment => <AttachmentThumbnail key={`${attachmentPrefix}:${attachment.id}`}
        attachment={attachment}
        src={`/api/agent${attachmentPrefix}/attachments/${encodeURIComponent(attachment.id)}`}
        onPreview={src => setPreview({src, name: attachment.fileName})}/>)}
    </div>
    <dialog ref={dialog} className="feedback-image-preview" aria-label={`图片预览：${preview?.name ?? ''}`}
      onCancel={event => {event.preventDefault(); setPreview(null);}}
      onClose={() => setPreview(null)}
      onKeyDown={event => {if (event.key === 'Escape') event.stopPropagation();}}
      onClick={event => {if (event.target === event.currentTarget) setPreview(null);}}>
      {preview && <>
        <header><strong>{preview.name}</strong>
          <button type="button" aria-label="关闭图片预览" onClick={() => setPreview(null)}>×</button>
        </header>
        <ZoomableImage key={preview.src} src={preview.src} name={preview.name}/>
        <footer>放大后可滚动查看 · 按 Esc 或点击空白处关闭</footer>
      </>}
    </dialog>
  </>;
}
