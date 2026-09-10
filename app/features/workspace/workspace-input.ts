"use client";

import { useState, useMemo, useCallback } from "react";
import { parseBatchAsinInput } from "../../lib/asin-batch-input";
import { type BuilderNotice, shouldShowBuilderNotice } from "../../lib/primary-admin";
import { buildInputSlots } from "../projects/workspace-navigation";
import { type MarketCode } from "../catalog/product-contracts";
import { ROOT_PATH_DIAGNOSTIC } from "./workspace-runtime-contracts";
import type { useWorkspaceLocation } from "./workspace-location";
import type { AuthenticatedWebSession } from "../../auth-session-gate";

type useWorkspaceInputInputs = Pick<ReturnType<typeof useWorkspaceLocation>, "initialAsins" | "slugParam">
  & { authSession: AuthenticatedWebSession };

export function useWorkspaceInput({ initialAsins, slugParam, authSession }: useWorkspaceInputInputs) {
  const [market, setMarket] = useState<MarketCode>("US");

  const [inputs, setInputs] = useState(() => buildInputSlots(initialAsins));

  const [asinDraft, setAsinDraft] = useState(() => initialAsins.join("\n"));

  const asinParse = useMemo(() => parseBatchAsinInput(asinDraft), [asinDraft]);

  const replaceInputAsins = useCallback((asins: string[]) => {
    setInputs(buildInputSlots(asins));
    setAsinDraft(asins.join("\n"));
  }, []);

  const [activeAsins, setActiveAsins] = useState(initialAsins);

  const [salesView, setSalesView] = useState<"history" | "revenue" | "prices" | "ranks">("history");

  const [builderNotice, setBuilderNotice] = useState<BuilderNotice>(() =>
    slugParam
      ? { kind: "business", text: `正在打开工作区 /p/${slugParam}` }
      : { kind: "path-diagnostic", text: ROOT_PATH_DIAGNOSTIC },
  );

  const setMessage = useCallback((text: string) => {
    setBuilderNotice({ kind: "business", text });
  }, []);

  const message = builderNotice.text;

  const showBuilderNotice = shouldShowBuilderNotice(builderNotice, authSession.user);

  return {
    market, setMarket, inputs, setInputs, asinDraft, setAsinDraft, asinParse, replaceInputAsins, activeAsins, setActiveAsins,
    salesView, setSalesView, setMessage, message, showBuilderNotice,
  };
}
