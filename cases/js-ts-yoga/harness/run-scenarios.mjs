/**
 * 用固定场景驱动 yoga：构建树 → calculateLayout → 拍平成标量（harness 与 replay 共用）。
 *
 * 输出契约（README §3.1）：[{scenario, results:[{case, value}]}]；
 * case 用节点路径（root / root.0 / root.1，子节点按插入序号），value 四舍五入到 3 位小数。
 */

import { SCENARIOS } from './scenarios.mjs';

const LAYOUT_FIELDS = ['left', 'top', 'width', 'height'];

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function enumOf(mod, group, value) {
  const table = mod[group];
  if (table === undefined || table[value] === undefined) {
    throw new Error('未知枚举值：' + group + '.' + String(value));
  }
  return table[value];
}

const ALIGN_KEYS = new Set(['alignItems', 'alignSelf', 'alignContent']);

function applyStyle(node, mod, style) {
  for (const key of Object.keys(style)) {
    const value = style[key];
    if (key === 'width' && typeof value === 'number') node.setWidth(value);
    else if (key === 'height' && typeof value === 'number') node.setHeight(value);
    else if (key === 'widthPercent') node.setWidthPercent(value);
    else if (key === 'heightPercent') node.setHeightPercent(value);
    else if (key === 'minWidth') node.setMinWidth(value);
    else if (key === 'maxWidth') node.setMaxWidth(value);
    else if (key === 'minHeight') node.setMinHeight(value);
    else if (key === 'maxHeight') node.setMaxHeight(value);
    else if (key === 'flexGrow') node.setFlexGrow(value);
    else if (key === 'flexShrink') node.setFlexShrink(value);
    else if (key === 'flexBasis') node.setFlexBasis(value);
    else if (key === 'padding') node.setPadding(enumOf(mod, 'Edge', 'All'), value);
    else if (key === 'margin') node.setMargin(enumOf(mod, 'Edge', 'All'), value);
    else if (key === 'border') node.setBorder(enumOf(mod, 'Edge', 'All'), value);
    else if (key === 'gap') node.setGap(enumOf(mod, 'Gutter', 'All'), value);
    else if (key === 'flexDirection') node.setFlexDirection(enumOf(mod, 'FlexDirection', value));
    else if (key === 'justifyContent') node.setJustifyContent(enumOf(mod, 'Justify', value));
    else if (key === 'display') node.setDisplay(enumOf(mod, 'Display', value));
    else if (ALIGN_KEYS.has(key)) {
      if (key === 'alignItems') node.setAlignItems(enumOf(mod, 'Align', value));
      else if (key === 'alignSelf') node.setAlignSelf(enumOf(mod, 'Align', value));
      else node.setAlignContent(enumOf(mod, 'Align', value));
    } else if (key === 'position') {
      node.setPositionType(enumOf(mod, 'PositionType', value.type));
      if (value.left !== undefined) node.setPosition(enumOf(mod, 'Edge', 'Left'), value.left);
      if (value.top !== undefined) node.setPosition(enumOf(mod, 'Edge', 'Top'), value.top);
    } else {
      throw new Error('未知样式键：' + key);
    }
  }
}

/** 深度优先建立节点；path 是报告里的稳定 case 前缀（root / root.0 / root.0.1 …）。 */
function buildNode(yoga, mod, spec, path, nodes) {
  const node = yoga.Node.create();
  applyStyle(node, mod, spec.style === undefined ? {} : spec.style);
  nodes.push({ path, node });
  const children = spec.children === undefined ? [] : spec.children;
  for (let index = 0; index < children.length; index++) {
    const child = buildNode(yoga, mod, children[index], path + '.' + index, nodes);
    node.insertChild(child, index);
  }
  return node;
}

export function runScenarios(yoga) {
  const mod = yoga.mod;
  return SCENARIOS.map((entry) => {
    const nodes = [];
    const root = buildNode(yoga, mod, entry.root, 'root', nodes);
    root.calculateLayout(undefined, undefined);
    const results = [];
    for (const item of nodes) {
      const layout = item.node.getComputedLayout();
      for (const field of LAYOUT_FIELDS) {
        results.push({ case: item.path + '.' + field, value: round3(layout[field]) });
      }
    }
    return { scenario: entry.scenario, results };
  });
}
