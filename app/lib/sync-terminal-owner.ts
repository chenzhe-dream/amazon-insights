export type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type TerminalOwnerInput = {
  storage: SessionStorageLike | null;
  /** Accepted for callers that know their route; intentionally not binding identity. */
  pathname: string;
  organizationId: string | null;
  projectId: string | null;
  /** Associated audit metadata; deliberately excluded from binding identity. */
  runId?: string | null;
  marketplace: string;
  asins: string[];
};

type TerminalRecordV1 = {
  version: 1;
  identity: string;
  jobId: string;
};

type TerminalRecordV2 = {
  version: 2;
  identity: string;
  jobId: string;
  artifactId: string | null;
};

type TerminalRecordV3 = {
  version: 3;
  identity: string;
  jobId: string;
  artifactId: string | null;
  reloadClaimedArtifactId: string | null;
};

type TerminalRecord = TerminalRecordV1 | TerminalRecordV2 | TerminalRecordV3;

const storagePrefix = "amz-lens.sync-terminal.v1:";
const maxJobIdLength = 160;
const entityIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const artifactIdPattern = /^[a-f0-9]{64}$/;

function normalizeAsins(asins: string[]) {
  return [...new Set(asins.map(asin => asin.trim().toUpperCase()).filter(asin => /^[A-Z0-9]{10}$/.test(asin)))].sort();
}

function terminalIdentity({ organizationId, projectId, marketplace, asins }: Omit<TerminalOwnerInput, "storage" | "pathname" | "runId">) {
  const normalizedAsins = normalizeAsins(asins);
  const normalizedMarketplace = marketplace.trim().toUpperCase();
  const normalizedProjectId = projectId?.trim() || "unscoped";
  const normalizedOrganizationId = organizationId?.trim() ?? "";
  if (!normalizedAsins.length || !entityIdPattern.test(normalizedOrganizationId) || !/^[A-Z0-9-]{1,128}$/i.test(normalizedProjectId) || !/^[A-Z0-9-]{2,16}$/.test(normalizedMarketplace)) {
    return null;
  }
  return JSON.stringify({ organizationId: normalizedOrganizationId, projectId: normalizedProjectId, marketplace: normalizedMarketplace, asins: normalizedAsins });
}

function readRecord(storage: SessionStorageLike | null, key: string | null, identity: string | null) {
  if (!storage || !key || !identity) return null;
  try {
    const candidate = JSON.parse(storage.getItem(key) ?? "") as Partial<Omit<TerminalRecordV3, "version">> & { version?: TerminalRecord["version"] };
    if (
      (candidate.version !== 1 && candidate.version !== 2 && candidate.version !== 3) ||
      candidate.identity !== identity ||
      typeof candidate.jobId !== "string" ||
      !candidate.jobId ||
      candidate.jobId.length > maxJobIdLength ||
      ((candidate.version === 2 || candidate.version === 3) && (candidate.artifactId === undefined || (candidate.artifactId !== null && (typeof candidate.artifactId !== "string" || !artifactIdPattern.test(candidate.artifactId))))) ||
      (candidate.version === 3 && (candidate.reloadClaimedArtifactId === undefined || (candidate.reloadClaimedArtifactId !== null && (typeof candidate.reloadClaimedArtifactId !== "string" || !artifactIdPattern.test(candidate.reloadClaimedArtifactId))))) ||
      (candidate.version === 3 && candidate.reloadClaimedArtifactId !== null && (candidate.artifactId === null || candidate.reloadClaimedArtifactId !== candidate.artifactId))
    ) {
      storage.removeItem(key);
      return null;
    }
    return {
      jobId: candidate.jobId,
      artifactId: candidate.version === 1 ? null : candidate.artifactId ?? null,
      reloadClaimedArtifactId: candidate.version === 3 ? candidate.reloadClaimedArtifactId ?? null : null,
    };
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
    readTerminal: () => {
      const record = readRecord(input.storage, key, identity);
      return record ? { jobId: record.jobId, artifactId: record.artifactId } : null;
    },
    blocksAutomaticStart: () => Boolean(readRecord(input.storage, key, identity)),
    recordTerminal: ({ jobId, artifactId }: { jobId: string; artifactId?: string | null }) => {
      if (!input.storage || !key || !identity || !jobId || jobId.length > maxJobIdLength) return false;
      try {
        const safeArtifact = artifactId && artifactIdPattern.test(artifactId) ? artifactId : null;
        const existing = readRecord(input.storage, key, identity);
        const reloadClaimedArtifactId = existing?.jobId === jobId && existing.artifactId === safeArtifact
          ? existing.reloadClaimedArtifactId
          : null;
        input.storage.setItem(key, JSON.stringify({
          version: 3,
          identity,
          jobId,
          artifactId: safeArtifact,
          reloadClaimedArtifactId,
        } satisfies TerminalRecordV3));
        return true;
      } catch {
        // Private browsing/storage quotas must not prevent normal completion.
        return false;
      }
    },
    claimArtifactReload: ({ jobId, artifactId }: { jobId: string; artifactId: string }) => {
      if (!input.storage || !key || !identity || !jobId || jobId.length > maxJobIdLength || !artifactIdPattern.test(artifactId)) return false;
      try {
        const existing = readRecord(input.storage, key, identity);
        if (!existing || existing.jobId !== jobId || existing.artifactId !== artifactId || existing.reloadClaimedArtifactId === artifactId) return false;
        input.storage.setItem(key, JSON.stringify({
          version: 3,
          identity,
          jobId,
          artifactId,
          reloadClaimedArtifactId: artifactId,
        } satisfies TerminalRecordV3));
        return true;
      } catch {
        return false;
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
