"use client";
import { useEffect, useMemo, useState } from "react";
import { localAgentFetch } from "./local-agent-browser";
import { createVocReviewReader, type VocReviewScope } from "./voc-review-reader";
import type { StageOutputSnapshot } from "./stage-output-browser";

export function useVocReviewOutput(scopeKey: string, scope: VocReviewScope | null, enabled: boolean): StageOutputSnapshot {
  const token = useMemo(() => ({ scopeKey }), [scopeKey]);
  const [receipt, setReceipt] = useState<{ token: object; snapshot: StageOutputSnapshot } | null>(null);
  useEffect(() => {
    if (!scope || !enabled) return;
    const reader = createVocReviewReader(scope, localAgentFetch, snapshot => setReceipt({ token, snapshot }));
    let timer: number | undefined;
    const refresh = async () => {
      await reader.refresh();
      if (!reader.isSettled()) timer = window.setTimeout(refresh, 3000);
    };
    void refresh();
    return () => { window.clearTimeout(timer); reader.dispose(); };
  }, [scope, token, enabled]);
  return scope && receipt?.token === token ? receipt.snapshot : {};
}
