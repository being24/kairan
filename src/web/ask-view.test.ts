import { describe, expect, test } from "bun:test";
import type { Ask } from "../shared/types.ts";
import { asksForFile } from "./ask-view.ts";

function ask(id: number, fileId: number, status: Ask["status"]): Ask {
  return {
    id,
    sessionId: "s1",
    fileId,
    status,
    questions: [
      { id: "q1", question: "どちらにする?", options: [{ label: "案1" }], multiSelect: false },
    ],
    answers:
      status === "answered" ? [{ questionId: "q1", selected: ["案1"], freeText: null }] : null,
    createdAt: 0,
    answeredAt: status === "answered" ? 1 : null,
  };
}

describe("asksForFile", () => {
  test("別の文書の質問は出さない", () => {
    const shown = asksForFile(1, [ask(10, 2, "open")], []);
    expect(shown.open).toEqual([]);
    expect(shown.answered).toEqual([]);
  });

  test("その文書の未回答フォームを出す", () => {
    const shown = asksForFile(1, [ask(10, 1, "open"), ask(11, 2, "open")], []);
    expect(shown.open.map((a) => a.id)).toEqual([10]);
  });

  test("回答直後に ask:changed が先に届いても回答済み表示は残る", () => {
    const answered = new Map<number, Ask>();
    const openBefore = [ask(10, 1, "open")];

    // SSE が先: 一覧から未回答が消える。まだ回答のレスポンスは返っていない
    const duringRace = asksForFile(1, [], answered.values());
    expect(duringRace.open).toEqual([]);
    expect(duringRace.answered).toEqual([]);

    // レスポンス到着: state に入れば同じ描画経路が回答済み表示を組む
    answered.set(10, ask(10, 1, "answered"));
    const afterResponse = asksForFile(1, [], answered.values());
    expect(afterResponse.answered.map((a) => a.id)).toEqual([10]);
    expect(openBefore.map((a) => a.id)).toEqual([10]);
  });

  test("回答済みの後に新しい質問が来たら両方出す", () => {
    const answered = new Map([[10, ask(10, 1, "answered")]]);
    const shown = asksForFile(1, [ask(11, 1, "open")], answered.values());
    expect(shown.answered.map((a) => a.id)).toEqual([10]);
    expect(shown.open.map((a) => a.id)).toEqual([11]);
  });
});
