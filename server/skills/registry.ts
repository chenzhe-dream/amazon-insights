import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  SkillManifestSchema,
  computeSkillContentHashFromEntries,
  readSkillTextFile,
  type SkillManifest,
} from "./manifest";

const MAX_MANIFEST_BYTES = 65_536;

export interface RegisteredSkill {
  id: string;
  version: string;
  contentHash: string;
}

export interface LoadedSkill {
  manifest: SkillManifest;
  instructions: string;
  references: ReadonlyMap<string, string>;
}

interface RegistryRecord {
  directory: string;
  manifest: SkillManifest;
}

function registryKey(id: string, version: string) {
  return `${id}@${version}`;
}

function comparePortableText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readManifest(directory: string) {
  const manifestPath = path.join(directory, "manifest.json");
  const stats = await lstat(manifestPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Skill manifest must be a regular file: ${manifestPath}`);
  }
  if (stats.size > MAX_MANIFEST_BYTES) {
    throw new Error(`Skill manifest exceeds the size limit: ${manifestPath}`);
  }
  const parsedJson: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  return SkillManifestSchema.parse(parsedJson);
}

function extractLocalMarkdownTargets(markdown: string) {
  const targets: string[] = [];
  const patterns: Array<{
    pattern: RegExp;
    target: (match: RegExpMatchArray) => string | undefined;
  }> = [
    {
      pattern: /!?\[[^\]]*\]\(([^)]+)\)/g,
      target: (match) => match[1],
    },
    {
      pattern: /^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm,
      target: (match) => match[1],
    },
    {
      pattern:
        /\b(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi,
      target: (match) => match[1] ?? match[2] ?? match[3],
    },
  ];
  for (const item of patterns) {
    for (const match of markdown.matchAll(item.pattern)) {
      const target = item.target(match);
      if (target) targets.push(target);
    }
  }

  return targets.flatMap((candidate) => {
    const rawTarget = candidate
      .trim()
      .replace(/^<|>$/g, "")
      .split(/\s+["']/)[0];
    if (
      !rawTarget ||
      rawTarget.startsWith("#") ||
      rawTarget.startsWith("//") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawTarget)
    ) {
      return [];
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]);
    } catch {
      throw new Error(`Invalid encoded Markdown reference: ${rawTarget}`);
    }
    return decoded ? [decoded] : [];
  });
}

function validateDeclaredReferences(
  manifest: SkillManifest,
  markdownFiles: ReadonlyMap<string, string>,
) {
  const allowed = new Set([manifest.entry, ...manifest.allowedReferences]);
  for (const [sourcePath, markdown] of markdownFiles) {
    for (const target of extractLocalMarkdownTargets(markdown)) {
      if (target.includes("\\") || path.posix.isAbsolute(target)) {
        throw new Error(`Undeclared reference in ${sourcePath}: ${target}`);
      }
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(sourcePath), target),
      );
      if (resolved.startsWith("../") || !allowed.has(resolved)) {
        throw new Error(`Undeclared reference in ${sourcePath}: ${target}`);
      }
    }
  }
}

export class SkillRegistry {
  private constructor(private readonly records: ReadonlyMap<string, RegistryRecord>) {}

  static async open(rootDirectory: string) {
    const root = await realpath(rootDirectory);
    const entries = await readdir(root, { withFileTypes: true });
    const records = new Map<string, RegistryRecord>();

    for (const entry of entries.sort((left, right) => comparePortableText(left.name, right.name))) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill directory cannot be a symlink: ${entry.name}`);
      }
      if (!entry.isDirectory()) continue;

      const directory = path.join(root, entry.name);
      const manifest = await readManifest(directory);
      const key = registryKey(manifest.id, manifest.version);
      if (records.has(key)) {
        throw new Error(
          `Duplicate Skill ID and version: ${manifest.id} ${manifest.version}`,
        );
      }
      records.set(key, { directory, manifest });
    }

    return new SkillRegistry(records);
  }

  list(): RegisteredSkill[] {
    return [...this.records.values()]
      .map(({ manifest }) => ({
        id: manifest.id,
        version: manifest.version,
        contentHash: manifest.contentHash,
      }))
      .sort(
        (left, right) =>
          comparePortableText(left.id, right.id) ||
          comparePortableText(left.version, right.version),
      );
  }

  async load(id: string, version: string): Promise<LoadedSkill> {
    const record = this.records.get(registryKey(id, version));
    if (!record) {
      throw new Error(`Skill is not registered: ${id} ${version}`);
    }

    let instructions: string;
    try {
      instructions = await readSkillTextFile(
        record.directory,
        record.manifest.entry,
      );
    } catch (error) {
      throw new Error(
        `Skill entry is missing or invalid: ${record.manifest.entry}`,
        { cause: error },
      );
    }
    const references = new Map<string, string>();
    for (const relativePath of record.manifest.allowedReferences) {
      references.set(
        relativePath,
        await readSkillTextFile(record.directory, relativePath),
      );
    }

    const markdownFiles = new Map<string, string>([
      [record.manifest.entry, instructions],
      ...references,
    ]);
    validateDeclaredReferences(record.manifest, markdownFiles);

    const { contentHash: expectedHash, ...manifestWithoutHash } =
      record.manifest;
    const actualHash = computeSkillContentHashFromEntries(
      manifestWithoutHash,
      [...markdownFiles].map(([entryPath, content]) => ({
        path: entryPath,
        content,
      })),
    );
    if (actualHash !== expectedHash) {
      throw new Error(
        `Skill content hash mismatch for ${record.manifest.id}@${record.manifest.version}: expected ${expectedHash}, received ${actualHash}`,
      );
    }

    return {
      manifest: record.manifest,
      instructions,
      references,
    };
  }
}
