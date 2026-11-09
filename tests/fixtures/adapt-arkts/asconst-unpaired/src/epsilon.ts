// 自造 fixture：规则 4（未配对的 as const 只报告，不改内容）

export const EpsilonLevel = {
  LOW: 1,
  HIGH: 2,
} as const;

export const EPSILON_NAME = "epsilon" as const;

export function epsilonFlag(): boolean {
  return ({ enabled: true } as const).enabled;
}
