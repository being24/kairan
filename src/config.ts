import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { detectHostPlatform, type HostPlatform } from "./platform.ts";
import { DEFAULT_PORT } from "./shared/consts.ts";

// 認証なし・HTML無制限実行のデーモンを LAN に公開させないため loopback に限定する
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

const configSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    host: z.enum(LOOPBACK_HOSTS),
    dataDir: z.string().min(1),
    autoOpen: z.enum(["session-first", "always", "never"]),
    reopenWhenNoTab: z.boolean(),
    notifications: z.boolean(),
    notifyOn: z.enum(["all", "new-file"]),
    // 空文字 = 環境に合わせて自動（platform.ts の openUrlCommand）
    openCommand: z.string(),
    // 空文字 = エディタで開く機能を使わない。それ以外は置換先が無いと
    // 「エディタは起動するがファイルは開かない」無言の失敗になるため入口で弾く
    editorUrl: z.string().refine((url) => url === "" || url.includes("{path}"), {
      message: 'editorUrl must be empty or contain the "{path}" placeholder',
    }),
    // 空でなければ「エディタで開く」は editorUrl ではなく `<editorCommand> <path>` を実行する
    editorCommand: z.string(),
    followDefault: z.boolean(),
    shutdownGraceMs: z.number().int().min(0),
    archiveGraceMs: z.number().int().min(0),
    reuseTab: z.boolean(),
    feedbackWaitMs: z.number().int().min(1000),
    hookWaitMs: z.number().int().min(1000),
  })
  .partial();

export type KairanConfig = Required<z.infer<typeof configSchema>>;

interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  readConfigFile?: (path: string) => string | null;
  platform?: HostPlatform;
}

function defaultReadConfigFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

function expandTilde(path: string, home: string): string {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function parseBoolEnv(name: string, value: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true/false/1/0, got: ${value}`);
}

function parseIntEnv(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer, got: ${value}`);
  return parsed;
}

function fromFile(raw: string, path: string): z.infer<typeof configSchema> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in config file ${path}: ${String(err)}`);
  }
  const result = configSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`invalid config file ${path}: ${result.error.message}`);
  }
  return result.data;
}

function fromEnv(env: Record<string, string | undefined>): z.infer<typeof configSchema> {
  const overrides: Record<string, unknown> = {};
  const mappings: Array<[string, keyof KairanConfig, "string" | "int" | "bool"]> = [
    ["KAIRAN_PORT", "port", "int"],
    ["KAIRAN_HOST", "host", "string"],
    ["KAIRAN_DATA_DIR", "dataDir", "string"],
    ["KAIRAN_AUTO_OPEN", "autoOpen", "string"],
    ["KAIRAN_REOPEN_WHEN_NO_TAB", "reopenWhenNoTab", "bool"],
    ["KAIRAN_NOTIFICATIONS", "notifications", "bool"],
    ["KAIRAN_NOTIFY_ON", "notifyOn", "string"],
    ["KAIRAN_OPEN_COMMAND", "openCommand", "string"],
    ["KAIRAN_EDITOR_URL", "editorUrl", "string"],
    ["KAIRAN_EDITOR_COMMAND", "editorCommand", "string"],
    ["KAIRAN_FOLLOW_DEFAULT", "followDefault", "bool"],
    ["KAIRAN_SHUTDOWN_GRACE_MS", "shutdownGraceMs", "int"],
    ["KAIRAN_ARCHIVE_GRACE_MS", "archiveGraceMs", "int"],
    ["KAIRAN_REUSE_TAB", "reuseTab", "bool"],
    ["KAIRAN_FEEDBACK_WAIT_MS", "feedbackWaitMs", "int"],
    ["KAIRAN_HOOK_WAIT_MS", "hookWaitMs", "int"],
  ];
  for (const [envName, key, kind] of mappings) {
    const value = env[envName];
    if (value == null) continue;
    overrides[key] =
      kind === "int"
        ? parseIntEnv(envName, value)
        : kind === "bool"
          ? parseBoolEnv(envName, value)
          : value;
  }
  const result = configSchema.safeParse(overrides);
  if (!result.success) {
    throw new Error(`invalid environment variable config: ${result.error.message}`);
  }
  return result.data;
}

export function configFilePath(env: Record<string, string | undefined>, home: string): string {
  return env.KAIRAN_CONFIG_PATH ?? join(home, ".kairan", "config.json");
}

export function loadConfig(options: LoadConfigOptions = {}): KairanConfig {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const readConfigFile = options.readConfigFile ?? defaultReadConfigFile;
  const platform = options.platform ?? detectHostPlatform(env);

  const defaults: KairanConfig = {
    port: DEFAULT_PORT,
    host: "127.0.0.1",
    dataDir: join(home, ".kairan"),
    autoOpen: "session-first",
    reopenWhenNoTab: true,
    notifications: true,
    notifyOn: "all",
    openCommand: "",
    editorUrl: "vscode://file{path}",
    // WSL の Windows 版 VS Code は vscode:// URL だと WSL 側のファイルを開けない
    editorCommand: platform === "wsl" ? "code" : "",
    followDefault: true,
    shutdownGraceMs: 5000,
    // デーモン再起動後、生きている agent が attach を張り直すのを待つ時間。
    // これを過ぎても attach が無い active セッションは「agent が終了済み」とみなす
    archiveGraceMs: 10_000,
    reuseTab: true,
    // Claude Code の MCP tool call は既定 270 秒がハード上限（progress notification では
    // 伸びない）。そこに達するとツール呼び出しがエラーで落ちるため、内側で自分から返す。
    // 使うのは hook を持たないクライアントがブロックして待つ場合だけ
    feedbackWaitMs: 240 * 1000,
    // Stop hook の待機。hook 側（settings.json の timeout）より短くして、
    // kairan が必ず先に返るようにする
    hookWaitMs: 60 * 60 * 1000,
  };

  const path = configFilePath(env, home);
  const raw = readConfigFile(path);
  const fileOverrides = raw == null ? {} : fromFile(raw, path);
  const envOverrides = fromEnv(env);

  const merged = { ...defaults, ...fileOverrides, ...envOverrides };
  const validated = configSchema.parse(merged) as KairanConfig;
  return { ...validated, dataDir: expandTilde(validated.dataDir, home) };
}
