import type { KairanConfig } from "../config.ts";
import { detectHostPlatform, type HostPlatform } from "../platform.ts";
import { daemonBaseUrl } from "../shared/url.ts";

export type Notifier = (title: string, body: string, url?: string) => void;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface NotifierDeps {
  platform?: HostPlatform;
  which?: (command: string) => string | null;
  spawn?: (args: string[]) => void;
}

function defaultSpawn(args: string[]): void {
  Bun.spawn(args, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

/** PowerShell の単一引用符リテラル。中身は一切展開されず、' だけを二重にすればよい */
function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// PowerShell 自身の AppUserModelID。kairan 用の ID を登録しなくてもトーストを出せる
const POWERSHELL_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Windows のトースト通知を出す PowerShell スクリプト。url を渡すと、クリックで
 * 既定のアプリ（ブラウザ）がその URL を開く
 */
export function windowsToastScript(title: string, body: string, url?: string): string {
  const xmlEscape = "[Security.SecurityElement]::Escape";
  const activation =
    url == null ? "" : ` activationType=\`"protocol\`" launch=\`"$(${xmlEscape}($url))\`"`;
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    `$title = ${powershellLiteral(title)}`,
    `$body = ${powershellLiteral(body)}`,
    ...(url == null ? [] : [`$url = ${powershellLiteral(url)}`]),
    "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    "$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
    `$xml = "<toast${activation}><visual><binding template=\`"ToastGeneric\`"><text>$(${xmlEscape}($title))</text><text>$(${xmlEscape}($body))</text></binding></visual></toast>"`,
    "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$doc.LoadXml($xml)",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${powershellLiteral(POWERSHELL_APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($doc))`,
  ].join("\n");
}

function encodePowershellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * macOS 通知センターへの通知。terminal-notifier があればクリックで URL を
 * 開ける通知にし、無ければ osascript（クリック遷移なし）にフォールバックする。
 * 通知は補助機能なので、どちらの経路でも失敗は publish に波及させない。
 */
export function createNotifier(config: KairanConfig, deps: NotifierDeps = {}): Notifier {
  if (!config.notifications) return () => {};
  const platform = deps.platform ?? detectHostPlatform();
  const which = deps.which ?? Bun.which;
  const spawn = deps.spawn ?? defaultSpawn;

  if (platform === "wsl") {
    return (title, body, url) => {
      try {
        spawn([
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          encodePowershellCommand(windowsToastScript(title, body, url)),
        ]);
      } catch {
        // no-op
      }
    };
  }
  if (platform !== "macos") return () => {};

  const terminalNotifier = which("terminal-notifier");
  if (terminalNotifier != null) {
    const focusEndpoint = `${daemonBaseUrl(config.host, config.port)}/api/focus`;
    return (title, body, url) => {
      try {
        const args = [terminalNotifier, "-title", title, "-message", body];
        if (url != null) {
          if (config.reuseTab) {
            // -open は常に新規タブを開いてしまうため、デーモンの /api/focus 経由で
            // タブ再利用ロジック（open.ts）に乗せる
            const payload = JSON.stringify({ url });
            args.push(
              "-execute",
              `curl -s -m 5 -X POST ${shellQuote(focusEndpoint)} -H 'content-type: application/json' -d ${shellQuote(payload)}`,
            );
          } else {
            args.push("-open", url);
          }
        }
        spawn(args);
      } catch {
        // no-op
      }
    };
  }

  return (title, body) => {
    try {
      // JSON.stringify は AppleScript 文字列リテラルのエスケープ（" と \）と互換
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      spawn(["osascript", "-e", script]);
    } catch {
      // no-op
    }
  };
}
