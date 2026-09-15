/**
 * plugin-blocked-builtins.cjs 的类型声明（tsc 用；运行时消费真实 .cjs）。
 * 见 plugin-blocked-builtins.cjs 头注释（黑名单 SSOT）。
 */
export const BLOCKED_BUILTINS: readonly string[]

declare const pluginBlockedBuiltins: {
  BLOCKED_BUILTINS: readonly string[]
}
export default pluginBlockedBuiltins
