// 自造 fixture：值 import 无法安全改名，这一对必须原样保留并上报 crossfile-type-ref
export type Tone = "A" | "B";

export const Tone = {
  A: "A",
  B: "B",
} as const;
