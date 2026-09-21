import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { xydcVariantAttributeLabel, type XydcVariantDisplayAttribute } from "../../app/xydc-variant-label";

type Attribute = XydcVariantDisplayAttribute;
type Translation = { id: string; labelZh: string };
type Entry = { id: string; labelZh: string | null; retryAfter: number };
const key = (a: Attribute) => createHash("sha256").update(JSON.stringify(
  [a.dimension, a.value].map(v => v.trim().replace(/\s+/g, " ").toLowerCase()),
)).digest("hex");
const cachePath = (root: string, id: string) => path.join(root, "xydc-labels", "v1", `${id}.json`);

function validLabel(value: unknown, raw: string): value is string {
  return typeof value === "string" && value.length <= 120 && /[\u3400-\u9fff]/.test(value)
    && !/[<>\r\n\x00-\x1f]/.test(value)
    && JSON.stringify(raw.match(/\d+(?:\.\d+)?/g) ?? []) === JSON.stringify(value.match(/\d+(?:\.\d+)?/g) ?? []);
}

function readEntry(root: string, attribute: Attribute): Entry | undefined {
  try {
    const id = key(attribute);
    const entry = JSON.parse(fs.readFileSync(cachePath(root, id), "utf8"));
    return entry.id === id && Number.isFinite(entry.retryAfter)
      && (entry.labelZh === null || validLabel(entry.labelZh, attribute.value)) ? entry : undefined;
  } catch { return undefined; }
}

/** Display enrichment only: source family snapshots and raw attribute values stay intact. */
export function readXydcTranslatedAttribute(root: string, attribute: Attribute): Attribute {
  const labelZh = readEntry(root, attribute)?.labelZh;
  return labelZh ? { ...attribute, labelZh } : attribute;
}

export async function translateXydcVariantLabels(input: {
  dataRoot: string;
  attributes: readonly Attribute[];
  translate(items: Array<{ id: string; dimension: string; value: string }>): Promise<Translation[]>;
  now?: Date;
  signal?: AbortSignal;
}) {
  const now = (input.now ?? new Date()).getTime();
  const pending = new Map<string, Attribute>();
  for (const attribute of input.attributes) {
    const raw = { dimension: attribute.dimension, value: attribute.value };
    if (raw.value.length > 200 || raw.dimension.length > 80 || !/[a-z]/i.test(raw.value)
      || xydcVariantAttributeLabel(raw) !== raw.value) continue;
    const cached = readEntry(input.dataRoot, raw);
    if (cached?.labelZh || cached && cached.retryAfter > now) continue;
    pending.set(key(raw), raw);
  }
  // At most four small batches per collection; subsequent collections can fill the rest.
  const entries = [...pending].slice(0, 128);
  for (let offset = 0; offset < entries.length; offset += 32) {
    if (input.signal?.aborted) return;
    const batch = entries.slice(offset, offset + 32);
    let results: Translation[] = [];
    try { results = await input.translate(batch.map(([id, a]) => ({ id, dimension: a.dimension, value: a.value }))); }
    catch { /* Optional enrichment: keep original values and apply a retry cooldown. */ }
    if (input.signal?.aborted) return;
    for (const [id, attribute] of batch) {
      const matches = results.filter(row => row.id === id);
      const labelZh = matches.length === 1 && validLabel(matches[0]?.labelZh, attribute.value) ? matches[0]!.labelZh.trim() : null;
      const target = cachePath(input.dataRoot, id);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(temporary, JSON.stringify({ id, labelZh, retryAfter: now + 600_000 }), { flag: "wx" });
        await fs.promises.rename(temporary, target);
      } catch { /* Cache failures must not fail product collection. */ }
      finally { await fs.promises.unlink(temporary).catch(() => {}); }
    }
  }
}
