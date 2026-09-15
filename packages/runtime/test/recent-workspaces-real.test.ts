/**
 * RecentWorkspacesStore 真实文件系统集成测试（integration real）
 *
 * 覆盖 execution-plan test-matrix 的 NFR 用例：
 * - T1.10: 数据目录与 pi 隔离（getConfigDir 非 ~/.pi/agent）+ 真实文件系统端到端落盘验证
 * - T1.11: atomicWrite 原子性（temp+rename）：崩溃保护 + 正常原子完成
 *
 * 与 recent-workspaces-store.test.ts 的区别：
 * - 本文件用真实文件系统（os.tmpdir() 临时目录）端到端验证落盘与原子性
 * - afterEach 清理临时目录，不污染真实 ~/.taiji
 *
 * Mock 策略（T1.11 场景 A 需要）：
 * - 仅 override writeFileSync（默认委托真实实现，对其它用例透明）
 * - renameSync / existsSync / readFileSync / mkdirSync 等全部保持真实（importActual 展开）
 * - 注意：不用 vi.spyOn(fs, 'writeFileSync') —— Vitest ESM 下 node:fs 命名空间不可配置
 *   （"Cannot spy on export ... Module namespace is not configurable in ESM"），
 *   故按需求「spy/mock writeFileSync」的 mock 路径实现。
 *
 * 测试框架：vitest（禁止 node:test / tsx --test）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// 仅 mock writeFileSync（默认委托真实实现），其余 fs 导出保持真实
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
  }
})

import * as fs from 'node:fs'
import { join } from 'node:path'
import * as os from 'node:os'

import { getConfigDir } from '../src/infra/pi/pi-paths.js'
import { atomicWrite } from '../src/utils/fs-utils.js'
import { RecentWorkspacesStore } from '../src/services/workspace/recent-workspaces-store.js'

const writeFileSyncMock = vi.mocked(fs.writeFileSync)

describe('T1.10 (integration real): 数据目录与 pi 隔离 + 真实落盘', () => {
  let tmpConfigDir: string

  afterEach(() => {
    if (tmpConfigDir) {
      fs.rmSync(tmpConfigDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
    // writeFileSync 默认委托真实实现；mockClear 只清调用记录，不动默认实现
    writeFileSyncMock.mockClear()
  })

  it('getConfigDir() 返回值不含 pi 数据目录路径（.pi/agent 或 pi/agent）', () => {
    const dir = getConfigDir()
    // NFR 核心：taiji 数据根与系统 pi 的 ~/.pi/agent 隔离（ADR-0009）。
    // 注意：getPiAgentDir() 返回 <dataDir>/pi/agent 含该子串是正常的，
    // 这里断言的是数据根 getConfigDir() 本身不是 pi 数据目录。
    expect(dir).not.toContain('.pi/agent')
    expect(dir).not.toContain('pi/agent')
  })

  it('真实文件系统：record + flushAll → recent-workspaces.json 落盘且内容正确', () => {
    tmpConfigDir = fs.mkdtempSync(join(os.tmpdir(), 'rws-real-t110-'))
    const cwd = join(tmpConfigDir, 'project-alpha')

    // 用真实 configDir 构造 store；writeFileSync 默认委托真实实现 → 真实落盘
    const store = new RecentWorkspacesStore(tmpConfigDir)
    store.record(cwd)
    store.flushAll() // 触发真实 atomicWrite（temp + rename）

    const filePath = join(tmpConfigDir, 'recent-workspaces.json')
    // 端到端：真实文件存在
    expect(fs.existsSync(filePath)).toBe(true)

    // 读回内容，解析后含刚 record 的 cwd（端到端验证落盘正确）
    const raw = fs.readFileSync(filePath, 'utf-8')
    const records = JSON.parse(raw) as Array<{ cwd: string }>
    expect(records.some(r => r.cwd === cwd)).toBe(true)
  })
})

describe('E1/E2 (W0/W1 integration real): persist 失败不 crash + dirname 落盘', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      // 只读目录无法 rmSync，先恢复权限
      try { fs.chmodSync(tmpDir, 0o755) } catch { /* 已删或权限已恢复 */ }
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  // E1: W0 端到端 — 只读目录（模拟盘满/权限）下 flushAll 不 crash + console.error
  it('E1: 只读目录下 record + flushAll 不抛异常且记 console.error（W0 真实集成）', () => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'rws-real-e1-'))
    const cwd = join(tmpDir, 'project')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const store = new RecentWorkspacesStore(tmpDir)
    store.record(cwd)

    // 先正常 flush 一次创建目录+文件（后续 chmod 只读后 atomicWrite 走 writeFileSync(tmp) 失败）
    store.flushAll()
    errorSpy.mockClear()

    // 设为只读，模拟盘满/权限不足
    fs.chmodSync(tmpDir, 0o444)

    // 再 record 新 cwd + flushAll → atomicWrite 内 writeFileSync(tmp) 遭 EACCES 失败
    store.record(join(tmpDir, 'project-2'))
    expect(() => store.flushAll()).not.toThrow()
    // W0：console.error 记录了 flush 失败（非 crash）
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()

    // cleanup：恢复权限 + flushAll 成功清 dirty，避免 W0 catch 内 scheduleFlush 的
    // 重试 timer 在测试结束后泄漏到下一个 it（pending timer 到点时 dirty 为空 → no-op）
    fs.chmodSync(tmpDir, 0o755)
    store.flushAll()
  })

  // E2: W1 端到端 — dirname 路径推导在真实文件系统正常落盘（回归保护）
  it('E2: record + flushAll 落盘到 configDir/recent-workspaces.json（dirname 路径推导验证）', () => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'rws-real-e2-'))
    const cwd = join(tmpDir, 'project-dn')

    const store = new RecentWorkspacesStore(tmpDir)
    store.record(cwd)
    store.flushAll()

    const filePath = join(tmpDir, 'recent-workspaces.json')
    expect(fs.existsSync(filePath)).toBe(true)
    const raw = fs.readFileSync(filePath, 'utf-8')
    const records = JSON.parse(raw) as Array<{ cwd: string }>
    expect(records.some(r => r.cwd === cwd)).toBe(true)
  })
})

describe('T1.11 (integration real): atomicWrite temp+rename 原子性', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
    // 场景 A 用 mockImplementationOnce，调用后自动回退到默认（委托真实实现）；
    // 这里只清调用记录。不动默认实现。
    writeFileSyncMock.mockClear()
  })

  it('场景 A（崩溃保护）：写 tmp 阶段抛错 → 主文件不被污染', () => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'rws-real-t111a-'))
    const filePath = join(tmpDir, 'target.json')
    const payload = '{"version":1}'

    // 只让 writeFileSync（写 tmp 阶段）抛错；
    // renameSync / existsSync 保持真实（vi.mock 工厂里 importActual 展开）。
    writeFileSyncMock.mockImplementationOnce(() => {
      throw new Error('simulated crash mid-write')
    })

    // atomicWrite 在写 tmp 时抛错（rename 阶段不会到达）
    expect(() => atomicWrite(filePath, payload)).toThrow('simulated crash mid-write')

    // NFR 核心：主文件不存在（半成品没有污染主文件）。
    // 残留 tmp 是否存在不强制（这里 writeFileSync 抛错，未真实落盘 tmp）。
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('场景 B（正常原子完成）：atomicWrite 后主文件内容正确且 tmp 已清', () => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'rws-real-t111b-'))
    const filePath = join(tmpDir, 'target.json')
    const payload = '{"records":[]}'

    atomicWrite(filePath, payload)

    // 主文件存在且内容正确
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(payload)

    // tmp 文件已被 rename 掉（原子完成的副产物）
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false)
  })
})
