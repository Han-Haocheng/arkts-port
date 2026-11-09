// 自造 fixture：规则 1 + 规则 2（多行构造器、类 JSDoc、可选字段）

/** 一段文本的显示样式。 */
export class AlphaStyle {
  readonly colorArgb: number;
  readonly sizePx: number;
  readonly bold: boolean;

  constructor(options: {
    colorArgb: number;
    sizePx: number;
    bold?: boolean;
  }) {
    this.colorArgb = options.colorArgb;
    this.sizePx = options.sizePx;
    this.bold = options.bold ?? false;
  }

  copy(patch: Partial<AlphaStyle>): AlphaStyle {
    return new AlphaStyle({
      colorArgb: patch.colorArgb ?? this.colorArgb,
      sizePx: patch.sizePx ?? this.sizePx,
      bold: patch.bold ?? this.bold,
    });
  }
}
