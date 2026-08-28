const SHA256 = /^[a-f0-9]{64}$/;

export async function waitForPublishedArtifact(input: {
  currentArtifactId: string;
  targetArtifactId: string;
  probe: () => Promise<string | null>;
  wait: (milliseconds: number) => Promise<void>;
  maxAttempts?: number;
  intervalMs?: number;
}): Promise<"already-current" | "ready" | "timeout"> {
  if (!SHA256.test(input.targetArtifactId)) return "timeout";
  if (input.currentArtifactId === input.targetArtifactId) return "already-current";
  const attempts = input.maxAttempts ?? 30;
  const interval = input.intervalMs ?? 1_000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await input.probe() === input.targetArtifactId) return "ready";
    if (attempt + 1 < attempts) await input.wait(interval);
  }
  return "timeout";
}

export function urlForPublishedArtifact(href: string, artifactId: string): string {
  if (!SHA256.test(artifactId)) return href;
  const url = new URL(href);
  url.searchParams.set("webArtifact", artifactId);
  return url.toString();
}
