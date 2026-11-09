// 自造 fixture：--ets 要去掉相对 import 的 .ts 后缀（含 side-effect / 默认导入）

import { helperOne } from "./helper.ts";
import type { HelperShape } from "./helper.ts";
import "./side-effect.ts";
import helperTwo from "../other/helper2.ts";

export function useAll(shape: HelperShape): string {
  return helperOne(shape.name) + helperTwo(shape.name);
}
