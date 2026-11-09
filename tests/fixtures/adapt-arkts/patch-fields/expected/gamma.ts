// 自造 fixture：规则 2（无构造参数 -> readonly 实例字段；getter 不计入；static 跳过）

/** GammaRect 的 copy 补丁（语义等同 Partial<GammaRect>，全部字段可选）。 */
export interface GammaRectPatch {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export class GammaRect {
  static readonly ZERO: GammaRect = new GammaRect(0, 0, 0, 0);

  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;

  constructor(left: number, top: number, right: number, bottom: number) {
    this.left = left;
    this.top = top;
    this.right = right;
    this.bottom = bottom;
  }

  get widthPx(): number {
    return this.right - this.left;
  }

  copy(patch: GammaRectPatch): GammaRect {
    return new GammaRect(
      patch.left ?? this.left,
      patch.top ?? this.top,
      patch.right ?? this.right,
      patch.bottom ?? this.bottom,
    );
  }
}

/** GammaMargin 的构造参数。 */
export interface GammaMarginOptions {
  topPx: number;
}

/** 只有构造参数、没有 copy 的类：只生成 Options。 */
export class GammaMargin {
  readonly topPx: number;

  constructor(options: GammaMarginOptions) {
    this.topPx = options.topPx;
  }
}
