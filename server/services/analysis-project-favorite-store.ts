import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FavoriteIdSchema } from "../../shared/analysis-project-favorite-contracts";
import { getProjectRoot } from "../../scripts/lib/project-root.mjs";
import { resolveRuntimeRoots } from "../../scripts/lib/runtime-roots.mjs";

const RecordSchema = z.object({
  organizationId: FavoriteIdSchema, projectId: FavoriteIdSchema, createdBy: FavoriteIdSchema,
  createdAt: z.string().datetime(),
}).strict();

export class FavoriteProjectError extends Error {
  constructor(readonly statusCode: 400 | 404, message: string) { super(message); }
}
function canonicalId(value: string) { return FavoriteIdSchema.parse(value).toLowerCase(); }
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

/** One marker per team/project; neither reads nor toggles mutate legacy project metadata. */
export function createAnalysisProjectFavoriteStore(options: {
  dataRoot?: string; env?: Readonly<Record<string, string | undefined>>;
} = {}) {
  const env = options.env ?? process.env;
  const dataRoot = options.dataRoot ?? resolveRuntimeRoots({ codeRoot: getProjectRoot(), env,
    formal: Boolean(env.AGENT_FORMAL_WORKTREE_ROOT) }).dataRoot;
  const root = join(dataRoot, "analysis-project-favorites");
  // Resolve using this store's runtime root, not project-store's import-time process.env.
  function readAnalysisProject(id: string) {
    let raw;
    try { raw = JSON.parse(readFileSync(join(dataRoot, "projects", `${id}.json`), "utf8")); }
    catch (error) { if (missing(error)) return false; throw error; }
    return raw?.id?.toLowerCase() === id && (raw.kind == null || raw.kind === "analysis");
  }
  return {
    list(organizationId: string): string[] {
      const org = canonicalId(organizationId);
      const directory = join(root, org);
      let files: string[];
      try { files = readdirSync(directory); } catch (error) { if (missing(error)) return []; throw error; }
      return files.filter(file => file.endsWith(".json")).flatMap(file => {
        const id = canonicalId(file.slice(0, -5));
        let record;
        try { record = RecordSchema.parse(JSON.parse(readFileSync(join(directory, file), "utf8"))); }
        catch (error) { if (missing(error)) return []; throw error; } // concurrent unfavorite
        if (record.organizationId !== org || record.projectId !== id) throw new Error("Invalid favorite record");
        return readAnalysisProject(id) ? [id] : [];
      }).sort();
    },
    set(organizationId: string, userId: string, projectId: string, favorited: boolean) {
      const org = canonicalId(organizationId), actor = canonicalId(userId), id = canonicalId(projectId);
      if (!readAnalysisProject(id)) throw new FavoriteProjectError(404, "Analysis project not found");
      const directory = join(root, org), file = join(directory, `${id}.json`);
      if (!favorited) {
        try { unlinkSync(file); } catch (error) { if (!missing(error)) throw error; }
        return;
      }
      mkdirSync(directory, { recursive: true });
      const temporary = join(directory, `${id}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify({ organizationId: org, projectId: id,
          createdBy: actor, createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
        renameSync(temporary, file);
      } finally {
        try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
      }
    },
  };
}
export type AnalysisProjectFavoriteStore = ReturnType<typeof createAnalysisProjectFavoriteStore>;
