// 自造 fixture：跨文件 import type 的类型引用要同步改名
export type Tone = "A" | "B";

export const Tone = {
  A: "A",
  B: "B",
} as const;
