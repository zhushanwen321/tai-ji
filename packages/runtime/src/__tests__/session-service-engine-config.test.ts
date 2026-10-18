/**
 * [U7 → W4] SessionRecords 子代理引擎配置读写测试（getSubagentEngineConfig /
 * setSubagentDefaultEngine / setSubagentEngineDefaultModel）——Settings 引擎选择器
 * 与 per-engine 默认模型偏好的 runtime 数据面。
 *
 * 覆盖：engines.json 动态清单读取；冷启动回退源单源化（W4：engines.json 缺失/损坏
 * → runtime 自身三级发现，零命中返回空清单——静态 JSON 兜底已删，设计 §3.4 派生视图
 * 表）；config.json defaultEngine 读取与缺省；set 的引擎校验（未知引擎 throw）、
 * 读改写保留其他字段、幂等零写。
 *
 * engine-provider-unification D5：reply 扩展（engineModels = 真实 ∪ 副本聚合派生 +
 * engineDefaults sanitize 读取）与 setSubagentEngineDefaultModel（写入校验 ref ∈
 * 清单、非法拒绝不落脏值、同锁 RMW、幂等零写、脏条目不连坐）。
 *
 * 测试对象 = SessionRecords 直构（deps 窄注入，zcodeModelListPaths 隔离真实 ~/.zcode
 * 树——缺省派生路径读宿主真实配置，断言不可控）——引擎配置方法均为 SessionRecords
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
let zcodeRealPath: string
let zcodeCopyPath: string

interface RecordsExtOverride {
  discoverEngines?: () => string[]
  zcodeModelListPaths?: { realProviderConfigPath: string; syncedCopyPath: string; builtinCatalogPath?: string }
}

function makeRecords(extOverride?: RecordsExtOverride): SessionRecords {
  return new SessionRecords({
    pm: {} as never,
    sessionStore: { scanSessions: vi.fn(() => []) } as never,
    hasSession: () => false,
    getMessageBus: () => null,
    // [W8] getExtensionPaths 死键已随 deps 面删除（W4 登记的保留期结束）
    // D5：zcode 模型清单派生源指向 tmp（隔离真实 ~/.zcode/v2/provider_config.json 与
    // 内建目录 account 直通枚举——[engine-ref-translation D3] 副本注入缺省项）
    zcodeModelListPaths: {
      realProviderConfigPath: zcodeRealPath,
      syncedCopyPath: zcodeCopyPath,
      builtinCatalogPath: path.join(tmpDataRoot, 'absent-builtin-catalog.json'),
    },
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

/** provider_config.json 个人条目 fixture（对齐 u1 测试的写盘形态）。 */
function writeProviderConfig(
  absPath: string,
  rules: ReadonlyArray<{ providerId: string; models: string[]; apiKey?: string; providerName?: string }>,
): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(
    absPath,
    JSON.stringify(
      {
        config: {
          providerConfigRules: {
            providerRules: rules.map((r) => ({
              providerId: r.providerId,
              ...(r.providerName !== undefined ? { providerName: r.providerName } : {}),
              config: {
                access: { apiKey: r.apiKey ?? 'sk-test' },
                modelOrder: r.models,
              },
            })),
          },
        },
      },
      null,
      2,
    ),
  )
}

beforeEach(() => {
  tmpDataRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'engine-config-'))
  zcodeRealPath = path.join(tmpDataRoot, 'zcode-home', 'v2', 'provider_config.json')
  zcodeCopyPath = path.join(tmpDataRoot, 'agent', 'engines', 'zcode', 'pi-synced-provider-config.json')
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
    // D5 扩展键恒带：无派生源时 zcode 清单空表、无偏好时空对象
    expect(view).toEqual({
      engines: ['pi', 'zcode'],
      defaultEngine: 'zcode',
      engineModels: { zcode: [] },
      engineDefaults: {},
    })
  })

  it('[W4] engines.json 缺失/损坏 → runtime 自身发现回退（deps.discoverEngines 注入面）', async () => {
    writeJson('config.json', { version: 1, maxConcurrent: 6 })
    // 回退源 = runtime 自身发现结果（§3.4 派生视图表「冷启动回退源单源化」）
    const discovered = await makeRecords({ discoverEngines: () => ['zcode', 'foo'] }).getSubagentEngineConfig()
    expect(discovered).toEqual({ engines: ['zcode', 'foo'], defaultEngine: 'pi', engineModels: { zcode: [] }, engineDefaults: {} })
    // engines.json 损坏同走发现回退
    writeJson('engines.json', '{ torn')
    const torn = await makeRecords({ discoverEngines: () => ['zcode'] }).getSubagentEngineConfig()
    expect(torn).toEqual({ engines: ['zcode'], defaultEngine: 'pi', engineModels: { zcode: [] }, engineDefaults: {} })
  })

  it('[W4] 零命中 → 空清单（无静态 JSON 兜底）', async () => {
    // 静态声明兜底已删：零命中返回空清单（静态声明列出的 id 无 bin 可执行，
    // 「能选不能跑」与「不可用引擎不进清单」派生视图规则冲突，§3.4 派生视图表）
    writeJson('config.json', { version: 1, maxConcurrent: 6 })
    const svc = makeRecords({ discoverEngines: () => [] })
    await expect(svc.getSubagentEngineConfig()).resolves.toEqual({
      engines: [],
      defaultEngine: 'pi',
      engineModels: { zcode: [] },
      engineDefaults: {},
    })
  })

  it('[W4] 发现回退失败 → 空清单（不阻塞配置视图）；defaultEngine 仍独立读 config.json', async () => {
    const svc = makeRecords({
      discoverEngines: () => {
        throw new Error('discovery exploded')
      },
    })
    writeJson('config.json', { version: 1, defaultEngine: 'zcode' })
    await expect(svc.getSubagentEngineConfig()).resolves.toEqual({
      engines: [],
      defaultEngine: 'zcode',
      engineModels: { zcode: [] },
      engineDefaults: {},
    })
  })

  it('[D5] engineModels：真实 ∪ 副本 id 级聚合（真实优先）+ name 派生', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    // 真实源同名条目（stepfun）必须胜出——副本 stepfun 的 step-stale 不进清单
    writeProviderConfig(zcodeRealPath, [
      { providerId: 'stepfun', models: ['step-1v'], providerName: 'StepFun' },
      { providerId: 'nokey', models: ['dead'], apiKey: '' },
    ])
    writeProviderConfig(zcodeCopyPath, [
      { providerId: 'stepfun', models: ['step-stale'] },
      { providerId: 'openrouter', models: ['m1', 'm2'] },
    ])
    const view = await makeRecords().getSubagentEngineConfig()
    expect(view.engineModels).toEqual({
      zcode: [
        { id: 'stepfun/step-1v', name: 'StepFun · step-1v' },
        { id: 'openrouter/m1' },
        { id: 'openrouter/m2' },
      ],
    })
  })

  it('[D5] engineModels：双源回落——真实源缺失时副本派生照常（纯 pi provider 用户形态）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeProviderConfig(zcodeCopyPath, [{ providerId: 'openrouter', models: ['m1'] }])
    const view = await makeRecords().getSubagentEngineConfig()
    expect(view.engineModels).toEqual({ zcode: [{ id: 'openrouter/m1' }] })
  })

  it('[D5] engineDefaults：读取经 u5 sanitize——手编脏条目剔除不连坐合法偏好', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', {
      version: 1,
      engineDefaults: { zcode: 'stepfun/step-1v', pi: '', bad: 42, '  ': 'x/y' },
    })
    const view = await makeRecords().getSubagentEngineConfig()
    expect(view.engineDefaults).toEqual({ zcode: 'stepfun/step-1v' })
  })

  it('[D5] config.json 缺失 → defaultEngine pi + engineDefaults 空表（absent 态）', async () => {
    const view = await makeRecords({ discoverEngines: () => ['pi'] }).getSubagentEngineConfig()
    expect(view).toEqual({ engines: ['pi'], defaultEngine: 'pi', engineModels: { zcode: [] }, engineDefaults: {} })
  })
})

describe('setSubagentDefaultEngine', () => {
  it('合法引擎：读改写 config.json（保留其他字段）+ 原子写', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 3, futureKey: { keep: true } })
    const svc = makeRecords()
    await svc.setSubagentDefaultEngine('zcode')
    const conf = readConfigJson()
    expect(conf['defaultEngine']).toBe('zcode')
    expect(conf['maxConcurrent']).toBe(3)
    expect(conf['futureKey']).toEqual({ keep: true }) // 未知键原样保留（向前兼容）
    // 读回视图一致
    expect(await svc.getSubagentEngineConfig()).toEqual({
      engines: ['pi', 'zcode'],
      defaultEngine: 'zcode',
      engineModels: { zcode: [] },
      engineDefaults: {},
    })
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
    writeJson('config.json', { version: 1, maxConcurrent: 5, futureKey: { keep: true } })
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
    // 锁释放后重试成功：defaultEngine 写入，未知键 / maxConcurrent 不被 RMW 覆盖回滚
    await makeRecords().setSubagentDefaultEngine('zcode')
    const confAfter = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    expect(confAfter['defaultEngine']).toBe('zcode')
    expect(confAfter['maxConcurrent']).toBe(5)
    expect(confAfter['futureKey']).toEqual({ keep: true })
  })
})

describe('[D5] setSubagentEngineDefaultModel', () => {
  it('合法 ref（真实源派生）：写入 engineDefaults，保留其他字段（defaultEngine/未知键）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 3, defaultEngine: 'zcode', futureKey: { keep: true } })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v', 'step-2'] }])
    const svc = makeRecords()
    await svc.setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    const conf = readConfigJson()
    expect(conf['engineDefaults']).toEqual({ zcode: 'stepfun/step-1v' })
    expect(conf['maxConcurrent']).toBe(3)
    expect(conf['defaultEngine']).toBe('zcode')
    expect(conf['futureKey']).toEqual({ keep: true })
    // 读回视图一致（reply engineDefaults 反映写入值）
    expect((await svc.getSubagentEngineConfig()).engineDefaults).toEqual({ zcode: 'stepfun/step-1v' })
  })

  it('合法 ref（副本派生）：双源回落下副本条目可写入（纯 pi provider 用户形态）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1 })
    writeProviderConfig(zcodeCopyPath, [{ providerId: 'openrouter', models: ['m1'] }])
    await makeRecords().setSubagentEngineDefaultModel('zcode', 'openrouter/m1')
    expect(readConfigJson()['engineDefaults']).toEqual({ zcode: 'openrouter/m1' })
  })

  it('非法 ref → throw（带 taiji settings 恢复指引），config.json 不落脏值', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 5 })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v'] }])
    await expect(
      makeRecords().setSubagentEngineDefaultModel('zcode', 'ghost/model'),
    ).rejects.toThrow(/unknown model 'ghost\/model' for engine 'zcode'.*taiji settings/)
    // 拒绝后 config.json 原样（无 engineDefaults 键，其他字段不被动）
    const conf = readConfigJson()
    expect(conf['engineDefaults']).toBeUndefined()
    expect(conf['maxConcurrent']).toBe(5)
  })

  it('无清单引擎（pi）→ throw（per-engine 默认模型仅覆盖有清单的引擎）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1 })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v'] }])
    await expect(
      makeRecords().setSubagentEngineDefaultModel('pi', 'stepfun/step-1v'),
    ).rejects.toThrow(/no selectable model list/)
    expect(readConfigJson()['engineDefaults']).toBeUndefined()
  })

  it('既有偏好脏条目经 sanitize 剔除（不连坐合法偏好），合法既有条目保留', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', {
      version: 1,
      engineDefaults: { pi: '', bad: 42 },
    })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v'] }])
    await makeRecords().setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    expect(readConfigJson()['engineDefaults']).toEqual({ zcode: 'stepfun/step-1v' })
  })

  it('值未变 → 幂等零写（mtime 不动）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, engineDefaults: { zcode: 'stepfun/step-1v' } })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v'] }])
    const p = configPath()
    const statBefore = fs.statSync(p)
    await makeRecords().setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    expect(fs.statSync(p).mtimeMs).toBe(statBefore.mtimeMs)
  })

  it('RMW 持跨进程锁（与 setSubagentDefaultEngine 同锁）：他方持锁期间 fail-fast（ELOCKED）零写入，释放后重试成功', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeJson('config.json', { version: 1, maxConcurrent: 5 })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v'] }])
    const p = configPath()
    const release = lockfile.lockSync(p, { realpath: false })
    const pending = makeRecords().setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    await expect(pending).rejects.toThrow(/ELOCKED/)
    // 锁竞争失败零写入：engineDefaults 未落盘，其他字段原样
    const confDuring = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    expect(confDuring['engineDefaults']).toBeUndefined()
    expect(confDuring['maxConcurrent']).toBe(5)
    release()
    await makeRecords().setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    const confAfter = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    expect(confAfter['engineDefaults']).toEqual({ zcode: 'stepfun/step-1v' })
    expect(confAfter['maxConcurrent']).toBe(5)
  })

  it('坏 JSON config.json（parse 抛错 / 非对象形态）→ 新建最小配置（与 setSubagentDefaultEngine 同款取舍）', async () => {
    writeJson('engines.json', { v: 1, engines: ['pi', 'zcode'], updatedAt: 1 })
    writeProviderConfig(zcodeRealPath, [{ providerId: 'stepfun', models: ['step-1v'] }])
    // 形态一：真坏 JSON 文本（JSON.parse 抛错）
    const p = configPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '{ torn')
    await makeRecords().setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    expect(readConfigJson()['engineDefaults']).toEqual({ zcode: 'stepfun/step-1v' })
    // 形态二：合法 JSON 但非对象（parse 成功、属性赋值会炸的形态）——归 {} 新建基底
    fs.writeFileSync(p, '"a scalar string"')
    await makeRecords().setSubagentEngineDefaultModel('zcode', 'stepfun/step-1v')
    expect(readConfigJson()['engineDefaults']).toEqual({ zcode: 'stepfun/step-1v' })
  })
})
