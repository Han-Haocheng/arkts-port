// 自造 fixture：跨文件 import type 的类型引用要同步改名
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
