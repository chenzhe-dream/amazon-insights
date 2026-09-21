import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// Deliberate, reviewable upgrades only: never fetch a moving branch at runtime.
const revision = '563a7be191d9fa8571bfe54f5f6d97f0a07808b5';
const base = `https://raw.githubusercontent.com/meodai/color-names/${revision}/`;
const get = async path => {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
};
const [csv, license] = await Promise.all([get('src/colornames.csv'), get('LICENSE')]);
const catalog = Object.create(null);
for (const line of csv.trim().split(/\r?\n/).slice(1)) {
  const match = line.match(/^(?:"((?:[^"]|"")*)"|([^,]+)),(#[a-f\d]{6}),/i);
  if (!match) throw new Error(`Invalid catalog row: ${line.slice(0, 80)}`);
  const key = (match[1] ?? match[2]).replaceAll('""', '"').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (Object.hasOwn(catalog, key)) throw new Error(`Duplicate normalized color: ${key}`);
  catalog[key] = match[3].toLowerCase();
}
if (Object.keys(catalog).length < 30000 || !license.includes('MIT')) throw new Error('Unexpected catalog/license');
const directory = new URL('../app/lib/color-catalog/', import.meta.url);
await mkdir(directory, { recursive: true });
const json = JSON.stringify(catalog) + '\n';
await writeFile(new URL('names.json', directory), json);
await writeFile(new URL('LICENSE', directory), license);
const metadata = {source:'https://github.com/meodai/color-names', revision, license:'MIT', entries:Object.keys(catalog).length, csvSha256:createHash('sha256').update(csv).digest('hex'), bytes:Buffer.byteLength(json), gzipBytes:gzipSync(json).length};
await writeFile(new URL('source.json', directory), JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify(metadata));
