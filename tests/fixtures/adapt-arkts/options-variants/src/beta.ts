// 自造 fixture：单行构造器 / "} = {}) {" 默认值 / 非导出类 / 连续两个类

/** 单行构造器。 */
export class BetaPoint {
  readonly xPx: number;
  readonly yPx: number;

  constructor(options: { xPx: number; yPx: number }) {
    this.xPx = options.xPx;
    this.yPx = options.yPx;
  }
}

class BetaDefaults {
  readonly widthPx: number;
  readonly heightPx: number;

  constructor(options: {
    widthPx?: number;
    heightPx?: number;
  } = {}) {
    this.widthPx = options.widthPx ?? 0;
    this.heightPx = options.heightPx ?? 0;
  }
}
export class BetaPair {
  readonly left: BetaPoint;
  readonly right: BetaPoint;

  constructor(options: { left: BetaPoint; right: BetaPoint }) {
    this.left = options.left;
    this.right = options.right;
  }
}
