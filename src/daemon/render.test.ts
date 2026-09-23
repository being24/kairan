import { beforeAll, describe, expect, test } from "bun:test";
import { createMarkdownRenderer } from "./render.ts";

let render: (src: string) => string;

beforeAll(async () => {
  render = await createMarkdownRenderer();
});

describe("createMarkdownRenderer", () => {
  test("renders headings and paragraphs", () => {
    const html = render("# 見出し\n\n本文です。");
    expect(html).toContain('<h1 data-kairan-lines="1-1">見出し</h1>');
    expect(html).toContain('<p data-kairan-lines="3-3">本文です。</p>');
  });

  test("renders GFM tables", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table ");
    expect(html).toContain("<td>1</td>");
  });

  test("highlights fenced code with shiki", () => {
    const html = render("```typescript\nconst x: number = 1;\n```");
    expect(html).toContain("shiki");
    expect(html).toContain("const");
  });

  test("mermaid fence becomes a pre.mermaid block, not highlighted code", () => {
    const html = render("```mermaid\ngraph TD;\nA-->B;\n```");
    expect(html).toContain('class="mermaid">');
    expect(html).toContain("A--&gt;B;");
    expect(html).not.toContain("shiki");
  });

  test("unknown language does not throw", () => {
    const html = render("```nosuchlang\nhello\n```");
    expect(html).toContain("hello");
  });

  test("raw HTML in markdown passes through", () => {
    const html = render('before\n\n<div class="custom">inner</div>\n\nafter');
    expect(html).toContain('<div class="custom">inner</div>');
  });

  test("blocks carry their 1-based source line range", () => {
    const html = render("段落の1行目\n2行目\n\n- a\n- b\n\n| x |\n|---|\n| 1 |");
    expect(html).toContain('<p data-kairan-lines="1-2">');
    expect(html).toContain('<li data-kairan-lines="5-5">b</li>');
    expect(html).toContain('<tr data-kairan-lines="9-9">');
  });

  test("highlighted fence and mermaid fence carry their source line range", () => {
    const html = render("intro\n\n```ts\nconst a = 1;\n```\n\n```mermaid\ngraph TD;\n```");
    expect(html).toContain('<pre data-kairan-lines="3-5" class="shiki');
    expect(html).toContain('<pre data-kairan-lines="7-9" class="mermaid">');
  });

  test("empty string renders to empty output", () => {
    expect(render("").trim()).toBe("");
  });
});
