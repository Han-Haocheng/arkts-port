// 自造 fixture：规则 3 的值位置不能被改名（P0 回归：Node 不能 ReferenceError）
export type ToneValue = "A" | "B";

/** Tone 常量的声明类型：ArkTS 不接受 as const，改为显式 interface。 */
export interface ToneMap {
  readonly A: ToneValue;
  readonly B: ToneValue;
}

export const Tone: ToneMap = {
  A: "A",
  B: "B",
};

// 值位置：一律保持 Tone
export const alias = Tone;
export const shorthand = { Tone };
export const keyed = { Tone: 1 };
export const member = Tone.A;
export const arg = String(Tone);
export const arrayed = [Tone, Tone];
export function viaReturn(): object {
  return Tone;
}
export const ternary = Math.random() > 0.5 ? Tone : Tone;
export const negated = !Tone;
export const typeofForm = typeof Tone;

// 类型位置：改成 ToneValue
export const typed: ToneValue = "A";
export function viaParam(value: ToneValue): ToneValue {
  return value;
}
export const union: ToneValue | null = null;
export const generic: Array<ToneValue> = [];
export const asserted = "A" as ToneValue;
