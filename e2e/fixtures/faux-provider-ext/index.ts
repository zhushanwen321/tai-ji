/**
 * e2e real 轨 faux LLM provider 注入壳（re-export，勿在此复刻逻辑）。
 *
 * 真实实现在 packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts（跨进程契约
 * SSOT 的一部分——ScriptedStep 与 equivalence/pi-fixture.ts 同构）。本壳只做 default
 * re-export：runtime 的 TAIJI_EXTENSION_PATHS 通道（extension-service.scanUserExtensions）
 * 要求 extension 是「目录 + isValidPiExtension（package.json 含 pi 字段）」，单文件
 * 不满足；jiti 以本文件位置解析相对 import（repo node_modules 内 pi-ai 与被加载方共享）。
 */
export { default } from '../../../../packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts'
