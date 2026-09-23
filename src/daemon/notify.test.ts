import { describe, expect, test } from "bun:test";
import type { KairanConfig } from "../config.ts";
import { createNotifier, windowsToastScript } from "./notify.ts";

function testConfig(overrides: Partial<KairanConfig> = {}): KairanConfig {
  return {
    port: 5766,
    host: "127.0.0.1",
    dataDir: "/tmp/unused",
    autoOpen: "session-first",
    reopenWhenNoTab: true,
    notifications: true,
    notifyOn: "all",
    openCommand: "open",
    editorUrl: "vscode://file{path}",
    editorCommand: "",
    followDefault: true,
    shutdownGraceMs: 5000,
    archiveGraceMs: 10_000,
    reuseTab: true,
    feedbackWaitMs: 1_200_000,
    hookWaitMs: 60 * 60 * 1000,
    ...overrides,
  };
}

describe("createNotifier", () => {
  test("reuseTab: click executes a curl to /api/focus instead of -open", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig(), {
      platform: "macos",
      which: () => "/opt/homebrew/bin/terminal-notifier",
      spawn: (args) => spawned.push(args),
    });
    notify("kairan", "新着: report.md", "http://127.0.0.1:5766/abc/report.md");
    const args = spawned[0] ?? [];
    expect(args).not.toContain("-open");
    const executeIndex = args.indexOf("-execute");
    expect(executeIndex).toBeGreaterThan(0);
    const command = args[executeIndex + 1] ?? "";
    expect(command).toContain("http://127.0.0.1:5766/api/focus");
    expect(command).toContain("report.md");
  });

  test("reuseTab=false: click opens the url directly with -open", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig({ reuseTab: false }), {
      platform: "macos",
      which: () => "/opt/homebrew/bin/terminal-notifier",
      spawn: (args) => spawned.push(args),
    });
    notify("kairan", "新着: report.md", "http://127.0.0.1:5766/abc/report.md");
    expect(spawned).toEqual([
      [
        "/opt/homebrew/bin/terminal-notifier",
        "-title",
        "kairan",
        "-message",
        "新着: report.md",
        "-open",
        "http://127.0.0.1:5766/abc/report.md",
      ],
    ]);
  });

  test("terminal-notifier without url omits -open", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig(), {
      platform: "macos",
      which: () => "/opt/homebrew/bin/terminal-notifier",
      spawn: (args) => spawned.push(args),
    });
    notify("kairan", "hello");
    expect(spawned[0]).not.toContain("-open");
  });

  test("falls back to osascript when terminal-notifier is missing", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig(), {
      platform: "macos",
      which: () => null,
      spawn: (args) => spawned.push(args),
    });
    notify("kairan", 'say "hi" \\ done', "http://127.0.0.1:5766/abc/a.md");
    expect(spawned[0]?.[0]).toBe("osascript");
    expect(spawned[0]?.[2]).toBe(
      'display notification "say \\"hi\\" \\\\ done" with title "kairan"',
    );
  });

  test("notifications=false yields a no-op notifier", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig({ notifications: false }), {
      platform: "macos",
      which: () => "/opt/homebrew/bin/terminal-notifier",
      spawn: (args) => spawned.push(args),
    });
    notify("kairan", "hello", "http://example");
    expect(spawned).toHaveLength(0);
  });
});

describe("WSL のトースト通知", () => {
  const decode = (args: string[]): string => {
    const encoded = args[args.indexOf("-EncodedCommand") + 1] ?? "";
    return Buffer.from(encoded, "base64").toString("utf16le");
  };

  test("PowerShell にスクリプトを UTF-16LE の base64 で渡す（シェルを経由しない）", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig(), {
      platform: "wsl",
      spawn: (args) => spawned.push(args),
    });
    const url = "http://127.0.0.1:5766/abc/report.md?rev=2&x=1";
    notify("kairan", "新着: report.md", url);
    const args = spawned[0] ?? [];
    expect(args.slice(0, 3)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive"]);
    expect(decode(args)).toBe(windowsToastScript("kairan", "新着: report.md", url));
  });

  test("値は単一引用符のリテラルに閉じ込め、引用符は二重にする", () => {
    const script = windowsToastScript("it's", "'; Remove-Item C:\\ -Recurse; '", "http://x/?a='b'");
    expect(script).toContain("$title = 'it''s'");
    expect(script).toContain("$body = '''; Remove-Item C:\\ -Recurse; '''");
    expect(script).toContain("$url = 'http://x/?a=''b'''");
  });

  test("XML に埋める前にエスケープし、URL があればクリックでそこを開く", () => {
    const script = windowsToastScript("t", "<b>&</b>", "http://x/?a=1&b=2");
    expect(script).toContain("[Security.SecurityElement]::Escape");
    expect(script).toContain('activationType=`"protocol`"');
  });

  test("URL が無ければクリックで何も開かない", () => {
    const script = windowsToastScript("t", "b");
    expect(script).not.toContain("activationType");
    expect(script).not.toContain("$url");
  });

  test("macOS でも WSL でもなければ何もしない", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig(), {
      platform: "other",
      which: () => "/usr/bin/terminal-notifier",
      spawn: (args) => spawned.push(args),
    });
    notify("kairan", "hello", "http://example");
    expect(spawned).toHaveLength(0);
  });
});
