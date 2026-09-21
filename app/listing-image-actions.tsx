"use client";

import { useRef, useState } from "react";
import type { SyncJob } from "./lib/sync-progress-presentation";
const styles = {actions:"listingImageActions_actions",trigger:"listingImageActions_trigger",options:"listingImageActions_options",message:"listingImageActions_message"};

export type ListingImageAction = "refresh" | "analyze";
function imageActionStatus(job: SyncJob | null | undefined, asin: string) {
  const stage = job?.stages.find(item => item.id === "image_remarks" && item.imageAction && item.repairAsins?.includes(asin));
  if (!job || !stage) return null;
  const terminal = ["completed", "completed-with-gaps", "failed"].includes(job.status);
  const progress = job.asinProgress?.[asin]?.image_remarks;
  const incomplete = ["partial", "failed"].includes(stage.status)
    || (progress && !["ready", "pending", "manual"].includes(progress.status));
  const detail = stage.detail ? ` · ${stage.detail}` : "";
  if (job.status === "failed") return {busy:false, text:`处理失败${detail || (job.message ? ` · ${job.message}` : "")}`};
  if (terminal) {
    const result = incomplete ? `处理结束，部分失败${detail}` : ["done", "completed"].includes(stage.status) ? `分析完成${detail}` : `处理结束，分析未完成${detail}`;
    if (job.publication?.status === "pending") return {busy:true, text:`${result} · 正在更新页面`};
    if (job.publication?.status === "failed") return {busy:false, text:`${result} · 页面更新失败`};
    return {busy:false, text:result};
  }
  const listing = job.stages.find(item => item.id === "listing");
  const text = job.status === "queued" ? "排队中…" : stage.status === "running" ? `图片分析中${detail}`
    : listing?.status === "running" ? "正在重新抓取图片…" : ["done", "completed"].includes(stage.status) ? "图片分析已完成，正在收尾…" : "等待图片分析…";
  return {busy:true, text};
}
export function ListingImageActions({ asin, onAction, disabled = false, job }: {
  asin: string;
  onAction?: (asin: string, action: ListingImageAction) => Promise<string | void>;
  job?: SyncJob | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);
  const status = imageActionStatus(job, asin);
  const currentStatus = !submittedJobId || submittedJobId === job?.jobId ? status : null;
  const busy = disabled || pending || Boolean(currentStatus?.busy);
  const displayMessage = pending ? "正在提交…" : message || currentStatus?.text || (submittedJobId ? "已提交，正在读取任务状态…" : "");
  async function run(action: ListingImageAction) {
    if (!onAction || busy || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setOpen(false);
    setMessage("");
    try {
      const jobId = await onAction(asin, action);
      setSubmittedJobId(jobId ?? null);
      if (!jobId) setMessage("未取得任务编号，请刷新同步进度确认");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提交失败，请重试");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return <div className={styles.actions} onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" className={styles.trigger} aria-label={`重新处理 ${asin} 的图片`}
      aria-expanded={open} disabled={!onAction || busy}
      title={!onAction ? "请先加载已同步的项目" : "仅处理这个 ASIN 的图片"}
      onClick={() => setOpen(value => !value)}>
      {pending ? "提交中…" : "重新处理 ▾"}
    </button>
    {open && <div className={styles.options}>
      <button type="button" onClick={() => void run("analyze")}>重新分析</button>
      <button type="button" onClick={() => void run("refresh")}>重新抓取并重新分析</button>
    </div>}
    {displayMessage && <span className={styles.message} role="status" aria-live="polite">{displayMessage}</span>}
  </div>;
}
