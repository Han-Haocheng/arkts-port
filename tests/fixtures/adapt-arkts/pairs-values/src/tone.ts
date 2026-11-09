// 自造 fixture：规则 3 的值位置不能被改名（P0 回归：Node 不能 ReferenceError）
export type Tone = "A" | "B";

export const Tone = {
  A: "A",
  B: "B",
} as const;

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
export const typed: Tone = "A";
export function viaParam(value: Tone): Tone {
  return value;
}
export const union: Tone | null = null;
export const generic: Array<Tone> = [];
export const asserted = "A" as Tone;
