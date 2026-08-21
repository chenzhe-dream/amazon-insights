import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  fromBufferPromise,
  type Entry as ZipEntry,
  type ZipFile,
} from "yauzl";

export interface SkillArchiveLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxFiles: number;
  maxPathBytes: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_SKILL_ARCHIVE_LIMITS: SkillArchiveLimits = Object.freeze({
  maxArchiveBytes: 2_097_152,
  maxEntries: 96,
  maxFiles: 64,
  maxPathBytes: 512,
  maxEntryBytes: 1_048_576,
  maxExpandedBytes: 4_194_304,
  maxCompressionRatio: 100,
});

export interface SkillArchiveOptions {
  expectedRoot: string;
  limits?: SkillArchiveLimits;
}

export interface SkillArchiveInventoryEntry {
  path: string;
  directory: boolean;
  compressedBytes: number;
  expandedBytes: number;
}

export interface SkillArchiveInventory {
  entries: SkillArchiveInventoryEntry[];
  fileCount: number;
  expandedBytes: number;
}

interface InspectedEntry extends SkillArchiveInventoryEntry {
  source: ZipEntry;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function portableKey(value: string) {
  return value.normalize("NFC").toLowerCase();
}

function validateLimits(limits: SkillArchiveLimits) {
  const integerLimits: Array<keyof SkillArchiveLimits> = [
    "maxArchiveBytes",
    "maxEntries",
    "maxFiles",
    "maxPathBytes",
    "maxEntryBytes",
    "maxExpandedBytes",
  ];
  for (const name of integerLimits) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0) {
      throw new Error(`Invalid ZIP safety limit: ${name}`);
    }
  }
  if (
    !Number.isFinite(limits.maxCompressionRatio) ||
    limits.maxCompressionRatio <= 0
  ) {
    throw new Error("Invalid ZIP safety limit: maxCompressionRatio");
  }
}

function validateExpectedRoot(expectedRoot: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(expectedRoot)) {
    throw new Error(`Invalid expected ZIP root: ${expectedRoot}`);
  }
}

function validateArchivePath(
  fileName: string,
  expectedRoot: string,
  limits: SkillArchiveLimits,
) {
  if (
    fileName.length === 0 ||
    fileName.includes("\0") ||
    fileName.includes("\\") ||
    fileName.startsWith("/") ||
    fileName.startsWith("//") ||
    /^[A-Za-z]:/.test(fileName)
  ) {
    throw new Error(`Unsafe or absolute ZIP path: ${fileName}`);
  }
  if (Buffer.byteLength(fileName, "utf8") > limits.maxPathBytes) {
    throw new Error(`ZIP path exceeds the path length limit: ${fileName}`);
  }

  const directory = fileName.endsWith("/");
  const normalizedName = directory ? fileName.slice(0, -1) : fileName;
  const segments = normalizedName.split("/");
  if (segments[0] !== expectedRoot) {
    throw new Error(`ZIP path has an unexpected root: ${fileName}`);
  }
  if (!directory && segments.length === 1) {
    throw new Error("ZIP root must be a directory, not a regular file");
  }
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes(":") ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED_NAME.test(segment)
    ) {
      throw new Error(`Unsafe relative ZIP path: ${fileName}`);
    }
  }
  return { directory, normalizedName };
}

function validateEntryType(entry: ZipEntry, directory: boolean) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0xf000;
  const dosDirectory = (entry.externalFileAttributes & 0x10) !== 0;

  if (directory) {
    if (
      entry.uncompressedSize !== 0 ||
      (unixType !== 0 && unixType !== 0x4000) ||
      (unixType === 0 && !dosDirectory && entry.externalFileAttributes !== 0)
    ) {
      throw new Error(`ZIP directory has a special entry type: ${entry.fileName}`);
    }
    return;
  }
  if (dosDirectory || (unixType !== 0 && unixType !== 0x8000)) {
    throw new Error(`ZIP contains a symlink or special entry: ${entry.fileName}`);
  }
}

async function openAndInspect(
  archive: Buffer,
  options: SkillArchiveOptions,
): Promise<{ zipFile: ZipFile; entries: InspectedEntry[]; inventory: SkillArchiveInventory }> {
  const limits = options.limits ?? DEFAULT_SKILL_ARCHIVE_LIMITS;
  validateExpectedRoot(options.expectedRoot);
  validateLimits(limits);
  if (archive.length > limits.maxArchiveBytes) {
    throw new Error("ZIP archive exceeds the compressed size limit");
  }

  const zipFile = await fromBufferPromise(archive, {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  const entries: InspectedEntry[] = [];
  const targets = new Map<string, { directory: boolean }>();
  let fileCount = 0;
  let expandedBytes = 0;

  try {
    for await (const entry of zipFile.eachEntry()) {
      if (entry.isEncrypted() || !entry.canDecodeFileData()) {
        throw new Error(`ZIP entry uses unsupported encryption or compression: ${entry.fileName}`);
      }
      if (
        (entry.generalPurposeBitFlag & 0x0800) === 0 &&
        [...entry.fileNameRaw].some((byte) => byte > 0x7f)
      ) {
        throw new Error(`ZIP entry name must be ASCII or UTF-8: ${entry.fileName}`);
      }

      if (entries.length + 1 > limits.maxEntries) {
        throw new Error("ZIP archive exceeds the entry count limit");
      }
      const { directory, normalizedName } = validateArchivePath(
        entry.fileName,
        options.expectedRoot,
        limits,
      );
      validateEntryType(entry, directory);
      const key = portableKey(normalizedName);
      if (targets.has(key)) {
        throw new Error(`ZIP contains a duplicate target path: ${entry.fileName}`);
      }
      const segments = key.split("/");
      for (let length = 1; length < segments.length; length += 1) {
        const ancestor = targets.get(segments.slice(0, length).join("/"));
        if (ancestor && !ancestor.directory) {
          throw new Error(
            `ZIP target has a file ancestor conflict: ${entry.fileName}`,
          );
        }
      }
      if (
        !directory &&
        [...targets.keys()].some((target) => target.startsWith(`${key}/`))
      ) {
        throw new Error(
          `ZIP target is a file ancestor of an existing entry: ${entry.fileName}`,
        );
      }
      targets.set(key, { directory });

      if (!directory) {
        fileCount += 1;
        expandedBytes += entry.uncompressedSize;
        if (fileCount > limits.maxFiles) {
          throw new Error("ZIP archive exceeds the file count limit");
        }
        if (entry.uncompressedSize > limits.maxEntryBytes) {
          throw new Error(`ZIP entry exceeds the expanded size limit: ${entry.fileName}`);
        }
        if (expandedBytes > limits.maxExpandedBytes) {
          throw new Error("ZIP archive exceeds the total expanded bytes limit");
        }
        const ratio =
          entry.compressedSize === 0
            ? entry.uncompressedSize === 0
              ? 1
              : Number.POSITIVE_INFINITY
            : entry.uncompressedSize / entry.compressedSize;
        if (ratio > limits.maxCompressionRatio) {
          throw new Error(`ZIP entry exceeds the compression ratio limit: ${entry.fileName}`);
        }
      }

      entries.push({
        source: entry,
        path: normalizedName,
        directory,
        compressedBytes: entry.compressedSize,
        expandedBytes: entry.uncompressedSize,
      });
    }
    if (entries.length !== zipFile.entryCount) {
      throw new Error(
        "ZIP contains duplicate or unreadable central-directory entries",
      );
    }
    return {
      zipFile,
      entries,
      inventory: {
        entries: entries.map((entry) => ({
          path: entry.path,
          directory: entry.directory,
          compressedBytes: entry.compressedBytes,
          expandedBytes: entry.expandedBytes,
        })),
        fileCount,
        expandedBytes,
      },
    };
  } catch (error) {
    zipFile.close();
    throw error;
  }
}

async function readEntry(zipFile: ZipFile, entry: InspectedEntry) {
  const stream = await zipFile.openReadStreamPromise(entry.source);
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += buffer.length;
    if (bytesRead > entry.expandedBytes) {
      throw new Error(`ZIP entry expanded beyond its declared size: ${entry.path}`);
    }
    chunks.push(buffer);
  }
  if (bytesRead !== entry.expandedBytes) {
    throw new Error(`ZIP entry size mismatch: ${entry.path}`);
  }
  return Buffer.concat(chunks, bytesRead);
}

async function readArchiveFiles(archive: Buffer, options: SkillArchiveOptions) {
  const inspected = await openAndInspect(archive, options);
  try {
    const files = new Map<string, Buffer>();
    for (const entry of inspected.entries) {
      if (!entry.directory) {
        files.set(entry.path, await readEntry(inspected.zipFile, entry));
      }
    }
    return { files, inventory: inspected.inventory };
  } finally {
    inspected.zipFile.close();
  }
}

export async function inspectSkillArchiveBuffer(
  archive: Buffer,
  options: SkillArchiveOptions,
) {
  const inspected = await openAndInspect(archive, options);
  inspected.zipFile.close();
  return inspected.inventory;
}

export async function extractSkillArchive(
  archivePath: string,
  destinationRoot: string,
  options: SkillArchiveOptions,
) {
  const limits = options.limits ?? DEFAULT_SKILL_ARCHIVE_LIMITS;
  const archive = await readArchiveFileBounded(archivePath, limits);
  const { files, inventory } = await readArchiveFiles(archive, options);
  const finalDirectory = path.join(destinationRoot, options.expectedRoot);
  try {
    await lstat(finalDirectory);
    throw new Error(`Skill extraction target already exists: ${finalDirectory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(destinationRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    path.join(destinationRoot, ".skill-extract-"),
  );
  try {
    for (const [archiveEntryPath, content] of files) {
      const relativePath = archiveEntryPath.split("/").slice(1);
      const target = path.join(temporaryDirectory, options.expectedRoot, ...relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
    }
    await rename(
      path.join(temporaryDirectory, options.expectedRoot),
      finalDirectory,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return inventory;
}

async function readArchiveFileBounded(
  archivePath: string,
  limits: SkillArchiveLimits,
) {
  validateLimits(limits);
  const pathStats = await lstat(archivePath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error(`ZIP archive must be a regular file: ${archivePath}`);
  }

  const handle = await open(archivePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`ZIP archive must be a regular file: ${archivePath}`);
    }
    if (stats.size > limits.maxArchiveBytes) {
      throw new Error("ZIP archive exceeds the compressed size limit");
    }
    const archive = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < archive.length) {
      const { bytesRead } = await handle.read(
        archive,
        offset,
        archive.length - offset,
        offset,
      );
      if (bytesRead === 0) {
        throw new Error("ZIP archive changed while it was being read");
      }
      offset += bytesRead;
    }
    const extraByte = Buffer.allocUnsafe(1);
    if ((await handle.read(extraByte, 0, 1, archive.length)).bytesRead !== 0) {
      throw new Error("ZIP archive changed while it was being read");
    }
    return archive;
  } finally {
    await handle.close();
  }
}

async function listFilesRecursively(directory: string, prefix = "") {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Published Skill source cannot contain symlinks: ${entry.name}`);
    }
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(
        ...(await listFilesRecursively(path.join(directory, entry.name), relativePath)),
      );
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Published Skill source contains a special file: ${relativePath}`);
    }
  }
  return files;
}

export async function validateSkillArchiveSource(
  archivePath: string,
  skillDirectory: string,
  expectedRoot: string,
) {
  const archive = await readArchiveFileBounded(
    archivePath,
    DEFAULT_SKILL_ARCHIVE_LIMITS,
  );
  const { files, inventory } = await readArchiveFiles(archive, { expectedRoot });
  const expectedSourcePaths = [...files.keys()]
    .map((entryPath) => entryPath.split("/").slice(1).join("/"))
    .sort();
  const actualSourcePaths = (await listFilesRecursively(skillDirectory))
    .filter((entryPath) => entryPath !== "manifest.json")
    .sort();
  if (
    expectedSourcePaths.length !== actualSourcePaths.length ||
    expectedSourcePaths.some(
      (entryPath, index) => entryPath !== actualSourcePaths[index],
    )
  ) {
    throw new Error(`Published Skill source inventory differs from ${archivePath}`);
  }

  for (const [entryPath, archivedContent] of files) {
    const relativePath = entryPath.split("/").slice(1);
    const publishedContent = await readFile(path.join(skillDirectory, ...relativePath));
    if (!archivedContent.equals(publishedContent)) {
      throw new Error(`Published Skill source differs from ZIP: ${entryPath}`);
    }
  }
  return inventory;
}
