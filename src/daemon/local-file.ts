import type { KairanConfig } from "../config.ts";
import { detectHostPlatform, type HostPlatform, openUrlCommand } from "../platform.ts";

export type LocalFileTarget = "file-manager" | "editor";

export type LocalFileOpener = (target: LocalFileTarget, path: string) => Promise<void>;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface LocalFileOpenerDeps {
  platform?: HostPlatform;
  runCommand?: (command: string[]) => Promise<CommandResult>;
}

/**
 * エディタ起動 URL を組み立てる。パス区切りは保ったままセグメントを percent-encode する
 * （`#` や `?` を含むパスをそのまま埋めると、URL parser が fragment / query と解釈して
 * 別のファイルを開いてしまうため）
 */
export function editorUrlFor(template: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return template.replaceAll("{path}", encoded);
}

const COMMAND_TIMEOUT_MS = 8000;

async function defaultRunCommand(command: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: COMMAND_TIMEOUT_MS,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * publish 元のローカルファイルをファイルマネージャー（Finder / エクスプローラー）やエディタで開く。
 * 呼び出し側にエラーを返せるよう、コマンドの終了コードまで待つ
 */
export function createLocalFileOpener(
  config: KairanConfig,
  deps: LocalFileOpenerDeps = {},
): LocalFileOpener {
  const platform = deps.platform ?? detectHostPlatform();
  const runCommand = deps.runCommand ?? defaultRunCommand;

  const run = async (command: string[]): Promise<CommandResult> => {
    const result = await runCommand(command);
    if (result.exitCode !== 0) {
      const { exitCode, stderr } = result;
      throw new Error(stderr === "" ? `${command[0]} exited with ${exitCode}` : stderr);
    }
    return result;
  };

  const revealInFileManager = async (path: string): Promise<void> => {
    switch (platform) {
      case "macos":
        await run(["open", "-R", path]);
        return;
      case "wsl": {
        const { stdout } = await run(["wslpath", "-w", path]);
        // explorer.exe は選択に成功しても終了コード 1 を返すため、終了コードでは判定できない
        await runCommand(["explorer.exe", `/select,${stdout.trim()}`]);
        return;
      }
      case "other":
        throw new Error("revealing files is not supported on this platform");
    }
  };

  const openInEditor = async (path: string): Promise<void> => {
    if (config.editorCommand !== "") {
      await run([config.editorCommand, path]);
      return;
    }
    if (config.editorUrl === "")
      throw new Error("neither editorCommand nor editorUrl is configured");
    await run(openUrlCommand(platform, editorUrlFor(config.editorUrl, path)));
  };

  return (target, path) =>
    target === "file-manager" ? revealInFileManager(path) : openInEditor(path);
}
