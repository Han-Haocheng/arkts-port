// 自造 fixture：单行构造器 / "} = {}) {" 默认值 / 非导出类 / 连续两个类

/** BetaPoint 的构造参数。 */
export interface BetaPointOptions {
  xPx: number;
  yPx: number;
}

/** 单行构造器。 */
export class BetaPoint {
  readonly xPx: number;
  readonly yPx: number;

  constructor(options: BetaPointOptions) {
    this.xPx = options.xPx;
    this.yPx = options.yPx;
  }
}

/** BetaDefaults 的构造参数。 */
export interface BetaDefaultsOptions {
  widthPx?: number;
  heightPx?: number;
}

class BetaDefaults {
  readonly widthPx: number;
  readonly heightPx: number;

  constructor(options: BetaDefaultsOptions = {}) {
    this.widthPx = options.widthPx ?? 0;
    this.heightPx = options.heightPx ?? 0;
  }
}

/** BetaPair 的构造参数。 */
export interface BetaPairOptions {
  left: BetaPoint;
  right: BetaPoint;
}

export class BetaPair {
  readonly left: BetaPoint;
  readonly right: BetaPoint;

  constructor(options: BetaPairOptions) {
    this.left = options.left;
    this.right = options.right;
  }
}
