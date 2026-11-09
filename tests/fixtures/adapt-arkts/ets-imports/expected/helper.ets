// 自造 fixture：被 --ets 重写的依赖

export interface HelperShape {
  readonly name: string;
}

export function helperOne(value: string): string {
  return "1:" + value;
}
