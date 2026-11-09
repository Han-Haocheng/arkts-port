// 自造 fixture：必须报告、不自动改的残留

export interface ZetaElement {
  readonly kind: "A" | "B";
}

export type ZetaKind = ZetaElement["kind"];

export type ZetaLoose = Partial<ZetaElement>;

/** globalThis + as unknown + 转换目标的内联对象类型。 */
export function zetaNowNs(): number {
  const host: { now?: () => number } = globalThis as unknown as { now?: () => number };
  const timer = host.now;
  return timer !== undefined ? timer() : Date.now();
}

/** any / unknown。 */
export function zetaAny(value: any): number {
  return value === null ? 0 : 1;
}

export function zetaUnknown(value: unknown): number {
  return value === null ? 0 : 1;
}

/** 类外的内联对象类型参数。 */
export function zetaKey(element: { readonly key: string }): string {
  return element.key;
}

/** copy 的 Partial 不是 Self：只报告。 */
export class ZetaHolder {
  readonly item: ZetaElement;

  constructor(item: ZetaElement) {
    this.item = item;
  }

  copy(patch: Partial<ZetaElement>): ZetaHolder {
    return new ZetaHolder(patch.kind === undefined ? this.item : this.item);
  }
}

/** 构造器内联对象类型里还有嵌套对象：不支持自动抽取。 */
export class ZetaNestedCtor {
  readonly nested: { readonly a: string };

  constructor(options: { nested: { readonly a: string } }) {
    this.nested = options.nested;
  }
}
/** 未配对的 as const（没有同名 type）：只报告。 */
export const ZETA_RAW = { a: 1 } as const;
