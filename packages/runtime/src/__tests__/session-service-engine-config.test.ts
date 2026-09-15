/**
 * [U7 → W4] SessionRecords 子代理引擎配置读写测试（getSubagentEngineConfig /
 * setSubagentDefaultEngine）——Settings 引擎选择器的 runtime 数据面。
 *
 * 覆盖：engines.json 动态清单读取；冷启动回退源单源化（W4：engines.json 缺失/损坏
 * → runtime 自身三级发现，零命中返回空清单——静态 JSON 兜底已删，设计 §3.4 投影面
 * 表）；config.json defaultEngine 读取与缺省；set 的引擎校验（未知引擎 throw）、
 * 读改写保留其他字段、幂等零写。
 *
 * 测试面 = SessionRecords 直构（deps 窄注入）——引擎配置三方法均为 SessionRecords
 * 域方法，无需经 SessionService 组合根。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-service-engine-config.test.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import lockfile from 'proper-lockfile'
import { SessionRecords } from '../services/session/session-records.js'

const PREV_DATA_DIR = process.env['TAIJI_AGENT_DATA_DIR']
let tmpDataRoot: string

function makeRecords(extOverride?: { discoverEngines?: () => string[] }): SessionRecords {
  return new SessionRecords({
    pm: {} as never,
    sessionStore: { scanSessions: vi.fn(() => []) } as never,
    hasSession: () => false,
    getMessageBus: () => null,
    // [W8] getExtensionPaths 死键已随 deps 面删除（W4 登记的保留期结束）
    ...extOverride,
  })
}

function writeJson(rel: string, v: unknown): void {
  const p = path.join(tmpDataRoot, 'agent/subagents', rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v, null, 2))
}

function readConfigJson(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(tmpDataRoot, 'agent/subagents/config.json'), 'utf8'),
  ) as Record<string, unknown>
}

function configPath(): string {
  return path.join(tmpDataRoot, 'agent/subagents/config.json')
}

beforeEach(() => {
  tmpDataRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'engine-config-'))
  process.env['TAIJI_AGENT_DATA_DIR'] = tmpDataRoot
})

afterEach(() => {
  if (PREV_DATA_DIR === undefined) delete process.env['TAIJI_AGENT_DATA_DIR']
  else process.env['TAIJI_AGENT_DATA_DIR'] = PREV_DATA_DIR
  fs.rmSync(tmpDataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('getSubagentEngineConfig', () => {
  it('engines.json + config.json 合成视图', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 6, defaultEngine: 'zcode' })
    const view = await makeRecords().getSubagentEngineConfig()
    expect(view).toEqual({ engines: ['pi', 'zcode'], defaultEngine: 'zcode' })
  })

  it('[W4] engines.json 缺失/损坏 → runtime 自身发现回退（deps.discoverEngines 注入面）', async () => {
    writeJson('config.json', { version: 1, maxConcurrent: 6 })
    // 回退源 = runtime 自身发现结果（§3.4 投影面表「冷启动回退源单源化」）
    const discovered = await makeRecords({ discoverEngines: () => ['zcode', 'foo'] }).getSubagentEngineConfig()
    expect(discovered).toEqual({ engines: ['zcode', 'foo'], defaultEngine: 'pi' })
    // engines.json 损坏同走发现回退
    writeJson('engines.json', '{ torn')
    const torn = await makeRecords({ discoverEngines: () => ['zcode'] }).getSubagentEngineConfig()
    expect(torn).toEqual({ engines: ['zcode'], defaultEngine: 'pi' })
  })

  it('[W4] 零命中 → 空清单（无静态 JSON 兜底）', async () => {
    // 静态声明兜底已删：零命中返回空清单（静态声明列出的 id 无 bin 可执行，
    // 「能选不能跑」与「不可用引擎不进清单」投影规则冲突，§3.4 投影面表）
    writeJson('config.json', { version: 1, maxConcurrent: 6 })
    const svc = makeRecords({ discoverEngines: () => [] })
    await expect(svc.getSubagentEngineConfig()).resolves.toEqual({ engines: [], defaultEngine: 'pi' })
  })

  it('[W4] 发现回退失败 → 空清单（不阻塞配置视图）；defaultEngine 仍独立读 config.json', async () => {
    const svc = makeRecords({
      discoverEngines: () => {
        throw new Error('discovery exploded')
      },
    })
    writeJson('config.json', { version: 1, defaultEngine: 'zcode' })
    await expect(svc.getSubagentEngineConfig()).resolves.toEqual({ engines: [], defaultEngine: 'zcode' })
  })
})

describe('setSubagentDefaultEngine', () => {
  it('合法引擎：读改写 config.json（保留其他字段）+ 原子写', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 3, engineRouting: { strict: true } })
    const svc = makeRecords()
    await svc.setSubagentDefaultEngine('zcode')
    const conf = readConfigJson()
    expect(conf['defaultEngine']).toBe('zcode')
    expect(conf['maxConcurrent']).toBe(3)
    expect(conf['engineRouting']).toEqual({ strict: true })
    // 读回视图一致
    expect(await svc.getSubagentEngineConfig()).toEqual({ engines: ['pi', 'zcode'], defaultEngine: 'zcode' })
  })

  it('未知引擎 → throw（防写坏配置）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi'], updatedAt: 1 })
    await expect(makeRecords().setSubagentDefaultEngine('ghost')).rejects.toThrow(/unknown subagent engine/)
  })

  it('值未变 → 幂等零写（mtime 不动）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 6, defaultEngine: 'zcode' })
    const p = configPath()
    const statBefore = fs.statSync(p)
    await makeRecords().setSubagentDefaultEngine('zcode')
    expect(fs.statSync(p).mtimeMs).toBe(statBefore.mtimeMs)
  })

  it('RMW 持跨进程锁：他方持同锁期间写入 fail-fast（ELOCKED），锁释放后重试成功且其他字段不被覆盖回滚', async () => {
    // review round1 MUST_FIX：config.json 是多写方共享文件（runtime RMW / agent bash /
    // 用户手编），RMW 必须持 withFileLockSync（lockfile = <config.json>.lock）。
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 5, engineRouting: { strict: true } })
    const p = configPath()
    // 他方（遵守锁协议的另一写方）持同一把锁
    const release = lockfile.lockSync(p, { realpath: false })
    const pending = makeRecords().setSubagentDefaultEngine('zcode')
    await expect(pending).rejects.toThrow(/ELOCKED/)
    // 锁竞争失败零写入（不是降级无锁写）：defaultEngine 未落盘，其他字段原样
    const confDuring = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    expect(confDuring['defaultEngine']).toBeUndefined()
    expect(confDuring['maxConcurrent']).toBe(5)
    release()
    // 锁释放后重试成功：defaultEngine 写入，engineRouting / maxConcurrent 不被 RMW 覆盖回滚
    await makeRecords().setSubagentDefaultEngine('zcode')
    const confAfter = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    expect(confAfter['defaultEngine']).toBe('zcode')
    expect(confAfter['maxConcurrent']).toBe(5)
    expect(confAfter['engineRouting']).toEqual({ strict: true })
  })
})
