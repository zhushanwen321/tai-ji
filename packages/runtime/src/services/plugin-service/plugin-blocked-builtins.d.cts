/**
 * plugin-blocked-builtins.cjs 的类型声明（tsc 用；运行时消费真实 .cjs）。
 * 见 plugin-blocked-builtins.cjs 头注释（基线黑名单 + 放行计算 SSOT，D3）。
 * coverage-file-gate-exempt: 纯类型声明文件（tsc 消费，无运行时实体，vitest 无法加载
 * 产生 lcov）——运行时载体是同名 .cjs，其黑名单与放行计算由 plugin-permission 族测试覆盖
 */
export const PERMANENTLY_BLOCKED_BUILTINS: readonly string[]
export const BLOCKED_BUILTINS: readonly string[]
export function computeBlockedBuiltins(allowed: readonly string[] | unknown): readonly string[]

declare const pluginBlockedBuiltins: {
  PERMANENTLY_BLOCKED_BUILTINS: readonly string[]
  BLOCKED_BUILTINS: readonly string[]
  computeBlockedBuiltins(allowed: readonly string[] | unknown): readonly string[]
}
export default pluginBlockedBuiltins
