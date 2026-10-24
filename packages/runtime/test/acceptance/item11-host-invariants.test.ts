/**
 * D3 验收资产：§7 验收项 11（宿主不变量，四族集合形态）gap 测试。
 *
 * 规格原文（设计文档 §7 表项 11，要点）：
 *   记录操作前 `<dataDir>/ext-sessions/` 一级目录名集合 → 建/删 btw 线若干次 + 主会话
 *   create/rename 若干次 → 重启 → 再取集合 → 断言 `新增 \ 活跃会话 id` 为空。断言覆盖
 *   四族（E-21）：`btw-create-*` / `btw-attach-*` / `ephemeral-*` / v4-UUID 空目录
 *   （主会话 tempId 残留，存量实测 121 个）。空目录也是残留。附加两条：
 *   `<piAgentDir>/sessions/` 无 btw 文件；pi 原生会话列表无异常条目。
 *   「活跃会话 id」权威源与取值时点 = 重启后 `scanSessions({force:true})` 的 id 集合
 *   ∪ `lifecycle` 内存 id 集合 ∪ `ext-sessions/<id>/logs/*.jsonl` 的 mtime 在保留期内
 *   的目录名。首 flush 窗口内的空目录按 mtime 保留期豁免。W3.5 安全条件失败分支的保留
 *   父目录（有兄弟域但 logs/ 已迁空）属显式保留形态、不计入新增残留（区分判据 = 兄弟域
 *   存在且 logs/ 已迁空）。
 *
 * 实现背景与既有覆盖的分工（本文件只补 D3 验收视角的缺口，不重复单元层断言）：
 * - 族③族④的新增来源根治（migratePiSessionLogTree 连父目录回收 + withEphemeralPi
 *   finally 自清理）由 u-w3.5 的 `src/__tests__/process-manager-ephemeral.test.ts` 与
 *   `logger.test.ts` 在单元层覆盖；本文件按项 11 的集合形态把「建线/删线/reattach/
 *   create/rename/非活跃 rename → 重启 → 目录名集合差」端到端串起来。
 * - 装配形态 = 真实 SessionLifecycle + 真实 BtwService + 真实 ProcessManager + 真实
 *   SessionScanner/PiSessionStore，唯一 mock 面 = rpc-client 模块（FakeRpcClient 复现
 *   真实 RpcClient 的 tee 接线：start() 驱动真实 logger.createPiSessionLog 建 tee 树、
 *   retargetSessionLog 驱动真实 logger.migratePiSessionLogTree 迁移——残留树的产生与
 *   回收全部走生产代码路径，非测试摆盘）。形态先例：process-manager-ephemeral.test.ts。
 *
 * 操作序列（任务规定）：主会话 create ×2 + rename ×1（活跃分支）+ btw 建线 ×2 +
 * reattach ×1（btw-attach-* 族②覆盖）+ 关线 ×1（删 1 条）+ 非活跃 rename ×1
 * （ephemeral-* 族③覆盖）；W3.5 迁移窗口竞态注入一次（rekey 前 tempId 树出现兄弟域
 * → 走「保留父目录 + warn」分支，构造显式保留形态供区分判据断言）。
 *
 * 非虚测断言（防假绿灯）：每次 spawn 的 tee 树确曾存在（start 时点检 logs 目录）、
 * rekey 迁移对（from 树消失 + to 树带 logs 存在）、ephemeral 树在 switchSession 时刻
 * 仍存在（mid-flight 点检）、活跃会话树（main ×2 + 线 ×1）清扫后逐个仍在。
 *
 * 数据隔离（项目测试红线）：dataDir 全部落 `mkdtempSync(join(tmpdir(), ...))`，
 * TAIJI_AGENT_DATA_DIR 指向该 tmp（fs-guard 白名单），不触真实数据目录 ~/.taiji。
 *
 * 运行：cd packages/runtime && npx vitest run test/acceptance/item11-host-invariants.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ── rpc-client 模块 mock（hoisted；FakeRpcClient 复现真实 tee 接线） ──────────
// 工厂内禁直接 import logger（mock 工厂先于模块顶层语句求值，直接 import 形成求值环）——
// 真实 logger 的三个挂点（createPiSessionLog / migratePiSessionLogTree / storeRoot）
// 经 rpcMock.state 间接注入（process-manager-ephemeral.test.ts 同款模式）。
const rpcMock = vi.hoisted(() => {
  const state = {
    /** 每次 spawn 的记录（tee 树点检 + 竞态注入标记 + 族归类）。 */
    spawns: [] as Array<{ key: string; cwd: string; teeTreeExisted: boolean; siblingInjected: boolean; family: 'main-temp' | 'btw-create' | 'btw-attach' | 'ephemeral' }>,
    /** rekey 迁移对（retargetSessionLog 实参）。 */
    retargets: [] as Array<{ from: string; to: string }>,
    /** switchSession 调用（ephemeral mid-flight 点检）。 */
    switchCalls: [] as Array<{ key: string; path: string; teeExistedAtSwitch: boolean }>,
    /** setSessionName 调用（rename 两分支的 RPC 证据）。 */
    setNameCalls: [] as Array<{ key: string; name: string }>,
    /** btw spawn 的 get_state 剧本（测试在每次 btw 操作前压栈）。 */
    btwStateQueue: [] as Array<{ sessionId: string; sessionFile: string }>,
    /** main create 的 get_state 生成器（模拟 pi 首 flush 写会话文件 + 回读真实 id）。 */
    mainGetState: null as null | ((key: string, cwd: string) => { sessionId: string; sessionFile: string }),
    /** ephemeral 附着的 get_state header 读取器。 */
    readHeaderId: null as null | ((file: string) => string | null),
    /** 挂点：真实 logger.createPiSessionLog。 */
    teeCreate: null as null | ((sessionId: string) => { write: (line: string) => void; end: () => void }),
    /** 挂点：真实 logger.migratePiSessionLogTree。 */
    migrate: null as null | ((from: string, to: string) => void),
    /** 存储树根（tee 树点检用）。 */
    storeRoot: '',
  }
  class FakeRpcClient {
    started = false
    killed = false
    exitCb: ((code: number | null, stderr: string) => void) | null = null
    private piSessionLog: { write: (line: string) => void; end: () => void } | null = null
    private currentSessionFile: string | undefined
    /** get_state 幂等缓存（pi 语义：同一附着会话的 get_state 结果稳定）。 */
    private stateOverride: Record<string, unknown> | undefined
    constructor(public options: Record<string, unknown>) {}
    async start(): Promise<void> {
      this.started = true
      const sid = String(this.options.sessionId)
      // 复现真实 RpcClient.start 的 tee 接线（rpc-client.ts:344-355）：spawn 后为
      // 本 session 建 tee 树 + 写 _spawn_boundary 边界行——四族残留树的产生源。
      if (rpcMock.state.teeCreate) {
        this.piSessionLog = rpcMock.state.teeCreate(sid)
        this.piSessionLog.write(
          JSON.stringify({ type: '_spawn_boundary', ts: new Date().toISOString(), runtimePid: process.pid, sessionId: sid }) + '\n',
        )
      }
      // tee 树点检：logs 目录由 sessionLogFileOrNull 同步 mkdir（确定性；jsonl 文件
      // 经 WriteStream 异步开流，不作为点检对象）。
      rpcMock.state.spawns.push({
        key: sid,
        cwd: String(this.options.cwd ?? ''),
        teeTreeExisted: existsSync(join(rpcMock.state.storeRoot, sid, 'logs')),
        siblingInjected: false,
        family: sid.startsWith('btw-create-') ? 'btw-create'
          : sid.startsWith('btw-attach-') ? 'btw-attach'
            : sid.startsWith('ephemeral-') ? 'ephemeral' : 'main-temp',
      })
    }
    onExit(cb: (code: number | null, stderr: string) => void): void { this.exitCb = cb }
    async kill(): Promise<void> { this.killed = true }
    get exited(): boolean { return this.killed }
    async switchSession(path: string): Promise<void> {
      this.currentSessionFile = path
      // 附着目标切换后 get_state 随之改变（真实 pi 语义）——清幂等缓存
      this.stateOverride = undefined
      const sid = String(this.options.sessionId)
      rpcMock.state.switchCalls.push({
        key: sid,
        path,
        teeExistedAtSwitch: existsSync(join(rpcMock.state.storeRoot, sid, 'logs')),
      })
    }
    async setSessionName(name: string): Promise<unknown> {
      rpcMock.state.setNameCalls.push({ key: String(this.options.sessionId), name })
      return { success: true }
    }
    async getState(): Promise<Record<string, unknown>> {
      // 同一客户端实例的 get_state 幂等（pi 语义；ensureProcess 一次附着会调两次：
      // assertPiSessionFile 一次 + 状态核对一次）
      if (this.stateOverride) return this.stateOverride
      const sid = String(this.options.sessionId)
      let state: Record<string, unknown>
      if (sid.startsWith('ephemeral-')) {
        // 短命 pi：附着目标文件（switchSession 已设）；sessionFile 必须与之一致
        // （assertPiSessionFile 逐字比对）。
        const file = this.currentSessionFile
        const id = file ? rpcMock.state.readHeaderId?.(file) ?? null : null
        state = { sessionId: id ?? 'ephemeral-unknown', sessionFile: file }
      } else if (sid.startsWith('btw-create-') || sid.startsWith('btw-attach-')) {
        const scripted = rpcMock.state.btwStateQueue.shift()
        if (!scripted) throw new Error(`fake rpc: no scripted btw state for spawn ${sid}`)
        this.currentSessionFile = scripted.sessionFile
        state = { sessionId: scripted.sessionId, sessionFile: scripted.sessionFile }
      } else {
        // main create：现场生成 pi 真实 id + 写会话文件（模拟 pi 首 flush）
        const gen = rpcMock.state.mainGetState
        if (!gen) throw new Error('fake rpc: mainGetState generator not wired')
        const r = gen(sid, String(this.options.cwd ?? ''))
        this.currentSessionFile = r.sessionFile
        state = { sessionId: r.sessionId, sessionFile: r.sessionFile }
      }
      this.stateOverride = state
      return state
    }
    retargetSessionLog(newSessionId: string): void {
      // 镜像真实 rpc-client.ts:254 retargetSessionLog：end 旧 writer → 真实
      // migratePiSessionLogTree 迁移 → reopen → _retarget_boundary 行。
      const from = String(this.options.sessionId)
      if (!this.piSessionLog || from === newSessionId) return
      this.piSessionLog.end()
      rpcMock.state.retargets.push({ from, to: newSessionId })
      rpcMock.state.migrate?.(from, newSessionId)
      this.options.sessionId = newSessionId
      if (rpcMock.state.teeCreate) {
        this.piSessionLog = rpcMock.state.teeCreate(newSessionId)
        this.piSessionLog.write(
          JSON.stringify({ type: '_retarget_boundary', ts: new Date().toISOString(), from: 'temp-id-tree (migrated)' }) + '\n',
        )
      }
    }
  }
  return { FakeRpcClient, state }
})

vi.mock('../../src/infra/pi/rpc-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/infra/pi/rpc-client.js')>()
  return { ...actual, RpcClient: rpcMock.FakeRpcClient }
})

import { ProcessManager } from '../../src/infra/pi/process-manager.js'
import { closeLogger, createPiSessionLog, initLogger, migratePiSessionLogTree } from '../../src/infra/logger.js'
import { PiSessionStore } from '../../src/infra/pi/session-store.js'
import { SessionLifecycle } from '../../src/services/session/session-lifecycle.js'
import { BtwService } from '../../src/services/session/btw-service.js'
import { SessionScanner } from '../../src/services/session/session-scanner.js'
import type { ILifecycleSessionOps, IScannerSessionOps, ISessionRegisterDeps } from '../../src/services/session/session-internal.js'
import type { IManagedSessionView } from '../../src/services/session/types.js'
import type { IEventAdapter } from '../../src/interfaces.js'
import type { IPiEngine, IProcessManager } from '../../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../../src/services/ports/config.js'
import type { ISessionStore } from '../../src/services/ports/session.js'
import type { IGitInfoReader } from '../../src/services/ports/git-info.js'
import type { WorkspaceService } from '../../src/services/workspace/workspace-service.js'
import type { SessionSummary } from '@taiji/shared'
import { readLogKeepDays } from '@taiji/shared'
import { getSessionBtwDir, getSessionStoreDir } from '@taiji/shared/paths'
import { encodeCwd } from '@taiji/shared/session-store-paths'

/** v4 UUID 形态（族④ 主会话 tempId 残留的名字特征）。 */
const V4_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MS_PER_DAY = 86_400_000
const OLD_DAYS = 30

let dataDir = ''
let cwdDir = ''
let restoreDataDir: (() => void) | undefined

function sessionHeaderLine(id: string, cwd: string): string {
  return `${JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() })}\n`
}

/** 读 jsonl 首行 header 的 id（供 ephemeral get_state 与 btw 文件点检用）。 */
function readHeaderId(file: string): string | null {
  try {
    const first = readFileSync(file, 'utf-8').split('\n', 1)[0]
    if (!first) return null
    const entry = JSON.parse(first) as { type?: unknown; id?: unknown }
    if (entry?.type !== 'session') return null
    return typeof entry.id === 'string' ? entry.id : null
  } catch {
    return null
  }
}

/** agent/sessions 下全部 jsonl 的 header id 集合（pi 原生会话列表口径）。 */
function collectPiSessionHeaderIds(): string[] {
  const sessionsDir = join(dataDir, 'agent', 'sessions')
  const ids: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch {
    return ids
  }
  for (const entry of entries) {
    const p = join(sessionsDir, entry)
    let files: string[] = []
    try {
      if (statSync(p).isDirectory()) files = readdirSync(p).filter(f => f.endsWith('.jsonl'))
      else if (entry.endsWith('.jsonl')) files = [entry]
    } catch {
      continue
    }
    for (const f of files) {
      const id = readHeaderId(join(p, f))
      if (id) ids.push(id)
    }
  }
  return ids
}

/** ext-sessions 一级目录名集合（根不存在 = 空集）。 */
function topLevelNames(): string[] {
  try {
    return readdirSync(getSessionStoreDir()).sort()
  } catch {
    return []
  }
}

/**
 * W3.5 安全条件失败分支的显式保留形态判据（设计项 11 末段）：兄弟域存在且 logs/
 * 已迁空（logs/ 不存在或为空）。该形态不计入新增残留。
 */
function isExplicitRetainForm(name: string): boolean {
  const dir = join(getSessionStoreDir(), name)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  if (entries.filter(e => e !== 'logs').length === 0) return false
  try {
    return readdirSync(join(dir, 'logs')).length === 0
  } catch {
    return true // logs/ 已 rmdir（迁移成功后父目录保留分支的实际形态）
  }
}

/** mtime 主语（与 W5 清扫三条件③ 同口径，不新造第二套规则）：logs/*.jsonl 最新 mtime，无 jsonl 取目录自身。 */
function mtimeSubjectMs(name: string): number | null {
  const dir = join(getSessionStoreDir(), name)
  const logsDir = join(dir, 'logs')
  let latest: number | null = null
  try {
    for (const f of readdirSync(logsDir)) {
      if (!f.endsWith('.jsonl')) continue
      try {
        const ms = statSync(join(logsDir, f)).mtimeMs
        if (latest === null || ms > latest) latest = ms
      } catch {
        // stat 失败的文件不计入主语
      }
    }
  } catch {
    // 无 logs/ 目录 → 取目录自身 mtime
  }
  if (latest !== null) return latest
  try {
    return statSync(dir).mtimeMs
  } catch {
    return null
  }
}

/** btw spawn 剧本压栈（测试在每次建线/reattach 前调用；线会话文件由本函数落盘 = 模拟 pi 首 flush）。 */
function scriptBtwLine(mainSid: string): { sessionId: string; sessionFile: string } {
  const sessionId = randomUUID()
  const sessionFile = join(getSessionBtwDir(mainSid), `${Date.now()}_${sessionId}.jsonl`)
  mkdirSync(dirname(sessionFile), { recursive: true })
  writeFileSync(sessionFile, sessionHeaderLine(sessionId, cwdDir))
  const entry = { sessionId, sessionFile }
  rpcMock.state.btwStateQueue.push(entry)
  return entry
}

describe('§7 验收项 11：宿主不变量（四族集合形态）', () => {
  beforeEach(() => {
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '') // hermetic 前提：非打包态（P1 同款机制）
    const prev = process.env.TAIJI_AGENT_DATA_DIR
    dataDir = mkdtempSync(join(tmpdir(), 'a7-item11-data-'))
    cwdDir = mkdtempSync(join(tmpdir(), 'a7-item11-cwd-'))
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    restoreDataDir = () => {
      if (prev === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
      else process.env.TAIJI_AGENT_DATA_DIR = prev
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      rmSync(cwdDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
    initLogger(dataDir)
    rpcMock.state.storeRoot = getSessionStoreDir()
    rpcMock.state.teeCreate = createPiSessionLog
    rpcMock.state.migrate = migratePiSessionLogTree
    rpcMock.state.readHeaderId = readHeaderId
    // main create 的 get_state：现场生成 pi 真实 id + 写会话文件（模拟 pi 首 flush）
    const mainIds: string[] = []
    let injectSiblingNext = false
    rpcMock.state.mainGetState = (key: string, cwd: string) => {
      const sessionId = randomUUID()
      const groupDir = join(dataDir, 'agent', 'sessions', encodeCwd(cwd))
      mkdirSync(groupDir, { recursive: true })
      const sessionFile = join(groupDir, `${Date.now()}_${sessionId}.jsonl`)
      writeFileSync(sessionFile, sessionHeaderLine(sessionId, cwd))
      // W3.5 迁移窗口竞态注入（探针场景）：rekey 前 tempId 树出现兄弟域 → 迁移走
      // 「保留父目录 + warn」分支（设计项 11 的显式保留形态）。
      if (injectSiblingNext) {
        injectSiblingNext = false
        mkdirSync(join(rpcMock.state.storeRoot, key, 'subagents'), { recursive: true })
        const rec = rpcMock.state.spawns.find(s => s.key === key)
        if (rec) rec.siblingInjected = true
      }
      mainIds.push(sessionId)
      return { sessionId, sessionFile }
    }
    // 注入开关经模块槽暴露给测试体（vi.mock hoist 后本闭包仍持有同一 state 对象）
    ;(rpcMock.state as unknown as { __armSiblingInjection: () => void }).__armSiblingInjection = () => { injectSiblingNext = true }
    ;(rpcMock.state as unknown as { __mainIds: string[] }).__mainIds = mainIds
  })

  afterEach(async () => {
    rpcMock.state.spawns.length = 0
    rpcMock.state.retargets.length = 0
    rpcMock.state.switchCalls.length = 0
    rpcMock.state.setNameCalls.length = 0
    rpcMock.state.btwStateQueue.length = 0
    rpcMock.state.mainGetState = null
    rpcMock.state.readHeaderId = null
    rpcMock.state.teeCreate = null
    rpcMock.state.migrate = null
    rpcMock.state.storeRoot = ''
    await closeLogger().catch(() => {})
    restoreDataDir?.()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('ops → 重启 → 新增 \\ 活跃会话id 为空；四族逐个点名 + 附加两条 + 非虚测点检', async () => {
    // ── 栈装配（真 lifecycle + 真 BtwService + 真 ProcessManager + 真 scanner/store） ──
    let lifecycle: SessionLifecycle
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const configStore = { getDefaultModel: vi.fn(() => ({ provider: 'test-provider', modelId: 'test-model' })) } as unknown as IConfigStore
    const store = new PiSessionStore()
    const registerDeps: ISessionRegisterDeps = {
      adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
      getMessageBus: () => null,
      broadcastGlobal: () => {},
    }
    const svc = {
      toSummary: (s: IManagedSessionView): SessionSummary => ({
        id: s.id, label: s.label, cwd: s.cwd, status: 'idle',
        lastActiveAt: s.lastActiveAt, sessionFile: s.sessionFilePath, surface: s.surface,
      }),
      // 与生产同构：force 旁路 TTL 的磁盘扫描查找（session-service.ts:1410 同款）
      findScannedSession: (sessionId: string) => store.scanSessions({ force: true }).find(s => s.id === sessionId),
      getSkillPaths: () => [],
      getExtensionPaths: async () => [],
      getReplaceSystemPrompt: () => undefined,
      getLaunchPresetOptions: async () => undefined,
      fetchAndBroadcastContext: async () => {},
      removeSessionEntry: vi.fn(),
      notifySessionCreated: vi.fn(),
      getActiveSummaries: (): SessionSummary[] => [...lifecycle.values()].map(s => ({
        id: s.id, label: s.label, cwd: s.cwd, status: 'idle',
        lastActiveAt: s.lastActiveAt, sessionFile: s.sessionFilePath, surface: s.surface,
      })),
      // scanner 窄接口去重用：活跃会话占用的 session 文件路径集合
      getActiveFilePaths: (): Set<string> => {
        const paths = new Set<string>()
        for (const s of lifecycle.values()) if (s.sessionFilePath) paths.add(s.sessionFilePath)
        return paths
      },
    }
    const gitInfoReader: IGitInfoReader = { readGitInfo: () => undefined, pruneStaleCache: () => {} }
    const pm = new ProcessManager(tmpdir())

    const wireBtw = (targetLifecycle: SessionLifecycle): BtwService => new BtwService({
      processes: pm,
      buildLineSpawnOptions: async () => ({}),
      // btw 直注册链（组合根 adapter 同款：surface 显传 'btw'）
      registerSession: (id, client, cwd, label, sessionFilePath, surface) =>
        targetLifecycle.registerSession(id, client as IPiEngine, cwd, label, sessionFilePath, undefined, undefined, undefined, undefined, undefined, surface),
      // 源不可用 → 分支② 无 fork 新建（btw-lifecycle.test.ts createNoForkLine 同款）
      resolveMainSessionFile: () => undefined,
      // 端口成功分支同效用 fake（树整树移除；端口废纸篓通道不是本项的被检对象）
      trashDirectory: async (dirPath: string) => { rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) },
      resolvePiCommand: () => 'pi-not-used-in-fake',
      forkSession: vi.fn(async () => { throw new Error('forkSession not used (no-fork branch)') }),
      // M4-a 线终结扇出（index.ts:1441 同款：detach → removeEntry；插件 sessionData 清理不涉磁盘树）
      onLineTerminated: (sessionId: string) => {
        if (!targetLifecycle.has(sessionId)) return
        targetLifecycle.detachSession(sessionId)
        targetLifecycle.removeEntry(sessionId)
      },
    })

    lifecycle = new SessionLifecycle(svc, pm, configStore, store, workspace, registerDeps)
    const btwService = wireBtw(lifecycle)

    // ── 操作前集合（ext-sessions 一级目录名） ──
    const before = topLevelNames()
    expect(before).toEqual([]) // 首启形态：存储树尚未建

    // 预置一个冷会话（从未在本进程注册的持久化会话）供非活跃 rename 附着
    const coldSid = randomUUID()
    const coldGroupDir = join(dataDir, 'agent', 'sessions', encodeCwd(cwdDir))
    mkdirSync(coldGroupDir, { recursive: true })
    const coldFile = join(coldGroupDir, `${Date.now()}_${coldSid}.jsonl`)
    writeFileSync(coldFile, sessionHeaderLine(coldSid, cwdDir))

    // ── 操作序列 ──
    // ① 主会话 create ×2（main1 带 W3.5 迁移窗口竞态注入 → tempId 父目录显式保留；
    //    main2 正常 → tempId 树整树回收，族④覆盖）
    ;(rpcMock.state as unknown as { __armSiblingInjection: () => void }).__armSiblingInjection()
    const main1 = await lifecycle.create(cwdDir, 'main-1')
    const main2 = await lifecycle.create(cwdDir, 'main-2')
    // 显式保留形态 aged 化：区分判据的负载场景（新鲜树本就被 mtime 豁免源覆盖，
    // aged 后只有显式保留规则能排除它——隔离出规则的净贡献）
    const retainTempId = rpcMock.state.spawns.find(s => s.siblingInjected)?.key
    expect(retainTempId).toBeDefined()
    utimesSync(join(getSessionStoreDir(), retainTempId as string), new Date(Date.now() - OLD_DAYS * MS_PER_DAY), new Date(Date.now() - OLD_DAYS * MS_PER_DAY))

    // ② rename ×1（活跃分支：pm.getClient → setSessionName）
    await lifecycle.renameSession(main1.id, 'renamed-main-1')

    // ③ btw 建线 ×2（btw-create-* tempKey → rekey 迁移回收，族①覆盖）
    const line1 = scriptBtwLine(main1.id)
    const line2 = scriptBtwLine(main1.id)
    const created1 = await btwService.createLine({ mainSid: main1.id, cwd: cwdDir })
    const created2 = await btwService.createLine({ mainSid: main1.id, cwd: cwdDir })
    expect(created1.sessionId).toBe(line1.sessionId)
    expect(created2.sessionId).toBe(line2.sessionId)

    // ④ reattach ×1（btw-attach-* tempKey → rekey 迁移回收，族②覆盖）
    btwService.getLine(line1.sessionId)!.client = undefined // 进程引用摘除 → 重附着入口
    // 重附着的 get_state 剧本 = 线自身 id + 线文件（reattach 必须落回原会话）
    rpcMock.state.btwStateQueue.push({ sessionId: line1.sessionId, sessionFile: line1.sessionFile })
    await btwService.ensureProcess(line1.sessionId)

    // ⑤ 关线 ×1（删 1 条：进程销毁 + 线文件删 + 线树软删）
    await btwService.closeLine(line2.sessionId, { deleteSessionFile: true })

    // ⑥ 非活跃 rename ×1（withEphemeralPi → ephemeral-* 非空树 → finally 回收，族③覆盖）
    await lifecycle.renameSession(coldSid, 'renamed-cold')

    // flush 屏障：closeLogger 等全部 pi tee 写流落定后重新初始化——迁移后的 tee
    // 文件存在性断言因此是确定性的（非异步竞态）。
    await closeLogger()
    initLogger(dataDir)

    // ── 重启 = 新 lifecycle + 新 scanner + force 扫 + btw rebuild ──
    const lifecycle2 = new SessionLifecycle(svc, pm, configStore, store, workspace, registerDeps)
    lifecycle = lifecycle2 // svc.getActiveSummaries 改读重启后实例（内存集为空 = 设计 contemplated 形态）
    const scanner = new SessionScanner(svc, store, gitInfoReader)
    const btwService2 = wireBtw(lifecycle2)
    const rebuilt = btwService2.rebuildFromDisk()
    const scanned = store.scanSessions({ force: true })

    // ── 复检集合 ──
    const after = topLevelNames()
    const newDirs = after.filter(n => !before.includes(n))

    // 活跃会话 id 三源并集（设计项 11 权威源与取值时点）
    const scanIds = new Set(scanned.map(s => s.id))
    const memIds = new Set(lifecycle2.keys())
    const keepMs = readLogKeepDays() * MS_PER_DAY
    const freshMtimeIds = new Set(after.filter(n => {
      const ms = mtimeSubjectMs(n)
      return ms !== null && Date.now() - ms < keepMs
    }))
    const activeIds = new Set([...scanIds, ...memIds, ...freshMtimeIds])

    // 核心断言：新增 \ 活跃会话 id 为空（显式保留形态按设计排除）
    const residual = newDirs.filter(n => !activeIds.has(n) && !isExplicitRetainForm(n))
    expect(residual).toEqual([])

    // 四族逐个点名（E-21）
    expect(after.filter(n => n.startsWith('btw-create-'))).toEqual([]) // 族①
    expect(after.filter(n => n.startsWith('btw-attach-'))).toEqual([]) // 族②
    expect(after.filter(n => n.startsWith('ephemeral-'))).toEqual([]) // 族③
    const emptyDirs = after.filter(n => {
      try { return readdirSync(join(getSessionStoreDir(), n)).length === 0 } catch { return false }
    })
    expect(emptyDirs).toEqual([]) // 族④：v4-UUID 空目录（主会话 tempId 残留）；空目录也是残留

    // 显式保留形态：确曾在新增集、确不被三源覆盖、确由区分判据排除（规则净贡献隔离）
    expect(newDirs).toContain(retainTempId as string)
    expect(activeIds.has(retainTempId as string)).toBe(false)
    expect(isExplicitRetainForm(retainTempId as string)).toBe(true)

    // 附加两条：piAgentDir/sessions 无 btw 文件；pi 原生会话列表无异常条目
    const lineIds = new Set([line1.sessionId, line2.sessionId])
    const piHeaderIds = collectPiSessionHeaderIds()
    expect(piHeaderIds.filter(id => lineIds.has(id))).toEqual([])
    expect(new Set(scanned.map(s => s.id))).toEqual(new Set([main1.id, main2.id, coldSid]))
    for (const s of scanned) {
      expect(s.id).toBeTruthy()
      expect(s.filePath).toBeTruthy()
      expect(/^(btw-create-|btw-attach-|ephemeral-)/.test(s.id)).toBe(false)
    }

    // 非虚测点检 1：全部 spawn 的 tee 树确曾存在（四族产生源都真实跑过）
    expect(rpcMock.state.spawns.length).toBe(6) // main ×2 + btw-create ×2 + btw-attach ×1 + ephemeral ×1
    expect(rpcMock.state.spawns.every(s => s.teeTreeExisted)).toBe(true)
    expect(rpcMock.state.spawns.filter(s => s.family === 'main-temp').length).toBe(2)
    expect(rpcMock.state.spawns.filter(s => s.family === 'btw-create').length).toBe(2)
    expect(rpcMock.state.spawns.filter(s => s.family === 'btw-attach').length).toBe(1)
    expect(rpcMock.state.spawns.filter(s => s.family === 'ephemeral').length).toBe(1)

    // 非虚测点检 2：每个临时键树都已回收（竞态注入的那个按设计保留 + 保留形态判据成立）
    for (const sp of rpcMock.state.spawns) {
      const exists = existsSync(join(getSessionStoreDir(), sp.key))
      if (sp.siblingInjected) {
        expect(exists).toBe(true)
        expect(isExplicitRetainForm(sp.key)).toBe(true)
      } else {
        expect(exists).toBe(false)
      }
    }

    // 非虚测点检 3：rekey 迁移对（from 树消失 + to 树带 logs 存在）；保留分支的迁移对
    // 与已关线（to 树随 closeLine 整树软删，属合法消失）除外
    const injectedKeys = new Set(rpcMock.state.spawns.filter(s => s.siblingInjected).map(s => s.key))
    const deletedLineIds = new Set([line2.sessionId])
    expect(rpcMock.state.retargets.length).toBe(5) // main1 + main2 + line1 create + line2 create + line1 attach
    for (const r of rpcMock.state.retargets) {
      if (injectedKeys.has(r.from)) continue
      expect(existsSync(join(getSessionStoreDir(), r.from))).toBe(false)
      if (deletedLineIds.has(r.to)) continue // 关线的 to 树已随 closeLine 消失（下方专项断言）
      expect(existsSync(join(getSessionStoreDir(), r.to, 'logs'))).toBe(true)
    }

    // 非虚测点检 4：ephemeral 树在 switchSession 时刻（fn 之前）仍存在——族③残留形态非虚测
    const ephemeralSwitch = rpcMock.state.switchCalls.find(c => c.key.startsWith('ephemeral-'))
    expect(ephemeralSwitch).toBeDefined()
    expect(ephemeralSwitch?.teeExistedAtSwitch).toBe(true)
    expect(ephemeralSwitch?.path).toBe(coldFile)

    // 非虚测点检 5：活跃会话树（main ×2 + line1）逐个仍在；被删 line2 的树已随关线消失
    for (const id of [main1.id, main2.id, line1.sessionId]) {
      expect(existsSync(join(getSessionStoreDir(), id, 'logs'))).toBe(true)
    }
    expect(existsSync(join(getSessionStoreDir(), line2.sessionId))).toBe(false)
    expect(existsSync(line2.sessionFile)).toBe(false) // 关线删了线会话文件

    // rename 两分支的 RPC 证据（活跃分支走 pm client；非活跃分支走 ephemeral client）
    expect(rpcMock.state.setNameCalls).toEqual(expect.arrayContaining([
      { key: main1.id, name: 'renamed-main-1' },
      { key: expect.stringMatching(/^ephemeral-/) as unknown as string, name: 'renamed-cold' },
    ]))

    // 重启后 btw 重建：line1 一条（line2 文件已删），surface 三写路径之 rebuildFromDisk 生效
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0].piSessionId).toBe(line1.sessionId)
    expect(rebuilt[0].surface).toBe('btw')
    expect(rebuilt[0].mainSid).toBe(main1.id)

    // 重启后 scanner 列表口径：活跃（内存空）+ 持久化（磁盘）合并后侧栏集合 = 三个主/冷会话
    const groups = scanner.listPersistedSessions()
    const sidebarIds = groups.flatMap(g => g.sessions.map(s => s.id)).sort()
    expect(sidebarIds).toEqual([coldSid, main1.id, main2.id].sort())
  })

  it('首 flush 窗口豁免：未注册、无 jsonl 的新空目录不算新增残留（mtime 保留期源兜底）', () => {
    // 设计项 11：「首 flush 窗口内的空目录按 mtime 保留期豁免」——兜住「刚 create 未首
    // flush 的主会话（无 jsonl）被当残留」的误判方向。本用例隔离该兜底方向。
    const before = topLevelNames()
    const freshSid = randomUUID()
    mkdirSync(join(getSessionStoreDir(), freshSid), { recursive: true }) // 空目录、mtime 新、未注册、无 jsonl
    const after = topLevelNames()
    const newDirs = after.filter(n => !before.includes(n))
    expect(newDirs).toEqual([freshSid])

    const keepMs = readLogKeepDays() * MS_PER_DAY
    const freshMtimeIds = new Set(after.filter(n => {
      const ms = mtimeSubjectMs(n)
      return ms !== null && Date.now() - ms < keepMs
    }))
    // 三源并集里它只可能被 mtime 保留期源覆盖（scan 无其文件、lifecycle 内存无其条目）
    expect(freshMtimeIds.has(freshSid)).toBe(true)
    const residual = newDirs.filter(n => !freshMtimeIds.has(n) && !isExplicitRetainForm(n))
    expect(residual).toEqual([])
  })
})
