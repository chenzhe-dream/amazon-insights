import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AlexaVocImportPanel } from "../../../app/alexa-voc-import-panel";
import "../../../app/globals.css";

const PROJECT_A = "10000000-0000-4000-8000-000000000010";
const RUN_A = "10000000-0000-4000-8000-000000000011";
const ASIN_A = "B099WTN2TR";
const ASIN_B = "B0B95XH99V";

declare global {
  interface Window {
    vocImported?: unknown[];
    switchVocScope?: (projectId: string, runId: string) => void;
    unmountVocPanel?: () => void;
  }
}

const existingRecord = {
  asin: ASIN_A,
  marketplace: "US" as const,
  revision: "3",
  contentHash: "c".repeat(64),
  normalizedRecord: {
    asin: ASIN_A,
    attention: [], positives: [], negatives: [], unmet: [], audiences: [], scenarios: [], motives: [],
    captureStatus: "dialog" as const,
    alexaReport: {
      title: "Existing lamp", asin: ASIN_A, rating: 4.3, reviewCount: 8,
      prompt: "Seven questions", overallConclusion: "Existing result",
    },
  },
  source: "postgres" as const,
  generation: null,
  capturedAt: "2026-09-01T08:00:00.000Z",
  sessionOrgEpoch: 1,
};

function Harness() {
  const [scope, setScope] = useState({ projectId: PROJECT_A, runId: RUN_A });
  useEffect(() => {
    window.switchVocScope = (projectId, runId) => setScope({ projectId, runId });
    return () => { delete window.switchVocScope; };
  }, []);
  return (
    <AlexaVocImportPanel
      projectId={scope.projectId}
      runId={scope.runId}
      products={[
        { asin: ASIN_A, brand: "Alpha", title: "Alpha lamp" },
        { asin: ASIN_B, brand: "Beta", title: "Beta lamp" },
      ]}
      effectiveVocByAsin={{ [ASIN_A]: existingRecord, [ASIN_B]: null }}
      statusByAsin={{ [ASIN_A]: "ready", [ASIN_B]: "missing" }}
      onImported={record => {
        window.vocImported!.push(record);
        return true;
      }}
      pollingEnabled
    />
  );
}

const root: Root = createRoot(document.getElementById("root")!);
window.vocImported = [];
window.unmountVocPanel = () => root.unmount();
root.render(<Harness />);
