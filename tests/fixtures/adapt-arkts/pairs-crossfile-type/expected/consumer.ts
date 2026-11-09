// 自造 fixture：import type 且全部用法都是类型位置 -> 改名（含 import 说明符）
import type { ToneValue } from "./tone.ts";

export const typed: ToneValue = "A";

export function pick(value: ToneValue): ToneValue {
  return value;
}
