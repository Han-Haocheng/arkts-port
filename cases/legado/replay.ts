import {
  ReaderPaginator,
  ReaderPaginationConfig,
  ReaderTextAlignment,
  ReaderMeasuredBlockInlineParagraph,
  ReaderMeasuredInlineItemText,
  ReaderMeasuredBlockBlankLine,
} from './ts/layout/ReaderPaginator.ts';
import { ReaderTextStyle } from './ts/model/ReaderPage.ts';

const style = new ReaderTextStyle({ colorArgb: 0xff111111 | 0, fontSizePx: 10 });

function textBlock(
  text: string,
  widths: number[],
  position = 0,
  indent = 0,
  alignment: ReaderTextAlignment = ReaderTextAlignment.START,
  lineHeightPx = 20,
  letterSpacingPx: number | null = null,
): ReaderMeasuredBlockInlineParagraph {
  let offset = 0;
  const items: ReaderMeasuredInlineItemText[] = [];
  for (let i = 0; i < text.length; i++) {
    items.push(new ReaderMeasuredInlineItemText({
      value: text.charAt(i),
      widthPx: widths[i],
      style,
      chapterPosition: position + offset,
    }));
    offset += 1;
  }
  return new ReaderMeasuredBlockInlineParagraph({
    items,
    indentCharacters: indent,
    alignment,
    lineHeightPx,
    baselineOffsetPx: 15,
    baseTextSizePx: 10,
    letterSpacingPx,
  });
}

function uniform(text: string, width = 20): number[] {
  return Array.from({ length: text.length }, () => width);
}

function config(opts: {
  chapterIndex?: number; viewportWidthPx?: number; viewportHeightPx?: number;
  paddingBottomPx?: number; paragraphSpacingPx?: number; columnCount?: number;
} = {}): ReaderPaginationConfig {
  return new ReaderPaginationConfig({
    chapterIndex: opts.chapterIndex ?? 0,
    chapterTitle: '标题',
    viewportWidthPx: opts.viewportWidthPx ?? 40,
    viewportHeightPx: opts.viewportHeightPx ?? 45,
    paddingLeftPx: 0,
    paddingTopPx: 0,
    paddingRightPx: 0,
    paddingBottomPx: opts.paddingBottomPx ?? 5,
    lineHeightPx: 20,
    baselineOffsetPx: 15,
    paragraphSpacingPx: opts.paragraphSpacingPx ?? 0,
    columnCount: opts.columnCount ?? 1,
  });
}

function run(name: string, blocks: unknown[], cfg: ReaderPaginationConfig): unknown {
  const pages = ReaderPaginator.paginateBlocks(blocks as never, cfg);
  return {
    scenario: name,
    pageCount: pages.length,
    pages: pages.map((p) => ({
      pageIndex: p.id.pageIndex,
      text: p.text,
      elements: p.elements.length,
      heightPx: p.heightPx,
      scrollExtentPx: p.scrollExtentPx,
    })),
  };
}

const out: unknown[] = [];

out.push(run('s1_cn_basic', [textBlock('一二三四五六七八九十', uniform('一二三四五六七八九十'))], config()));

const s2 = '天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。';
out.push(run('s2_cn_punct', [textBlock(s2, uniform(s2))], config()));

const s3 = 'the quick brown fox jumps over lazy dog';
const w3 = Array.from(s3, (c) => (c === ' ' ? 5 : 8));
out.push(run('s3_en_words', [textBlock(s3, w3)], config()));

const p4 = '第一段文字内容比较长一些';
out.push(run('s4_para_spacing', [
  textBlock(p4, uniform(p4), 0),
  textBlock(p4, uniform(p4), p4.length),
], config({ paragraphSpacingPx: 6 })));

const p5 = '缩进测试文字内容一二三四五六';
out.push(run('s5_indent', [textBlock(p5, uniform(p5), 0, 2)], config()));

const p6 = '居中对齐的文字内容';
out.push(run('s6_center', [textBlock(p6, uniform(p6), 0, 0, ReaderTextAlignment.CENTER)], config()));

const p7 = '双栏排版测试文字内容一二三四五六七八';
out.push(run('s7_columns2', [textBlock(p7, uniform(p7))], config({ viewportWidthPx: 80, columnCount: 2 })));

const p8 = '字间距测试文字内容';
out.push(run('s8_letter_spacing', [textBlock(p8, uniform(p8), 0, 0, ReaderTextAlignment.START, 20, 1.5)], config()));

const p9 = '块一文字';
out.push(run('s9_blocks', [
  textBlock(p9, uniform(p9), 0),
  new ReaderMeasuredBlockBlankLine({ chapterPosition: p9.length, lineHeightPx: 20, lineSpacingMultiplier: 1 }),
  textBlock(p9, uniform(p9), p9.length + 1),
], config()));

const p10 = '一二三四五六七八';
out.push(run('s10_exact_fit', [textBlock(p10, uniform(p10))], config()));


const alphabet = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏';
function stressText(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet.charAt(i % alphabet.length);
  return s;
}
function stressWidths(t: string): number[] {
  return Array.from({ length: t.length }, (_, i) => 8 + ((i * 37) % 13));
}
function bigConfig(w: number, h: number, lh: number, cols: number, pad: number): ReaderPaginationConfig {
  return new ReaderPaginationConfig({
    chapterIndex: 1,
    chapterTitle: '压力测试章',
    viewportWidthPx: w,
    viewportHeightPx: h,
    paddingLeftPx: pad,
    paddingTopPx: pad,
    paddingRightPx: pad,
    paddingBottomPx: pad,
    lineHeightPx: lh,
    baselineOffsetPx: lh * 0.8,
    paragraphSpacingPx: 4,
    columnCount: cols,
  });
}
const big = stressText(2000);
const bigW = stressWidths(big);
out.push(run('s11_stress_phone', [textBlock(big, bigW)], bigConfig(360, 640, 30, 1, 20)));
out.push(run('s12_stress_pad', [textBlock(big, bigW)], bigConfig(1080, 2400, 56, 1, 40)));
out.push(run('s13_stress_2col', [textBlock(big, bigW)], bigConfig(800, 1200, 40, 2, 24)));
out.push(run('s14_stress_tiny', [textBlock(big, bigW)], bigConfig(200, 300, 24, 1, 10)));
const paras: unknown[] = [];
for (let idx = 0; idx < 12; idx++) {
  const t = stressText(180);
  paras.push(textBlock(t, stressWidths(t), idx * 181));
}
out.push(run('s15_stress_paras', paras, bigConfig(360, 640, 30, 1, 20)));
let punctText = '';
const base = stressText(600);
for (let i = 0; i < base.length; i += 7) punctText += base.slice(i, i + 7) + '，。';
out.push(run('s16_stress_punct', [textBlock(punctText, stressWidths(punctText))], bigConfig(360, 640, 30, 1, 20)));

console.log(JSON.stringify(out));
