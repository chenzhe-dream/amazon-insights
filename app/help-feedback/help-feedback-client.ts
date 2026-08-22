import type { FeedbackDetail, FeedbackListItem, FeedbackStatus } from "./feedback-types";
import type { FeedbackDraft } from "./feedback-types";

export class FeedbackRequestError extends Error {
  constructor(readonly status: number) {
    super("Feedback request failed");
    this.name = "FeedbackRequestError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as T | null;
  if (!response.ok || payload === null) throw new FeedbackRequestError(response.status);
  return payload;
}

function requestJson(fetcher: typeof fetch, url: string, body: unknown) {
  return fetcher(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function createHelpFeedbackClient(fetcher: typeof fetch = (...args) => fetch(...args)) {
  return {
    async submit(input: FeedbackDraft & { pagePath: string }) {
      const body = new FormData();
      body.set("category", input.category);
      body.set("title", input.title);
      body.set("description", input.description);
      body.set("pagePath", input.pagePath);
      for (const image of input.images) body.append("images", image.file, image.file.name);
      return readJson<{ feedbackId: string; createdAt: string }>(await fetcher("/api/agent/v1/feedback", {
        method: "POST",
        credentials: "same-origin",
        body,
      }));
    },

    async listMine(): Promise<FeedbackListItem[]> {
      return (await readJson<{ feedback: FeedbackListItem[] }>(await fetcher(
        "/api/agent/v1/feedback/mine",
        { credentials: "same-origin" },
      ))).feedback;
    },

    async getMine(feedbackId: string): Promise<FeedbackDetail> {
      return (await readJson<{ feedback: FeedbackDetail }>(await fetcher(
        `/api/agent/v1/feedback/mine/${encodeURIComponent(feedbackId)}`,
        { credentials: "same-origin" },
      ))).feedback;
    },

    async listAdmin(status: FeedbackStatus | null): Promise<FeedbackListItem[]> {
      const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
      return (await readJson<{ feedback: FeedbackListItem[] }>(await fetcher(
        `/api/agent/v1/feedback/admin${suffix}`,
        { credentials: "same-origin" },
      ))).feedback;
    },

    async getAdmin(feedbackId: string): Promise<FeedbackDetail> {
      return (await readJson<{ feedback: FeedbackDetail }>(await fetcher(
        `/api/agent/v1/feedback/admin/${encodeURIComponent(feedbackId)}`,
        { credentials: "same-origin" },
      ))).feedback;
    },

    async unreadCount(signal?: AbortSignal): Promise<number> {
      return (await readJson<{ count: number }>(await fetcher(
        "/api/agent/v1/feedback/admin/unread-count",
        { credentials: "same-origin", signal },
      ))).count;
    },

    async markSeen(feedbackId: string): Promise<boolean> {
      return (await readJson<{ seen: boolean }>(await requestJson(
        fetcher,
        `/api/agent/v1/feedback/admin/${encodeURIComponent(feedbackId)}/mark-seen`,
        {},
      ))).seen;
    },

    async changeStatus(feedbackId: string, status: FeedbackStatus, expectedVersion: number): Promise<FeedbackDetail> {
      return (await readJson<{ feedback: FeedbackDetail }>(await requestJson(
        fetcher,
        `/api/agent/v1/feedback/admin/${encodeURIComponent(feedbackId)}/status`,
        { status, expectedVersion },
      ))).feedback;
    },

    async openAttachment(path: string): Promise<void> {
      const response = await fetcher(`/api/agent${path}`, { credentials: "same-origin" });
      if (!response.ok) throw new FeedbackRequestError(response.status);
      const objectUrl = URL.createObjectURL(await response.blob());
      window.open(objectUrl, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    },
  };
}

export type HelpFeedbackClient = ReturnType<typeof createHelpFeedbackClient>;
