import { describe, expect, test } from "bun:test";
import { describeBundle, FEEDBACK_GUIDANCE, formatFeedbackForHook } from "./feedback-text.ts";
import type { FeedbackBundle } from "./shared/types.ts";

function reviewEntry(index: number, body: string): FeedbackBundle["reviews"][number] {
  return {
    review: {
      id: index,
      sessionId: "s1",
      summary: `まとめ${index}`,
      state: "submitted",
      createdAt: 0,
      submittedAt: 1,
    },
    comments: [
      {
        id: index,
        fileId: 1,
        rev: 1,
        anchor: { exact: "ここ", prefix: "", suffix: "" },
        body,
        state: "open",
        createdAt: 0,
        submittedAt: 1,
        resolvedAt: null,
        replies: [],
        fileName: "report.md",
      },
    ],
    replies: [],
  };
}

function answeredAsk(index: number): FeedbackBundle["answeredAsks"][number] {
  return {
    id: index,
    sessionId: "s1",
    fileId: 1,
    status: "answered",
    questions: [
      { id: "q1", question: "どちらにする?", options: [{ label: "案1" }], multiSelect: false },
    ],
    answers: [{ questionId: "q1", selected: ["案1"], freeText: "ついでにこれも" }],
    createdAt: 0,
    answeredAt: 1,
  };
}

describe("describeBundle", () => {
  test("行範囲は 1 行なら単独、複数行なら start-end、無ければ null で返す", () => {
    const withLines = (lines: { start: number; end: number } | null) => {
      const entry = reviewEntry(1, "直して");
      const comment = entry.comments[0];
      if (comment?.anchor == null) throw new Error("fixture must be anchored");
      return { ...entry, comments: [{ ...comment, anchor: { ...comment.anchor, lines } }] };
    };
    const described = describeBundle({
      reviews: [
        withLines({ start: 12, end: 12 }),
        withLines({ start: 3, end: 5 }),
        withLines(null),
      ],
      answeredAsks: [],
    });
    expect(described.reviews.map((r) => r.comments[0]?.lines)).toEqual(["12", "3-5", null]);
  });

  test("空の要約は null にし、回答は質問文と対で並べる", () => {
    const described = describeBundle({
      reviews: [
        {
          ...reviewEntry(1, "直して"),
          review: { ...reviewEntry(1, "直して").review, summary: "" },
        },
      ],
      answeredAsks: [answeredAsk(1)],
    });
    expect(described.reviews[0]?.summary).toBeNull();
    expect(described.answeredQuestions[0]?.answers[0]).toEqual({
      question: "どちらにする?",
      selected: ["案1"],
      freeText: "ついでにこれも",
    });
  });

  test("回答が無い質問は選択なしとして出す", () => {
    const ask = answeredAsk(1);
    const described = describeBundle({ reviews: [], answeredAsks: [{ ...ask, answers: null }] });
    expect(described.answeredQuestions[0]?.answers[0]?.selected).toEqual([]);
    expect(described.answeredQuestions[0]?.answers[0]?.freeText).toBeNull();
  });
});

describe("formatFeedbackForHook", () => {
  test("上限に収まればそのまま全文を返す", () => {
    const result = formatFeedbackForHook(
      { reviews: [reviewEntry(1, "直して")], answeredAsks: [answeredAsk(1)] },
      10_000,
    );
    expect(result.clipped).toBe(false);
    expect(result.text.startsWith(FEEDBACK_GUIDANCE)).toBe(true);
    expect(result.text).toContain("直して");
  });

  test("フィードバックが空でも整形できる", () => {
    const result = formatFeedbackForHook({ reviews: [], answeredAsks: [] }, 10_000);
    expect(result.clipped).toBe(false);
    expect(result.text).toContain('"reviews": []');
  });

  test("上限を超えたらレビューから落とし、回答は残す", () => {
    const bundle: FeedbackBundle = {
      reviews: [reviewEntry(1, "あ".repeat(400)), reviewEntry(2, "い".repeat(400))],
      answeredAsks: [answeredAsk(1)],
    };
    const full = formatFeedbackForHook(bundle, 10_000);
    const limit = full.text.length - 100;

    const result = formatFeedbackForHook(bundle, limit);
    expect(result.clipped).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(limit);
    expect(result.text).toContain("list_feedback");
    expect(result.text).toContain("どちらにする?");
  });

  test("1件でも収まらないなら本文を載せず回収を促す", () => {
    const result = formatFeedbackForHook(
      { reviews: [reviewEntry(1, "あ".repeat(4000))], answeredAsks: [] },
      200,
    );
    expect(result.clipped).toBe(true);
    expect(result.text.startsWith(FEEDBACK_GUIDANCE)).toBe(true);
    expect(result.text).not.toContain('"reviews"');
    expect(result.text).toContain("list_feedback");
  });

  test("上限は文字数で見る（CJK と ASCII で同じ文字数なら同じ結果になる）", () => {
    const limit = formatFeedbackForHook(
      { reviews: [reviewEntry(1, "a".repeat(300))], answeredAsks: [] },
      10_000,
    ).text.length;

    const cjk = formatFeedbackForHook(
      { reviews: [reviewEntry(1, "あ".repeat(300))], answeredAsks: [] },
      limit,
    );
    const ascii = formatFeedbackForHook(
      { reviews: [reviewEntry(1, "a".repeat(300))], answeredAsks: [] },
      limit,
    );
    expect(cjk.clipped).toBe(false);
    expect(ascii.clipped).toBe(false);
  });
});
