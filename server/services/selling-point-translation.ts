import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SellingTranslationResponse, type SellingTranslationResult } from "../../shared/selling-point-translation-contracts";
export { readOriginalSellingPoints } from "../../shared/selling-point-source";

export type SellingSource = { organizationId: string; projectId: string; runId: string; asin: string; original: string[]; sourceComplete: boolean };

function numbers(text: string, includeWords = false) {
  const words: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
  return (text.replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, value => includeWords ? words[value.toLowerCase()] : value)
    .match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}
export function validateSellingTranslation(original: string[], points: string[]) {
  if (points.length !== original.length) throw new Error("Translation item count mismatch");
  return points.map((point, index) => {
    if (!/[\u4e00-\u9fff]/.test(point) || point.length > 4000) throw new Error("Chinese translation required");
    const sourceNumbers = new Set(numbers(original[index]));
    const allowedNumbers = new Set(numbers(original[index], true));
    const resultNumbers = new Set(numbers(point));
    if ([...sourceNumbers].some(value => !resultNumbers.has(value)) || [...resultNumbers].some(value => !allowedNumbers.has(value))) throw new Error("Translation changed a numeric parameter");
    for (const certification of ["ETL", "UL", "ASTM", "EN71", "CE", "FCC", "CPC", "RoHS"]) {
      const pattern = new RegExp("\\b" + certification + "\\b", "i");
      if (pattern.test(original[index]) !== pattern.test(point)) throw new Error("Translation changed a certification");
    }
    if (/(?:[a-z]{3,}\s+){5}[a-z]{3,}/i.test(point)) throw new Error("Untranslated English sentence");
    return point.trim();
  });
}

export class SellingPointTranslationService {
  private readonly jobs = new Map<string, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly options: {
    root: string; modelIdentity: string;
    resolveSource: (organizationId: string, projectId: string, asin: string) => Promise<SellingSource>;
    translate: (source: SellingSource, sourceHash: string) => Promise<string[]>;
  }) {}

  private async context(organizationId: string, projectId: string, asin: string) {
    const source = await this.options.resolveSource(organizationId, projectId, asin);
    if (source.organizationId !== organizationId || source.projectId !== projectId || source.asin !== asin) throw new Error("Translation scope mismatch");
    const sourceHash = createHash("sha256").update(JSON.stringify(["selling-zh-v1", this.options.modelIdentity, organizationId, asin, source.original])).digest("hex");
    const empty: SellingTranslationResult = { asin, sourceHash, state: source.original.length ? "missing" : "unavailable", original: source.original,
      sourceComplete: source.sourceComplete, points: [], message: source.original.length ? null : "没有完整卖点原文，请先同步商品信息。" };
    let result = empty;
    try {
      const cached = JSON.parse(readFileSync(join(this.options.root, sourceHash + ".json"), "utf8"));
      const parsed = SellingTranslationResponse.parse(cached.result);
      if (parsed.sourceHash === sourceHash && parsed.asin === asin) {
        result = { ...parsed, sourceComplete: source.sourceComplete };
        if (result.state === "pending" && !this.jobs.has(sourceHash) && Date.now() - Number(cached.savedAt) > 600_000) {
          result = { ...empty, state: "failed", message: "翻译任务已中断，请重试。" };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("翻译缓存读取失败，请稍后重试。");
    }
    return { source, result };
  }
  private save(result: SellingTranslationResult) {
    mkdirSync(this.options.root, { recursive: true });
    const target = join(this.options.root, result.sourceHash + ".json");
    const temporary = target + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify({ savedAt: Date.now(), result }), "utf8");
    renameSync(temporary, target);
  }
  async read(organizationId: string, projectId: string, asin: string) {
    return (await this.context(organizationId, projectId, asin)).result;
  }
  async start(organizationId: string, projectId: string, asin: string) {
    const { source, result } = await this.context(organizationId, projectId, asin);
    if (["ready", "pending", "unavailable"].includes(result.state) || this.jobs.has(result.sourceHash)) return result;
    if (this.jobs.size >= 10) return { ...result, state: "failed" as const, message: "翻译队列已满，请稍后重试。" };
    const pending = { ...result, state: "pending" as const, message: null };
    this.save(pending);
    const task = this.tail.then(async () => {
      try {
        const points = validateSellingTranslation(source.original, await this.options.translate(source, result.sourceHash));
        this.save({ ...pending, points, state: "ready" });
      } catch {
        this.save({ ...pending, state: "failed", message: "翻译未完成或参数校验未通过，请重试。" });
      }
    }).catch(() => {}).finally(() => { this.jobs.delete(result.sourceHash); });
    this.jobs.set(result.sourceHash, task);
    this.tail = task;
    return pending;
  }
  async drain() { await this.tail; }
}
