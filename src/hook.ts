import type { KairanConfig } from "./config.ts";
import { formatFeedbackForHook } from "./feedback-text.ts";
import { claudeAgentSessionKey } from "./shared/session-id.ts";
import type { FeedbackBundle } from "./shared/types.ts";
import { daemonBaseUrl } from "./shared/url.ts";

/**
 * stderr に書ける量の上限。Stop hook の stderr はそのままモデルの入力になるため、
 * 1ターン分の注入として無理のない大きさに抑える
 */
const STDERR_LIMIT_BYTES = 16 * 1024;

const PROBE_TIMEOUT_MS = 2000;

export interface StopHookDeps {
  readStdin: () => Promise<string>;
  fetchFn: typeof fetch;
  config: KairanConfig;
  writeErr: (text: string) => Promise<void>;
}

interface ClaimResponse {
  status?: string;
  claimId?: string;
  bundle?: FeedbackBundle;
}

/** hook 入力の JSON から Claude Code のセッション ID を取り出す */
function parseSessionId(stdin: string): string | null {
  try {
    const payload = JSON.parse(stdin) as { session_id?: unknown };
    return typeof payload.session_id === "string" && payload.session_id !== ""
      ? payload.session_id
      : null;
  } catch {
    return null;
  }
}

/**
 * port を握っているのが kairan 本人か確かめる。ここで起動はしない
 * （質問の無い普通のターンの Stop でデーモンを起こさないため）
 */
async function isKairanUp(base: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`${base}/healthz`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as { app?: string } | null;
    return json?.app === "kairan";
  } catch {
    return false;
  }
}

/**
 * 人の回答をこのセッションへ注入する。戻り値は exit code で、
 * 2 が「stderr に注入した（モデルを起こす）」、0 が「注入するものが無い」
 */
export async function runStopHook(deps: StopHookDeps): Promise<number> {
  const stdin = await deps.readStdin().catch(() => "");
  const sessionId = parseSessionId(stdin);
  if (sessionId == null) return 0;

  const base = daemonBaseUrl(deps.config.host, deps.config.port);
  if (!(await isKairanUp(base, deps.fetchFn))) return 0;

  let claimed: ClaimResponse;
  try {
    const res = await deps.fetchFn(`${base}/api/feedback/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentSessionKey: claudeAgentSessionKey(sessionId),
        timeoutMs: deps.config.hookWaitMs,
      }),
      signal: AbortSignal.timeout(deps.config.hookWaitMs + 30_000),
    });
    if (!res.ok) return 0;
    claimed = (await res.json()) as ClaimResponse;
  } catch {
    return 0;
  }
  if (claimed.status !== "feedback" || claimed.bundle == null || claimed.claimId == null) return 0;

  const { text, clipped } = formatFeedbackForHook(claimed.bundle, STDERR_LIMIT_BYTES);
  await deps.writeErr(text);

  // 受領確定は「モデルへ届けきれた」ことの記録。全文を載せられなかったときは
  // 未受領のまま残し、次の tool call で回収させる
  if (!clipped) {
    await deps
      .fetchFn(`${base}/api/feedback/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claimId: claimed.claimId }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      .catch(() => null);
  }
  return 2;
}
