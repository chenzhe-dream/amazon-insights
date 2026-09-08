import {
  AdminUserPresenceResponseSchema,
  type AdminUserPresenceResponse,
} from "../../shared/agent-contracts";
import { localAgentFetch } from "./local-agent-browser";

export const ADMIN_USER_PRESENCE_ERROR_MESSAGE = "用户活动数据暂不可用，请稍后重试";

export class AdminUserPresenceForbiddenError extends Error {
  readonly kind = "forbidden" as const;

  constructor() {
    super(ADMIN_USER_PRESENCE_ERROR_MESSAGE);
    this.name = "AdminUserPresenceForbiddenError";
  }
}

type FetchAdminUserPresence = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export async function readAdminUserPresence(
  signal: AbortSignal,
  fetchImpl: FetchAdminUserPresence = localAgentFetch,
): Promise<AdminUserPresenceResponse> {
  try {
    const response = await fetchImpl("/v1/admin/users", {
      method: "GET",
      signal,
    });
    if (response.status === 403) throw new AdminUserPresenceForbiddenError();
    if (!response.ok) throw new Error(ADMIN_USER_PRESENCE_ERROR_MESSAGE);

    const parsed = AdminUserPresenceResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error(ADMIN_USER_PRESENCE_ERROR_MESSAGE);
    return parsed.data;
  } catch (error) {
    if (error instanceof AdminUserPresenceForbiddenError) throw error;
    throw new Error(ADMIN_USER_PRESENCE_ERROR_MESSAGE);
  }
}

export type AdminUserPresenceLoadState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "empty"; data: AdminUserPresenceResponse }>
  | Readonly<{ status: "ready"; data: AdminUserPresenceResponse }>
  | Readonly<{ status: "forbidden" }>
  | Readonly<{ status: "error"; message: typeof ADMIN_USER_PRESENCE_ERROR_MESSAGE }>;

type LoadAdminUserPresence = (
  signal: AbortSignal,
) => Promise<AdminUserPresenceResponse>;

type AdminUserPresenceLoadContext = Readonly<{
  sessionIdentity: string;
  onForbidden: (sessionIdentity: string) => void;
}>;

export class AdminUserPresenceLoaderController {
  private generation = 0;
  private activeRequest: AbortController | null = null;

  constructor(
    private readonly load: LoadAdminUserPresence = readAdminUserPresence,
  ) {}

  start(
    setState: (state: AdminUserPresenceLoadState) => void,
    context?: AdminUserPresenceLoadContext,
  ): void {
    this.stop();
    const generation = this.generation;
    const request = new AbortController();
    this.activeRequest = request;
    setState({ status: "loading" });

    void this.load(request.signal).then(
      (data) => {
        if (!this.isCurrent(generation, request)) return;
        setState(data.users.length === 0
          ? { status: "empty", data }
          : { status: "ready", data });
      },
      (error) => {
        if (!this.isCurrent(generation, request)) return;
        if (
          error instanceof AdminUserPresenceForbiddenError ||
          (typeof error === "object" && error !== null &&
            "kind" in error && error.kind === "forbidden")
        ) {
          setState({ status: "forbidden" });
          if (context) context.onForbidden(context.sessionIdentity);
          return;
        }
        setState({ status: "error", message: ADMIN_USER_PRESENCE_ERROR_MESSAGE });
      },
    );
  }

  stop(): void {
    this.generation += 1;
    this.activeRequest?.abort();
    this.activeRequest = null;
  }

  private isCurrent(generation: number, request: AbortController): boolean {
    return generation === this.generation
      && this.activeRequest === request
      && !request.signal.aborted;
  }
}
