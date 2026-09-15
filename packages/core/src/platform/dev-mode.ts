/**
 * Dev-mode 配置端口（core headless 化，audit §15.6）。
 *
 * core 是 headless 包（零 DOM / 零 Vite / 零浏览器 API），不能读 import.meta.env。
 * dev 标志由壳（renderer main.ts）启动时经 provideDevMode 注入；默认 false（core 单测 /
 * 非 Vite 环境不吐 debug 日志）。消费方（chat effects/registry、chat store 诊断日志）
 * 运行时调 isDevMode() 读取，故 provideDevMode 可在 store 实例化前的任意时刻注入。
 *
 * 与 platform/port 的关系：PlatformPort 是「平台能力端口」（storage/ws/ipc，fail-fast）；
 * isDev 是「构建模式标志」，语义上非平台能力，且 debug 日志须无害（不能因未注入抛错），
 * 故独立于此模块，默认 false 而非 fail-fast。
 */

let _isDev = false

/** 壳 bootstrap 时注入 dev 标志（renderer: import.meta.env.DEV）。 */
export function provideDevMode(isDev: boolean): void {
  _isDev = isDev
}

/** 当前是否 dev 模式（未注入恒 false，不抛错——debug 日志须无害）。 */
export function isDevMode(): boolean {
  return _isDev
}

/** 仅测试用：重置为 false（单测隔离，对齐 platform/port __resetPlatformForTesting）。 */
export function __resetDevModeForTesting(): void {
  _isDev = false
}
