import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LEGACY_MANUAL_VOC_OWNER_MANIFEST_SCHEMA_VERSION,
  LegacyManualAlexaVocSource,
  LegacyVocReadEligibilityGate,
  type LegacyManualVocOwnerManifest,
} from "../../server/data/legacy-manual-alexa-voc-source";
import {
  bindLegacyManualAlexaVoc,
  parseLegacyManualAlexaVocBindingArgv,
} from "../../server/cli/bind-legacy-manual-alexa-voc";

const ASIN = "B0TEST0001";
const ORGANIZATION_ID = "org-legacy-owner";
const CAPTURED_AT = "2026-08-30T08:07:06.543Z";
const CUTOFF = "2026-08-31T12:00:00.000Z";

function normalizedRecord() {
  return {
    asin: ASIN,
    captureStatus: "dialog" as const,
    alexaReport: {
      title: "Legacy report",
      asin: ASIN,
      rating: 4.5,
      reviewCount: 10,
      prompt: "Seven questions",
      overallConclusion: "Legacy conclusion",
      captureStatus: "dialog" as const,
    },
    attention: ["stable"],
    positives: ["easy"],
    negatives: ["heavy"],
    unmet: ["lighter"],
    audiences: ["families"],
    scenarios: ["outdoors"],
    motives: ["gift"],
  };
}

function manifest(
  overrides: Partial<LegacyManualVocOwnerManifest> = {},
): LegacyManualVocOwnerManifest {
  return {
    schemaVersion: LEGACY_MANUAL_VOC_OWNER_MANIFEST_SCHEMA_VERSION,
    ownerOrganizationId: ORGANIZATION_ID,
    marketplace: "US",
    artifactGeneration: "9",
    sourceHeadsHash: "a".repeat(64),
    generatedAt: "2026-08-31T00:00:00.000Z",
    records: {
      [ASIN]: {
        revision: "3",
        contentHash: "b".repeat(64),
        capturedAt: CAPTURED_AT,
        generation: "9",
      },
    },
    ...overrides,
  };
}

async function withDefaultOrganization<T>(
  value: string | undefined,
  operation: () => T | Promise<T>,
): Promise<T> {
  const previous = process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID;
  if (value === undefined) delete process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID;
  else process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID = value;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID;
    else process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID = previous;
  }
}

test("LegacyVocReadEligibilityGate closes owner, market, schema, generation, and config mismatches", async () => {
  await withDefaultOrganization(ORGANIZATION_ID, () => {
    assert.deepEqual(LegacyVocReadEligibilityGate(ORGANIZATION_ID, "US", manifest()), { allowed: true });
    assert.deepEqual(LegacyVocReadEligibilityGate("org-other", "US", manifest()), {
      allowed: false, reason: "owner_mismatch",
    });
    assert.deepEqual(LegacyVocReadEligibilityGate(
      ORGANIZATION_ID, "US", manifest({ marketplace: "CA" as "US" }),
    ), { allowed: false, reason: "marketplace_mismatch" });
    assert.deepEqual(LegacyVocReadEligibilityGate(
      ORGANIZATION_ID,
      "US",
      manifest({
        schemaVersion: "wrong" as typeof LEGACY_MANUAL_VOC_OWNER_MANIFEST_SCHEMA_VERSION,
      }),
    ), { allowed: false, reason: "schema_mismatch" });
    assert.deepEqual(LegacyVocReadEligibilityGate(ORGANIZATION_ID, "US", manifest({
      records: { [ASIN]: { ...manifest().records[ASIN]!, generation: "8" } },
    })), { allowed: false, reason: "generation_mismatch" });
    assert.deepEqual(LegacyVocReadEligibilityGate(ORGANIZATION_ID, "US", null), {
      allowed: false, reason: "owner_missing",
    });
  });
  await withDefaultOrganization(undefined, () => {
    assert.deepEqual(LegacyVocReadEligibilityGate(ORGANIZATION_ID, "US", null), {
      allowed: false, reason: "config_missing",
    });
  });
  await withDefaultOrganization("*", () => {
    assert.deepEqual(LegacyVocReadEligibilityGate(ORGANIZATION_ID, "US", null), {
      allowed: false, reason: "config_missing",
    });
  });
});

test("legacy reads expose exact per-ASIN capturedAt without owner fields", async () => {
  await withDefaultOrganization(ORGANIZATION_ID, async () => {
    let dataLoads = 0;
    const source = new LegacyManualAlexaVocSource({
      loadManifest: async () => manifest(),
      loadLegacyData: async () => {
        dataLoads += 1;
        return {
          capturedAt: "2026-08-30",
          marketplace: "US",
          data: { [ASIN]: normalizedRecord() },
        };
      },
    });
    const result = await source.readIfEligible({
      principalOrg: ORGANIZATION_ID,
      marketplace: "US",
      asin: ASIN,
      dataCutoffAt: "2026-08-31T00:00:00.000Z",
    });

    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    assert.equal(result.source, "legacy-static-stale");
    assert.equal(result.record.capturedAt, CAPTURED_AT);
    assert.equal(result.record.source, "legacy-static-stale");
    assert.equal(result.record.generation, "9");
    assert.equal(dataLoads, 1);
    assert.equal("ownerOrganizationId" in result, false);
    assert.equal(JSON.stringify(result).includes("sourceHeadsHash"), false);
  });
});

test("pre-binding date-only content is normalized and explicitly marked stale", async () => {
  await withDefaultOrganization(ORGANIZATION_ID, async () => {
    const source = new LegacyManualAlexaVocSource({
      loadManifest: async () => manifest({
        records: {
          [ASIN]: { ...manifest().records[ASIN]!, capturedAt: "2026-08-30" },
        },
      }),
      loadLegacyData: async () => ({
        capturedAt: "2026-08-30",
        marketplace: "US",
        data: { [ASIN]: normalizedRecord() },
      }),
    });
    const result = await source.readIfEligible({
      principalOrg: ORGANIZATION_ID,
      marketplace: "US",
      asin: ASIN,
      dataCutoffAt: "2026-08-31T00:00:00.000Z",
    });

    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    assert.equal(result.source, "legacy-static-date-only");
    assert.equal(result.record.capturedAt, "2026-08-30T23:59:59.999Z");
  });
});

test("ineligible organizations never load the legacy data module", async () => {
  await withDefaultOrganization(ORGANIZATION_ID, async () => {
    let dataLoads = 0;
    const source = new LegacyManualAlexaVocSource({
      loadManifest: async () => manifest(),
      loadLegacyData: async () => {
        dataLoads += 1;
        return { capturedAt: "2026-08-30", marketplace: "US", data: {} };
      },
    });
    const result = await source.readIfEligible({
      principalOrg: "org-other",
      marketplace: "US",
      asin: ASIN,
      dataCutoffAt: "2026-08-31T00:00:00.000Z",
    });
    assert.deepEqual(result, { status: "ineligible", reason: "owner_mismatch" });
    assert.equal(dataLoads, 0);
  });
});

test("binding CLI refuses request-derived ownership arguments", () => {
  assert.throws(
    () => parseLegacyManualAlexaVocBindingArgv(["--organization-id", ORGANIZATION_ID]),
    /unknown argument/i,
  );
  assert.throws(
    () => parseLegacyManualAlexaVocBindingArgv(["--request-organization-id", ORGANIZATION_ID]),
    /unknown argument/i,
  );
});

test("one-time binding validates an active actor, writes immutable owner metadata, and audits it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-voc-binding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "manifest.json");
  const auditDirectory = join(directory, "audit");
  const actor = {
    id: "legacy-owner-admin",
    organizationId: ORGANIZATION_ID,
    email: "owner@example.com",
    displayName: "Owner",
    role: "admin" as const,
    status: "active" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const dependencies = {
    defaultOrganizationId: ORGANIZATION_ID,
    findUserById: async (id: string) => id === actor.id ? actor : null,
    loadLegacyData: async () => ({
      capturedAt: "2026-08-30",
      marketplace: "US" as const,
      data: { [ASIN]: normalizedRecord() },
    }),
    now: () => "2026-08-31T01:02:03.004Z",
    createId: () => "70000000-0000-4000-8000-000000000001",
  };

  const first = await bindLegacyManualAlexaVoc({
    actorUserId: actor.id,
    marketplace: "US",
    manifestPath,
    auditDirectory,
  }, dependencies);
  const stored = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(first.created, true);
  assert.equal(stored.ownerOrganizationId, ORGANIZATION_ID);
  assert.equal(stored.records[ASIN].capturedAt, "2026-08-30");
  assert.equal(JSON.stringify(stored).includes("Legacy conclusion"), false);

  const replay = await bindLegacyManualAlexaVoc({
    actorUserId: actor.id,
    marketplace: "US",
    manifestPath,
    auditDirectory,
  }, dependencies);
  assert.equal(replay.created, false);
  await assert.rejects(
    bindLegacyManualAlexaVoc({
      actorUserId: "other-admin",
      marketplace: "US",
      manifestPath,
      auditDirectory,
    }, {
      ...dependencies,
      defaultOrganizationId: "org-other",
      findUserById: async () => ({ ...actor, id: "other-admin", organizationId: "org-other" }),
    }),
    /different organization|already bound/i,
  );

  const auditPath = join(auditDirectory, "70000000-0000-4000-8000-000000000001.json");
  const audit = JSON.parse(await readFile(auditPath, "utf8"));
  assert.deepEqual({ action: audit.action, organizationId: audit.organizationId }, {
    action: "manual-alexa-voc.legacy-owner-bound",
    organizationId: ORGANIZATION_ID,
  });
});

test("binding rejects invalid default orgs, nonexistent/inactive actors, and marketplace drift", async () => {
  const base = {
    actorUserId: "actor",
    marketplace: "US" as const,
    manifestPath: "unused-manifest.json",
    auditDirectory: "unused-audit",
  };
  const active = {
    id: "actor",
    organizationId: ORGANIZATION_ID,
    email: "owner@example.com",
    displayName: "Owner",
    role: "admin" as const,
    status: "active" as const,
    createdAt: CUTOFF,
    updatedAt: CUTOFF,
  };
  const dependencies = {
    defaultOrganizationId: ORGANIZATION_ID,
    findUserById: async () => active,
    loadLegacyData: async () => ({
      capturedAt: "2026-08-30", marketplace: "US" as const, data: {},
    }),
  };

  for (const defaultOrganizationId of ["", "*", " request-org "]) {
    await assert.rejects(
      bindLegacyManualAlexaVoc(base, { ...dependencies, defaultOrganizationId }),
      /default organization/i,
    );
  }
  await assert.rejects(
    bindLegacyManualAlexaVoc(base, { ...dependencies, findUserById: async () => null }),
    /does not exist/i,
  );
  await assert.rejects(
    bindLegacyManualAlexaVoc(base, {
      ...dependencies,
      findUserById: async () => ({ ...active, status: "disabled" as const }),
    }),
    /active/i,
  );
  await assert.rejects(
    bindLegacyManualAlexaVoc(base, {
      ...dependencies,
      findUserById: async () => ({ ...active, organizationId: "org-other" }),
    }),
    /organization/i,
  );
  await assert.rejects(
    bindLegacyManualAlexaVoc({ ...base, marketplace: "CA" as "US" }, dependencies),
    /marketplace/i,
  );
});
