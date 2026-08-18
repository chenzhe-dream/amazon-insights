import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import {
  ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS,
} from "../../server/evaluation/analysis-agent-auto-evaluator";
import { REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS } from "../../server/evaluation/analysis-agent-evaluation-contract";
import {
  ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS,
  createAnalysisAgentHumanRating,
  createAnalysisAgentModuleModeEvent,
  resolveAnalysisAgentModuleMode,
} from "../../server/evaluation/analysis-agent-human-review";
import {
  analysisAgentReleaseCandidateDigest,
  createAnalysisAgentReleaseCandidate,
  evaluateAnalysisAgentRelease,
} from "../../server/evaluation/analysis-agent-release-gate";

const NOW = "2026-08-18T13:00:00.000Z";
const ORG_A = "40000000-0000-4000-8000-000000000001";
const ORG_B = "40000000-0000-4000-8000-000000000002";
const ACTOR_A = "40000000-0000-4000-8000-000000000003";
const ACTOR_B = "40000000-0000-4000-8000-000000000004";
const SKILL = {
  id: "define-amazon-voc-positioning",
  version: "1.0.0",
  contentHash: "b".repeat(64),
};
const MODEL = { provider: "openai", model: "gpt-release-fixture" };

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amazon-agent-release-decision-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

async function seedActors(repository: ReturnType<typeof openSqliteAgentRepository>) {
  for (const [id, organizationId, suffix] of [
    [ACTOR_A, ORG_A, "a"],
    [ACTOR_B, ORG_B, "b"],
  ] as const) {
    await repository.createUser({
      id,
      organizationId,
      email: `release-${suffix}@example.com`,
      displayName: `Release ${suffix}`,
      role: "admin",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

function releaseCandidate(organizationId = ORG_A) {
  return createAnalysisAgentReleaseCandidate({
    schemaVersion: "1.0.0",
    organizationId,
    module: "voc-positioning",
    skill: SKILL,
    model: MODEL,
    evalSetVersion: "openspec-9.1.0",
  });
}

function decision(
  id: string,
  options: { organizationId?: string; actorUserId?: string; lowScore?: boolean } = {},
) {
  const organizationId = options.organizationId ?? ORG_A;
  const actorUserId = options.actorUserId ?? ACTOR_A;
  const candidate = releaseCandidate(organizationId);
  return evaluateAnalysisAgentRelease({
    id,
    actorUserId,
    createdAt: NOW,
    candidate,
    autoResults: REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS.map((caseId) => ({
      candidateDigest: analysisAgentReleaseCandidateDigest(candidate),
      evalSetVersion: "openspec-9.1.0",
      caseId,
      passed: true,
      gates: ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS.map((gateId) => ({
        id: gateId,
        passed: true,
        ruleIds: [],
      })),
    })),
    humanRatings: REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS.map((caseId, index) =>
      createAnalysisAgentHumanRating({
        id: `40000000-0000-4000-8000-${(100 + index).toString().padStart(12, "0")}`,
        organizationId,
        actorUserId,
        module: "voc-positioning",
        evalSetVersion: "openspec-9.1.0",
        caseId,
        skill: SKILL,
        model: MODEL,
        reportId: `40000000-0000-4000-8000-${(200 + index).toString().padStart(12, "0")}`,
        scores: Object.fromEntries(
          ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS.map((dimension) => [
            dimension,
            options.lowScore && index === 0 && dimension === "accuracy" ? 3 : 4,
          ]),
        ),
        createdAt: NOW,
      }),
    ),
  });
}

function primaryMode(
  id: string,
  releaseDecisionId: string,
  candidateDigest: string,
  organizationId = ORG_A,
  actorUserId = ACTOR_A,
) {
  return createAnalysisAgentModuleModeEvent({
    id,
    organizationId,
    actorUserId,
    module: "voc-positioning",
    mode: "agent-primary",
    releaseDecisionId,
    candidateDigest,
    reason: "Approved release",
    createdAt: NOW,
  });
}

test("SQLite appends immutable approved and rejected release decisions with organization isolation", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedActors(repository);
  const approved = decision("40000000-0000-4000-8000-000000000010");
  const rejected = decision("40000000-0000-4000-8000-000000000011", { lowScore: true });
  const crossOrganizationActor = decision("40000000-0000-4000-8000-000000000012", {
    actorUserId: ACTOR_B,
  });
  assert.equal(approved.status, "approved");
  assert.equal(rejected.status, "rejected");

  assert.deepEqual(await repository.appendAnalysisAgentReleaseDecision(approved), approved);
  assert.deepEqual(await repository.appendAnalysisAgentReleaseDecision(rejected), rejected);
  await assert.rejects(() => repository.appendAnalysisAgentReleaseDecision(approved));
  await assert.rejects(() => repository.appendAnalysisAgentReleaseDecision(crossOrganizationActor));
  assert.equal(await repository.findAnalysisAgentReleaseDecision({
    organizationId: ORG_A,
    decisionId: crossOrganizationActor.id,
  }), null);
  assert.deepEqual(await repository.findAnalysisAgentReleaseDecision({
    organizationId: ORG_A,
    decisionId: approved.id,
  }), approved);
  assert.equal(await repository.findAnalysisAgentReleaseDecision({
    organizationId: ORG_B,
    decisionId: approved.id,
  }), null);
});

test("agent-primary requires the exact same-organization approved decision and rollback remains immediate", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedActors(repository);
  const approved = decision("40000000-0000-4000-8000-000000000020");
  await repository.appendAnalysisAgentReleaseDecision(approved);
  const primary = primaryMode(
    "40000000-0000-4000-8000-000000000021",
    approved.id,
    approved.candidateDigest,
  );
  assert.deepEqual(await repository.appendAnalysisAgentModuleMode(primary), primary);
  assert.deepEqual(await repository.findLatestAnalysisAgentModuleMode({
    organizationId: ORG_A,
    module: "voc-positioning",
  }), primary);
  assert.deepEqual(await resolveAnalysisAgentModuleMode(repository, {
    organizationId: ORG_A,
    module: "voc-positioning",
  }), {
    module: "voc-positioning",
    mode: "agent-primary",
    source: "event",
    releaseDecisionId: approved.id,
    candidateDigest: approved.candidateDigest,
  });

  const rollback = createAnalysisAgentModuleModeEvent({
    id: "40000000-0000-4000-8000-000000000022",
    organizationId: ORG_A,
    actorUserId: ACTOR_A,
    module: "voc-positioning",
    mode: "legacy-primary",
    reason: "Immediate rollback",
    createdAt: "2026-08-18T12:59:00.000Z",
  });
  assert.deepEqual(await repository.appendAnalysisAgentModuleMode(rollback), rollback);
  assert.deepEqual(await repository.findLatestAnalysisAgentModuleMode({
    organizationId: ORG_A,
    module: "voc-positioning",
  }), rollback);
});

test("missing rejected mismatched cross-organization or corrupt decisions cannot change primary mode", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedActors(repository);
  const baseline = createAnalysisAgentModuleModeEvent({
    id: "40000000-0000-4000-8000-000000000030",
    organizationId: ORG_A,
    actorUserId: ACTOR_A,
    module: "voc-positioning",
    mode: "legacy-primary",
    reason: "Baseline",
    createdAt: NOW,
  });
  await repository.appendAnalysisAgentModuleMode(baseline);
  const approved = decision("40000000-0000-4000-8000-000000000031");
  const rejected = decision("40000000-0000-4000-8000-000000000032", { lowScore: true });
  const foreign = decision("40000000-0000-4000-8000-000000000033", {
    organizationId: ORG_B,
    actorUserId: ACTOR_B,
  });
  await repository.appendAnalysisAgentReleaseDecision(approved);
  await repository.appendAnalysisAgentReleaseDecision(rejected);
  await repository.appendAnalysisAgentReleaseDecision(foreign);

  for (const event of [
    primaryMode("40000000-0000-4000-8000-000000000041", "40000000-0000-4000-8000-000000000099", approved.candidateDigest),
    primaryMode("40000000-0000-4000-8000-000000000042", rejected.id, rejected.candidateDigest),
    primaryMode("40000000-0000-4000-8000-000000000043", approved.id, "f".repeat(64)),
    primaryMode("40000000-0000-4000-8000-000000000044", foreign.id, foreign.candidateDigest),
  ]) {
    await assert.rejects(() => repository.appendAnalysisAgentModuleMode(event));
  }

  const inspector = new DatabaseSync(path);
  inspector.prepare(
    `INSERT INTO audit_events
     (id, organization_id, actor_user_id, action, target_type, target_id,
      metadata_json, created_at)
     VALUES (?, ?, ?, 'analysis-agent.release-decision-recorded',
             'analysis-module', 'voc-positioning', ?, ?)`,
  ).run(
    "40000000-0000-4000-8000-000000000034",
    ORG_A,
    ACTOR_A,
    JSON.stringify({ status: "approved", candidateDigest: approved.candidateDigest }),
    NOW,
  );
  inspector.close();
  await assert.rejects(() => repository.appendAnalysisAgentModuleMode(
    primaryMode(
      "40000000-0000-4000-8000-000000000045",
      "40000000-0000-4000-8000-000000000034",
      approved.candidateDigest,
    ),
  ));

  assert.deepEqual(await repository.findLatestAnalysisAgentModuleMode({
    organizationId: ORG_A,
    module: "voc-positioning",
  }), baseline);
  const readOnly = new DatabaseSync(path, { readOnly: true });
  const modeCount = Number((readOnly.prepare(
    `SELECT COUNT(*) AS count FROM audit_events
     WHERE organization_id = ? AND action = 'analysis-agent.module-mode-set'`,
  ).get(ORG_A) as { count: number }).count);
  readOnly.close();
  assert.equal(modeCount, 1);
});
