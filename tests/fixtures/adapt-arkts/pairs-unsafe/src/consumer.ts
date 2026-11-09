// 自造 fixture：通过 re-export 拿到类型，引用不可安全改名

import type { DeltaMode } from "./reexport.ts";

export function pickMode(raw: DeltaMode): DeltaMode {
  return raw === "A" ? "A" : "B";
}
