import Shiki from "@shikijs/markdown-it";
import MarkdownIt from "markdown-it";
import { type BundledLanguage, createHighlighter } from "shiki";
import { SOURCE_LINES_ATTR } from "../shared/consts.ts";

// shiki は特殊言語 "text"（プレーン表示）を実行時に受理するが、
// BundledLanguage 型に含まれない型定義の不備があるためここだけ閉じてアサートする
const PLAIN_TEXT_LANGUAGE = "text" as BundledLanguage;

const THEMES = { light: "github-light", dark: "github-dark" } as const;

/**
 * markdown-it の map は [開始行, 終了行) の 0-based。リスト末尾の項目などは後続の空行まで
 * 含むため、末尾の空行は落として返す
 */
function sourceLinesOf(map: [number, number], lines: string[]): string {
  let end = map[1];
  while (end > map[0] + 1 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return `${map[0] + 1}-${end}`;
}

/**
 * markdown → HTML のレンダラーを構築する。shiki のハイライター初期化が
 * 非同期のため factory も async。デーモン起動時に一度だけ呼ぶ。
 */
export async function createMarkdownRenderer(): Promise<(src: string) => string> {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
  });

  md.use(
    await Shiki({
      themes: THEMES,
      fallbackLanguage: PLAIN_TEXT_LANGUAGE,
    }),
  );

  // mermaid はクライアント側でレンダリングするため、shiki に渡さず素通しする。
  // fence ルールのラップは Shiki プラグイン適用後に行う必要がある（先に intercept するため）
  const defaultFence = md.renderer.rules.fence?.bind(md.renderer.rules);
  const renderFence: NonNullable<typeof defaultFence> = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token != null && token.info.trim() === "mermaid") {
      return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`;
    }
    if (defaultFence != null) return defaultFence(tokens, idx, options, env, self);
    return self.renderToken(tokens, idx, options);
  };
  // shiki と mermaid の fence 出力は token の attrs を反映しないため、出力の <pre> へ直接差し込む
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const html = renderFence(tokens, idx, options, env, self);
    const sourceLines = tokens[idx]?.attrGet(SOURCE_LINES_ATTR);
    if (sourceLines == null) return html;
    return html.replace(/^<pre\b/, `<pre ${SOURCE_LINES_ATTR}="${sourceLines}"`);
  };

  md.core.ruler.push("source_lines", (state) => {
    const lines = state.src.split("\n");
    for (const token of state.tokens) {
      if (token.block && token.map != null && token.nesting >= 0) {
        token.attrSet(SOURCE_LINES_ATTR, sourceLinesOf(token.map, lines));
      }
    }
  });

  return (src: string) => md.render(src);
}

/**
 * LaTeX はソースのまま行番号つきで見せる（組版しない）。
 * markdown のコードブロックと同じ `<pre data-kairan-lines>` + `.line` の形で出すことで、
 * 選択コメントの行範囲をクライアントが同じ計算で求められる
 */
export async function createLatexSourceRenderer(): Promise<(src: string) => string> {
  const highlighter = await createHighlighter({
    themes: Object.values(THEMES),
    langs: ["latex"],
  });
  return (src: string) => {
    const html = highlighter.codeToHtml(src, { lang: "latex", themes: THEMES });
    // 開始行を 0（開き fence の位置）とすることで、コードブロックと同じ「開始行+1+行番号」が
    // そのまま文書の 1-based の行番号になる
    const lineCount = src.split("\n").length;
    return html.replace(/^<pre\b/, `<pre ${SOURCE_LINES_ATTR}="0-${lineCount}"`);
  };
}
