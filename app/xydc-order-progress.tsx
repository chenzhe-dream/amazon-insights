"use client";
import * as React from "react";
import { isXydcOrderProgressTerminal, type XydcOrderProgressView } from "../shared/xydc-order-progress";

const labels = { queued: "等待订单采集", collecting: "当前采集", "rate-wait": "限流等待", partial: "部分完成",
  completed: "完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
export function XydcOrderProgress({ value }: { value: XydcOrderProgressView | null }) {
  const [now, setNow] = React.useState(() => Date.now());
  const progress = value?.progress;
  const running = progress && !isXydcOrderProgressTerminal(progress.state);
  React.useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!value || (!progress && !value.activeJob)) return null;
  if (!progress) return <div className="xydc-order-progress" role="status">等待订单采集</div>;
  const state = running && now - Date.parse(progress.updatedAt) > 45_000 ? "interrupted" : progress.state;
  const remaining = state === "rate-wait" && progress.retryAt ? Math.max(0, Math.ceil((Date.parse(progress.retryAt) - now) / 1_000)) : null;
  return <div className="xydc-order-progress" role="status">
    <div><span>已发现子体：已就绪 {progress.ready}/{progress.total}（缓存复用 {progress.cached}）</span><span>{labels[state]}
      {remaining !== null ? remaining > 0 ? ` · ${remaining}秒` : " · 等待下一次实际状态" : ""}</span></div>
    <progress aria-label="订单数据响应就绪" value={progress.ready} max={progress.total} />
  </div>;
}
