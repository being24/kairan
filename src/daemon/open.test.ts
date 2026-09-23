import { describe, expect, test } from "bun:test";
import type { KairanConfig } from "../config.ts";
import { createOpener } from "./open.ts";

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

function waitTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createOpener", () => {
  test("does not open a new tab when an existing tab was reused", async () => {
    const opened: string[] = [];
    let jxaArgs: string[] = [];
    const open = createOpener(testConfig(), {
      platform: "macos",
      runJxa: async (_script, args) => {
        jxaArgs = args;
        return "reused";
      },
      plainOpen: (url) => opened.push(url),
    });
    open("http://127.0.0.1:5766/abc/a.md");
    await waitTick();
    expect(opened).toHaveLength(0);
    expect(jxaArgs[0]).toBe("http://127.0.0.1:5766/abc/a.md");
    expect(jxaArgs).toContain("http://localhost:5766/");
  });

  test("falls back to plain open when no tab matched", async () => {
    const opened: string[] = [];
    const open = createOpener(testConfig(), {
      platform: "macos",
      runJxa: async () => "none",
      plainOpen: (url) => opened.push(url),
    });
    open("http://127.0.0.1:5766/abc/a.md");
    await waitTick();
    expect(opened).toEqual(["http://127.0.0.1:5766/abc/a.md"]);
  });

  test("falls back to plain open when osascript fails", async () => {
    const opened: string[] = [];
    const open = createOpener(testConfig(), {
      platform: "macos",
      runJxa: async () => {
        throw new Error("osascript not available");
      },
      plainOpen: (url) => opened.push(url),
    });
    open("http://127.0.0.1:5766/abc/a.md");
    await waitTick();
    expect(opened).toEqual(["http://127.0.0.1:5766/abc/a.md"]);
  });

  test("reuseTab=false skips JXA entirely", async () => {
    const opened: string[] = [];
    let jxaCalled = false;
    const open = createOpener(testConfig({ reuseTab: false }), {
      platform: "macos",
      runJxa: async () => {
        jxaCalled = true;
        return "reused";
      },
      plainOpen: (url) => opened.push(url),
    });
    open("http://127.0.0.1:5766/abc/a.md");
    await waitTick();
    expect(jxaCalled).toBe(false);
    expect(opened).toHaveLength(1);
  });

  test("WSL ではタブ再利用を試さず、Windows の既定ブラウザで開く", async () => {
    const spawned: string[][] = [];
    let jxaCalled = false;
    const open = createOpener(testConfig({ openCommand: "" }), {
      platform: "wsl",
      runJxa: async () => {
        jxaCalled = true;
        return "reused";
      },
      spawn: (command) => spawned.push(command),
    });
    open("http://127.0.0.1:5766/abc/a.md?rev=2&x=1");
    await waitTick();
    expect(jxaCalled).toBe(false);
    expect(spawned).toEqual([
      ["rundll32.exe", "url.dll,FileProtocolHandler", "http://127.0.0.1:5766/abc/a.md?rev=2&x=1"],
    ]);
  });

  test("openCommand を明示していればそのコマンドに URL を渡す", async () => {
    const spawned: string[][] = [];
    const open = createOpener(testConfig({ openCommand: "firefox", reuseTab: false }), {
      platform: "wsl",
      spawn: (command) => spawned.push(command),
    });
    open("http://127.0.0.1:5766/abc/a.md");
    await waitTick();
    expect(spawned).toEqual([["firefox", "http://127.0.0.1:5766/abc/a.md"]]);
  });
});
