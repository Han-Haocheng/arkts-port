/**
 * TS 侧真值 harness 示例（templates/kotlin-harness/harness.example.ts），与 harness.kt 的场景/编码完全一致。
 * 运行：node templates/kotlin-harness/harness.example.ts
 *
 * 编码约定（与 Kotlin 侧一致）：
 *   Long   → { kind: 'i64', value: '<十进制字符串>' }（BigInt）
 *   Float  → { kind: 'f32', bits: '<uint32 raw bits 十进制>' }
 *   Double → { kind: 'f64', bits: '<uint64 raw bits 十进制>' }
 *   Int    → 普通 JSON 数字；String/Boolean/数组/对象 → 原生 JSON（对象键顺次插入，保持固定顺序）
 */

function f32(value) {
  const view = new Uint32Array(new Float32Array([value]).buffer);
  return { kind: 'f32', bits: String(view[0]) };
}

function f64(value) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  return { kind: 'f64', bits: view.getBigUint64(0).toString() };
}

function i64(value) {
  return { kind: 'i64', value: value.toString() };
}

/** Kotlin round() 语义：ties-to-even（JS Math.round 是 ties-to-+infinity，两者不能混用）。 */
function roundHalfEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function halfEven(x) {
  return BigInt(roundHalfEven(x));
}

/** Kotlin Math.round = ties-to-+infinity。 */
function halfUp(x) {
  return BigInt(Math.round(x));
}

const CHARS_PER_PAGE = 800;
const SCALE = Math.fround(1.1);

function estimate(chapterChars, charsPerPage, scale) {
  const ratio = Number(chapterChars) / charsPerPage;
  const scaled = Math.fround(Math.fround(ratio) * scale);
  const pages = BigInt(roundHalfEven(ratio * scale));
  return { pages, scaled, ratio };
}

function main() {
  const store = new Map([
    ['1', 12000n],
    ['2', 0n],
    ['3', 123456789012n],
  ]);
  store.set('4', 7000n);
  store.delete('3');

  const scenarios = [];
  for (const id of [1n, 2n, 3n, 4n]) {
    const chars = store.get(id.toString()) ?? 0n;
    const est = estimate(chars, CHARS_PER_PAGE, SCALE);
    scenarios.push({
      chapterId: i64(id),
      chars: i64(chars),
      pages: i64(est.pages),
      scaled: f32(est.scaled),
      ratio: f64(est.ratio),
      title: '第' + id + '章',
      empty: chars === 0n,
    });
  }

  const rounding = [0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5].map((x) => ({
    x: f64(x),
    halfEven: i64(halfEven(x)),
    halfUp: i64(halfUp(x)),
  }));

  const payload = {
    scenarios,
    rounding,
    fakeSize: store.size,
    labels: ['alpha', 'b"eta', 'line\nbreak'],
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

main();