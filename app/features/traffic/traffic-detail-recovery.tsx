'use client';
import { useEffect, useRef, useState } from 'react';
import { localAgentErrorMessage, localAgentFetch } from '../../lib/local-agent-browser';

function requestUuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function TrafficDetailRecoveryControl({ runId, recovered, onRecovered }: { runId: string; recovered: boolean; onRecovered(): Promise<unknown> }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  const requestId = useRef<string | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function recover() {
    if (controller.current) return;
    const request = new AbortController(); controller.current = request;
    requestId.current ??= requestUuid();
    setBusy(true); setMessage('正在补采并校验流量明细，数据采集限时 45 秒；现有结果保留。');
    const timeout = setTimeout(() => request.abort(), 55_000);
    try {
      const response = await localAgentFetch(`/v1/runs/${encodeURIComponent(runId)}/traffic-details/refresh`, { method: 'POST', body: JSON.stringify({ requestId: requestId.current }), signal: request.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(localAgentErrorMessage(payload, '补采失败，原结果已保留，请重试'));
      if (request.signal.aborted) return;
      requestId.current = null;
      await onRecovered();
      if (!request.signal.aborted) setMessage('流量明细已补齐；其他分析结果未改动。');
    } catch (error) {
      if (!request.signal.aborted) setMessage(error instanceof Error ? error.message : '补采失败，原结果已保留，请重试');
      else setMessage('等待超时，原结果已保留。可重试核对补采结果。');
    } finally {
      clearTimeout(timeout);
      if (controller.current === request) { controller.current = null; setBusy(false); }
    }
  }
  return <section className="card" data-traffic-recovery aria-busy={busy}>
    <div className="section-head"><div><strong>流量明细补采</strong><p>只更新当前项目的近30天流量结构，不重新运行 VOC 或其他分析。</p></div>
      <button type="button" className="secondary-btn" disabled={busy} onClick={() => void recover()}>{busy ? '正在补采流量明细…' : recovered ? '重新补采流量明细' : '补齐流量明细'}</button></div>
    {message && <p role="status">{message}</p>}
  </section>;
}
