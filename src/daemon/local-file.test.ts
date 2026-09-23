import { describe, expect, test } from "bun:test";
import { createLocalFileOpener, editorUrlFor } from "./local-file.ts";

describe("editorUrlFor", () => {
  test("{path} を絶対パスに置換する", () => {
    expect(editorUrlFor("vscode://file{path}", "/Users/me/report.md")).toBe(
      "vscode://file/Users/me/report.md",
    );
  });

  test("空白を percent-encode する", () => {
    expect(editorUrlFor("vscode://file{path}", "/Users/me/my report.md")).toBe(
      "vscode://file/Users/me/my%20report.md",
    );
  });

  test("fragment・query として解釈される記号を encode する", () => {
    const url = editorUrlFor("vscode://file{path}", "/tmp/a#b?c%d.md");
    expect(url).toBe("vscode://file/tmp/a%23b%3Fc%25d.md");
    expect(new URL(url).hash).toBe("");
    expect(new URL(url).search).toBe("");
  });

  test("日本語ファイル名を UTF-8 で encode する", () => {
    expect(editorUrlFor("vscode://file{path}", "/tmp/設計メモ.md")).toBe(
      "vscode://file/tmp/%E8%A8%AD%E8%A8%88%E3%83%A1%E3%83%A2.md",
    );
  });

  test("別エディタのテンプレートにも使える", () => {
    expect(editorUrlFor("cursor://file{path}", "/tmp/a.md")).toBe("cursor://file/tmp/a.md");
  });
});

describe("createLocalFileOpener", () => {
  const configWith = (editorUrl: string, editorCommand = "") =>
    ({ editorUrl, editorCommand }) as unknown as Parameters<typeof createLocalFileOpener>[0];

  type Result = { exitCode: number; stdout: string; stderr: string };
  const ok = (stdout = ""): Result => ({ exitCode: 0, stdout, stderr: "" });

  function recorder(respond: (command: string[]) => Result = () => ok()) {
    const calls: string[][] = [];
    return {
      calls,
      runCommand: async (command: string[]) => {
        calls.push(command);
        return respond(command);
      },
    };
  }

  describe("macOS", () => {
    test("file-manager は open -R でパスを渡す", async () => {
      const { calls, runCommand } = recorder();
      const open = createLocalFileOpener(configWith("vscode://file{path}"), {
        platform: "macos",
        runCommand,
      });
      await open("file-manager", "/tmp/a.md");
      expect(calls).toEqual([["open", "-R", "/tmp/a.md"]]);
    });

    test("editor は組み立てた URL を open に渡す", async () => {
      const { calls, runCommand } = recorder();
      const open = createLocalFileOpener(configWith("vscode://file{path}"), {
        platform: "macos",
        runCommand,
      });
      await open("editor", "/tmp/my note.md");
      expect(calls).toEqual([["open", "vscode://file/tmp/my%20note.md"]]);
    });

    test("editorUrl も editorCommand も空なら editor を拒否する", async () => {
      const open = createLocalFileOpener(configWith(""), {
        platform: "macos",
        runCommand: async () => ok(),
      });
      expect(open("editor", "/tmp/a.md")).rejects.toThrow(/editor/);
    });

    test("非ゼロ終了は失敗として伝える", async () => {
      const open = createLocalFileOpener(configWith("vscode://file{path}"), {
        platform: "macos",
        runCommand: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "no application knows how to open",
        }),
      });
      expect(open("editor", "/tmp/a.md")).rejects.toThrow(/no application knows how to open/);
    });
  });

  describe("WSL", () => {
    test("file-manager は Windows のパスに変換してエクスプローラーで選択する", async () => {
      const { calls, runCommand } = recorder((command) =>
        command[0] === "wslpath"
          ? ok("\\\\wsl.localhost\\Ubuntu\\home\\me\\a.md\r\n")
          : { exitCode: 1, stdout: "", stderr: "" },
      );
      const open = createLocalFileOpener(configWith("vscode://file{path}", "code"), {
        platform: "wsl",
        runCommand,
      });
      // explorer.exe は成功しても 1 を返すので、失敗扱いにしない
      await open("file-manager", "/home/me/a.md");
      expect(calls).toEqual([
        ["wslpath", "-w", "/home/me/a.md"],
        ["explorer.exe", "/select,\\\\wsl.localhost\\Ubuntu\\home\\me\\a.md"],
      ]);
    });

    test("パスを変換できなければ失敗として伝える", async () => {
      const open = createLocalFileOpener(configWith("vscode://file{path}", "code"), {
        platform: "wsl",
        runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "wslpath: bad path" }),
      });
      expect(open("file-manager", "/nowhere")).rejects.toThrow(/wslpath: bad path/);
    });

    test("editorCommand があれば URL ではなくコマンドにパスを渡す", async () => {
      const { calls, runCommand } = recorder();
      const open = createLocalFileOpener(configWith("vscode://file{path}", "code"), {
        platform: "wsl",
        runCommand,
      });
      await open("editor", "/home/me/my note.md");
      expect(calls).toEqual([["code", "/home/me/my note.md"]]);
    });

    test("editorCommand が空なら editorUrl を Windows 側で開く", async () => {
      const { calls, runCommand } = recorder();
      const open = createLocalFileOpener(configWith("cursor://file{path}", ""), {
        platform: "wsl",
        runCommand,
      });
      await open("editor", "/home/me/a.md");
      expect(calls).toEqual([
        ["rundll32.exe", "url.dll,FileProtocolHandler", "cursor://file/home/me/a.md"],
      ]);
    });
  });

  test("その他の環境ではファイルマネージャーで開けない", async () => {
    const open = createLocalFileOpener(configWith("vscode://file{path}"), {
      platform: "other",
      runCommand: async () => ok(),
    });
    expect(open("file-manager", "/tmp/a.md")).rejects.toThrow(/not supported/);
  });
});
