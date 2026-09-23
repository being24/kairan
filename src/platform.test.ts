import { describe, expect, test } from "bun:test";
import { detectHostPlatform, openUrlCommand } from "./platform.ts";

describe("detectHostPlatform", () => {
  test("darwin は macOS", () => {
    expect(detectHostPlatform({}, "darwin")).toBe("macos");
  });

  test("WSL のディストリビューション名を持つ Linux は WSL", () => {
    expect(detectHostPlatform({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe("wsl");
  });

  test("それ以外の Linux や Windows ネイティブは other", () => {
    expect(detectHostPlatform({}, "linux")).toBe("other");
    expect(detectHostPlatform({ WSL_DISTRO_NAME: "" }, "linux")).toBe("other");
    expect(detectHostPlatform({}, "win32")).toBe("other");
  });
});

describe("openUrlCommand", () => {
  const url = "http://127.0.0.1:5766/0923-1914/report.md?rev=2&x=1#top";

  test("WSL は Windows の既定ブラウザで開く（URL は1引数のまま渡す）", () => {
    expect(openUrlCommand("wsl", url)).toEqual([
      "rundll32.exe",
      "url.dll,FileProtocolHandler",
      url,
    ]);
  });

  test("macOS は open、それ以外は xdg-open", () => {
    expect(openUrlCommand("macos", url)).toEqual(["open", url]);
    expect(openUrlCommand("other", url)).toEqual(["xdg-open", url]);
  });
});
