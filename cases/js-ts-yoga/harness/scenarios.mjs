/**
 * yoga 案例的固定场景（规格：cases/js-ts-yoga/README.md §3.2，4 组 / 44 items）。
 *
 * 每个场景是一棵小树；样式用普通对象描述，由 run-scenarios.mjs 映射到 yoga Node 的 setter。
 * 期望值（README §3.2，本机实测）：
 *   s1-basic               root (0,0,100,50)；root.0 (0,0,40,20)
 *   s2-row-center-pad      root (0,0,200,40)；root.0 (70,10,30,10)；root.1 (100,10,30,10)
 *   s3-col-center-gap-margin root (0,0,120,80)；root.0 (40,8,40,10)；root.1 (30,25,60,50)
 *   s4-percent-absolute    root (0,0,200,100)；root.0 (0,0,100,25)；root.1 (10,20,30,30)
 * 最终以 gen-golden 产出的 golden.json 为准（当前实现跑出、两次一致才落盘）。
 */

export const SCENARIOS = [
  {
    scenario: 's1-basic',
    root: {
      style: { width: 100, height: 50 },
      children: [{ style: { width: 40, height: 20 } }],
    },
  },
  {
    scenario: 's2-row-center-pad',
    root: {
      style: { width: 200, height: 40, flexDirection: 'Row', justifyContent: 'Center', padding: 10 },
      children: [
        { style: { width: 30, height: 10 } },
        { style: { width: 30, height: 10 } },
      ],
    },
  },
  {
    scenario: 's3-col-center-gap-margin',
    root: {
      style: { width: 120, height: 80, flexDirection: 'Column', alignItems: 'Center', padding: 5, gap: 4 },
      children: [
        { style: { width: 40, height: 10, margin: 3 } },
        { style: { width: 60, height: 20, flexGrow: 1 } },
      ],
    },
  },
  {
    scenario: 's4-percent-absolute',
    root: {
      style: { width: 200, height: 100 },
      children: [
        { style: { widthPercent: 50, heightPercent: 25 } },
        { style: { position: { type: 'Absolute', left: 10, top: 20 }, width: 30, height: 30 } },
      ],
    },
  },
];
