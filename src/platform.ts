/**
 * デーモンが動いている環境。ブラウザ・通知・ファイルマネージャーの呼び方がここで分かれる。
 * wsl はデーモンが WSL 上で動き、ブラウザやエディタは Windows 側にある構成
 */
export type HostPlatform = "macos" | "wsl" | "other";

export function detectHostPlatform(
  env: Record<string, string | undefined> = process.env,
  nodePlatform: NodeJS.Platform = process.platform,
): HostPlatform {
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "linux" && (env.WSL_DISTRO_NAME ?? "") !== "") return "wsl";
  return "other";
}

/** URL を既定のアプリ（http ならブラウザ、vscode:// ならエディタ）で開くコマンド */
export function openUrlCommand(platform: HostPlatform, url: string): string[] {
  switch (platform) {
    case "macos":
      return ["open", url];
    case "wsl":
      // explorer.exe <url> はブラウザと一緒に既定フォルダも開いてしまう
      return ["rundll32.exe", "url.dll,FileProtocolHandler", url];
    case "other":
      return ["xdg-open", url];
  }
}

/** ファイルを選択状態で表示するアプリの名前（UI の表記）。この環境で開けなければ null */
export function fileManagerName(platform: HostPlatform): string | null {
  switch (platform) {
    case "macos":
      return "Finder";
    case "wsl":
      return "エクスプローラー";
    case "other":
      return null;
  }
}
