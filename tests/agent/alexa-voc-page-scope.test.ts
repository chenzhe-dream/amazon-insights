import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveAlexaVocPageScope } from "../../app/lib/alexa-voc-page-scope";

const PROJECT_A = "10000000-0000-4000-8000-000000000010";
const PROJECT_B = "10000000-0000-4000-8000-000000000011";
const RUN_A = "10000000-0000-4000-8000-000000000012";

test("run A cannot authorize Alexa import or polling in current project B", () => {
  assert.deepEqual(resolveAlexaVocPageScope({
    currentProjectId: PROJECT_B,
    resumedSyncScope: {
      status: "resolved",
      context: { projectId: PROJECT_A, runId: RUN_A },
    },
  }), {
    manualListProjectId: PROJECT_B,
    authoritativeImportScope: null,
    canPoll: false,
  });
});

test("resolving run scope disables Alexa import and polling", () => {
  assert.deepEqual(resolveAlexaVocPageScope({
    currentProjectId: PROJECT_B,
    resumedSyncScope: { status: "resolving", context: null },
  }), {
    manualListProjectId: PROJECT_B,
    authoritativeImportScope: null,
    canPoll: false,
  });
});

test("only an exactly matching resolved run scope becomes authoritative", () => {
  assert.deepEqual(resolveAlexaVocPageScope({
    currentProjectId: PROJECT_B,
    resumedSyncScope: {
      status: "resolved",
      context: { projectId: PROJECT_B, runId: RUN_A },
    },
  }), {
    manualListProjectId: PROJECT_B,
    authoritativeImportScope: { projectId: PROJECT_B, runId: RUN_A },
    canPoll: true,
  });
});

test("the page lists Manual VOC from the current project and passes only authoritative import scope", () => {
  const page = readFileSync("app/page.tsx", "utf8");
  const hook = page.slice(page.indexOf("const manualVoc = useManualAlexaVoc"), page.indexOf("const manualVocByAsin"));
  const panelStart = page.indexOf("<AlexaVocImportPanel");
  const panel = page.slice(panelStart, page.indexOf("/>", panelStart) + 2);
  assert.match(hook, /projectId: alexaVocPageScope\.manualListProjectId/);
  assert.match(panel, /projectId=\{alexaVocPageScope\.authoritativeImportScope\?\.projectId \?\? null\}/);
  assert.match(panel, /runId=\{alexaVocPageScope\.authoritativeImportScope\?\.runId \?\? null\}/);
  assert.match(panel, /pollingEnabled=\{alexaVocPageScope\.canPoll\}/);
  assert.doesNotMatch(panel, /projectId=\{resumedProjectId \?\? currentProjectId\}/);
});
