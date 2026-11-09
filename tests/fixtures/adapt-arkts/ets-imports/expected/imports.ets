// 自造 fixture：--ets 要去掉相对 import 的 .ts 后缀（含 side-effect / 默认导入）

import { helperOne } from "./helper";
import type { HelperShape } from "./helper";
import "./side-effect";
import helperTwo from "../other/helper2";

export function useAll(shape: HelperShape): string {
  return helperOne(shape.name) + helperTwo(shape.name);
}
