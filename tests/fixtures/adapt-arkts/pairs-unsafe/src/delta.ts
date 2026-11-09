// 自造 fixture：跨文件类型引用无法安全判定时，这一对必须原样保留

export type DeltaMode = "A" | "B";

export const DeltaMode = {
  A: "A",
  B: "B",
} as const;
