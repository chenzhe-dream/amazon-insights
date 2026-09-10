"use client";
import { useEffect, useMemo, useState } from "react";
import { localAgentFetch } from "./local-agent-browser";
import { createVocReviewReader, type VocReviewScope } from "./voc-review-reader";
import type { StageOutputEntry, StageOutputSnapshot } from "./stage-output-browser";
import { selectVerifiedReviewSnapshot } from "./voc-review-snapshot";

export function useVocReviewOutput(scopeKey: string, scope: VocReviewScope | null, enabled: boolean, seed?: StageOutputEntry): { snapshot: StageOutputSnapshot; refreshFailed: boolean } {
  const token = useMemo(() => ({ scopeKey }), [scopeKey]);
  const [receipt, setReceipt] = useState<{ token: object; snapshot: StageOutputSnapshot; refreshFailed: boolean } | null>(null);
  const trustedSeed = scope && seed && seed.stageStatus !== "missing-output" && seed.projectId === scope.projectId && seed.runId === scope.runId && seed.jobId === scope.jobId ? seed : undefined;
  useEffect(() => {
    if (!scope || !enabled) return;
    const reader = createVocReviewReader(scope, localAgentFetch, snapshot => setReceipt(previous => {
      const retained = selectVerifiedReviewSnapshot(trustedSeed, previous?.token === token ? previous.snapshot.reviews : undefined);
      return { token, snapshot: { reviews: selectVerifiedReviewSnapshot(retained, snapshot.reviews) }, refreshFailed: snapshot.reviews?.stageStatus === "missing-output" };
    }));
    let timer: number | undefined;
    const refresh = async () => {
      await reader.refresh();
      if (!reader.isSettled()) timer = window.setTimeout(refresh, 3000);
    };
    void refresh();
    return () => { window.clearTimeout(timer); reader.dispose(); };
  }, [scope, token, enabled, trustedSeed]);
  const current = receipt?.token === token ? receipt : null;
  const reviews = scope ? selectVerifiedReviewSnapshot(trustedSeed, current?.snapshot.reviews) : undefined;
  return { snapshot: reviews ? { reviews } : {}, refreshFailed: Boolean(scope && current?.refreshFailed) };
}
