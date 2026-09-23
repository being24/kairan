import { describe, expect, test } from "bun:test";
import type { KairanConfig } from "./config.ts";
import { runStopHook } from "./hook.ts";
import type { FeedbackBundle } from "./shared/types.ts";

function testConfig(overrides: Partial<KairanConfig> = {}): KairanConfig {
  return {
    port: 5766,
    host: "127.0.0.1",
    dataDir: "/tmp/unused",
    autoOpen: "session-first",
    reopenWhenNoTab: false,
    notifications: true,
    notifyOn: "all",
    openCommand: "open",
    editorUrl: "vscode://file{path}",
    editorCommand: "",
    followDefault: true,
    shutdownGraceMs: 5000,
    archiveGraceMs: 10_000,
    reuseTab: true,
    feedbackWaitMs: 240_000,
    hookWaitMs: 60 * 60 * 1000,
    ...overrides,
  };
}

const bundleWithAnswer = (freeText: string): FeedbackBundle => ({
  reviews: [],
  answeredAsks: [
    {
      id: 1,
      sessionId: "s1",
      fileId: 1,
      status: "answered",
      questions: [
        { id: "q1", question: "どちらにする?", options: [{ label: "案1" }], multiSelect: false },
      ],
      answers: [{ questionId: "q1", selected: ["案1"], freeText }],
      createdAt: 0,
      answeredAt: 1,
    },
  ],
});

interface FakeDaemonOptions {
  up?: boolean;
  claim?: { status: number; body: unknown };
}

function fakeDaemon(options: FakeDaemonOptions = {}) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/healthz") {
      if (options.up === false) throw new Error("connection refused");
      return Response.json({ app: "kairan" });
    }
    if (path === "/api/feedback/claim") {
      const claim = options.claim ?? { status: 200, body: { status: "pending" } };
      return Response.json(claim.body, { status: claim.status });
    }
    if (path === "/api/feedback/ack") {
      expect(init?.method).toBe("POST");
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected call: ${path}`);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function collectStderr() {
  const written: string[] = [];
  return {
    written,
    writeErr: async (text: string) => {
      written.push(text);
    },
  };
}

describe("runStopHook", () => {
  test("stdin が読めなければデーモンに触らず終わる", async () => {
    const daemon = fakeDaemon();
    const err = collectStderr();
    const code = await runStopHook({
      readStdin: async () => "not json",
      fetchFn: daemon.fetchFn,
      config: testConfig(),
      writeErr: err.writeErr,
    });
    expect(code).toBe(0);
    expect(daemon.calls).toEqual([]);
    expect(err.written).toEqual([]);
  });

  test("session_id が無ければ何もしない", async () => {
    const daemon = fakeDaemon();
    const err = collectStderr();
    const code = await runStopHook({
      readStdin: async () => JSON.stringify({ cwd: "/proj" }),
      fetchFn: daemon.fetchFn,
      config: testConfig(),
      writeErr: err.writeErr,
    });
    expect(code).toBe(0);
    expect(daemon.calls).toEqual([]);
  });

  test("デーモンが止まっていれば起動せず終わる", async () => {
    const daemon = fakeDaemon({ up: false });
    const err = collectStderr();
    const code = await runStopHook({
      readStdin: async () => JSON.stringify({ session_id: "abc" }),
      fetchFn: daemon.fetchFn,
      config: testConfig(),
      writeErr: err.writeErr,
    });
    expect(code).toBe(0);
    expect(daemon.calls).toEqual(["/healthz"]);
  });

  test("回答が届いていれば stderr へ注入し、受領確定して exit 2", async () => {
    const daemon = fakeDaemon({
      claim: {
        status: 200,
        body: { status: "feedback", claimId: "c1", bundle: bundleWithAnswer("案1でいく") },
      },
    });
    const err = collectStderr();
    const code = await runStopHook({
      readStdin: async () => JSON.stringify({ session_id: "abc" }),
      fetchFn: daemon.fetchFn,
      config: testConfig(),
      writeErr: err.writeErr,
    });
    expect(code).toBe(2);
    expect(err.written.join("")).toContain("案1でいく");
    expect(daemon.calls).toEqual(["/healthz", "/api/feedback/claim", "/api/feedback/ack"]);
  });

  test("claim は claude: 前置きした鍵と hookWaitMs を渡す", async () => {
    const bodies: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : input.toString()).pathname;
      if (path === "/healthz") return Response.json({ app: "kairan" });
      bodies.push(String(init?.body));
      return Response.json({ status: "pending" });
    }) as unknown as typeof fetch;

    await runStopHook({
      readStdin: async () => JSON.stringify({ session_id: "abc-123" }),
      fetchFn,
      config: testConfig({ hookWaitMs: 1234 }),
      writeErr: collectStderr().writeErr,
    });
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({
      agentSessionKey: "claude:abc-123",
      timeoutMs: 1234,
    });
  });

  test("待って何も来なければ注入しない", async () => {
    const daemon = fakeDaemon({ claim: { status: 200, body: { status: "pending" } } });
    const err = collectStderr();
    const code = await runStopHook({
      readStdin: async () => JSON.stringify({ session_id: "abc" }),
      fetchFn: daemon.fetchFn,
      config: testConfig(),
      writeErr: err.writeErr,
    });
    expect(code).toBe(0);
    expect(err.written).toEqual([]);
    expect(daemon.calls).toEqual(["/healthz", "/api/feedback/claim"]);
  });

  test("セッションが無ければ注入しない", async () => {
    const daemon = fakeDaemon({ claim: { status: 200, body: { status: "no-session" } } });
    const code = await runStopHook({
      readStdin: async () => JSON.stringify({ session_id: "abc" }),
      fetchFn: daemon.fetchFn,
      config: testConfig(),
      writeErr: collectStderr().writeErr,
    });
    expect(code).toBe(0);
  });

  test("claim がエラーを返したら黙って終わる", async () => {
    const daemon = fakeDaemon({ claim: { status: 500, body: { error: "boom" } } });
    const err = collectStderr();
    const code = await runStopHook({
      readStdin: async () => JSON.stringify({ session_id: "abc" }),
      fetchFn: daemon.fetchFn,
      config: testConfig(),
      writeErr: err.writeErr,
    });
    expect(code).toBe(0);
    expect(err.written).toEqual([]);
  });

  test("全文を載せられなかったときは受領確定しない", async () => {
    const daemon = fakeDaemon({
      claim: {
        status: 200,
        body: { status: "feedback", claimId: "c1", bundle: bundleWithAnswer("あ".repeat(20_000)) },
      },
    });
    const err = collectStderr();
    const code = await runStopHook({
      readStdin: async () => JSON.stringify({ session_id: "abc" }),
      fetchFn: daemon.fetchFn,
      config: testConfig(),
      writeErr: err.writeErr,
    });
    expect(code).toBe(2);
    expect(err.written.join("")).toContain("list_feedback");
    expect(daemon.calls).not.toContain("/api/feedback/ack");
  });
});
