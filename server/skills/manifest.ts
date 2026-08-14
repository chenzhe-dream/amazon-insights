import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCHEMA_NAME_PATTERN =
  /^[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const MAX_MARKDOWN_FILE_BYTES = 1_048_576;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function comparePortableText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSafeRelativePath(value: string) {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }

  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

const MarkdownPathSchema = z
  .string()
  .max(256)
  .refine(isSafeRelativePath, "must be a safe POSIX relative path")
  .refine((value) => value.toLowerCase().endsWith(".md"), "must be Markdown");

const ReferencePathSchema = MarkdownPathSchema.refine(
  (value) => value.startsWith("references/"),
  "must be inside references/",
);

export const SchemaNameSchema = z.string().regex(SCHEMA_NAME_PATTERN);

function isSortedUnique(values: readonly string[]) {
  return values.every(
    (value, index) => index === 0 || comparePortableText(values[index - 1], value) < 0,
  );
}

export const SkillManifestSchema = z
  .object({
    id: z.string().regex(SKILL_ID_PATTERN),
    version: z.string().regex(SEMVER_PATTERN),
    entry: MarkdownPathSchema,
    allowedReferences: z
      .array(ReferencePathSchema)
      .min(1)
      .refine(isSortedUnique, "must be sorted and unique"),
    inputSchema: SchemaNameSchema,
    outputSchema: SchemaNameSchema,
    fixtures: z
      .array(z.string().regex(SKILL_ID_PATTERN))
      .min(1)
      .refine(isSortedUnique, "must be sorted and unique"),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type SkillManifestWithoutHash = Omit<SkillManifest, "contentHash">;

export interface SkillContentEntry {
  path: string;
  content: string;
}

function normalizeText(content: string) {
  return content.replace(/\r\n?/g, "\n");
}

function normalizeEntryPath(value: string) {
  return value.replaceAll("\\", "/");
}

function updateFramed(hash: ReturnType<typeof createHash>, value: string) {
  const bytes = Buffer.from(value, "utf8");
  hash.update(String(bytes.length));
  hash.update(":");
  hash.update(bytes);
  hash.update("\0");
}

function canonicalManifestMetadata(manifest: SkillManifestWithoutHash) {
  return JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    entry: manifest.entry,
    allowedReferences: manifest.allowedReferences,
    inputSchema: manifest.inputSchema,
    outputSchema: manifest.outputSchema,
    fixtures: manifest.fixtures,
  });
}

export function computeSkillContentHashFromEntries(
  manifest: SkillManifestWithoutHash,
  entries: readonly SkillContentEntry[],
) {
  const parsedManifest = SkillManifestSchema.omit({ contentHash: true }).parse(
    manifest,
  );
  const expectedPaths = [
    parsedManifest.entry,
    ...parsedManifest.allowedReferences,
  ].sort(comparePortableText);
  const normalizedEntries = entries
    .map((entry) => ({
      path: normalizeEntryPath(entry.path),
      content: normalizeText(entry.content),
    }))
    .sort((left, right) => comparePortableText(left.path, right.path));

  assertExactContentSet(expectedPaths, normalizedEntries.map(({ path }) => path));

  const hash = createHash("sha256");
  updateFramed(hash, "amazon-agent-skill-content-v1");
  updateFramed(hash, canonicalManifestMetadata(parsedManifest));
  for (const entry of normalizedEntries) {
    updateFramed(hash, entry.path);
    updateFramed(hash, entry.content);
  }
  return hash.digest("hex");
}

function assertExactContentSet(
  expectedPaths: readonly string[],
  actualPaths: readonly string[],
) {
  if (
    expectedPaths.length !== actualPaths.length ||
    expectedPaths.some((value, index) => value !== actualPaths[index])
  ) {
    throw new Error(
      `Skill content set mismatch: expected ${expectedPaths.join(", ")}; received ${actualPaths.join(", ")}`,
    );
  }
}

function isInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function readSkillTextFile(
  skillDirectory: string,
  relativePath: string,
) {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`Unsafe Skill path: ${relativePath}`);
  }

  const root = await realpath(skillDirectory);
  const candidate = path.resolve(root, ...relativePath.split("/"));
  if (!isInside(root, candidate)) {
    throw new Error(`Skill path escapes its directory: ${relativePath}`);
  }

  let stats;
  try {
    stats = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Skill file is missing: ${relativePath}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Skill path must be a regular file: ${relativePath}`);
  }
  if (stats.size > MAX_MARKDOWN_FILE_BYTES) {
    throw new Error(`Skill file exceeds the size limit: ${relativePath}`);
  }

  const resolvedCandidate = await realpath(candidate);
  if (!isInside(root, resolvedCandidate)) {
    throw new Error(`Skill path resolves outside its directory: ${relativePath}`);
  }
  return utf8Decoder.decode(await readFile(resolvedCandidate));
}

export async function computeSkillContentHash(
  skillDirectory: string,
  manifest: SkillManifestWithoutHash,
) {
  const paths = [manifest.entry, ...manifest.allowedReferences];
  const entries = await Promise.all(
    paths.map(async (relativePath) => ({
      path: relativePath,
      content: await readSkillTextFile(skillDirectory, relativePath),
    })),
  );
  return computeSkillContentHashFromEntries(manifest, entries);
}
