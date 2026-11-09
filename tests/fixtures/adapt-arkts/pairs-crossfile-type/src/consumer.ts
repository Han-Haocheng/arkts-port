// 自造 fixture：import type 且全部用法都是类型位置 -> 改名（含 import 说明符）
import type { Tone } from "./tone.ts";

export const typed: Tone = "A";

export function pick(value: Tone): Tone {
  return value;
}
