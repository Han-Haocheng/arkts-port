// 自造 fixture：规则 1 + 规则 2（多行构造器、类 JSDoc、可选字段）

/** AlphaStyle 的构造参数。 */
export interface AlphaStyleOptions {
  colorArgb: number;
  sizePx: number;
  bold?: boolean;
}

/** AlphaStyle 的 copy 补丁（语义等同 Partial<AlphaStyle>，全部字段可选）。 */
export interface AlphaStylePatch {
  colorArgb?: number;
  sizePx?: number;
  bold?: boolean;
}

/** 一段文本的显示样式。 */
export class AlphaStyle {
  readonly colorArgb: number;
  readonly sizePx: number;
  readonly bold: boolean;

  constructor(options: AlphaStyleOptions) {
    this.colorArgb = options.colorArgb;
    this.sizePx = options.sizePx;
    this.bold = options.bold ?? false;
  }

  copy(patch: AlphaStylePatch): AlphaStyle {
    return new AlphaStyle({
      colorArgb: patch.colorArgb ?? this.colorArgb,
      sizePx: patch.sizePx ?? this.sizePx,
      bold: patch.bold ?? this.bold,
    });
  }
}
