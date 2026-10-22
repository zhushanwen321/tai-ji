/**
 * WoolManager 单测（wool-provider 设计 D2/D6 ②③）。
 *
 * 覆盖（任务书目标 6）：
 * - 清单拉取失败 → 安装阻断不直装（unreachable/bad_shape/family_absent 三态）
 * - 清单成功 → 钉版本安装（npm:<pkg>@<version> 经既有 installExtension）
 * - 管理专用会话即起即收（一次编排 create 一次 + finally delete 回收；checkin
 *   同会话两条指令只起一次会话）
 * - 管理响应 envelope 解析（getEntries 内存态 custom entry）+ extension_missing/
 *   not_logged_in 错误分流
 * - 状态缓存（detect/account 进缓存、快照组装、settings 读写）
 * - 目录缓存持久化（wool-catalog.json 落盘 → 重启恢复 → listWoolProviderInfos 聚合源）
 * - runAction 成功后 wool.state 广播出口
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/services/__tests__/wool-manager.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage, WoolFamilyState } from '@taiji/shared'
import { WoolManager, type WoolExtensionPort, type WoolModelsEntryPort, type WoolSessionPort, type WoolSettingsPort } from '../wool-manager.js'

// ── 桩基建 ─────────────────────────────────────────────────────────────

interface SessionCall { kind: 'create' | 'delete'; sid?: string; label?: string; hidden?: boolean }  // oe-exempt:20261022:test:测试内会话调用记录形状，仅本文件消费

function makeSessionPort(overrides: Partial<WoolSessionPort> = {}) {
  const calls: SessionCall[] = []
  let nextSid = 0
  const entriesBySid = new Map<string, unknown[]>()
  const port: WoolSessionPort = {
    create: async (_cwd: string, label?: string, options?: { hidden?: boolean }) => {
      const sid = `sid-${++nextSid}`
      calls.push({ kind: 'create', sid, label, hidden: options?.hidden })
      return { id: sid } as Awaited<ReturnType<WoolSessionPort['create']>>
    },
    delete: async (sid: string) => {
      calls.push({ kind: 'delete', sid })
      entriesBySid.delete(sid)
    },
    getRpcClient: (sid: string) => ({
      getEntries: async () => ({ data: { entries: entriesBySid.get(sid) ?? [] } }),
    }) as Awaited<ReturnType<WoolSessionPort['getRpcClient']>>,
    sendSystemCommand: async () => ({ kind: 'sent' as const }),
    ...overrides,
  }
  return { port, calls, entriesBySid }
}

function makeExtPort(scan: Array<{ name: string; version: string; enabled: boolean }>, installed: string[] = []) {
  const installs: string[] = []
  const uninstalls: string[] = []
  const port: WoolExtensionPort = {
    scanExtensions: async () => scan,
    installExtension: async (source: string) => {
      installs.push(source)
      installed.push(source.replace(/^npm:@[^@]+@/, ''))
    },
    uninstallExtension: async (name: string) => {
      uninstalls.push(name)
      // 模拟既有链：卸载后 scanExtensions 不再返回该包。
      const idx = scan.findIndex((ext) => ext.name === name)
      if (idx >= 0) scan.splice(idx, 1)
    },
  }
  return { port, installs, uninstalls }
}

function makeSettingsPort(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = initial
  const port: WoolSettingsPort = {
    read: () => data as never,
    write: (d) => { data = { families: d.families } as never },
  }
  return { port, read: () => data }
}

/**
 * models.json 羊毛条目 port 内存桩（凭据通道 D2）：条目表 + hasCredentials 按 apiKey
 * 事实判。真实写入器防线（损坏拒入）由「models.json 真实写入器」describe 块经
 * setModelsPath/setSettingsPath 重定向到 mkdtemp 覆盖。
 */
function makeModelsEntryPort(initial: Record<string, Record<string, unknown>> = {}) {
  const entries = new Map<string, Record<string, unknown>>(Object.entries(initial))
  const port: WoolModelsEntryPort = {
    readEntry: (id) => {
      const entry = entries.get(id)
      return entry !== undefined ? JSON.parse(JSON.stringify(entry)) : undefined
    },
    writeEntry: (id, entry) => { entries.set(id, JSON.parse(JSON.stringify(entry))) },
    deleteEntry: (id) => {
      const prev = entries.get(id)
      const hadApiKey = prev !== undefined && typeof prev.apiKey === 'string' && (prev.apiKey as string).length > 0
      entries.delete(id)
      return hadApiKey
    },
    hasCredentials: (id) => {
      const entry = entries.get(id)
      return entry !== undefined && typeof entry.apiKey === 'string' && (entry.apiKey as string).length > 0
    },
  }
  return { port, entries }
}

/** 管理响应 custom entry（wool-shared manage-protocol 回写形态镜像）。 */
function manageEntry(family: string, response: unknown) {
  return { type: 'custom', customType: 'wool-manage-response', data: { family, response } }
}

/** extract/authorize 成功回包（凭据通道 D2 契约形态）。 */
const CREDENTIALS_OK = {
  v: 1, ok: true,
  data: {
    credentials: { apiKey: 'sk-wool-1', refreshToken: 'rt-wool-1' },
    account: { displayName: 'demo-user' },
    expiresAt: 1_800_000_000_000,
  },
}

function manifestBody(families: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    generatedAt: 1,
    families: {
      qoder: { pkg: '@zhushanwen/pi-wool-qoder', version: '0.2.0', displayName: 'Qoder', vendor: '阿里', credentialsSource: 'ide-extract', riskNotice: 'r' },
      workbuddy: { pkg: '@zhushanwen/pi-wool-workbuddy', version: '0.3.0', displayName: 'WorkBuddy', vendor: '腾讯', credentialsSource: 'oauth', riskNotice: 'r' },
      ...families,
    },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// ── 组装 ───────────────────────────────────────────────────────────────

let dataDir: string

function assemble(opts: {
  fetchFn?: typeof fetch
  extScan?: Array<{ name: string; version: string; enabled: boolean }>
  installed?: string[]
  sessionOverrides?: Partial<WoolSessionPort>
  /** 单指令响应等待上界（固定时钟下轮询超时判定依赖它；默认不注入 = 用例 getEntries 首查即中，轮询首轮返回） */
  manageResponseWaitMs?: number
  /** settings 羊毛域预置（adopted/autoCheckin 用例形态）。 */
  settingsInitial?: Record<string, unknown>
  /** models.json 羊毛条目 port（缺省 = 内存桩；真实写入器用例经此注入 setModelsPath 重定向的实装）。 */
  modelsEntry?: WoolModelsEntryPort
  /** 每日签到提醒定时器延迟（0 = 立即触发，定时器接线用例）。 */
  dailyCheckinDelayMs?: number
} = {}) {
  const session = makeSessionPort(opts.sessionOverrides)
  const ext = makeExtPort(opts.extScan ?? [{ name: '@zhushanwen/pi-wool-qoder', version: '0.2.0', enabled: true }], opts.installed ?? [])
  const settings = makeSettingsPort(opts.settingsInitial)
  const modelsEntry = opts.modelsEntry ?? makeModelsEntryPort().port
  const broadcasts: Array<ServerMessage<'wool.state'> | ServerMessage<'wool.authorize_url'>> = []
  const manager = new WoolManager({
    sessionService: session.port,
    extensionService: ext.port,
    settings: settings.port,
    modelsEntry,
    dataDir,
    broadcast: (msg) => broadcasts.push(msg),
    fetchFn: opts.fetchFn ?? (async () => jsonResponse(manifestBody())),
    now: (() => 1_700_000_000_000) as () => number,
    ...(opts.manageResponseWaitMs !== undefined ? { manageResponseWaitMs: opts.manageResponseWaitMs } : {}),
    ...(opts.dailyCheckinDelayMs !== undefined ? { dailyCheckinDelayMs: opts.dailyCheckinDelayMs } : {}),
  })
  return { manager, session, ext, settings, modelsEntry, broadcasts }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wool-manager-test-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── 清单拉取（D2：失败阻断不直装）────────────────────────────────────

describe('清单拉取与安装编排', () => {
  it('清单不可达 → install 回 unreachable 结构化错误 + installExtension 未被调（阻断不直装）', async () => {
    const { manager, ext } = assemble({ fetchFn: async () => new Response('nope', { status: 503 }) })
    const reply = await manager.runAction({ action: 'install', family: 'qoder' })
    expect(reply).toEqual({ ok: false, error: { code: 'unreachable', message: expect.stringContaining('HTTP 503') } })
    expect(ext.installs).toEqual([])
  })

  it('清单 schema 损坏 → bad_shape 阻断', async () => {
    const { manager, ext } = assemble({ fetchFn: async () => jsonResponse({ schemaVersion: 9 }) })
    const reply = await manager.runAction({ action: 'install', family: 'qoder' })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe('bad_shape')
    expect(ext.installs).toEqual([])
  })

  it('清单缺家族条目 → family_absent', async () => {
    const { manager } = assemble({ fetchFn: async () => jsonResponse(manifestBody({ qoder: undefined })) })
    const reply = await manager.runAction({ action: 'install', family: 'qoder' })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe('family_absent')
  })

  it('清单成功 → 钉版本安装（npm:<pkg>@<version>）+ 安装态扫描 + installedVersion 回执', async () => {
    const { manager, ext } = assemble()
    const reply = await manager.runAction({ action: 'install', family: 'qoder' })
    expect(reply).toEqual({ ok: true, data: { installedVersion: '0.2.0' } })
    expect(ext.installs).toEqual(['npm:@zhushanwen/pi-wool-qoder@0.2.0'])
  })

  it('安装链成功但扫描未见 → install_failed 如实报（不假装成功）', async () => {
    const { manager, ext } = assemble({ extScan: [], installed: ['@zhushanwen/pi-wool-qoder'] })
    const reply = await manager.runAction({ action: 'install', family: 'qoder' })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe('install_failed')
    expect(ext.installs).toHaveLength(1)
  })
})

// ── 管理专用会话（D6 ②：hidden 即起即收）─────────────────────────────

describe('管理专用会话生命周期', () => {
  it('detect 编排 = hidden 创建一次 + finally 回收一次（即起即收，无常驻）', async () => {
    const { manager, session } = assemble()
    session.entriesBySid.set('sid-1', [manageEntry('qoder', { v: 1, ok: true, data: { detected: true } })])
    const reply = await manager.runAction({ action: 'detect', family: 'qoder' })
    expect(reply).toEqual({ ok: true, data: { detected: true, fetchedAt: 1_700_000_000_000 } })
    const creates = session.calls.filter((c) => c.kind === 'create')
    const deletes = session.calls.filter((c) => c.kind === 'delete')
    expect(creates).toEqual([{ kind: 'create', sid: 'sid-1', label: 'wool-manage-qoder', hidden: true }])
    expect(deletes).toEqual([{ kind: 'delete', sid: 'sid-1' }])
  })

  it('checkin 编排 = 同会话两条指令（checkin + status），会话只起一次', async () => {
    const { manager, session } = assemble()
    const sendCalls: string[] = []
    // sendSystemCommand 记录指令序列；第一次（checkin）与第二次（status）都回 sent，
    // getEntries 按「最新一条在树尾」先后返回两段响应——用计数器轮转 entries。
    let seq = 0
    const responses = [
      [manageEntry('qoder', { v: 1, ok: true, data: { checked: true } })],
      [manageEntry('qoder', { v: 1, ok: true, data: { loggedIn: true, fetchedAt: 5 } })],
    ]
    const port: WoolSessionPort = {
      create: session.port.create,
      delete: session.port.delete,
      getRpcClient: (sid: string) => ({
        // 第 N 次指令（sendSystemCommand 后 seq=N）读第 N 段响应（seq-1；sendSystemCommand 先于 getEntries）
        getEntries: async () => ({ data: { entries: responses[Math.min(Math.max(seq - 1, 0), responses.length - 1)] } }),
      }) as Awaited<ReturnType<WoolSessionPort['getRpcClient']>>,
      sendSystemCommand: async (_sid: string, commandLine: string) => {
        sendCalls.push(commandLine.split(' ')[0])
        seq++
        return { kind: 'sent' as const }
      },
    }
    const manager2 = new WoolManager({
      sessionService: port,
      extensionService: makeExtPort([]).port,
      settings: makeSettingsPort().port,
      modelsEntry: makeModelsEntryPort().port,
      dataDir,
      broadcast: () => {},
      now: () => 1,
    })
    void manager
    void session
    const reply = await manager2.runAction({ action: 'checkin', family: 'qoder' })
    expect(reply.ok).toBe(true)
    // 两条指令（一次编排 = 一批连续指令一会话）；命令行须带 "/" 前缀——pi 命令分发
    // 只认 startsWith("/")（真机实证：裸名被当用户消息进 LLM turn，handler 永不执行）。
    expect(sendCalls).toEqual(['/wool-qoder', '/wool-qoder'])
    expect(manager2.getSnapshot().families.find((f) => f.family === 'qoder')?.account?.loggedIn).toBe(true)
  })

  it('扩展命令未注册 → extension_missing（安装态前置引导）', async () => {
    const { manager } = assemble({ sessionOverrides: { sendSystemCommand: async () => ({ kind: 'extension-missing' as const }) } })
    const reply = await manager.runAction({ action: 'status', family: 'qoder' })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe('extension_missing')
  })

  it('指令送达但无响应 entry → internal（可重试指引）', async () => {
    // manageResponseWaitMs=0：等待上界耗尽即报——固定时钟（now 恒值）下 deadline=now，
    // 首查无 entry 立即走超时分支（不注入会因 deadline 恒未到而无限轮询）。
    const { manager } = assemble({ manageResponseWaitMs: 0 })
    const reply = await manager.runAction({ action: 'detect', family: 'qoder' })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe('internal')
  })

  it('响应 entry 延迟落树 → 轮询命中返回（prompt 受理口径 ≠ handler 已执行）', async () => {
    // getEntries 首查空、次查返回——模拟真机时序（entry 在 prompt resolve 之后到达）。
    // 固定时钟下 deadline 恒未到，轮询推进由 mock 换面驱动；命中即返回，不依赖时钟推进。
    let first = true
    const base = makeSessionPort()
    const port: WoolSessionPort = {
      ...base.port,
      getRpcClient: ((sid: string) => ({
        getEntries: async () =>
          first
            ? ((first = false), { data: { entries: [] } })
            : { data: { entries: [manageEntry('qoder', { v: 1, ok: true, data: { detected: true } })] } },
      })) as unknown as WoolSessionPort['getRpcClient'],
    }
    const manager = new WoolManager({
      sessionService: port,
      extensionService: makeExtPort([]).port,
      settings: makeSettingsPort().port,
      modelsEntry: makeModelsEntryPort().port,
      dataDir,
      broadcast: () => {},
      now: (() => 1_700_000_000_000) as () => number,
      manageResponsePollIntervalMs: 1,
    })
    const reply = await manager.runAction({ action: 'detect', family: 'qoder' })
    expect(reply.ok).toBe(true)
    if (reply.ok) expect(manager.getSnapshot().families.find((f) => f.family === 'qoder')?.detect?.detected).toBe(true)
  })
})

// ── 状态缓存与快照 ────────────────────────────────────────────────────

describe('状态缓存与快照组装', () => {
  it('status 成功 → accountCache 更新 + 快照反映 + wool.state 广播出口被调', async () => {
    const { manager, session, broadcasts } = assemble()
    session.entriesBySid.set('sid-1', [
      manageEntry('qoder', { v: 1, ok: true, data: { loggedIn: true, nickname: 'demo', quota: { used: 1, total: 10, unit: 'credits' }, fetchedAt: 5 } }),
    ])
    const reply = await manager.runAction({ action: 'status', family: 'qoder' })
    expect(reply.ok).toBe(true)
    const fam = manager.getSnapshot().families.find((f) => f.family === 'qoder')
    expect(fam?.account).toMatchObject({ loggedIn: true, nickname: 'demo' })
    // 动作后 wool.state 广播（payload 无 sessionId 纯全局帧）
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].type).toBe('wool.state')
    if (broadcasts[0].type === 'wool.state') {
      expect(broadcasts[0].payload.snapshot.families.some((f) => f.family === 'qoder' && f.account?.nickname === 'demo')).toBe(true)
    }
  })

  it('status 回 not_logged_in → accountCache 落 loggedIn:false + not_logged_in 错误回（合法状态面）', async () => {
    const { manager, session } = assemble()
    session.entriesBySid.set('sid-1', [
      manageEntry('qoder', { v: 1, ok: false, error: { code: 'not_logged_in', message: 'no credentials' } }),
    ])
    const reply = await manager.runAction({ action: 'status', family: 'qoder' })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe('not_logged_in')
    expect(manager.getSnapshot().families.find((f) => f.family === 'qoder')?.account).toEqual({ loggedIn: false, fetchedAt: 1_700_000_000_000 })
  })

  it('setAutoCheckin → settings 羊毛域写入 + 快照回读（默认关）', async () => {
    const { manager, settings } = assemble()
    expect(manager.getSnapshot().families.find((f) => f.family === 'workbuddy')?.autoCheckin).toBe(false)
    await manager.runAction({ action: 'setAutoCheckin', family: 'workbuddy', params: { enabled: true } })
    expect(manager.getSnapshot().families.find((f) => f.family === 'workbuddy')?.autoCheckin).toBe(true)
    expect(settings.read()).toEqual({ families: { workbuddy: { autoCheckin: true } } } as never)
  })

  it('updateAvailable 派生（D2 更新角标数据源）：已装版本 = 清单版本 → 无标记；版本落后 → true', async () => {
    // assemble 缺省 extScan qoder@0.2.0 与清单 0.2.0 一致 → 无标记。
    const sameVersion = assemble()
    await sameVersion.manager.initialize()
    const fresh = sameVersion.manager.getSnapshot().families.find((f) => f.family === 'qoder')
    expect(fresh?.updateAvailable).toBeUndefined()

    // 已装 0.1.0 < 清单 0.2.0 → updateAvailable=true。
    const older = assemble({ extScan: [{ name: '@zhushanwen/pi-wool-qoder', version: '0.1.0', enabled: true }] })
    await older.manager.initialize()
    expect(older.manager.getSnapshot().families.find((f) => f.family === 'qoder')?.updateAvailable).toBe(true)
  })

  it('词表外家族 → invalid_request', async () => {
    const { manager } = assemble()
    const reply = await manager.runAction({ action: 'status', family: 'nope' as never })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe('invalid_request')
  })
})

// ── 目录缓存持久化 + 聚合源（D6 ③）───────────────────────────────────

describe('目录缓存与聚合源', () => {
  /** 带 getAvailableModels 探测面的 rpc client 桩（refresh 目录数据源）。 */
  function clientWithModels(models: unknown[]) {
    return {
      getEntries: async () => ({ data: { entries: [] } }),
      getAvailableModels: async () => models,
    }
  }

  it('refresh 目录 → wool-catalog.json 原子落盘 + listWoolProviderInfos 输出羊毛条目（provider 过滤）', async () => {
    const session = makeSessionPort()
    const manager = new WoolManager({
      sessionService: { ...session.port, getRpcClient: () => clientWithModels([
        { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', provider: 'wool-qoder', reasoning: true },
        { id: 'other-model', name: 'Other', provider: 'someone-else' },
      ]) } as unknown as WoolSessionPort, // 桩 client 仅消费面成员，经 unknown 中转（见 wool-manager refreshCatalog 探测窄化）
      extensionService: makeExtPort([]).port,
      settings: makeSettingsPort().port,
      modelsEntry: makeModelsEntryPort().port,
      dataDir,
      broadcast: () => {},
      now: () => 42,
    })
    const reply = await manager.runAction({ action: 'refresh', family: 'qoder' })
    expect(reply.ok).toBe(true)
    // 落盘形态（families → models + fetchedAt；非羊毛 provider 被过滤）
    const raw = JSON.parse(readFileSync(join(dataDir, 'wool-catalog.json'), 'utf8'))
    expect(raw.families.qoder.models).toEqual([
      { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', reasoning: true },
    ])
    expect(raw.families.qoder.fetchedAt).toBe(42)
    // 聚合源：羊毛条目进 ProviderInfo 形态
    const infos = manager.listWoolProviderInfos()
    expect(infos).toHaveLength(1)
    expect(infos[0].id).toBe('wool-qoder')
    expect(infos[0].models).toEqual([{ id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', reasoning: true }])
  })

  it('重启恢复：initialize 读 wool-catalog.json → 无网络无会话仍可输出聚合条目（离线可见，S12）', async () => {
    // 先落一份缓存
    const session = makeSessionPort()
    const preManager = new WoolManager({
      sessionService: { ...session.port, getRpcClient: () => clientWithModels([{ id: 'hy3', name: 'HY3', provider: 'wool-workbuddy' }]) } as unknown as WoolSessionPort,
      extensionService: makeExtPort([]).port,
      settings: makeSettingsPort().port,
      modelsEntry: makeModelsEntryPort().port,
      dataDir,
      broadcast: () => {},
      now: () => 7,
    })
    await preManager.runAction({ action: 'refresh', family: 'workbuddy' })
    expect(existsSync(join(dataDir, 'wool-catalog.json'))).toBe(true)

    // 新实例（模拟重启）：initialize 恢复缓存 + best-effort 拉清单（此处无网 → 清单失败
    // 只降级不阻断——updateAvailable 角标暂不派生），零会话即可读聚合源。
    const fresh = assemble({ fetchFn: async () => { throw new Error('network down — manifest degrade tolerated') } })
    await fresh.manager.initialize()
    const infos = fresh.manager.listWoolProviderInfos()
    expect(infos).toHaveLength(1)
    expect(infos[0].id).toBe('wool-workbuddy')
    expect(infos[0].models[0].id).toBe('hy3')
    // 快照目录视图带数据时点（「无会话时设置页读缓存展示」的时点来源）
    const fam = fresh.manager.getSnapshot().families.find((f) => f.family === 'workbuddy') as WoolFamilyState
    expect(fam.catalog?.fetchedAt).toBe(7)
  })
})

// ── 卸载编排（D3：clear 扩展侧副本 → models.json 条目删除 → 包卸载 → 羊毛域清除）──

describe('卸载编排（D3 + 凭据通道 D2）', () => {
  it('干净卸载：clear 指令送达 → models.json 条目删除 → 包卸载 → settings 羊毛域与缓存全清 + 聚合源条目消失', async () => {
    // 预置接入态 + 目录缓存 + models.json 凭据条目（卸载后断言全部清理）。
    const modelsEntry = makeModelsEntryPort({ 'wool-qoder': { name: 'Qoder', apiKey: 'sk-old', headers: { 'x-wool-refresh-token': 'rt' } } })
    const { manager, session, ext } = assemble({
      extScan: [{ name: '@zhushanwen/pi-wool-qoder', version: '0.2.0', enabled: true }],
      settingsInitial: { families: { qoder: { adopted: true } } },
      modelsEntry: modelsEntry.port,
    })
    // 先经 refresh 落一份目录缓存（聚合源有条目）。
    const refreshSession = makeSessionPort()
    const refreshManager = new WoolManager({
      sessionService: { ...refreshSession.port, getRpcClient: () => ({ getEntries: async () => ({ data: { entries: [] } }), getAvailableModels: async () => [{ id: 'hy3', name: 'HY3', provider: 'wool-qoder' }] }) } as unknown as WoolSessionPort,
      extensionService: ext.port,
      settings: makeSettingsPort({ families: { qoder: { adopted: true } } }).port,
      modelsEntry: modelsEntry.port,
      dataDir,
      broadcast: () => {},
      now: () => 1,
    })
    await refreshManager.runAction({ action: 'refresh', family: 'qoder' })
    expect(refreshManager.listWoolProviderInfos()).toHaveLength(1)

    // 卸载编排：管理会话 clear 响应预置（cleared=进程内副本已清，persistCleared=目录已删）。
    session.entriesBySid.set('sid-1', [manageEntry('qoder', { v: 1, ok: true, data: { cleared: true, persistCleared: true } })])
    const reply = await manager.runAction({ action: 'uninstall', family: 'qoder' })
    expect(reply.ok).toBe(true)
    if (reply.ok) {
      // 凭据通道 D2：models.json 条目删除成功 → credentialsCleared=true（无残留提示）。
      const data = reply.data as { credentialsCleared: boolean; residualHint?: string }
      expect(data.credentialsCleared).toBe(true)
      expect(data.residualHint).toBeUndefined()
    }
    // models.json 羊毛条目已删除（apiKey 随条目清除）。
    expect(modelsEntry.port.hasCredentials('wool-qoder')).toBe(false)
    expect(modelsEntry.port.readEntry('wool-qoder')).toBeUndefined()
    expect(ext.uninstalls).toEqual(['@zhushanwen/pi-wool-qoder'])
    // 既有卸载链语义：卸载后 scanExtensions 不再返回该包。
    const scanned = await ext.port.scanExtensions()
    expect(scanned.some((e) => e.name === '@zhushanwen/pi-wool-qoder')).toBe(false)
    // settings 羊毛域该家族清除 + 快照回落。
    expect(manager.getSnapshot().families.find((f) => f.family === 'qoder')?.adopted).toBe(false)
    // 独立实例（同 dataDir 模拟重启）读目录缓存文件 → 无该家族（缓存文件已重写）。
    const after = assemble({ extScan: [] })
    await after.manager.initialize()
    expect(after.manager.listWoolProviderInfos()).toHaveLength(0)
  })

  it('条目本就不存在（从未接入凭据）→ credentialsCleared=true 空清除形态（无残留提示）', async () => {
    const session = makeSessionPort()
    const manager = new WoolManager({
      sessionService: session.port,
      extensionService: makeExtPort([{ name: '@zhushanwen/pi-wool-workbuddy', version: '0.3.0', enabled: true }]).port,
      settings: makeSettingsPort({ families: { workbuddy: { adopted: true } } }).port,
      modelsEntry: makeModelsEntryPort().port,
      dataDir,
      broadcast: () => {},
      now: () => 1,
    })
    session.entriesBySid.set('sid-1', [manageEntry('workbuddy', { v: 1, ok: true, data: { cleared: false, persistCleared: true } })])
    const reply = await manager.runAction({ action: 'uninstall', family: 'workbuddy' })
    expect(reply.ok).toBe(true)
    if (reply.ok) {
      const data = reply.data as { credentialsCleared: boolean; residualHint?: string }
      expect(data.credentialsCleared).toBe(true)
      expect(data.residualHint).toBeUndefined()
    }
  })

  it('models.json 条目删除被拒（损坏降级态）→ 卸载照常完成 + credentialsCleared=false 残留提示（不静默）', async () => {
    const modelsEntry = makeModelsEntryPort({ 'wool-qoder': { apiKey: 'sk-old' } })
    modelsEntry.port.deleteEntry = () => { throw new Error('models.json 已损坏，拒绝写入') }
    const { manager, ext } = assemble({
      extScan: [{ name: '@zhushanwen/pi-wool-qoder', version: '0.2.0', enabled: true }],
      sessionOverrides: { sendSystemCommand: async () => ({ kind: 'extension-missing' as const }) },
      modelsEntry: modelsEntry.port,
    })
    const reply = await manager.runAction({ action: 'uninstall', family: 'qoder' })
    expect(reply.ok).toBe(true)
    if (reply.ok) {
      const data = reply.data as { credentialsCleared: boolean; residualHint?: string }
      expect(data.credentialsCleared).toBe(false)
      expect(data.residualHint).toContain('wool-qoder')
      expect(data.residualHint).toContain('models.json')
    }
    // 主链不受降级影响：包卸载照常。
    expect(ext.uninstalls).toEqual(['@zhushanwen/pi-wool-qoder'])
  })

  it('卸载链失败 → uninstall_failed 结构化错误', async () => {
    const ext = makeExtPort([{ name: '@zhushanwen/pi-wool-qoder', version: '0.2.0', enabled: true }])
    ext.port.uninstallExtension = async () => { throw new Error('npm unlink boom') }
    const session = makeSessionPort()
    const manager = new WoolManager({
      sessionService: session.port,
      extensionService: ext.port,
      settings: makeSettingsPort({ families: { qoder: { adopted: true } } }).port,
      modelsEntry: makeModelsEntryPort().port,
      dataDir,
      broadcast: () => {},
      now: () => 1,
    })
    session.entriesBySid.set('sid-1', [manageEntry('qoder', { v: 1, ok: true, data: {} })])
    const reply = await manager.runAction({ action: 'uninstall', family: 'qoder' })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe('uninstall_failed')
  })
})

// ── 凭据编排（extract/authorize，凭据通道 D2：models.json 羊毛条目）────────

describe('凭据编排（extract/authorize → models.json 条目 + 账号态点亮）', () => {
  it('extract 成功 → models.json 条目幂等写入（name/apiKey/refreshToken headers）+ adopted + 账号态点亮 + 回执不含 apiKey', async () => {
    const modelsEntry = makeModelsEntryPort({ 'wool-qoder': { baseUrl: 'https://keep.example' } })
    const { manager, session } = assemble({ modelsEntry: modelsEntry.port })
    // initialize 拉清单（name 取清单显示名的前提；向导真实时序 = install 后 extract，
    // 清单已就位）。
    await manager.initialize()
    session.entriesBySid.set('sid-1', [manageEntry('qoder', CREDENTIALS_OK)])
    const reply = await manager.runAction({ action: 'extract', family: 'qoder' })
    expect(reply.ok).toBe(true)
    if (reply.ok) {
      // 回执只携安全摘要——凭据不出 models.json。
      expect(reply.data).toEqual({
        credentialsStored: true,
        account: { displayName: 'demo-user' },
        expiresAt: 1_800_000_000_000,
      })
    }
    // 条目形态：保留他方键（baseUrl）+ 最小凭据形态（name 取清单显示名）。
    expect(modelsEntry.port.readEntry('wool-qoder')).toEqual({
      baseUrl: 'https://keep.example',
      name: 'Qoder',
      apiKey: 'sk-wool-1',
      headers: { 'x-wool-refresh-token': 'rt-wool-1' },
    })
    expect(modelsEntry.port.hasCredentials('wool-qoder')).toBe(true)
    // adopted 置位 + 账号缓存即时点亮（displayName/expiresAt 入状态）。
    expect(manager.getSnapshot().families.find((f) => f.family === 'qoder')?.adopted).toBe(true)
    expect(manager.getSnapshot().families.find((f) => f.family === 'qoder')?.account).toMatchObject({
      loggedIn: true, nickname: 'demo-user', tokenExpiresAt: 1_800_000_000_000,
    })
  })

  it('二次 extract 无 refreshToken → 旧 refresh 键删除（幂等 = 条目反映本次凭据集）；headers 空则省键', async () => {
    const modelsEntry = makeModelsEntryPort()
    const { manager, session } = assemble({ modelsEntry: modelsEntry.port })
    await manager.initialize()
    session.entriesBySid.set('sid-1', [manageEntry('qoder', CREDENTIALS_OK)])
    await manager.runAction({ action: 'extract', family: 'qoder' })
    // 第二次编排 spawn 新会话（sid-2）——响应 entry 挂新 sid。
    session.entriesBySid.set('sid-2', [manageEntry('qoder', {
      v: 1, ok: true, data: { credentials: { apiKey: 'sk-wool-2' } },
    })])
    const reply = await manager.runAction({ action: 'extract', family: 'qoder' })
    expect(reply.ok).toBe(true)
    expect(modelsEntry.port.readEntry('wool-qoder')).toEqual({ name: 'Qoder', apiKey: 'sk-wool-2' })
  })

  it('extract 成功但回包缺凭据载荷 → internal（读侧不信任扩展回包）', async () => {
    const modelsEntry = makeModelsEntryPort()
    const { manager, session } = assemble({ modelsEntry: modelsEntry.port })
    session.entriesBySid.set('sid-1', [manageEntry('qoder', { v: 1, ok: true, data: { foo: 1 } })])
    const reply = await manager.runAction({ action: 'extract', family: 'qoder' })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe('internal')
    expect(modelsEntry.port.readEntry('wool-qoder')).toBeUndefined()
  })

  it('旧扩展回 invalid_request（Unknown action 文案）→ extract_unavailable / authorize_unavailable（协议未就绪分流）', async () => {
    const { manager, session } = assemble()
    await manager.initialize()
    session.entriesBySid.set('sid-1', [manageEntry('qoder', { v: 1, ok: false, error: { code: 'invalid_request', message: 'Unknown action "extract"; expected one of status, detect, checkin, clear. Expected: /wool-qoder {...}' } })])
    const extractReply = await manager.runAction({ action: 'extract', family: 'qoder' })
    expect(extractReply.ok).toBe(false)
    if (!extractReply.ok) expect(extractReply.error.code).toBe('extract_unavailable')

    session.entriesBySid.set('sid-2', [manageEntry('workbuddy', { v: 1, ok: false, error: { code: 'invalid_request', message: 'Unknown action "authorize"; expected one of status, detect, checkin, clear.' } })])
    const authorizeReply = await manager.runAction({ action: 'authorize', family: 'workbuddy' })
    expect(authorizeReply.ok).toBe(false)
    if (!authorizeReply.ok) expect(authorizeReply.error.code).toBe('authorize_unavailable')
  })

  it('invalid_request 非 Unknown action 文案（家族凭据策略不支持）→ action_not_supported 分流', async () => {
    const { manager, session } = assemble()
    session.entriesBySid.set('sid-1', [manageEntry('workbuddy', {
      v: 1, ok: false,
      error: { code: 'invalid_request', message: 'WorkBuddy is an OAuth family: run the authorize action (browser sign-in), not local extraction' },
    })])
    const reply = await manager.runAction({ action: 'extract', family: 'workbuddy' })
    expect(reply.ok).toBe(false)
    if (!reply.ok) {
      expect(reply.error.code).toBe('action_not_supported')
      expect(reply.error.message).toContain('authorize')
    }
  })

  it('authorize 回 internal + cancelled 文案（扩展取消终态）→ cancelled 转译（向导回待授权态）', async () => {
    const { manager, session } = assemble()
    session.entriesBySid.set('sid-1', [manageEntry('workbuddy', {
      v: 1, ok: false,
      error: { code: 'internal', message: 'WorkBuddy login cancelled: overlay cancel signal' },
    })])
    const reply = await manager.runAction({ action: 'authorize', family: 'workbuddy' })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe('cancelled')
  })

  it('authorize 成功（全载荷）→ 凭据落库同 extract', async () => {
    const modelsEntry = makeModelsEntryPort()
    const { manager, session } = assemble({ modelsEntry: modelsEntry.port })
    await manager.initialize()
    session.entriesBySid.set('sid-1', [manageEntry('workbuddy', CREDENTIALS_OK)])
    const reply = await manager.runAction({ action: 'authorize', family: 'workbuddy' })
    expect(reply.ok).toBe(true)
    expect(modelsEntry.port.readEntry('wool-workbuddy')).toEqual({
      name: 'WorkBuddy',
      apiKey: 'sk-wool-1',
      headers: { 'x-wool-refresh-token': 'rt-wool-1' },
    })
    expect(manager.getSnapshot().families.find((f) => f.family === 'workbuddy')?.adopted).toBe(true)
  })

  /** wool-authorize 单行 JSON 通知（buildWoolAuthorizeNotice 契约形态）。 */
  function authorizeNotice(sidUrl: { authUrl: string; callbackUrl?: string; state?: string } = {
    authUrl: 'https://auth.workbuddy.example/oauth?state=xyz',
  }): string {
    return JSON.stringify({
      type: 'wool-authorize', family: 'workbuddy',
      authUrl: sidUrl.authUrl,
      callbackUrl: sidUrl.callbackUrl ?? 'http://127.0.0.1:45678/wool-auth/callback',
      state: sidUrl.state ?? 'st-1',
    })
  }

  it('授权通知 JSON 契约：在途窗口内 → callbackUrl/state 登记 + wool.authorize_url 广播；他 sid / 非 JSON / 家族不符零消费', async () => {
    const modelsEntry = makeModelsEntryPort()
    // 会话桩：首查 entries 空（触发轮询窗口）——在窗口内模拟扩展 notify 到达；
    // 次查返回 authorize 完成响应。
    let poll = 0
    const base = makeSessionPort()
    let notifyProbe: ((sid: string, message: string) => void) | undefined
    const port: WoolSessionPort = {
      ...base.port,
      getRpcClient: ((sid: string) => ({
        getEntries: async () => {
          poll += 1
          if (poll === 1) {
            // 在途窗口内：自家管理会话合法 JSON 通知 → 消费；他 sid / 非 JSON / 家族不符零消费。
            notifyProbe?.('sid-1', authorizeNotice())
            notifyProbe?.('sid-other', authorizeNotice())
            notifyProbe?.('sid-1', 'plain text page url https://auth.example/x')
            notifyProbe?.('sid-1', JSON.stringify({ type: 'other-kind', family: 'workbuddy', authUrl: 'https://x.example', callbackUrl: 'http://127.0.0.1:1/cb', state: 's' }))
            return { data: { entries: [] } }
          }
          return { data: { entries: [manageEntry('workbuddy', CREDENTIALS_OK)] } }
        },
      })) as unknown as WoolSessionPort['getRpcClient'],
    }
    const broadcasts: Array<ServerMessage<'wool.state'> | ServerMessage<'wool.authorize_url'>> = []
    const manager = new WoolManager({
      sessionService: port,
      extensionService: makeExtPort([]).port,
      settings: makeSettingsPort().port,
      modelsEntry: modelsEntry.port,
      dataDir,
      broadcast: (msg) => broadcasts.push(msg),
      now: () => 1_700_000_000_000,
      manageResponsePollIntervalMs: 1,
    })
    notifyProbe = (sid, message) => manager.noteExtensionNotify(sid, message)
    const reply = await manager.runAction({ action: 'authorize', family: 'workbuddy' })
    expect(reply.ok).toBe(true)
    // 恰一条授权 URL 广播（自家会话合法 JSON；他 sid / 纯文本 / type 不符各零条）。
    const urlFrames = broadcasts.filter((b) => b.type === 'wool.authorize_url')
    expect(urlFrames).toEqual([{
      type: 'wool.authorize_url',
      payload: { family: 'workbuddy', url: 'https://auth.workbuddy.example/oauth?state=xyz' },
    }])
    // 编排收尾后（会话已回收 + 窗口关闭）同 sid 的通知不再消费。
    const before = broadcasts.length
    manager.noteExtensionNotify('sid-1', authorizeNotice({ authUrl: 'https://late.example' }))
    expect(broadcasts.length).toBe(before)
  })

  it('authorizeSignal：done 202（未完成可重试）/ 200（完成）/ cancel / 窗外 invalid_request', async () => {
    // 信号目标 URL 断言素材 + 可编排响应码的 fetch 桩。
    const fetchedUrls: string[] = []
    let nextStatus = 202
    const modelsEntry = makeModelsEntryPort()
    const base = makeSessionPort()
    let notifyProbe: ((sid: string, message: string) => void) | undefined
    let signalEntries: unknown[] | undefined
    const port: WoolSessionPort = {
      ...base.port,
      getRpcClient: ((sid: string) => ({
        getEntries: async () => ({ data: { entries: signalEntries ?? [] } }),
      })) as unknown as WoolSessionPort['getRpcClient'],
    }
    const manager = new WoolManager({
      sessionService: port,
      extensionService: makeExtPort([]).port,
      settings: makeSettingsPort().port,
      modelsEntry: modelsEntry.port,
      dataDir,
      broadcast: () => {},
      now: () => 1_700_000_000_000,
      manageResponsePollIntervalMs: 1,
      // fetch 桩：manifest 正常回 + 信号端点按 nextStatus 回。
      fetchFn: (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input)
        if (url.includes('wool-auth/callback')) {
          fetchedUrls.push(url)
          return new Response('', { status: nextStatus })
        }
        return jsonResponse(manifestBody())
      }) as typeof fetch,
    })
    notifyProbe = (sid, message) => manager.noteExtensionNotify(sid, message)
    // authorize 编排挂起（响应 entry 延迟注入——信号测试窗口）。
    const authorizePromise = manager.runAction({ action: 'authorize', family: 'workbuddy' })
    // 等通知消费（callback 登记）落地：signal 成功即登记完成（确定性信号）。
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      notifyProbe?.('sid-1', authorizeNotice())
      const probe = await manager.runAction({ action: 'authorizeSignal', family: 'workbuddy', params: { status: 'done' } })
      if (probe.ok) break
    }

    // 202 = 未完成（completed=false，可重试）。
    nextStatus = 202
    const pending = await manager.runAction({ action: 'authorizeSignal', family: 'workbuddy', params: { status: 'done' } })
    expect(pending).toEqual({ ok: true, data: { completed: false } })

    // 200 = 扩展侧令牌交换完成（completed=true）。
    nextStatus = 200
    const done = await manager.runAction({ action: 'authorizeSignal', family: 'workbuddy', params: { status: 'done' } })
    expect(done).toEqual({ ok: true, data: { completed: true } })
    // 信号 URL 形态（callback-server 契约：?state=...&status=done）。
    expect(fetchedUrls.some((u) => u.includes('state=st-1') && u.includes('status=done'))).toBe(true)

    // 放行 authorize 响应（编排收尾 → 窗口关闭）。
    signalEntries = [manageEntry('workbuddy', CREDENTIALS_OK)]
    const authorizeReply = await authorizePromise
    expect(authorizeReply.ok).toBe(true)

    // 窗外信号 → invalid_request（authorizeCallback 已清）。
    const outside = await manager.runAction({ action: 'authorizeSignal', family: 'workbuddy', params: { status: 'done' } })
    expect(outside.ok).toBe(false)
    if (!outside.ok) expect(outside.error.code).toBe('invalid_request')
  })

  it('authorizeSignal cancel：信号送达 + URL 带 status=cancel', async () => {
    const fetchedUrls: string[] = []
    const modelsEntry = makeModelsEntryPort()
    const base = makeSessionPort()
    let notifyProbe: ((sid: string, message: string) => void) | undefined
    let signalEntries: unknown[] | undefined
    const port: WoolSessionPort = {
      ...base.port,
      getRpcClient: ((sid: string) => ({
        getEntries: async () => ({ data: { entries: signalEntries ?? [] } }),
      })) as unknown as WoolSessionPort['getRpcClient'],
    }
    const manager = new WoolManager({
      sessionService: port,
      extensionService: makeExtPort([]).port,
      settings: makeSettingsPort().port,
      modelsEntry: modelsEntry.port,
      dataDir,
      broadcast: () => {},
      now: () => 1_700_000_000_000,
      manageResponsePollIntervalMs: 1,
      fetchFn: (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input)
        if (url.includes('wool-auth/callback')) {
          fetchedUrls.push(url)
          return new Response('', { status: 200 })
        }
        return jsonResponse(manifestBody())
      }) as typeof fetch,
    })
    notifyProbe = (sid, message) => manager.noteExtensionNotify(sid, message)
    const authorizePromise = manager.runAction({ action: 'authorize', family: 'workbuddy' })
    // 等 callback 登记 + 发 cancel 信号（确定性信号 = fetchedUrls 出现 cancel URL）。
    let cancelReply: Awaited<ReturnType<typeof manager.runAction>> | undefined
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      notifyProbe?.('sid-1', authorizeNotice())
      cancelReply = await manager.runAction({ action: 'authorizeSignal', family: 'workbuddy', params: { status: 'cancel' } })
      if (cancelReply.ok) break
    }
    expect(cancelReply).toEqual({ ok: true, data: { cancelled: true } })
    expect(fetchedUrls.some((u) => u.includes('status=cancel'))).toBe(true)
    // authorize 随取消终态回执（cancelled 转译）。
    signalEntries = [manageEntry('workbuddy', { v: 1, ok: false, error: { code: 'internal', message: 'WorkBuddy login cancelled: overlay cancel signal' } })]
    const authorizeReply = await authorizePromise
    expect(authorizeReply.ok).toBe(false)
    if (!authorizeReply.ok) expect(authorizeReply.error.code).toBe('cancelled')
  })

  it('非授权窗（无 authorize 在途）的 extension:notify → 零编排零广播', () => {
    const { manager, broadcasts } = assemble()
    manager.noteExtensionNotify('sid-1', authorizeNotice())
    expect(broadcasts).toHaveLength(0)
  })
})

// ── models.json 真实写入器防线（组合根同款 port 装配 + mkdtemp 注入路径）────

describe('models.json 真实写入器（pi-provider-store 装配 + 损坏拒入）', () => {
  let modelsDir: string
  // 组合根同款 port 装配（index.ts woolManager.modelsEntry 的镜像——分层约束下
  // services 测试经 infra 函数直接组装，形态漂移由组合根评审兜底）。
  let realPort: WoolModelsEntryPort

  beforeEach(async () => {
    modelsDir = mkdtempSync(join(tmpdir(), 'wool-models-entry-test-'))
    const { setModelsPath, setSettingsPath, getProviderConfig, upsertProvider, removeProvider } = await import('../../infra/pi/pi-provider-store.js')
    setModelsPath(join(modelsDir, 'models.json'))
    setSettingsPath(join(modelsDir, 'settings.json'))
    realPort = {
      readEntry: (providerId) => getProviderConfig(providerId) as Record<string, unknown> | undefined,
      writeEntry: (providerId, entry) => {
        upsertProvider(providerId, entry as Parameters<typeof upsertProvider>[1])
      },
      deleteEntry: (providerId) => {
        const prev = getProviderConfig(providerId)
        const hadApiKey = prev !== undefined && typeof prev.apiKey === 'string' && prev.apiKey.length > 0
        if (prev !== undefined) removeProvider(providerId)
        return hadApiKey
      },
      hasCredentials: (providerId) => {
        const cfg = getProviderConfig(providerId)
        return cfg !== undefined && typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0
      },
    }
  })

  afterEach(() => {
    rmSync(modelsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('extract 全链 → models.json 落盘（保留其他 provider 条目）+ hasCredentials 事实源 + uninstall 删条目', async () => {
    const { manager, session } = assemble({ modelsEntry: realPort })
    await manager.initialize()
    session.entriesBySid.set('sid-1', [manageEntry('qoder', CREDENTIALS_OK)])
    const reply = await manager.runAction({ action: 'extract', family: 'qoder' })
    expect(reply.ok).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(modelsDir, 'models.json'), 'utf8')) as {
      providers: Record<string, Record<string, unknown>>
    }
    expect(onDisk.providers['wool-qoder']).toEqual({
      name: 'Qoder',
      apiKey: 'sk-wool-1',
      headers: { 'x-wool-refresh-token': 'rt-wool-1' },
    })
    expect(realPort.hasCredentials('wool-qoder')).toBe(true)
    // 聚合源 apiKeySet 走条目事实（无凭据条目 = false）。
    expect(manager.listWoolProviderInfos().every((info) => info.id !== 'wool-qoder' || info.apiKeySet)).toBe(true)

    // 卸载删条目：磁盘条目消失 + deleteEntry 返回删前含 apiKey。
    session.entriesBySid.set('sid-2', [manageEntry('qoder', { v: 1, ok: true, data: { cleared: true, persistCleared: false } })])
    const uninstallReply = await manager.runAction({ action: 'uninstall', family: 'qoder' })
    expect(uninstallReply.ok).toBe(true)
    const afterDisk = JSON.parse(readFileSync(join(modelsDir, 'models.json'), 'utf8')) as {
      providers: Record<string, Record<string, unknown>>
    }
    expect(afterDisk.providers['wool-qoder']).toBeUndefined()
    expect(realPort.hasCredentials('wool-qoder')).toBe(false)
  })

  it('models.json 损坏（JSON 非法已隔离）→ extract 落库被拒 internal + 坏文件不被空基线覆写', async () => {
    writeFileSync(join(modelsDir, 'models.json'), '{ not valid json', 'utf8')
    const { manager, session } = assemble({ modelsEntry: realPort })
    session.entriesBySid.set('sid-1', [manageEntry('qoder', CREDENTIALS_OK)])
    const reply = await manager.runAction({ action: 'extract', family: 'qoder' })
    expect(reply.ok).toBe(false)
    if (!reply.ok) {
      expect(reply.error.code).toBe('internal')
      expect(reply.error.message).toContain('models.json')
    }
    // 损坏拒入防线：坏文件被隔离为 .corrupt- 副本（现场保留），原位未出现
    // 以空 providers 合法化覆写的新文件（writeModels 拒入，未触碰磁盘）。
    const files = readdirSync(modelsDir)
    expect(files.some((name) => name.startsWith('models.json.corrupt-'))).toBe(true)
    expect(existsSync(join(modelsDir, 'models.json'))).toBe(false)
  })
})

// ── 每日签到提醒（D5：定时器 taiji 侧 + 到点编排）─────────────────────

describe('每日签到提醒（D5）', () => {
  /** 记录指令序列的会话桩（checkin 编排断言用）。 */
  function recordingSession(entries: unknown[]) {
    const commands: Array<{ sid: string; line: string }> = []
    let sid = 0
    const entriesBySid = new Map<string, unknown[]>()
    const port: WoolSessionPort = {
      create: async () => {
        const s = `sid-${++sid}`
        entriesBySid.set(s, entries)
        return { id: s } as Awaited<ReturnType<WoolSessionPort['create']>>
      },
      delete: async () => {},
      getRpcClient: (s: string) => ({
        getEntries: async () => ({ data: { entries: entriesBySid.get(s) ?? [] } }),
      }) as Awaited<ReturnType<WoolSessionPort['getRpcClient']>>,
      sendSystemCommand: async (s: string, line: string) => {
        commands.push({ sid: s, line })
        return { kind: 'sent' as const }
      },
    }
    return { port, commands }
  }

  it('autoCheckin 开 → 到点经管理通道自动执行签到（checkin + status 两条指令一会话）', async () => {
    const session = recordingSession([
      manageEntry('workbuddy', { v: 1, ok: true, data: { checked: true } }),
      manageEntry('workbuddy', { v: 1, ok: true, data: { loggedIn: true, nickname: 'n', fetchedAt: 5 } }),
    ])
    const manager = new WoolManager({
      sessionService: session.port,
      extensionService: makeExtPort([]).port,
      settings: makeSettingsPort({ families: { workbuddy: { adopted: true, autoCheckin: true } } }).port,
      modelsEntry: makeModelsEntryPort().port,
      dataDir,
      broadcast: () => {},
      now: () => 1,
    })
    await manager.runDailyCheckinTick()
    expect(session.commands.map((c) => c.line.split(' ')[0])).toEqual(['/wool-workbuddy', '/wool-workbuddy'])
    // checkin 指令 envelope action=checkin（经管理通道调扩展执行）。
    expect(JSON.parse(session.commands[0].line.slice('/wool-workbuddy '.length))).toMatchObject({ action: 'checkin' })
    expect(manager.getSnapshot().families.find((f) => f.family === 'workbuddy')?.account?.loggedIn).toBe(true)
  })

  it('autoCheckin 关（默认）→ 到点拉账号状态 + 广播（「今日未签到」徽标新鲜点亮 = 提醒形态）', async () => {
    const session = recordingSession([
      manageEntry('workbuddy', { v: 1, ok: true, data: { loggedIn: true, nickname: 'n', checkin: { doneToday: false }, fetchedAt: 5 } }),
    ])
    const broadcasts: Array<ServerMessage<'wool.state'> | ServerMessage<'wool.authorize_url'>> = []
    const manager = new WoolManager({
      sessionService: session.port,
      extensionService: makeExtPort([]).port,
      settings: makeSettingsPort({ families: { workbuddy: { adopted: true } } }).port,
      modelsEntry: makeModelsEntryPort().port,
      dataDir,
      broadcast: (msg) => broadcasts.push(msg),
      now: () => 1,
    })
    await manager.runDailyCheckinTick()
    // 只拉状态不执行签到（默认关 = 提醒不代执行）。
    expect(session.commands).toHaveLength(1)
    expect(JSON.parse(session.commands[0].line.slice('/wool-workbuddy '.length))).toMatchObject({ action: 'status' })
    expect(manager.getSnapshot().families.find((f) => f.family === 'workbuddy')?.account?.checkin?.doneToday).toBe(false)
    expect(broadcasts).toHaveLength(1)
  })

  it('提醒形态状态拉取失败 → warn 日志照记（降级不吞错）+ 编排与广播不受影响', async () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((msg?: unknown) => { warns.push(String(msg)) })
    try {
      const session = recordingSession([])
      const port: WoolSessionPort = {
        ...session.port,
        sendSystemCommand: async () => ({ kind: 'error' as const, message: 'boom' }),
      }
      const broadcasts: Array<ServerMessage<'wool.state'> | ServerMessage<'wool.authorize_url'>> = []
      const manager = new WoolManager({
        sessionService: port,
        extensionService: makeExtPort([]).port,
        settings: makeSettingsPort({ families: { workbuddy: { adopted: true } } }).port,
        modelsEntry: makeModelsEntryPort().port,
        dataDir,
        broadcast: (msg) => broadcasts.push(msg),
        now: () => 1,
      })
      await manager.runDailyCheckinTick()
      // 失败可观测：warn 含 family 归因（与成功路径可区分，排障有线索）。
      expect(warns.some((w) => w.includes('daily reminder status fetch failed') && w.includes('workbuddy'))).toBe(true)
      expect(broadcasts).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('未接入家族到点零编排（无管理会话 spawn）', async () => {
    const session = recordingSession([])
    const manager = new WoolManager({
      sessionService: session.port,
      extensionService: makeExtPort([]).port,
      settings: makeSettingsPort().port,
      modelsEntry: makeModelsEntryPort().port,
      dataDir,
      broadcast: () => {},
      now: () => 1,
    })
    await manager.runDailyCheckinTick()
    expect(session.commands).toHaveLength(0)
  })

  it('startDailyCheckinTimer 定时器到点触发编排（dailyCheckinDelayMs=0 注入）+ dispose 停链', async () => {
    const session = recordingSession([
      manageEntry('workbuddy', { v: 1, ok: true, data: { loggedIn: true, fetchedAt: 5 } }),
    ])
    const manager = new WoolManager({
      sessionService: session.port,
      extensionService: makeExtPort([]).port,
      settings: makeSettingsPort({ families: { workbuddy: { adopted: true } } }).port,
      modelsEntry: makeModelsEntryPort().port,
      dataDir,
      broadcast: () => {},
      now: () => 1,
      dailyCheckinDelayMs: 0,
    })
    manager.startDailyCheckinTimer()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 0ms 链式排程下至少触发过一轮到点编排；dispose 后链停（commands 不再增长）。
    expect(session.commands.length).toBeGreaterThanOrEqual(1)
    manager.dispose()
    const countAtDispose = session.commands.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(session.commands.length).toBe(countAtDispose)
  })
})

// ── 会话错误分类（D6 ③ 报错时刷新 + 失败路径表对话 401 分类）──────────

describe('会话错误分类（D6 ③）', () => {
  it('对话 401（含 wool provider 标识）→ 账号缓存置失效 + 广播（失效徽标判定源之二）', async () => {
    const { manager, session, broadcasts } = assemble()
    // 先建立 loggedIn=true 账号态（nickname 保留断言）。
    session.entriesBySid.set('sid-1', [
      manageEntry('qoder', { v: 1, ok: true, data: { loggedIn: true, nickname: 'demo', fetchedAt: 5 } }),
    ])
    await manager.runAction({ action: 'status', family: 'qoder' })
    broadcasts.length = 0

    manager.noteSessionError('wool-qoder upstream returned 401 Unauthorized')
    const fam = manager.getSnapshot().families.find((f) => f.family === 'qoder')
    expect(fam?.account).toMatchObject({ loggedIn: false, nickname: 'demo' })
    expect(broadcasts).toHaveLength(1)
  })

  it('Model not found（含 wool provider 标识）→ 触发一次目录刷新（自动收敛，缓存出现目录）', async () => {
    const session = makeSessionPort()
    const manager = new WoolManager({
      sessionService: { ...session.port, getRpcClient: () => ({
        getEntries: async () => ({ data: { entries: [] } }),
        getAvailableModels: async () => [{ id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', provider: 'wool-qoder' }],
      }) } as unknown as WoolSessionPort,
      extensionService: makeExtPort([]).port,
      settings: makeSettingsPort().port,
      modelsEntry: makeModelsEntryPort().port,
      dataDir,
      broadcast: () => {},
      now: () => 1,
    })
    expect(manager.getSnapshot().families.find((f) => f.family === 'qoder')?.catalog).toBeNull()
    manager.noteSessionError('Model not found: wool-qoder/qwen3.8-flash')
    // fire-and-forget 刷新：轮询等待目录缓存出现（确定性信号 = catalog 非空）。
    for (let i = 0; i < 50 && manager.getSnapshot().families.find((f) => f.family === 'qoder')?.catalog === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(manager.getSnapshot().families.find((f) => f.family === 'qoder')?.catalog?.models[0]?.id).toBe('qwen3.8-flash')
  })

  it('4011 限流码不误命中 401 分类（词界匹配）', async () => {
    const { manager, session } = assemble()
    session.entriesBySid.set('sid-1', [
      manageEntry('qoder', { v: 1, ok: true, data: { loggedIn: true, fetchedAt: 5 } }),
    ])
    await manager.runAction({ action: 'status', family: 'qoder' })
    manager.noteSessionError('wool-qoder upstream error 4011 rate limited')
    expect(manager.getSnapshot().families.find((f) => f.family === 'qoder')?.account?.loggedIn).toBe(true)
  })

  it('非羊毛错误文本 → 零编排（不误触发他域刷新）', () => {
    const { manager, session, broadcasts } = assemble()
    manager.noteSessionError('Model not found: openai/gpt-5')
    manager.noteSessionError('401 Unauthorized from anthropic')
    expect(session.calls).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)
  })
})
