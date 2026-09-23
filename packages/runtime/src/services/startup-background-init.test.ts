/**
 * 启动后台初始化块（perf W29 D8-1，06 §3.3）测试。
 *
 * 锁定：
 * - ② 顺序约束：migrateBuiltinExtensions 必须先于 checkAndAutoUpgrade（spy 调用序——
 *   index.ts:190 既有注释 + 06 §5 门禁，防止未来重排回归「autoUpgrade 升级打包内置包」）。
 * - D8-3：迁移 gate 在序列最前创建并 setMigrationGate，迁移完成前后续步骤不执行。
 * - D8-2：getPiVersion 完成后 mutate appInfo 同对象 + 补发 app.info（broadcastAppInfo 恰一次）。
 * - ③ 先 listen 后初始化：index.ts 源码顺序断言——runStartupBackgroundInit 调用点
 *   必须在 await server.start() 之后（任务书许可的「启动函数顺序断言」）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/startup-background-init.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runStartupBackgroundInit, resolveReclaimConfig } from './startup-background-init.js'
import { getMigrationGate } from './session/session-lifecycle.js'
import { getSessionsDir, getPiAgentDir } from '../infra/pi/pi-paths.js'
import {
  TAIJI_RUNTIME_PI_RECLAIM_IDLE_MS,
  TAIJI_RUNTIME_PI_RECLAIM_TICK_MS,
  TAIJI_RUNTIME_PI_RECLAIM_VIEWED_WINDOW_MS,
  TAIJI_RUNTIME_PI_RECLAIM_FORM_MAX_AGE_MS,
  DEFAULT_PI_RECLAIM_IDLE_MS,
  DEFAULT_PI_RECLAIM_TICK_MS,
  DEFAULT_PI_RECLAIM_VIEWED_WINDOW_MS,
  DEFAULT_PI_RECLAIM_FORM_MAX_AGE_MS,
} from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'
import type { ExtensionService } from './extension-service.js'
import type { ProcessManager } from '../infra/pi/process-manager.js'
import type { SkillRegistry } from './skill-registry.js'
import type { PluginService } from './plugin-service/plugin-service.js'
import type { PiConfigStore } from '../infra/pi/pi-config-store.js'
import type { AuthStorage } from './auth/auth-storage.js'

// vi.hoisted：vi.mock 工厂不能引用外部变量（hoisting 限制）——deferred 经 holder 对象透出。
const h = vi.hoisted(() => {
  const deferred: { resolve?: (v: unknown) => void } = {}
  const migrateProviderConfig = vi.fn(() => new Promise<unknown>((res) => {
    deferred.resolve = res
  }))
  return { migrateProviderConfig, deferred }
})

// ⑨ 孤儿收殓挂载测试用 mock：文件级 vi.mock 同时保护其余用例——若测试文件整体跑超
// 5s（慢 CI），真实 5s 定时器触发时命中的也是此 mock，不会真扫/真杀本机进程。
const rh = vi.hoisted(() => ({
  reapOrphanPiProcesses: vi.fn(async (_options: { dataDir: string; ownPid: number; readSpawnMarkers: () => string[] | null }) => ({
    scanned: 0,
    reaped: [] as number[],
    failed: [] as number[],
    unsupported: false,
  })),
}))

vi.mock('./migration/legacy-provider-migration.js', () => ({
  migrateProviderConfig: h.migrateProviderConfig,
}))
vi.mock('./rename-session-config.js', () => ({
  ensureAutoRenameDefault: vi.fn(),
}))
// ⑦b startupConfig ensure 挂载测试用 mock：真实实现会写 getPiAgentDir()（测试未隔离
// 数据目录时可能触真实用户目录），mock 后同时可断言 ⑦b 的调用与顺序。
const sc = vi.hoisted(() => ({
  ensureDeclaredStartupConfigs: vi.fn(() => ({ ensured: 0, skipped: 0, failed: 0 })),
}))
vi.mock('./extension-startup-config.js', () => ({
  ensureDeclaredStartupConfigs: sc.ensureDeclaredStartupConfigs,
}))
vi.mock('./reap-orphan-pi.js', () => ({
  // 挂载方从该模块 import 常量与函数，mock 需两者都供给（值与真实实现一致）。
  ORPHAN_REAP_DELAY_MS: 5_000,
  reapOrphanPiProcesses: rh.reapOrphanPiProcesses,
}))

/** 与 ProviderConfigMigrationReport 形状一致（catalog 含 errors 字段——handled 分支会读）。 */
function noopReport() {
  return {
    catalog: { migrated: [], kept: [], skipped: [], failed: [], errors: [] },
    enabled: { migratedEnabled: false, fullDisabledWarn: false },
  }
}

/** 构造 helper 依赖：全部 spy，record 调用序。 */
function makeDeps() {
  const calls: string[] = []
  const extensionService = {
    migrateBuiltinExtensions: vi.fn(async () => { calls.push('migrateBuiltinExtensions') }),
    checkAndAutoUpgrade: vi.fn(async () => { calls.push('checkAndAutoUpgrade'); return [] }),
    getExtensionPaths: vi.fn(async () => { calls.push('getExtensionPaths'); return [] }),
  } as unknown as ExtensionService
  const pm = {
    getPiVersion: vi.fn(async () => { calls.push('getPiVersion'); return '9.9.9' }),
  } as unknown as ProcessManager
  const skillRegistry = {
    initGlobal: vi.fn(async () => { calls.push('initGlobal'); return undefined }),
    getGlobalSkills: vi.fn(() => []),
  } as unknown as SkillRegistry
  const pluginService = {
    initialize: vi.fn(async () => { calls.push('pluginService.initialize'); return undefined }),
  } as unknown as PluginService
  const appInfo = { appVersion: '1.2.3', piVersion: 'unknown' }
  const broadcastAppInfo = vi.fn(() => { calls.push('broadcastAppInfo') })
  // u17：spawn 清单读取 port（组合根注入 infra 读侧闭包）；值无意义（reap 全 mock），形态保真。
  const readSpawnMarkers = vi.fn(() => ['/data/taiji/extensions/pi-agent-ext'])
  const deps = {
    configStore: {} as PiConfigStore,
    authStorage: {} as AuthStorage,
    credentialWriter: { saveCredential: vi.fn() },
    extensionService,
    pm,
    appInfo,
    broadcastAppInfo,
    skillRegistry,
    pluginService,
    readSpawnMarkers,
  }
  return { deps, calls, extensionService, pm, broadcastAppInfo, skillRegistry, pluginService, appInfo, readSpawnMarkers }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.migrateProviderConfig.mockReset()
  // 每个用例默认：迁移立即成功（no-op 报告）
  h.migrateProviderConfig.mockImplementation(async () => noopReport())
})

afterEach(() => {
  // 释放 pending 的 deferred（防测试结束悬挂）；gate 状态由 lifecycle 测试文件负责重置。
  // 可选调用：默认 impl 不注册 deferred（避免「resolveMigration is not a function」）。
  h.deferred.resolve?.(undefined)
})

describe('runStartupBackgroundInit（D8-1 后台初始化序列）', () => {
  it('顺序约束：migrateBuiltinExtensions 先于 checkAndAutoUpgrade，且都在 getPiVersion 前', async () => {
    const { deps, calls } = makeDeps()
    await runStartupBackgroundInit(deps)
    expect(calls).toEqual([
      'migrateBuiltinExtensions',
      'checkAndAutoUpgrade',
      'getPiVersion',
      'broadcastAppInfo',
      'initGlobal',
      'pluginService.initialize',
      'getExtensionPaths',
    ])
  })

  it('⑦b：getExtensionPaths + ensureDeclaredStartupConfigs 在插件初始化之后执行（序列尾部）', async () => {
    const { deps, extensionService } = makeDeps()
    await runStartupBackgroundInit(deps)
    expect(extensionService.getExtensionPaths).toHaveBeenCalledTimes(1)
    expect(sc.ensureDeclaredStartupConfigs).toHaveBeenCalledTimes(1)
    // ensure 收到 getExtensionPaths 的返回值（空数组直通）与真实 pi agentDir
    expect(sc.ensureDeclaredStartupConfigs).toHaveBeenCalledWith([], getPiAgentDir())
  })

  it('D8-3：gate 在序列最前创建——迁移未完成时后续步骤不执行，完成才放行', async () => {
    const { deps, extensionService, calls } = makeDeps()
    // 迁移 deferred：先不 resolve
    h.migrateProviderConfig.mockImplementation(() => new Promise((res) => { h.deferred.resolve = res }))
    const pending = runStartupBackgroundInit(deps)
    // 让同步前缀 + 首个 await 执行
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([])
    expect(extensionService.migrateBuiltinExtensions).not.toHaveBeenCalled()
    // getMigrationGate 已注入（pending 未完成，非默认 resolved）
    expect(getMigrationGate()).not.toBeUndefined()

    h.deferred.resolve!(noopReport())
    await pending
    expect(calls[0]).toBe('migrateBuiltinExtensions')
  })

  it('D8-2：getPiVersion 返回后 mutate appInfo 同对象 + 补发 app.info 恰一次', async () => {
    const { deps, appInfo, broadcastAppInfo, pm } = makeDeps()
    await runStartupBackgroundInit(deps)
    expect(appInfo.piVersion).toBe('9.9.9')
    expect(pm.getPiVersion).toHaveBeenCalledTimes(1)
    expect(broadcastAppInfo).toHaveBeenCalledTimes(1)
  })

  it('迁移失败不阻塞后续步骤（best-effort，gate 恒 resolve）', async () => {
    const { deps, extensionService, pm } = makeDeps()
    h.migrateProviderConfig.mockRejectedValue(new Error('migration boom'))
    await expect(runStartupBackgroundInit(deps)).resolves.toBeUndefined()
    expect(extensionService.migrateBuiltinExtensions).toHaveBeenCalled()
    expect(pm.getPiVersion).toHaveBeenCalled()
  })

  it('getPiVersion 抛错时 appInfo.piVersion 保持 unknown 且不补发（兜底不阻塞）', async () => {
    const { deps, appInfo, broadcastAppInfo, pm } = makeDeps()
    pm.getPiVersion = vi.fn(async () => { throw new Error('pi missing') }) as never
    await runStartupBackgroundInit(deps)
    expect(appInfo.piVersion).toBe('unknown')
    expect(broadcastAppInfo).not.toHaveBeenCalled()
  })
})

describe('⑨ 孤儿 pi 收殓挂载（integrity-hardening §3.4 D4a）', () => {
  it('启动后延迟 5s 触发一次收殓，参数带本实例 dataDir、注入的清单读取函数与 runtime pid', async () => {
    vi.useFakeTimers()
    try {
      const { deps, readSpawnMarkers } = makeDeps()
      await runStartupBackgroundInit(deps)
      // 串行链完成后宽限未到：不收殓（5s 给 pi stdin-EOF 自杀链留时间）
      expect(rh.reapOrphanPiProcesses).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(rh.reapOrphanPiProcesses).toHaveBeenCalledTimes(1)
      const arg = rh.reapOrphanPiProcesses.mock.calls[0][0]
      expect(arg.ownPid).toBe(process.pid)
      expect(arg.dataDir).toBe(getDataDir())
      // 组合根注入的清单读取 port 原样透传（D6c：services 不自行 import infra 读侧）
      expect(arg.readSpawnMarkers).toBe(readSpawnMarkers)
    } finally {
      vi.useRealTimers()
    }
  })

  it('收殓异常不外溢：reap reject 被挂载点 catch 消化，不产生 unhandled rejection、不影响其他步', async () => {
    vi.useFakeTimers()
    try {
      rh.reapOrphanPiProcesses.mockRejectedValueOnce(new Error('reap boom'))
      const { deps, extensionService } = makeDeps()
      await expect(runStartupBackgroundInit(deps)).resolves.toBeUndefined()
      // advanceTimersByTimeAsync 会 flush 微任务：reject 必须已被挂载点 catch 消化
      await vi.advanceTimersByTimeAsync(5_000)
      expect(rh.reapOrphanPiProcesses).toHaveBeenCalledTimes(1)
      expect(extensionService.checkAndAutoUpgrade).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('先 listen 后初始化（D8-1，index.ts 源码顺序断言）', () => {
  it('runStartupBackgroundInit 调用点位于 await server.start() 之后', () => {
    // 定位 packages/runtime/src/index.ts：cwd 可能是包根（cd packages/runtime）或仓库根。
    // 不用模块元信息定位（runtime bundle 验证禁止 src 下出现 import_meta 用法）。
    const candidates = [
      join(process.cwd(), 'src/index.ts'),
      join(process.cwd(), 'packages/runtime/src/index.ts'),
    ]
    const srcFile = candidates.find((p) => existsSync(p))
    if (!srcFile) throw new Error(`index.ts not found from cwd=${process.cwd()}`)
    const src = readFileSync(srcFile, 'utf-8')
    const startCall = src.indexOf('await server.start()')
    const initCall = src.indexOf('runStartupBackgroundInit(')
    expect(startCall).toBeGreaterThan(-1)
    expect(initCall).toBeGreaterThan(-1)
    expect(initCall).toBeGreaterThan(startCall)
  })
})

describe('⑧ sessions 残留清扫家族扩展（缓存治理 U9：退役 .model.json sidecar）', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'u9-startup-sidecar-residue-'))
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('启动序列执行后 sessions 目录 *.model.json 零残留，JSONL 主文件不受影响（设计验收挂点）', async () => {
    const sessionsDir = join(dataDir, 'agent', 'sessions')
    const subDir = join(sessionsDir, '--Users-x-proj--')
    mkdirSync(subDir, { recursive: true })
    const rootJsonl = join(sessionsDir, 'sess-root.jsonl')
    const rootSidecar = rootJsonl + '.model.json'
    const subJsonl = join(subDir, 'sess-sub.jsonl')
    const subSidecar = subJsonl + '.model.json'
    writeFileSync(rootJsonl, '{"type":"session","id":"sess-root","cwd":"/x"}\n', 'utf-8')
    writeFileSync(rootSidecar, '{"modelId":"a/b"}', 'utf-8')
    writeFileSync(subJsonl, '{"type":"session","id":"sess-sub","cwd":"/y"}\n', 'utf-8')
    writeFileSync(subSidecar, '{"modelId":"c/d"}', 'utf-8')

    const { deps } = makeDeps()
    await expect(runStartupBackgroundInit(deps)).resolves.toBeUndefined()

    // 启动后零残留断言（两层目录均无 .model.json）
    for (const dir of [sessionsDir, subDir]) {
      expect(readdirSync(dir).filter((name) => name.endsWith('.model.json'))).toEqual([])
    }
    // JSONL 主文件不受影响
    expect(existsSync(rootJsonl)).toBe(true)
    expect(existsSync(subJsonl)).toBe(true)
  })

  it('sessions 目录无残留时启动序列正常完成（零操作不抛）', async () => {
    mkdirSync(join(dataDir, 'agent', 'sessions'), { recursive: true })
    const { deps } = makeDeps()
    await expect(runStartupBackgroundInit(deps)).resolves.toBeUndefined()
  })
})

describe('⑩ 空闲 pi 回收 reaper 挂载（idle-pi-reclamation D4，u3b）', () => {
  it('传入 startIdleReaper 时在序列中被调用恰一次', async () => {
    const { deps } = makeDeps()
    const startIdleReaper = vi.fn()
    await runStartupBackgroundInit({ ...deps, startIdleReaper })
    expect(startIdleReaper).toHaveBeenCalledTimes(1)
    expect(startIdleReaper).toHaveBeenCalledWith()
  })

  it('未传 startIdleReaper 时跳过且其余步骤不受影响（序列正常完成）', async () => {
    const { deps, extensionService, pluginService } = makeDeps()
    await expect(runStartupBackgroundInit(deps)).resolves.toBeUndefined()
    expect(extensionService.migrateBuiltinExtensions).toHaveBeenCalled()
    expect(pluginService.initialize).toHaveBeenCalled()
  })

  it('startIdleReaper 抛错被挂载点 catch 消化，不阻塞序列（fire-and-forget 形态）', async () => {
    const { deps, pluginService } = makeDeps()
    const startIdleReaper = vi.fn(() => { throw new Error('reaper start boom') })
    await expect(runStartupBackgroundInit({ ...deps, startIdleReaper })).resolves.toBeUndefined()
    expect(startIdleReaper).toHaveBeenCalledTimes(1)
    expect(pluginService.initialize).toHaveBeenCalled()
  })
})

describe('resolveReclaimConfig（idle-pi-reclamation D4 env 覆盖解析）', () => {
  it('env 全缺失时返回 shared 默认四旋钮', () => {
    expect(resolveReclaimConfig({})).toEqual({
      idleThresholdMs: DEFAULT_PI_RECLAIM_IDLE_MS,
      tickIntervalMs: DEFAULT_PI_RECLAIM_TICK_MS,
      viewedWindowMs: DEFAULT_PI_RECLAIM_VIEWED_WINDOW_MS,
      pendingUiRequestMaxAgeMs: DEFAULT_PI_RECLAIM_FORM_MAX_AGE_MS,
    })
  })

  it('合法值逐项覆盖，未覆盖项保持默认', () => {
    const env = {
      [TAIJI_RUNTIME_PI_RECLAIM_IDLE_MS]: String(5 * 60 * 1000),
      [TAIJI_RUNTIME_PI_RECLAIM_VIEWED_WINDOW_MS]: String(10 * 60 * 1000),
    }
    const cfg = resolveReclaimConfig(env)
    expect(cfg.idleThresholdMs).toBe(5 * 60 * 1000)
    expect(cfg.viewedWindowMs).toBe(10 * 60 * 1000)
    expect(cfg.tickIntervalMs).toBe(DEFAULT_PI_RECLAIM_TICK_MS)
    expect(cfg.pendingUiRequestMaxAgeMs).toBe(DEFAULT_PI_RECLAIM_FORM_MAX_AGE_MS)
  })

  it('v6 上界旋钮：TAIJI_RUNTIME_PI_RECLAIM_FORM_MAX_AGE_MS 合法值生效', () => {
    // 3h > 默认 IDLE 2h（避免无意触发「上界 < 空闲阈」warn）
    const cfg = resolveReclaimConfig({ [TAIJI_RUNTIME_PI_RECLAIM_FORM_MAX_AGE_MS]: String(3 * 60 * 60 * 1000) })
    expect(cfg.pendingUiRequestMaxAgeMs).toBe(3 * 60 * 60 * 1000)
  })

  it('r5 联动护栏：上界 < 空闲阈值时打 warn（豁免恒不命中 = 死代码），但不 throw', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cfg = resolveReclaimConfig({
        [TAIJI_RUNTIME_PI_RECLAIM_IDLE_MS]: String(2 * 60 * 60 * 1000),
        [TAIJI_RUNTIME_PI_RECLAIM_FORM_MAX_AGE_MS]: String(60 * 60 * 1000), // 1h < 2h
      })
      expect(cfg.pendingUiRequestMaxAgeMs).toBe(60 * 60 * 1000)
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('pending-UI-request exemption is unreachable'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('r5 联动护栏对照：上界 ≥ 空闲阈值不 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      resolveReclaimConfig({
        [TAIJI_RUNTIME_PI_RECLAIM_IDLE_MS]: String(2 * 60 * 60 * 1000),
        [TAIJI_RUNTIME_PI_RECLAIM_FORM_MAX_AGE_MS]: String(6 * 60 * 60 * 1000),
      })
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('exemption is unreachable'))).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('v6 上界旋钮：非数字回落默认（含其余非法形态）', () => {
    expect(resolveReclaimConfig({ [TAIJI_RUNTIME_PI_RECLAIM_FORM_MAX_AGE_MS]: 'abc' }).pendingUiRequestMaxAgeMs)
      .toBe(DEFAULT_PI_RECLAIM_FORM_MAX_AGE_MS)
    expect(resolveReclaimConfig({ [TAIJI_RUNTIME_PI_RECLAIM_FORM_MAX_AGE_MS]: '0' }).pendingUiRequestMaxAgeMs)
      .toBe(DEFAULT_PI_RECLAIM_FORM_MAX_AGE_MS)
  })

  it.each([
    ['负数', '-1000'],
    ['零', '0'],
    ['非数字', 'abc'],
    ['空串', ''],
    ['NaN 字面量', 'NaN'],
    ['Infinity', 'Infinity'],
  ])('非法值（%s）回落默认', (_label, raw) => {
    const cfg = resolveReclaimConfig({ [TAIJI_RUNTIME_PI_RECLAIM_TICK_MS]: raw })
    expect(cfg.tickIntervalMs).toBe(DEFAULT_PI_RECLAIM_TICK_MS)
  })

  it('非法值只影响自身旋钮，其余合法项正常透传', () => {
    const cfg = resolveReclaimConfig({
      [TAIJI_RUNTIME_PI_RECLAIM_IDLE_MS]: 'not-a-number',
      [TAIJI_RUNTIME_PI_RECLAIM_TICK_MS]: '60000',
    })
    expect(cfg.idleThresholdMs).toBe(DEFAULT_PI_RECLAIM_IDLE_MS)
    expect(cfg.tickIntervalMs).toBe(60000)
    expect(cfg.viewedWindowMs).toBe(DEFAULT_PI_RECLAIM_VIEWED_WINDOW_MS)
  })
})
