/**
 * 全仓 vitest 防线工厂（taijiTestConfig）——所有 vitest.config.ts 的唯一防线入口。
 *
 * [2026-09-16 prod 数据目录删除事故] 防线从「runtime 包私有」升级为「仓库级强制」：
 * 此前 global-setup（TAIJI_AGENT_DATA_DIR 钉死 tmp + 白名单 fail-fast）与 fs-guard
 * （破坏性 fs 白名单切面）只挂在 packages/runtime 的 vitest 配置里，从其他 cwd 误跑
 * workspace 全仓 vitest 时（如 Gate A 从 packages/shared cwd 触发 workspace-wide mis-run）
 * runtime 配置不加载，双防线整段失效——runtime 测试组按默认推导把数据目录解析到真实
 * ~/.taiji，测试间「清理数据目录」的常规逻辑删光了用户正式版数据。
 *
 * 机制：本仓库各包 vitest.config.ts 一律经本工厂包装（defineConfig 的直接替换），
 * 工厂无条件注入 globalSetup + fs-guard setupFiles（绝对路径，不受各包 root 差异影响），
 * 并保留用户既有配置（reporters/include/alias/projects 等原样 merge，用户同名字段
 * 按数组追加不覆盖）。「漏挂」由 scripts/check-vitest-guard.mjs 机器守卫拦截
 * （pre-commit 按路径触发 + ci.yml invariants），禁止手写 defineConfig 绕过。
 *
 * 合并语义：
 * - globalSetup：防线排最前（env 钉死必须早于任何测试进程派生），用户项追后在后。
 * - setupFiles：fs-guard 排最前（先注册 vi.mock 全局切面），用户 setup（如 env 净化）追后。
 * - 其余字段：用户配置原样生效，工厂只增不改。
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type ViteUserConfig } from 'vitest/config'

const GUARD_DIR = fileURLToPath(new URL('.', import.meta.url))
export const GLOBAL_SETUP_PATH = join(GUARD_DIR, 'global-setup.ts')
export const FS_GUARD_PATH = join(GUARD_DIR, 'fs-guard.ts')

export function taijiTestConfig(config: ViteUserConfig = {}): ViteUserConfig {
  const userTest = (config.test ?? {}) as ViteUserConfig['test'] & {
    globalSetup?: string[]
    setupFiles?: string[]
  }
  return defineConfig({
    ...config,
    test: {
      ...userTest,
      globalSetup: [GLOBAL_SETUP_PATH, ...(userTest.globalSetup ?? [])],
      setupFiles: [FS_GUARD_PATH, ...(userTest.setupFiles ?? [])],
    } as ViteUserConfig['test'],
  })
}
