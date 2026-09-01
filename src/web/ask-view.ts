import type { Ask } from "../shared/types.ts";

/**
 * その文書の末尾に出す質問。回答済みを先、未回答のフォームを後に並べる。
 *
 * 回答済みをサーバーの一覧ではなくローカルに持った state から取るのは、
 * 回答 API が HTTP レスポンスより先に `ask:changed` を配るため。
 * SSE 側の再取得が先に走っても、この関数が state から組み直せば表示は消えない
 */
export function asksForFile(
  fileId: number,
  openAsks: readonly Ask[],
  answeredAsks: Iterable<Ask>,
): { answered: Ask[]; open: Ask[] } {
  return {
    answered: [...answeredAsks].filter((ask) => ask.fileId === fileId),
    open: openAsks.filter((ask) => ask.fileId === fileId),
  };
}
