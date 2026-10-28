/**
 * plugin-fs-guard.cjs 的类型声明（tsc 用；运行时消费真实 .cjs）。
 * 见 plugin-fs-guard.cjs 头注释（fs.read-user-data 的路径检查归一 + 代理模块 ESM
 * 源码模板 + CJS 只读代理对象，D3；Node hooks 线程隔离决定 ESM 通道代理以
 * format:'module' 源码在主线程求值，CJS 通道由 initSandbox 直接持有代理对象）。
 */
export const ENV_ALLOWED_MODULES_KEY: string
export const ENV_READ_PATHS_KEY: string
export function configure(options: { readPaths?: readonly unknown[] }): void
export function inlineReadBases(): string[]
export function proxyExportNames(target: 'fs' | 'fs/promises'): string[]
export function buildProxyModuleSource(target: 'fs' | 'fs/promises'): string
export function buildProxyObject(target: 'fs' | 'fs/promises', realFs: typeof import('node:fs')): Record<string, unknown>
export function parseStringArrayEnv(raw: unknown): string[]

declare const pluginFsGuard: {
  ENV_ALLOWED_MODULES_KEY: string
  ENV_READ_PATHS_KEY: string
  configure(options: { readPaths?: readonly unknown[] }): void
  inlineReadBases(): string[]
  proxyExportNames(target: 'fs' | 'fs/promises'): string[]
  buildProxyModuleSource(target: 'fs' | 'fs/promises'): string
  buildProxyObject(target: 'fs' | 'fs/promises', realFs: typeof import('node:fs')): Record<string, unknown>
  parseStringArrayEnv(raw: unknown): string[]
}
export default pluginFsGuard
