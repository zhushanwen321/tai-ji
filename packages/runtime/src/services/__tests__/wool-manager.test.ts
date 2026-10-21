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
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage, WoolFamilyState } from '@taiji/shared'
import { WoolManager, type WoolExtensionPort, type WoolSessionPort, type WoolSettingsPort } from '../wool-manager.js'

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
  const port: WoolExtensionPort = {
    scanExtensions: async () => scan,
    installExtension: async (source: string) => {
      installs.push(source)
      installed.push(source.replace(/^npm:@[^@]+@/, ''))
    },
  }
  return { port, installs }
}

function makeSettingsPort() {
  let data: Record<string, unknown> = {}
  const port: WoolSettingsPort = {
    read: () => data as never,
    write: (d) => { data = { families: d.families } as never },
  }
  return { port, read: () => data }
}

/** 管理响应 custom entry（wool-shared manage-protocol 回写形态镜像）。 */
function manageEntry(family: string, response: unknown) {
  return { type: 'custom', customType: 'wool-manage-response', data: { family, response } }
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
} = {}) {
  const session = makeSessionPort(opts.sessionOverrides)
  const ext = makeExtPort(opts.extScan ?? [{ name: '@zhushanwen/pi-wool-qoder', version: '0.2.0', enabled: true }], opts.installed ?? [])
  const settings = makeSettingsPort()
  const broadcasts: ServerMessage<'wool.state'>[] = []
  const manager = new WoolManager({
    sessionService: session.port,
    extensionService: ext.port,
    settings: settings.port,
    dataDir,
    broadcast: (msg) => broadcasts.push(msg),
    fetchFn: opts.fetchFn ?? (async () => jsonResponse(manifestBody())),
    now: (() => 1_700_000_000_000) as () => number,
    ...(opts.manageResponseWaitMs !== undefined ? { manageResponseWaitMs: opts.manageResponseWaitMs } : {}),
  })
  return { manager, session, ext, settings, broadcasts }
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
    expect(broadcasts[0].payload.snapshot.families.some((f) => f.family === 'qoder' && f.account?.nickname === 'demo')).toBe(true)
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
    expect(settings.read()).toEqual({ families: { workbuddy: { autoCheckin: true } } })
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
      dataDir,
      broadcast: () => {},
      now: () => 7,
    })
    await preManager.runAction({ action: 'refresh', family: 'workbuddy' })
    expect(existsSync(join(dataDir, 'wool-catalog.json'))).toBe(true)

    // 新实例（模拟重启）：initialize 恢复缓存，零网络零会话即可读聚合源
    const fresh = assemble({ fetchFn: async () => { throw new Error('network must not be touched') } })
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
