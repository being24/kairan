import { describe, expect, test } from "bun:test";
import { SignalHub } from "./waiters.ts";

describe("SignalHub", () => {
  test("notify wakes all waiters on the key with true", async () => {
    const hub = new SignalHub();
    const a = hub.wait("k", 1000);
    const b = hub.wait("k", 1000);
    hub.notify("k");
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(hub.waiterCount("k")).toBe(0);
  });

  test("timeout resolves false and cleans up", async () => {
    const hub = new SignalHub();
    expect(await hub.wait("k", 5)).toBe(false);
    expect(hub.waiterCount("k")).toBe(0);
  });

  test("notify on a different key does not wake", async () => {
    const hub = new SignalHub();
    const waiting = hub.wait("a", 20);
    hub.notify("b");
    expect(await waiting).toBe(false);
  });

  test("abort resolves false immediately", async () => {
    const hub = new SignalHub();
    const controller = new AbortController();
    const waiting = hub.wait("k", 10_000, controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
    expect(hub.waiterCount("k")).toBe(0);
  });

  test("releasePreviousWaiters は既存の待機を timeout と同じ扱いで解放する", async () => {
    const hub = new SignalHub();
    const first = hub.wait("k", 10_000);
    hub.releasePreviousWaiters("k");
    expect(await first).toBe(false);
    expect(hub.waiterCount("k")).toBe(0);

    // 解放後に張り直した待機は、次の notify を受け取れる
    const second = hub.wait("k", 10_000);
    hub.notify("k");
    expect(await second).toBe(true);
  });

  test("releasePreviousWaiters は他のキーの待機に触らない", async () => {
    const hub = new SignalHub();
    const waiting = hub.wait("a", 20);
    hub.releasePreviousWaiters("b");
    expect(hub.waiterCount("a")).toBe(1);
    expect(await waiting).toBe(false);
  });
});
