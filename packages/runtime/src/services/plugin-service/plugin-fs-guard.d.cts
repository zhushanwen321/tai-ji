/**
 * plugin-fs-guard.cjs 的类型声明（tsc 用；运行时消费真实 .cjs）。
 * 见 plugin-fs-guard.cjs 头注释（fs.read-user-data 的路径检查归一 + 代理模块 ESM
 * 源码模板，D3；Node hooks 线程隔离决定代理以 format:'module' 源码在主线程求值）。
 * coverage-file-gate-exempt: 纯类型声明文件（tsc 消费，无运行时实体，vitest 无法加载
 * 产生 lcov）——运行时载体是同名 .cjs，其路径检查与代理模板由 plugin-perm-fixtures
 * 族测试覆盖
 */
export const ENV_ALLOWED_MODULES_KEY: string
export const ENV_READ_PATHS_KEY: string
export function configure(options: { readPaths?: readonly unknown[] }): void
export function inlineReadBases(): string[]
export function proxyExportNames(target: 'fs' | 'fs/promises'): string[]
export function buildProxyModuleSource(target: 'fs' | 'fs/promises'): string
export function parseStringArrayEnv(raw: unknown): string[]

declare const pluginFsGuard: {
  ENV_ALLOWED_MODULES_KEY: string
  ENV_READ_PATHS_KEY: string
  configure(options: { readPaths?: readonly unknown[] }): void
  inlineReadBases(): string[]
  proxyExportNames(target: 'fs' | 'fs/promises'): string[]
  buildProxyModuleSource(target: 'fs' | 'fs/promises'): string
  parseStringArrayEnv(raw: unknown): string[]
}
export default pluginFsGuard
