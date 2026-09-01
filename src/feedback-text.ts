import type { FeedbackBundle } from "./shared/types.ts";

export const FEEDBACK_GUIDANCE =
  "Human feedback received. Address each comment, then respond with reply_comment " +
  "(use commentId; set resolve=true once handled) and publish updated revisions as needed.\n";

const CLIP_NOTICE =
  "\n[kairan] This is a partial excerpt; the rest was left out for length. " +
  "Call list_feedback to retrieve the whole thing.\n";

export function describeBundle(bundle: FeedbackBundle) {
  return {
    reviews: bundle.reviews.map((entry) => ({
      summary: entry.review.summary === "" ? null : entry.review.summary,
      comments: entry.comments.map((comment) => ({
        commentId: comment.id,
        file: comment.fileName,
        rev: comment.rev,
        quote: comment.anchor?.exact ?? null,
        comment: comment.body,
      })),
      replies: entry.replies.map((reply) => ({
        commentId: reply.commentId,
        originalComment: reply.commentBody,
        reply: reply.body,
      })),
    })),
    answeredQuestions: bundle.answeredAsks.map((ask) => ({
      answers: ask.questions.map((question) => {
        const answer = ask.answers?.find((a) => a.questionId === question.id);
        return {
          question: question.question,
          selected: answer?.selected ?? [],
          freeText: answer?.freeText ?? null,
        };
      }),
    })),
  };
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const render = (bundle: FeedbackBundle): string =>
  `${FEEDBACK_GUIDANCE}${JSON.stringify(describeBundle(bundle), null, 2)}\n`;

/**
 * Stop hook の stderr へ載せる本文。上限に収まらない場合は項目単位で落とす
 * （JSON の途中で切ると読めない入力になる）。
 * clipped=true のときは全文が届いていないため、呼び出し側は受領確定してはならない
 */
export function formatFeedbackForHook(
  bundle: FeedbackBundle,
  limitBytes: number,
): { text: string; clipped: boolean } {
  const full = render(bundle);
  if (byteLength(full) <= limitBytes) return { text: full, clipped: false };

  // レビューは list_feedback で取り直せる一方、質問の回答はこのターンで効く判断材料。
  // 落とすならレビューから落とす
  let reviews = bundle.reviews;
  let answeredAsks = bundle.answeredAsks;
  while (reviews.length + answeredAsks.length > 1) {
    if (reviews.length > 0) reviews = reviews.slice(0, -1);
    else answeredAsks = answeredAsks.slice(0, -1);
    const text = `${render({ reviews, answeredAsks })}${CLIP_NOTICE}`;
    if (byteLength(text) <= limitBytes) return { text, clipped: true };
  }
  return { text: `${FEEDBACK_GUIDANCE}${CLIP_NOTICE}`, clipped: true };
}
