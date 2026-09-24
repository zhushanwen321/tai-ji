/**
 * @taiji/core/testing —— 测试工具导出面（[C3] SettingsTransport 桩工厂等测试共用双）。
 *
 * 消费方：core/renderer/ui 三包测试（renderer/ui vitest 的 @taiji/core 前缀 alias 与
 * node_modules exports 两种解析路径都经本 index 命中——故用 index.ts 形态而非直达文件）。
 */
export * from './settings-transport-stub'
export * from './quota-module-stub'
