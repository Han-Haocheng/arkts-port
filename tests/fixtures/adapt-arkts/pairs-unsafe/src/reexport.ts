// 自造 fixture：同名类型被 re-export，codemod 无法安全判定改动范围

export type { DeltaMode } from "./delta.ts";
