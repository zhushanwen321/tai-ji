/**
 * 终态写入纪律单测（chat-flow-consistency，design-turn-statemachine 缺陷 1/2 验收）：
 *
 * 1. 第一终态优先（缺陷 2 方案 2）：persistSessionOutcome 统一层——已有任意终态
 *    （done/error/stopped）则跳过写入；三个终态写点（handleTurnEndSideEffects / abort /
 *    进程退出链）统一继承。射程 = 同回合写入竞态（abort vs pi 自发 agent_end）。
 *    V3 已核实：restore/fork 附着成功后均删 .meta.json 旧 sidecar，重开新周期不受旧终态
 *    拦截。dmg-r1-1 补齐跨回合放行：活跃会话新回合受理入口（message-dispatcher
 *    runAcceptance 受理成功后）经 clearSessionOutcome 清旧 sidecar——旧终态不再永久拦截
 *    新周期写入（否则用户 abort 后继续对话，重启后侧栏滞留旧终态），本文件第三组用例锁定。
 * 2. willRetry 中间失败跳终态（缺陷 1 方案 A）：handleTurnEndSideEffects 第三参
 *    willRetry=true → settling 转移照写、终态 sidecar 不写（settling 转移与 project sidecar
 *    兜底在 session-state-projection.test.ts 已有行为锚，此处锁 outcome 跳过）。
 *
 * mock 策略：真 SessionService 最小装置（session-service-plugin-data-clear.test.ts 同款）
 * + 真 PiSessionStore + 真 fs tmp sidecar（persistSessionEnd/extractSessionOutcome 走实盘，
 * 检查与写入同源无 mock 循环论证）。
 * 运行：pnpm -C packages/runtime exec vitest run src/services/session
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from '../session-service.js'
import { PiSessionStore } from '../../../infra/pi/session-store.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'
import { persistSessionEnd } from '../../../infra/pi/session-file-utils.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { IExtensionService } from '../../../interfaces.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { SessionLifecycle } from '../session-lifecycle.js'
import type { IManagedSessionRecord } from '../session-internal.js'

let runDir: string

beforeAll(() => {
  runDir = mkdtempSync(join(tmpdir(), 'session-outcome-first-terminal-'))
})

afterAll(() => {
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 真 SessionService 最小装置（session-service-plugin-data-clear.test.ts createSetup 同款）。 */
function createService(): { service: SessionService; sessionStore: PiSessionStore } {
  const client = { lastActivityAt: 1, exited: false } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client),
    hasClient: vi.fn(() => false),
    destroySession: vi.fn(async () => undefined),
    destroyAll: vi.fn(async () => undefined),
  }
  const sessionStore = new PiSessionStore()
  vi.spyOn(sessionStore, 'refreshAll').mockImplementation(() => {})
  vi.spyOn(sessionStore, 'invalidateScanCache').mockImplementation(() => {})
  vi.spyOn(sessionStore, 'trash').mockImplementation(async () => undefined)
  const service = new SessionService(
    pm as unknown as IProcessManager,
    { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() },
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    new PiConfigStore(),
    sessionStore,
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    { record: vi.fn(), list: vi.fn(() => []) } as unknown as WorkspaceService,
  )
  return { service, sessionStore }
}

/** 经 lifecycle Map 塞入带 sessionFilePath 的最小记录（persistSessionOutcome 的定位路径）。 */
function registerSessionRecord(service: SessionService, sid: string, filePath: string): void {
  const lifecycle = (service as unknown as { lifecycle: SessionLifecycle }).lifecycle
  const sessions = (lifecycle as unknown as { sessions: Map<string, IManagedSessionRecord> }).sessions
  sessions.set(sid, {
    id: sid,
    cwd: runDir,
    label: 't',
    modelId: 'm',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    bashRunToken: undefined,
    occupancy: { turn: 'idle', compacting: false, bash: false, handingOff: false },
    sessionFilePath: filePath,
  } as IManagedSessionRecord)
}

describe('persistSessionOutcome 第一终态优先（chat-flow-consistency 缺陷 2 方案 2）', () => {
  it('已有 done 终态 → 后写 stopped 跳过（settling 窗口 abort 不覆盖自然完成的 done）', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-done.jsonl')
    writeFileSync(filePath, '{}\n')
    persistSessionEnd(filePath, 'done', 'natural finish')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('done')

    registerSessionRecord(service, 's1', filePath)
    service.persistSessionOutcome('s1', 'stopped', 'User aborted')
    // 第一终态优先：done 不被覆盖（会话不误标 stopped、不骗出恢复入口）
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('done')
  })

  it('已有 error 终态 → 后写 stopped/done 均跳过', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-error.jsonl')
    writeFileSync(filePath, '{}\n')
    persistSessionEnd(filePath, 'error', 'first failure')
    registerSessionRecord(service, 's2', filePath)
    service.persistSessionOutcome('s2', 'stopped', 'User aborted')
    service.persistSessionOutcome('s2', 'done')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('error')
  })

  it('无既有终态 → 正常写入（首终态落盘通路不拦）', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-fresh.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's3', filePath)
    service.persistSessionOutcome('s3', 'stopped', 'User aborted')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('stopped')
  })

  it('先写者赢的竞态口径：stopped 先写 → 后到 agent_end 的 done 跳过（对齐进程退出链「abort reason 更具诊断价值」）', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-race.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's4', filePath)
    service.persistSessionOutcome('s4', 'stopped', 'User aborted')
    service.persistSessionOutcome('s4', 'done')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('stopped')
  })
})

describe('跨回合终态放行（dmg-r1-1：新回合受理入口清旧终态 sidecar）', () => {
  it('stopped 先写 → 新回合受理 clearSessionOutcome → 新回合正常完成 done 应覆盖', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-cross-stopped.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's7', filePath)
    // 上一回合：用户 abort → stopped 落盘
    service.persistSessionOutcome('s7', 'stopped', 'User aborted')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('stopped')
    // 新回合受理（message-dispatcher.runAcceptance 受理成功后的调用点）：清旧终态
    service.clearSessionOutcome('s7')
    expect(sessionStore.extractSessionOutcome(filePath)).toBeNull()
    // 新回合正常完成：done 不再被旧 stopped 拦截（重启后侧栏按新终态显示）
    service.persistSessionOutcome('s7', 'done')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('done')
  })

  it('error → done 同型：新回合受理清旧 error 后，新回合完成 done 应覆盖', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-cross-error.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's8', filePath)
    service.persistSessionOutcome('s8', 'error', 'LLM failed')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('error')
    service.clearSessionOutcome('s8')
    service.persistSessionOutcome('s8', 'done')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('done')
  })

  it('未受理新回合（不清除）时第一终态优先保护原样生效：done 仍被旧 stopped 拦截（同回合竞态口径回归锚）', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-cross-guard.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's9', filePath)
    service.persistSessionOutcome('s9', 'stopped', 'User aborted')
    service.persistSessionOutcome('s9', 'done')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('stopped')
  })

  it('clearSessionOutcome 对无 sidecar 的会话幂等无害（进行中会话常态）', () => {
    const { service } = createService()
    const filePath = join(runDir, 's-cross-nometa.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's10', filePath)
    expect(() => service.clearSessionOutcome('s10')).not.toThrow()
  })
})

describe('handleTurnEndSideEffects willRetry 中间失败跳终态（chat-flow-consistency 缺陷 1 方案 A）', () => {
  it('willRetry=true → persistSessionOutcome 不调用（attempt 级失败不落盘终态）', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-retry.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's5', filePath)
    const outcomeSpy = vi.spyOn(service, 'persistSessionOutcome')
    service.handleTurnEndSideEffects('s5', 'error', true)
    expect(outcomeSpy).not.toHaveBeenCalled()
    expect(sessionStore.extractSessionOutcome(filePath)).toBeNull()
  })

  it('willRetry=false/缺省 → 终态照写（stopReason error → error）', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-final.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's6', filePath)
    service.handleTurnEndSideEffects('s6', 'error', false)
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('error')
    service.handleTurnEndSideEffects('s6', undefined)
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('error') // 已有终态，first wins
  })
})
