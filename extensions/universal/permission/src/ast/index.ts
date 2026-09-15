/**
 * ast 模块 barrel —— 只 re-export 公开 API。
 *
 * loader 内部细节（getBashParser / resolveWasmPaths）不泄露给 ast 之外的消费者，
 * 但 loader.test.ts 直接从 "./loader" import 测试（保持公开 API 最小）。
 */
export { analyzeBashStructure } from "./analyzer.js";
