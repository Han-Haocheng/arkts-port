// 自造 fixture：规则 3（同名 type + as const；联合类型 + 对象类型别名 + 值访问）

export type GammaAlign = "START" | "CENTER";

export const GammaAlign = {
  START: "START",
  CENTER: "CENTER",
} as const;

/** 对象类型别名的同名常量：类型要变成 interface。 */
export type GammaVisual = {
  readonly name: "TEXT" | "ICON";
  readonly weight: number;
};

export const GammaVisual = {
  TEXT: { name: "TEXT", weight: 1 },
  ICON: { name: "ICON", weight: 2 },
} as const;

export class GammaLabel {
  readonly text: string;
  readonly align: GammaAlign;
  readonly visual: GammaVisual;
  readonly fallback: GammaAlign;

  constructor(options: {
    text: string;
    align?: GammaAlign;
    visual?: GammaVisual;
  }) {
    this.text = options.text;
    this.align = options.align ?? GammaAlign.CENTER;
    this.visual = options.visual ?? GammaVisual.TEXT;
    this.fallback = GammaAlign.START;
  }
}
