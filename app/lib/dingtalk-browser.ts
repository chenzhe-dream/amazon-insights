export type DingTalkBrowserErrorKind = "cancelled" | "unavailable";

export class DingTalkBrowserError extends Error {
  constructor(readonly kind: DingTalkBrowserErrorKind) {
    super(kind === "cancelled" ? "DingTalk login was cancelled" : "DingTalk login is unavailable");
    this.name = "DingTalkBrowserError";
  }
}

type NavigatorLike = Readonly<{ userAgent?: string | null }>;
type DingTalkModuleLoader = () => Promise<unknown>;

export class DingTalkWorkbenchAttempt {
  #attempted = false;

  claim(input: Readonly<{ enabled: boolean; navigator: NavigatorLike | null | undefined }>): boolean {
    if (this.#attempted || !input.enabled || !isDingTalkContainer(input.navigator)) {
      return false;
    }
    this.#attempted = true;
    return true;
  }
}

export function isDingTalkContainer(navigatorLike: NavigatorLike | null | undefined): boolean {
  return /(?:DingTalk|AliApp\(DingTalk)/i.test(navigatorLike?.userAgent ?? "");
}

export async function requestDingTalkWorkbenchCode(
  corpId: string,
  loadModule: DingTalkModuleLoader = () => import("dingtalk-jsapi"),
): Promise<string> {
  const normalizedCorpId = corpId.trim();
  if (!normalizedCorpId || normalizedCorpId.length > 200) {
    throw new DingTalkBrowserError("unavailable");
  }
  try {
    const loaded = await loadModule();
    const moduleRecord = asRecord(loaded);
    const candidate = asRecord(moduleRecord?.default) ?? moduleRecord;
    const runtime = asRecord(candidate?.runtime);
    const permission = asRecord(runtime?.permission);
    const requestAuthCode = permission?.requestAuthCode;
    if (typeof requestAuthCode !== "function") {
      throw new DingTalkBrowserError("unavailable");
    }
    const result = asRecord(await requestAuthCode({ corpId: normalizedCorpId }));
    const code = typeof result?.code === "string" ? result.code.trim() : "";
    if (!code || code.length > 2_000) {
      throw new DingTalkBrowserError("unavailable");
    }
    return code;
  } catch (error) {
    if (error instanceof DingTalkBrowserError) throw error;
    throw new DingTalkBrowserError(isCancellation(error) ? "cancelled" : "unavailable");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function isCancellation(value: unknown): boolean {
  const record = asRecord(value);
  const candidates = [record?.errorMessage, record?.message, record?.errorCode];
  return candidates.some(
    (candidate) => typeof candidate === "string" && /cancel|取消/i.test(candidate),
  );
}
