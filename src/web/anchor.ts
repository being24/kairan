import { SOURCE_LINES_ATTR } from "../shared/consts.ts";
import type { CommentAnchor, LineRange } from "../shared/types.ts";

/** 引用に添える前後文脈の長さ */
const CONTEXT_LENGTH = 30;

/**
 * コメントの引用として保存できる最大長。デーモン側の anchor スキーマと揃える
 * （超えたまま送ると 400 になり、入力したコメントが黙って消える）
 */
export const MAX_QUOTE_LENGTH = 5000;

/** 選択範囲を「引用 + 前後文脈」に変換する。root は本文のルート要素 */
export function computeAnchor(root: Node, range: Range): CommentAnchor {
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const after = range.cloneRange();
  after.selectNodeContents(root);
  after.setStart(range.endContainer, range.endOffset);
  return {
    exact: range.toString(),
    prefix: before.toString().slice(-CONTEXT_LENGTH),
    suffix: after.toString().slice(0, CONTEXT_LENGTH),
  };
}

/** 選択の端がある位置。lines は最も内側のブロックの属性値、codeLineIndex はコードブロック内の何行目か */
export interface LinePosition {
  lines: string;
  codeLineIndex: number | null;
}

function parseLines(value: string): LineRange | null {
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (match == null) return null;
  return { start: Number(match[1]), end: Number(match[2]) };
}

/** 選択の最初と最後の位置から、ソースの行範囲を求める */
export function lineRangeOf(
  first: LinePosition | null,
  last: LinePosition | null,
): LineRange | null {
  if (first == null || last == null) return null;
  const firstBlock = parseLines(first.lines);
  const lastBlock = parseLines(last.lines);
  if (firstBlock == null || lastBlock == null) return null;
  // コードブロックの1行目は開き fence なので、コードの行は次の行から始まる
  const start =
    first.codeLineIndex == null ? firstBlock.start : firstBlock.start + 1 + first.codeLineIndex;
  const end = last.codeLineIndex == null ? lastBlock.end : lastBlock.start + 1 + last.codeLineIndex;
  return { start, end };
}

function linePositionOf(node: Text): LinePosition | null {
  const block = node.parentElement?.closest(`[${SOURCE_LINES_ATTR}]`);
  const lines = block?.getAttribute(SOURCE_LINES_ATTR);
  if (block == null || lines == null) return null;
  const codeLine = node.parentElement?.closest(`pre[${SOURCE_LINES_ATTR}] .line`);
  if (codeLine == null || !block.contains(codeLine)) return { lines, codeLineIndex: null };
  return { lines, codeLineIndex: [...block.querySelectorAll(".line")].indexOf(codeLine) };
}

/**
 * markdown の描画表示での選択範囲を、ソースの行範囲へ落とす。
 * 端は「実際に1文字以上選ばれたテキストノード」で取る。Range の終端は排他的で、
 * 次のブロックの先頭（offset 0）を指すことがあり、そこを含めると1ブロック広がるため
 */
export function markdownLineRange(root: Element, range: Range): LineRange | null {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let first: LinePosition | null = null;
  let last: LinePosition | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!range.intersectsNode(node)) continue;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.data.length;
    if (to <= from) continue;
    // ブロック間の改行（</p>\n<p> の \n）は行を持たない。選択の端に来ても行範囲には数えない
    const position = linePositionOf(node);
    if (position == null) continue;
    first ??= position;
    last = position;
  }
  return lineRangeOf(first, last);
}

function commonSuffixLength(a: string, b: string): number {
  let count = 0;
  while (
    count < a.length &&
    count < b.length &&
    a[a.length - 1 - count] === b[b.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

function commonPrefixLength(a: string, b: string): number {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1;
  return count;
}

/**
 * 保存された引用が本文のどこを指すかを求める。
 *
 * 同じ文言が複数回現れる文書（表・カード・繰り返しのセクション）では出現位置だけでは
 * 決まらないため、全ての出現について前後文脈の一致長を見て最も合うものを選ぶ。
 * 本文が書き換わって引用ごと消えた場合は null（ハイライトを諦める）。
 */
export function resolveQuoteOffsets(
  fullText: string,
  anchor: CommentAnchor,
): { start: number; end: number } | null {
  if (anchor.exact === "") return null;
  let best: { start: number; score: number } | null = null;
  for (let from = 0; ; ) {
    const start = fullText.indexOf(anchor.exact, from);
    if (start < 0) break;
    const end = start + anchor.exact.length;
    const score =
      commonSuffixLength(fullText.slice(0, start), anchor.prefix) +
      commonPrefixLength(fullText.slice(end), anchor.suffix);
    if (best == null || score > best.score) best = { start, score };
    from = start + 1;
  }
  if (best == null) return null;
  return { start: best.start, end: best.start + anchor.exact.length };
}

export interface TextSlice {
  node: Text;
  from: number;
  to: number;
}

/** 文字オフセットの範囲を、実際に囲むべきテキストノードの断片へ落とす */
export function collectTextSlices(root: Element, start: number, end: number): TextSlice[] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const slices: TextSlice[] = [];
  let pos = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const nodeStart = pos;
    const nodeEnd = pos + node.data.length;
    if (nodeEnd > start && nodeStart < end) {
      slices.push({
        node,
        from: Math.max(0, start - nodeStart),
        to: Math.min(node.data.length, end - nodeStart),
      });
    }
    pos = nodeEnd;
    if (pos >= end) break;
  }
  return slices;
}

/**
 * 引用範囲を mark で囲む。囲めた要素を返す（要素境界を跨ぐ選択では複数になる）。
 * mark の見た目とイベントは呼び出し側が付ける（本体画面と文書内で振る舞いが違うため）
 */
export function wrapSlices(slices: TextSlice[], className: string): HTMLElement[] {
  const marks: HTMLElement[] = [];
  for (const slice of slices) {
    const doc = slice.node.ownerDocument;
    const range = doc.createRange();
    range.setStart(slice.node, slice.from);
    range.setEnd(slice.node, slice.to);
    const mark = doc.createElement("mark");
    mark.className = className;
    try {
      range.surroundContents(mark);
      marks.push(mark);
    } catch {
      // 断片は単一のテキストノード内に収めてあるので通常は失敗しない。
      // agent が生成した任意の DOM が相手なので、想定外の失敗でも残りの引用は貼り続ける
    }
  }
  return marks;
}

/** 貼ったハイライトを剥がして元のテキストへ戻す */
export function unwrapMarks(root: Element, className: string): void {
  for (const mark of [...root.querySelectorAll(`mark.${className}`)]) {
    const parent = mark.parentNode;
    if (parent == null) continue;
    while (mark.firstChild != null) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent.normalize();
  }
}
