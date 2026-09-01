/**
 * key ごとの待機者にシグナルを届ける。未受領フィードバックの到着を待つ
 * 長時間ポーリング（HTTP ハンドラが await する）の中核。
 */
export class SignalHub {
  private readonly waiters = new Map<string, Set<(signalled: boolean) => void>>();

  notify(key: string): void {
    this.settle(key, true);
  }

  /**
   * 同じ key の既存の待機者を timeout と同じ扱いで解放する。Stop hook は毎ターン走るので、
   * 解放しないと同じセッションの待機が積み上がる
   */
  releasePreviousWaiters(key: string): void {
    this.settle(key, false);
  }

  waiterCount(key: string): number {
    return this.waiters.get(key)?.size ?? 0;
  }

  /** シグナル受信で true、timeout / abort / 解放で false */
  wait(key: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const set = this.waiters.get(key) ?? new Set<(signalled: boolean) => void>();
      this.waiters.set(key, set);
      let done = false;
      const finish = (signalled: boolean): void => {
        if (done) return;
        done = true;
        set.delete(finish);
        if (set.size === 0) this.waiters.delete(key);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(signalled);
      };
      const onAbort = (): void => finish(false);
      set.add(finish);
      const timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener("abort", onAbort);
      if (signal?.aborted) onAbort();
    });
  }

  private settle(key: string, signalled: boolean): void {
    const set = this.waiters.get(key);
    if (set == null) return;
    for (const finish of [...set]) finish(signalled);
  }
}

export const feedbackKey = (sessionId: string): string => `feedback:${sessionId}`;
