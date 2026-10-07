/**
 * factory 防线挂载语义自测（Must-Fix E：project 级显式形态曾只挂 fs-guard 单防线）。
 *
 * 三视角：
 * - 构建者白盒：taijiTestConfig / guardProjectSetup 产物字段断言——双防线
 *   （fs-guard + env-purity）同时在场且 fs 在前（env 净化语义基线「测试进程 = 根
 *   进程」要求 env 剥除早于任何用户 setup，顺序锁死）。
 * - 使用者黑盒：本文件自身运行于 vitest.config.ts（经 factory 包装的 worker），
 *   import 链真实（同目录 factory.ts，无 mock）。
 * - 观察者形态：合并语义——用户既有 setupFiles 追加在双防线之后，不被覆盖。
 *
 * scripts/check-vitest-guard.mjs 规则 5 与本文件同语义（helper 形态 / 显式双挂载
 * 形态放行、单 fs 形态违规），静态侧由该脚本守卫，动态形状由本文件锁定。
 */
import { describe, expect, it } from 'vitest'
import { ENV_PURITY_PATH, FS_GUARD_PATH, GLOBAL_SETUP_PATH, guardProjectSetup, taijiTestConfig } from './factory.ts'

describe('taijiTestConfig 双防线挂载（root 级）', () => {
  it('setupFiles 同时含 fs-guard 与 env-purity，且 fs-guard 在前', () => {
    const config = taijiTestConfig({ test: { include: ['x.test.ts'] } })
    const test = config.test as { setupFiles: string[] }
    expect(test.setupFiles).toContain(FS_GUARD_PATH)
    expect(test.setupFiles).toContain(ENV_PURITY_PATH)
    expect(test.setupFiles.indexOf(FS_GUARD_PATH)).toBeLessThan(test.setupFiles.indexOf(ENV_PURITY_PATH))
  })

  it('globalSetup 排最前（env 钉死必须早于测试进程派生）', () => {
    const config = taijiTestConfig({})
    const test = config.test as { globalSetup: string[] }
    expect(test.globalSetup[0]).toBe(GLOBAL_SETUP_PATH)
  })

  it('用户既有 setupFiles 追加在双防线之后（不覆盖工厂防线）', () => {
    const config = taijiTestConfig({ test: { setupFiles: ['./user-setup.ts'] } })
    const test = config.test as { setupFiles: string[] }
    expect(test.setupFiles.indexOf('./user-setup.ts')).toBeGreaterThan(test.setupFiles.indexOf(ENV_PURITY_PATH))
  })
})

describe('guardProjectSetup 双防线挂载（project 级——projects 内不继承 root 级）', () => {
  it('产物 setupFiles 同时含 fs-guard 与 env-purity（Must-Fix E 收紧语义锚）', () => {
    const fragment = guardProjectSetup({ include: ['src/**/*.test.ts'] })
    expect(fragment.setupFiles).toContain(FS_GUARD_PATH)
    expect(fragment.setupFiles).toContain(ENV_PURITY_PATH)
  })

  it('透传其余字段 + 用户 setupFiles 追加在双防线之后', () => {
    const fragment = guardProjectSetup({ name: 'g', include: ['src/**/*.test.ts'], setupFiles: ['./project-setup.ts'] })
    expect(fragment.include).toEqual(['src/**/*.test.ts']) // 其余字段透传
    expect((fragment as { name?: string }).name).toBe('g')
    expect(fragment.setupFiles.indexOf('./project-setup.ts')).toBeGreaterThan(
      fragment.setupFiles.indexOf(FS_GUARD_PATH),
    )
  })
})
