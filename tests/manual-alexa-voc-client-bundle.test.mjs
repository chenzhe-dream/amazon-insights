import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = path.join(repositoryRoot, "dist", "client");
const serverRoot = path.join(repositoryRoot, "dist", "server");
const legacyInput = path.join(repositoryRoot, "app", "rufus-voc-data.ts");
const fixedForbidden = [
  "rufus-voc-data",
  "B0TENANT01",
  "TENANT_VOC_SENTINEL",
  "ownerOrganizationId",
  "sourceHeadsHash",
];
const textArtifact = /\.(?:html|js|json|map)$/i;

async function filesBelow(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && textArtifact.test(entry.name)) files.push(target);
    }
  }
  return files.sort();
}

function protectedLegacySentinels(source) {
  const dataStart = source.indexOf("export const rufusVocData");
  assert.notEqual(dataStart, -1, "server legacy input must expose its data boundary");
  const dataSource = source.slice(dataStart);
  const candidates = [];
  const stringLiteral = /(["'])([^\r\n"']{72,})\1/g;
  for (const match of dataSource.matchAll(stringLiteral)) {
    const value = match[2];
    if (!value || value.includes("${") || value.includes("\\")) continue;
    if (!/[\u3400-\u9fff]/u.test(value)) continue;
    if (!candidates.includes(value)) candidates.push(value);
  }
  assert.ok(
    candidates.length >= 3,
    "server legacy input must provide at least three real protected sentinels",
  );
  return candidates.slice(0, 8);
}

async function assertAbsent(files, forbidden, label) {
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const sentinel of forbidden) {
      assert.equal(
        text.includes(sentinel),
        false,
        `${path.relative(repositoryRoot, file)} leaked ${label} sentinel`,
      );
    }
  }
}

test("production client manifests and chunks exclude Manual Alexa VOC tenant/server inputs", async () => {
  await access(path.join(clientRoot, ".vite", "manifest.json"));
  const clientFiles = await filesBelow(clientRoot);
  assert.ok(clientFiles.some(file => file.endsWith("manifest.json")));
  assert.ok(clientFiles.some(file => file.endsWith(".js")));

  const legacySource = await readFile(legacyInput, "utf8");
  const tenantSentinels = protectedLegacySentinels(legacySource);
  await assertAbsent(clientFiles, [...fixedForbidden, ...tenantSentinels], "client");
});

test("Web server build may name server modules but excludes raw legacy tenant report sentinels", async () => {
  const serverFiles = await filesBelow(serverRoot);
  assert.ok(serverFiles.some(file => file.endsWith(".js")));
  const tenantSentinels = protectedLegacySentinels(await readFile(legacyInput, "utf8"));
  await assertAbsent(serverFiles, tenantSentinels, "server raw-report");
});
