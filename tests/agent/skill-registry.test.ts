import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SkillManifestSchema,
  computeSkillContentHash,
  computeSkillContentHashFromEntries,
  type SkillManifest,
} from "../../server/skills/manifest";
import {
  agentDefinitions,
  validateAgentDefinitions,
} from "../../server/skills/agent-definitions";
import { SkillRegistry } from "../../server/skills/registry";

const repoSkillsRoot = path.resolve("skills-src");

async function withTempDirectory(
  run: (directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-skills-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type ManifestOverrides = Partial<Omit<SkillManifest, "contentHash">>;

async function createSkill(
  root: string,
  directoryName: string,
  overrides: ManifestOverrides = {},
  entryMarkdown = "Read [rules](references/rules.md).\n",
) {
  const skillDirectory = path.join(root, directoryName);
  await mkdir(path.join(skillDirectory, "references"), { recursive: true });
  await writeFile(path.join(skillDirectory, "SKILL.md"), entryMarkdown, "utf8");
  await writeFile(
    path.join(skillDirectory, "references", "rules.md"),
    "# Rules\n\nUse evidence.\n",
    "utf8",
  );

  const manifestWithoutHash = {
    id: "test-analysis-skill",
    version: "1.0.0",
    entry: "SKILL.md",
    allowedReferences: ["references/rules.md"],
    inputSchema: "TestAnalysisInput@1.0.0",
    outputSchema: "TestAnalysisOutput@1.0.0",
    fixtures: ["test-analysis-complete-v1"],
    ...overrides,
  };
  const manifest = {
    ...manifestWithoutHash,
    contentHash: await computeSkillContentHash(
      skillDirectory,
      manifestWithoutHash,
    ),
  } satisfies SkillManifest;
  await writeFile(
    path.join(skillDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return { manifest, skillDirectory };
}

test("published manifests are strict, versioned, and all five Skills load", async () => {
  const registry = await SkillRegistry.open(repoSkillsRoot);
  const registered = registry.list();

  assert.deepEqual(
    registered.map(({ id }) => id),
    [
      "alexa-for-shopping-voc",
      "amazon-voc-insight",
      "analyze-amazon-competitor-traffic",
      "define-amazon-product-from-voc-keywords",
      "define-amazon-voc-positioning",
    ],
  );
  assert.deepEqual(
    registered.map(({ id, version }) => ({ id, version })),
    [
      { id: "alexa-for-shopping-voc", version: "1.1.1" },
      { id: "amazon-voc-insight", version: "1.0.0" },
      { id: "analyze-amazon-competitor-traffic", version: "1.0.0" },
      { id: "define-amazon-product-from-voc-keywords", version: "1.0.0" },
      { id: "define-amazon-voc-positioning", version: "1.0.2" },
    ],
  );

  for (const item of registered) {
    const loaded = await registry.load(item.id, item.version);
    assert.equal(loaded.manifest.contentHash, item.contentHash);
    assert.match(loaded.instructions, /^---[\s\S]+# /);
    assert.deepEqual(
      [...loaded.references.keys()],
      loaded.manifest.allowedReferences,
    );
    assert.equal("openAiConfig" in loaded, false);
    assert.equal("icon" in loaded, false);
  }
});

test("registers only the vendored Alexa normalizer and formal VOC insight skills", async () => {
  const registry = await SkillRegistry.open(repoSkillsRoot);
  assert.deepEqual(
    registry
      .list()
      .filter((skill) =>
        [
          "alexa-for-shopping-voc",
          "amazon-voc-insight",
          "voc-listing-optimizer",
        ].includes(skill.id),
      )
      .map((skill) => skill.id),
    ["alexa-for-shopping-voc", "amazon-voc-insight"],
  );
  await assert.rejects(
    registry.load("voc-listing-optimizer", "1.0.0"),
    /Skill is not registered/,
  );
});

test("strict manifests reject unknown fields and path traversal", () => {
  const valid = {
    id: "test-analysis-skill",
    version: "1.0.0",
    entry: "SKILL.md",
    allowedReferences: ["references/rules.md"],
    inputSchema: "TestAnalysisInput@1.0.0",
    outputSchema: "TestAnalysisOutput@1.0.0",
    fixtures: ["test-analysis-complete-v1"],
    contentHash: "a".repeat(64),
  };

  assert.equal(SkillManifestSchema.safeParse(valid).success, true);
  assert.equal(
    SkillManifestSchema.safeParse({ ...valid, entry: "../SKILL.md" }).success,
    false,
  );
  assert.equal(
    SkillManifestSchema.safeParse({
      ...valid,
      allowedReferences: ["references/../../secret.md"],
    }).success,
    false,
  );
  assert.equal(
    SkillManifestSchema.safeParse({ ...valid, command: "node script.js" })
      .success,
    false,
  );
});

test("the loader rejects a missing entry file", async () => {
  await withTempDirectory(async (root) => {
    const { manifest, skillDirectory } = await createSkill(root, "missing-entry");
    await unlink(path.join(skillDirectory, manifest.entry));

    const registry = await SkillRegistry.open(root);
    await assert.rejects(
      registry.load(manifest.id, manifest.version),
      /entry.*missing|missing.*entry/i,
    );
  });
});

test("the loader rejects Markdown links to undeclared references", async () => {
  await withTempDirectory(async (root) => {
    const { manifest, skillDirectory } = await createSkill(
      root,
      "undeclared-reference",
      {},
      "Read [rules](references/rules.md) and [secret](references/secret.md).\n",
    );
    await writeFile(
      path.join(skillDirectory, "references", "secret.md"),
      "# Undeclared\n",
      "utf8",
    );

    const registry = await SkillRegistry.open(root);
    await assert.rejects(
      registry.load(manifest.id, manifest.version),
      /undeclared reference/i,
    );
  });
});

test("the loader rejects reference-style and HTML undeclared references", async () => {
  for (const entryMarkdown of [
    "Read [secret][ref].\n\n[ref]: references/secret.md\n",
    '<a href="references/secret.md">secret</a>\n',
    '<img src="references%2F..%2Fsecret.md">\n',
    "<a href=references/secret.md>secret</a>\n",
    "<img src=references%2F..%2Fsecret.md>\n",
  ]) {
    await withTempDirectory(async (root) => {
      const { manifest, skillDirectory } = await createSkill(
        root,
        "undeclared-reference-syntax",
        {},
        entryMarkdown,
      );
      await writeFile(
        path.join(skillDirectory, "references", "secret.md"),
        "# Undeclared\n",
        "utf8",
      );

      const registry = await SkillRegistry.open(root);
      await assert.rejects(
        registry.load(manifest.id, manifest.version),
        /undeclared reference/i,
      );
    });
  }
});

test("the registry rejects duplicate Skill ID and version pairs", async () => {
  await withTempDirectory(async (root) => {
    await createSkill(root, "first");
    await createSkill(root, "second");

    await assert.rejects(SkillRegistry.open(root), /duplicate.*id.*version/i);
  });
});

test("the loader rejects manifest and content hash mismatches", async () => {
  await withTempDirectory(async (root) => {
    const { manifest, skillDirectory } = await createSkill(root, "hash-mismatch");
    await writeFile(
      path.join(skillDirectory, manifest.entry),
      "Changed after the manifest was signed.\n",
      "utf8",
    );

    const registry = await SkillRegistry.open(root);
    await assert.rejects(
      registry.load(manifest.id, manifest.version),
      /content hash mismatch/i,
    );
  });
});

test("content hashing is stable across path separators, line endings, and entry order", () => {
  const manifest = {
    id: "test-analysis-skill",
    version: "1.0.0",
    entry: "SKILL.md",
    allowedReferences: ["references/rules.md"],
    inputSchema: "TestAnalysisInput@1.0.0",
    outputSchema: "TestAnalysisOutput@1.0.0",
    fixtures: ["test-analysis-complete-v1"],
  };
  const windowsOrdered = [
    { path: "references\\rules.md", content: "# Rules\r\nUse evidence.\r\n" },
    { path: "SKILL.md", content: "# Skill\r\n" },
  ];
  const unixOrdered = [
    { path: "SKILL.md", content: "# Skill\n" },
    { path: "references/rules.md", content: "# Rules\nUse evidence.\n" },
  ];

  assert.equal(
    computeSkillContentHashFromEntries(manifest, windowsOrdered),
    computeSkillContentHashFromEntries(manifest, unixOrdered),
  );
});

test("all Agent Definitions resolve registered Skills, schemas, budgets, and dependencies", async () => {
  const registry = await SkillRegistry.open(repoSkillsRoot);
  const validated = await validateAgentDefinitions(agentDefinitions, registry);

  assert.deepEqual(
    validated.map(({ id }) => id),
    [
      "traffic-analysis",
      "alexa-voc-normalization",
      "voc-positioning",
      "product-definition",
    ],
  );
  assert.deepEqual(validated[0].dependencies, []);
  assert.deepEqual(validated[1].dependencies, []);
  assert.deepEqual(validated[2].dependencies, []);
  assert.deepEqual(validated[3].dependencies, [
    { kind: "agent", id: "voc-positioning" },
    { kind: "snapshot", id: "keyword-analysis" },
  ]);
  assert.deepEqual(
    {
      skill: validated[2].skill,
      inputSchema: validated[2].inputSchema,
      outputSchema: validated[2].outputSchema,
    },
    {
      skill: { id: "amazon-voc-insight", version: "1.0.0" },
      inputSchema: "AmazonVocInsightInput@1.0.0",
      outputSchema: "AmazonVocInsightOutput@1.0.0",
    },
  );
  assert.equal(
    validated.every(
      ({ budget }) =>
        budget.maxInputTokens > 0 &&
        budget.maxOutputTokens > 0 &&
        budget.timeoutMs > 0,
    ),
    true,
  );
});
