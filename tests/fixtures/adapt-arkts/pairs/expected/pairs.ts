// 自造 fixture：规则 3（同名 type + as const；联合类型 + 对象类型别名 + 值访问）

export type GammaAlignValue = "START" | "CENTER";

/** GammaAlign 常量的声明类型：ArkTS 不接受 as const，改为显式 interface。 */
export interface GammaAlignMap {
  readonly START: GammaAlignValue;
  readonly CENTER: GammaAlignValue;
}

export const GammaAlign: GammaAlignMap = {
  START: "START",
  CENTER: "CENTER",
};

/** 对象类型别名的同名常量：类型要变成 interface。 */
export interface GammaVisualValue {
  readonly name: "TEXT" | "ICON";
  readonly weight: number;
}

/** GammaVisual 常量的声明类型：ArkTS 不接受 as const，改为显式 interface。 */
export interface GammaVisualMap {
  readonly TEXT: GammaVisualValue;
  readonly ICON: GammaVisualValue;
}

export const GammaVisual: GammaVisualMap = {
  TEXT: { name: "TEXT", weight: 1 },
  ICON: { name: "ICON", weight: 2 },
};

/** GammaLabel 的构造参数。 */
export interface GammaLabelOptions {
  text: string;
  align?: GammaAlignValue;
  visual?: GammaVisualValue;
}

export class GammaLabel {
  readonly text: string;
  readonly align: GammaAlignValue;
  readonly visual: GammaVisualValue;
  readonly fallback: GammaAlignValue;

  constructor(options: GammaLabelOptions) {
    this.text = options.text;
    this.align = options.align ?? GammaAlign.CENTER;
    this.visual = options.visual ?? GammaVisual.TEXT;
    this.fallback = GammaAlign.START;
  }
}
