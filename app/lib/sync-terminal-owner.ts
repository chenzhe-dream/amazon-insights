export type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type TerminalOwnerInput = {
  storage: SessionStorageLike | null;
  pathname: string;
  projectId: string | null;
  marketplace: string;
  asins: string[];
};

type TerminalRecord = {
  version: 1;
  identity: string;
  jobId: string;
};

const storagePrefix = "amz-lens.sync-terminal.v1:";
const maxJobIdLength = 160;

function normalizeAsins(asins: string[]) {
  return [...new Set(asins.map(asin => asin.trim().toUpperCase()).filter(asin => /^[A-Z0-9]{10}$/.test(asin)))].sort();
}

function terminalIdentity({ pathname, projectId, marketplace, asins }: Omit<TerminalOwnerInput, "storage">) {
  const normalizedAsins = normalizeAsins(asins);
  const normalizedMarketplace = marketplace.trim().toUpperCase();
  const normalizedProjectId = projectId?.trim() || "unscoped";
  if (!normalizedAsins.length || !/^[A-Z0-9-]{1,128}$/i.test(normalizedProjectId) || !/^[A-Z0-9-]{2,16}$/.test(normalizedMarketplace)) {
    return null;
  }
  const normalizedPathname = pathname.length <= 240 ? pathname : pathname.slice(0, 240);
  return JSON.stringify({ pathname: normalizedPathname, projectId: normalizedProjectId, marketplace: normalizedMarketplace, asins: normalizedAsins });
}

function readRecord(storage: SessionStorageLike | null, key: string | null, identity: string | null) {
  if (!storage || !key || !identity) return null;
  try {
    const candidate = JSON.parse(storage.getItem(key) ?? "") as Partial<TerminalRecord>;
    if (candidate.version !== 1 || candidate.identity !== identity || typeof candidate.jobId !== "string" || !candidate.jobId || candidate.jobId.length > maxJobIdLength) {
      storage.removeItem(key);
      return null;
    }
    return { jobId: candidate.jobId };
  } catch {
    return null;
  }
}

/**
 * Page-owned terminal lifecycle state.  It deliberately persists only a
 * bounded job id plus its binding identity; run IDs and job/provider payloads
 * are audit or display data, not restart-suppression inputs.
 */
export function createTerminalSyncOwner(input: TerminalOwnerInput) {
  const identity = terminalIdentity(input);
  const key = identity ? `${storagePrefix}${encodeURIComponent(identity)}` : null;

  return {
    readTerminal: () => readRecord(input.storage, key, identity),
    blocksAutomaticStart: () => Boolean(readRecord(input.storage, key, identity)),
    recordTerminal: ({ jobId }: { jobId: string }) => {
      if (!input.storage || !key || !identity || !jobId || jobId.length > maxJobIdLength) return;
      try {
        input.storage.setItem(key, JSON.stringify({ version: 1, identity, jobId } satisfies TerminalRecord));
      } catch {
        // Private browsing/storage quotas must not prevent normal completion.
      }
    },
    clearForExplicitStart: () => {
      if (!input.storage || !key) return;
      try {
        input.storage.removeItem(key);
      } catch {
        // The explicit start request remains usable if browser storage is unavailable.
      }
    },
  };
}

export function browserSessionStorage(): SessionStorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
