/**
 * RT-8#4 依赖安装假成功修复验证（code-harden 审计批次 2）：
 * `installDependencies` 此前对「package.json 解析失败 / 单个依赖安装失败」两类均静默
 * return（依赖失败仅 warn），调用方（extension-service）按成功登记 → 缺依赖的扩展以
 * 子进程崩溃形式延后暴露。修复 = 失败聚合进返回值 failed[]。
 *
 * 口径（审查 D 订正）：「无 package.json」不是失败类——无该文件即本无依赖，
 * return 是正确 no-op，不进 failed[]。
 *
 * 网络零依赖设计：依赖失败用例全部用非法包名（fetchMetadata 顶部 validateNpmName
 * 白名单先抛，RT-8#3 修复引入），不触达 registry。
 *
 * 运行：cd packages/runtime && npx vitest run test/npm-installer-deps-failed.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installDependencies } from '../src/infra/installers/npm-installer.js'

let projectDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'taiji-deps-failed-'))
})

afterEach(() => {
  try {
    rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch { /* ignore */ }
})

describe('RT-8#4: installDependencies 失败聚合', () => {
  it('无 package.json → 空清单（合法 no-op，防回归：不得进 failed[]）', async () => {
    const result = await installDependencies(projectDir)
    expect(result.failed).toEqual([])
  })

  it('空 dependencies → 空清单', async () => {
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }), 'utf-8')
    const result = await installDependencies(projectDir)
    expect(result.failed).toEqual([])
  })

  it('package.json 解析失败 → failed 含 name="package.json" 与原因（此前静默 return）', async () => {
    writeFileSync(join(projectDir, 'package.json'), '{ not valid json !!', 'utf-8')
    const result = await installDependencies(projectDir)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.name).toBe('package.json')
    expect(result.failed[0]!.error.length).toBeGreaterThan(0)
  })

  it('单个依赖安装失败 → 进 failed[] 且其余依赖继续尝试（此前仅 warn 后吞掉）', async () => {
    // 两个非法包名：均在 fetchMetadata 顶部被 validateNpmName 拒绝（零网络），
    // 逐条进 failed[] 证明 for 循环未被首个失败短路
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
      dependencies: {
        '../evil': '^1.0.0',
        'has space': '^1.0.0',
      },
    }), 'utf-8')

    const result = await installDependencies(projectDir)
    expect(result.failed.map(f => f.name)).toEqual(['../evil', 'has space'])
    expect(result.failed.every(f => f.error.includes('Invalid package name'))).toBe(true)
  })
})
