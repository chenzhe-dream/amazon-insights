import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

export const IMAGE_REMARK_CANDIDATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const IMAGE_REMARK_CANDIDATE_SWEEP_INTERVAL_MS = 60_000;

const candidateDirectoryName = /^image-(?:(\d+)-)?[A-Za-z0-9]{6}$/;
const candidateFileName = /^(?:listing\.json|image-candidate\.json|\.image-candidate\.json\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission denial also means the process may still own this directory.
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/** Only removes known, old files from a direct child of AGENT_DATA_ROOT/sync-image-candidates. */
export async function cleanupExpiredImageRemarkCandidates({
  dataRoot,
  now = new Date(),
  limit = 100,
}: {
  dataRoot: string;
  now?: Date;
  limit?: number;
}): Promise<{ purgedCount: number }> {
  if (!path.isAbsolute(dataRoot)) throw new Error("Image candidate data root must be absolute");
  if (!Number.isFinite(now.getTime())) throw new Error("Image candidate retention time is invalid");
  const root = path.join(path.resolve(dataRoot), "sync-image-candidates");
  let rootStat;
  try { rootStat = await lstat(root); }
  catch (error) {
    if (isMissing(error)) return { purgedCount: 0 };
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { purgedCount: 0 };
  const cutoff = now.getTime() - IMAGE_REMARK_CANDIDATE_MAX_AGE_MS;
  let purgedCount = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (purgedCount >= limit) break;
    const match = candidateDirectoryName.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const pid = match[1] ? Number(match[1]) : null;
    if (pid && isProcessAlive(pid)) continue;
    const directory = path.join(root, entry.name);
    if (path.dirname(directory) !== root) continue;
    let directoryStat;
    try { directoryStat = await lstat(directory); }
    catch (error) { if (isMissing(error)) continue; throw error; }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;
    const names = await readdir(directory);
    if (names.some(name => !candidateFileName.test(name))) continue;
    let newestWrite = directoryStat.mtimeMs;
    let safe = true;
    for (const name of names) {
      let fileStat;
      try { fileStat = await lstat(path.join(directory, name)); }
      catch (error) { if (isMissing(error)) { safe = false; break; } throw error; }
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) { safe = false; break; }
      newestWrite = Math.max(newestWrite, fileStat.mtimeMs);
    }
    if (!safe || newestWrite >= cutoff) continue;
    // Recheck immediately before deletion. unlink + rmdir cannot recursively
    // remove a newly created unrelated file or nested directory.
    if ((await readdir(directory)).sort().join("\0") !== [...names].sort().join("\0")) continue;
    for (const name of names) await unlink(path.join(directory, name));
    await rmdir(directory);
    purgedCount += 1;
  }
  return { purgedCount };
}

export class ImageRemarkCandidateRetentionService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;

  constructor(private readonly options: {
    dataRoot: string;
    intervalMs?: number;
    cleanup?: typeof cleanupExpiredImageRemarkCandidates;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (this.timer) return;
    this.sweep();
    this.timer = setInterval(() => this.sweep(), this.options.intervalMs ?? IMAGE_REMARK_CANDIDATE_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
  }

  private sweep(): void {
    if (this.pending) return;
    this.pending = Promise.resolve()
      .then(() => (this.options.cleanup ?? cleanupExpiredImageRemarkCandidates)({ dataRoot: this.options.dataRoot }))
      .then(() => undefined)
      .catch(error => this.options.onError?.(error))
      .finally(() => { this.pending = null; });
  }
}
