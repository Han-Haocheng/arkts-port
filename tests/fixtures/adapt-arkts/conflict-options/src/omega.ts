// 自造 fixture：已有同名 interface 时规则 1 必须报错（拒绝覆盖）

export interface OmegaBoxOptions {
  readonly sizePx: number;
}

export class OmegaBox {
  readonly sizePx: number;

  constructor(options: { sizePx: number }) {
    this.sizePx = options.sizePx;
  }
}
