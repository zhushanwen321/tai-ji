// P0 coexistence spike 方案 B 实证：独立 renderer 入口占位。
// 纯 TS 最小入口（不引 vue / 现有 src 代码），仅证明独立入口可构建 +
// 产物可被 main-new.ts 的 loadFile 指向。生产新壳入口在 P3 逐域绞杀时设计。
const app = document.getElementById('app')
if (app) {
  app.textContent = 'P0 spike — dual entry placeholder'
}
