import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SKILL_ARCHIVE_LIMITS,
  extractSkillArchive,
  inspectSkillArchiveBuffer,
} from "../../server/skills/archive";

interface ZipEntryInput {
  name: string;
  content?: string;
  externalAttributes?: number;
  versionMadeBy?: number;
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoredZip(entries: readonly ZipEntryInput[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const input of entries) {
    const name = Buffer.from(input.name, "utf8");
    const content = Buffer.from(input.content ?? "", "utf8");
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(input.versionMadeBy ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(
      (input.externalAttributes ?? (0o100644 << 16)) >>> 0,
      38,
    );
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function pathExists(candidate: string) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

test("approved ZIP inventories and extracts only after full preflight", async () => {
  const archive = buildStoredZip([
    { name: "safe-skill/SKILL.md", content: "# Safe\n" },
    {
      name: "safe-skill/references/rules.md",
      content: "# Rules\n",
    },
  ]);
  const inventory = await inspectSkillArchiveBuffer(archive, {
    expectedRoot: "safe-skill",
  });
  assert.deepEqual(
    inventory.entries.map(({ path: entryPath }) => entryPath),
    ["safe-skill/SKILL.md", "safe-skill/references/rules.md"],
  );

  const root = await mkdtemp(path.join(tmpdir(), "skill-archive-"));
  try {
    const zipPath = path.join(root, "safe-skill.zip");
    const destination = path.join(root, "skills-src");
    await writeFile(zipPath, archive);
    await extractSkillArchive(zipPath, destination, {
      expectedRoot: "safe-skill",
    });
    assert.equal(
      await readFile(path.join(destination, "safe-skill", "SKILL.md"), "utf8"),
      "# Safe\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ZIP preflight rejects escaping, absolute, duplicate, and special entries", async () => {
  const regular = (name: string) => ({ name, content: "data" });
  const cases: Array<{ name: string; archive: Buffer; pattern: RegExp }> = [
    {
      name: "zip-slip",
      archive: buildStoredZip([regular("safe-skill/../escape.md")]),
      pattern: /unsafe|escape|relative/i,
    },
    {
      name: "absolute path",
      archive: buildStoredZip([regular("/safe-skill/SKILL.md")]),
      pattern: /absolute|unsafe/i,
    },
    {
      name: "Windows drive path",
      archive: buildStoredZip([regular("C:/safe-skill/SKILL.md")]),
      pattern: /absolute|drive|root/i,
    },
    {
      name: "duplicate target",
      archive: buildStoredZip([
        regular("safe-skill/SKILL.md"),
        regular("safe-skill/SKILL.md"),
      ]),
      pattern: /duplicate/i,
    },
    {
      name: "case-folded duplicate target",
      archive: buildStoredZip([
        regular("safe-skill/SKILL.md"),
        regular("safe-skill/skill.md"),
      ]),
      pattern: /duplicate/i,
    },
    {
      name: "symlink",
      archive: buildStoredZip([
        {
          name: "safe-skill/SKILL.md",
          content: "target",
          externalAttributes: 0o120777 << 16,
        },
      ]),
      pattern: /symlink|special/i,
    },
    {
      name: "special FIFO",
      archive: buildStoredZip([
        {
          name: "safe-skill/SKILL.md",
          externalAttributes: 0o010644 << 16,
        },
      ]),
      pattern: /special/i,
    },
    {
      name: "root as a regular file",
      archive: buildStoredZip([regular("safe-skill")]),
      pattern: /root|directory/i,
    },
    {
      name: "file before descendant",
      archive: buildStoredZip([
        regular("safe-skill/references"),
        regular("safe-skill/references/rules.md"),
      ]),
      pattern: /ancestor|conflict/i,
    },
    {
      name: "descendant before file",
      archive: buildStoredZip([
        regular("safe-skill/references/rules.md"),
        regular("safe-skill/references"),
      ]),
      pattern: /ancestor|conflict/i,
    },
  ];

  for (const item of cases) {
    await assert.rejects(
      inspectSkillArchiveBuffer(item.archive, { expectedRoot: "safe-skill" }),
      item.pattern,
      item.name,
    );
  }
});

test("ZIP preflight enforces file-count and expanded-size limits", async () => {
  const twoFiles = buildStoredZip([
    { name: "safe-skill/SKILL.md", content: "a" },
    { name: "safe-skill/references/rules.md", content: "b" },
  ]);
  await assert.rejects(
    inspectSkillArchiveBuffer(twoFiles, {
      expectedRoot: "safe-skill",
      limits: { ...DEFAULT_SKILL_ARCHIVE_LIMITS, maxFiles: 1 },
    }),
    /file count/i,
  );

  const largeFile = buildStoredZip([
    { name: "safe-skill/SKILL.md", content: "12345" },
  ]);
  await assert.rejects(
    inspectSkillArchiveBuffer(largeFile, {
      expectedRoot: "safe-skill",
      limits: {
        ...DEFAULT_SKILL_ARCHIVE_LIMITS,
        maxEntryBytes: 4,
        maxExpandedBytes: 4,
      },
    }),
    /size|bytes/i,
  );

  const directoryFlood = buildStoredZip([
    { name: "safe-skill/one/", externalAttributes: 0x10 },
    { name: "safe-skill/two/", externalAttributes: 0x10 },
  ]);
  await assert.rejects(
    inspectSkillArchiveBuffer(directoryFlood, {
      expectedRoot: "safe-skill",
      limits: {
        ...DEFAULT_SKILL_ARCHIVE_LIMITS,
        maxEntries: 1,
      },
    }),
    /entry count/i,
  );

  const longPath = buildStoredZip([
    { name: `safe-skill/${"a".repeat(20)}.md`, content: "safe" },
  ]);
  await assert.rejects(
    inspectSkillArchiveBuffer(longPath, {
      expectedRoot: "safe-skill",
      limits: {
        ...DEFAULT_SKILL_ARCHIVE_LIMITS,
        maxPathBytes: 20,
      },
    }),
    /path.*length/i,
  );
});

test("ZIP limits must be finite positive integers", async () => {
  const archive = buildStoredZip([
    { name: "safe-skill/SKILL.md", content: "safe" },
  ]);
  for (const invalidLimit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      inspectSkillArchiveBuffer(archive, {
        expectedRoot: "safe-skill",
        limits: {
          ...DEFAULT_SKILL_ARCHIVE_LIMITS,
          maxArchiveBytes: invalidLimit,
        },
      }),
      /limit/i,
    );
  }
});

test("path-based extraction rejects an oversized archive before reading it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-archive-oversized-"));
  const zipPath = path.join(root, "safe-skill.zip");
  try {
    const file = await open(zipPath, "wx");
    try {
      await file.truncate(DEFAULT_SKILL_ARCHIVE_LIMITS.maxArchiveBytes + 1);
    } finally {
      await file.close();
    }
    await assert.rejects(
      extractSkillArchive(zipPath, path.join(root, "skills-src"), {
        expectedRoot: "safe-skill",
      }),
      /compressed size limit/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected archive leaves zero extracted files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-archive-reject-"));
  try {
    const zipPath = path.join(root, "safe-skill.zip");
    const destination = path.join(root, "skills-src");
    await writeFile(
      zipPath,
      buildStoredZip([
        { name: "safe-skill/SKILL.md", content: "safe" },
        { name: "safe-skill/../escape.md", content: "unsafe" },
      ]),
    );

    await assert.rejects(
      extractSkillArchive(zipPath, destination, {
        expectedRoot: "safe-skill",
      }),
    );
    assert.equal(await pathExists(destination), false);
    assert.equal(await pathExists(path.join(root, "escape.md")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
