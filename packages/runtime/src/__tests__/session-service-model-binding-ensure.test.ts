/**
 * tryPersistModelBinding（D1 写点③延迟 flush 兜底）turn-end 路径测试。
 *
 * 背景（Gate B 端到端实证，2026-09-04）：lifecycle create 路径的写点③在真实流程中从不
 * 生效——pi 延迟 flush，create 瞬间 sessionFilePath undefined，`if (session.sessionFilePath)`
 * 守卫恒跳过；旧单元测试 mock 了 sessionFile 掩盖时序（真实 app：新建并对话过的 session
 * 目录里无 .model.json，重启后 composer 回落全局默认；同 session 显式切模型（写点①）
 * 立即产出 sidecar，证明写点本身工作、缺的只是 create 窗口的补写时机）。
 *
 * 修复镜像 tryPersistProjectBinding（D14 同款问题同款解法）：turn_end（主路径，
 * handleTurnUsageSideEffects）/ agent_end（兜底，handleTurnEndSideEffects）时 session
 * 文件已 materialize，Facade tryPersistModelBinding 补写——缺失才写（readModelBinding
 * 命中即打标跳过不覆写，新鲜度归写点①⑤），modelBindingSidecarEnsured 打标防重复。
 *
 * 场景：
 * a. 从未显式切模的 session：turn end → .model.json 产生且含内存生效值（modelId/thinkingLevel）
 * b. sidecar 已存在（预写不同值）→ turn end 不覆写（值保持预写值）
 * c. sessionFilePath undefined / JSONL 不存在 / modelId 空 → no-op 不抛
 * d. 同 session 第二次 turn end（含 agent_end 兜底）→ persist 只调一次（打标生效）
 *
 * stub 形态照抄 session-service-thinking-effective.test.ts makeEnv（Facade 全家桶最小
 * 构造，真实 SessionService + 真实落盘）；persistModelBinding 经 vi.mock + importActual
 * 委托真值落盘（restore-seeding 同款 mock 链，re-export 面锚定 session-file-utils），
 * spy 计数供 d 断言。写删目标 mkdtempSync 自建自删（TEST-STRATEGY 红线，fs-guard 白名单）。
 *
 * 运行：cd packages/runtime && pnpm vitest run src/__tests__/session-service-model-binding-ensure.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// persistModelBinding 包装成 spy 并委托真值实现（真值落盘行为不变，spy 计数供打标断言；
// readModelBinding 保持 actual——「缺失才写」守卫走真实读）。
vi.mock('../infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/session-file-utils.js')>()
  return { ...actual, persistModelBinding: vi.fn(actual.persistModelBinding) }
})
import { persistModelBinding } from '../infra/pi/session-file-utils.js'
import { SessionService } from '../services/session/session-service.js'
import { MessageBus } from '../services/message-bus/message-bus.js'
import type { IMessageBroker } from '../interfaces.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { IManagedSessionView } from '../services/session/types.js'

/** 每用例独立临时目录（自建自删，fs-guard 白名单 = tmpdir）。 */
function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'model-binding-ensure-'))
}

/**
 * Facade 全家桶最小构造（thinking-effective 同款）：sessionStore 补齐 persist* 与
 * outcome 终态 stub，client 补齐播种 RPC 三方法（registerSession 播种异步 fetch 不崩）。
 */
function makeEnv() {
  const broker = { broadcast: vi.fn() } as unknown as IMessageBroker
  const client = {
    getState: vi.fn(async () => ({ thinkingLevel: 'high' })),
    getSessionStats: vi.fn(async () => ({ contextUsage: { tokens: 100, contextWindow: 128000, percent: 25 } })),
    getCommands: vi.fn(async () => []),
  } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => undefined),
  } as unknown as IProcessManager
  const bus = new MessageBus()
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService
    { getDefaultModel: () => ({ provider: 'p', modelId: 'm' }) } as never, // configStore
    {
      scanSessions: vi.fn(() => []),
      extractSessionOutcome: vi.fn(() => null),
      persistSessionEnd: vi.fn(),
      persistPresetBinding: vi.fn(),
      persistProjectBinding: vi.fn(),
    } as never, // sessionStore
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
    bus,
  )
  svc.setMessageBus(bus)
  return { svc, client }
}

/**
 * create 瞬间真实形态：sessionFilePath undefined（pi 延迟 flush 窗口，写点③恒跳过），
 * 经 modelOverride 播种内存生效 modelId（从未显式切模的 session 也有内存值）。
 */
async function createInFlushWindow(svc: SessionService, client: IPiEngine, modelOverride = 'prov/model-x'): Promise<IManagedSessionView> {
  return svc.initializeManagedSession('s1', client, '/tmp', 't', undefined, undefined, undefined, undefined, modelOverride)
}

/** 模拟 pi 首 turn flush：session JSONL materialize（存在性即守卫所需，内容随意）。 */
function materializeSessionFile(dir: string): string {
  const jsonl = join(dir, 's1.jsonl')
  writeFileSync(jsonl, '{"type":"session_info"}\n', 'utf8')
  return jsonl
}

afterEach(() => {
  vi.mocked(persistModelBinding).mockClear()
})

// ── 场景 a：从未显式切模 → turn end 补写内存生效值 ──

describe('tryPersistModelBinding（D1 写点③延迟 flush 兜底）', () => {
  it('a: 从未显式切模的 session——turn end 时 .model.json 产生且含内存生效值（modelId/thinkingLevel）', async () => {
    const dir = newDir()
    try {
      const { svc, client } = makeEnv()
      const session = await createInFlushWindow(svc, client)
      session.thinkingLevel = 'high'
      const jsonl = materializeSessionFile(dir)
      session.sessionFilePath = jsonl // pi flush materialize（create 窗口后）
      expect(existsSync(jsonl + '.model.json')).toBe(false) // 前置：写点③窗口已错过且无 sidecar

      svc.handleTurnUsageSideEffects('s1') // turn_end 主路径

      expect(existsSync(jsonl + '.model.json')).toBe(true)
      expect(JSON.parse(readFileSync(jsonl + '.model.json', 'utf8'))).toMatchObject({
        modelId: 'prov/model-x',
        thinkingLevel: 'high',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('b: sidecar 已存在（预写不同值）→ turn end 不覆写（值保持预写值）', async () => {
    const dir = newDir()
    try {
      const { svc, client } = makeEnv()
      const session = await createInFlushWindow(svc, client)
      const jsonl = materializeSessionFile(dir)
      session.sessionFilePath = jsonl
      const prewritten = { modelId: 'other/model', thinkingLevel: 'max', version: 1 }
      writeFileSync(jsonl + '.model.json', JSON.stringify(prewritten), 'utf8')

      svc.handleTurnUsageSideEffects('s1')

      // 严格全等比对：内存生效值（prov/model-x）不得覆写已有 sidecar（新鲜度归写点①⑤）
      expect(JSON.parse(readFileSync(jsonl + '.model.json', 'utf8'))).toEqual(prewritten)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('c1: sessionFilePath undefined（create 瞬间）→ no-op 不抛', async () => {
    const { svc, client } = makeEnv()
    await createInFlushWindow(svc, client)
    expect(() => svc.handleTurnUsageSideEffects('s1')).not.toThrow()
    expect(() => svc.handleTurnEndSideEffects('s1')).not.toThrow()
  })

  it('c2: JSONL 不存在（守卫存在性）→ no-op 不抛且不产生 sidecar（规则 #6 绝不提前建文件）', async () => {
    const dir = newDir()
    try {
      const { svc, client } = makeEnv()
      const session = await createInFlushWindow(svc, client)
      session.sessionFilePath = join(dir, 'not-materialized.jsonl')

      expect(() => svc.handleTurnUsageSideEffects('s1')).not.toThrow()
      expect(existsSync(session.sessionFilePath + '.model.json')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('c3: modelId 空（守卫在路径之前）→ no-op 不抛且不产生 sidecar', async () => {
    const dir = newDir()
    try {
      const { svc, client } = makeEnv()
      const session = await createInFlushWindow(svc, client, '')
      const jsonl = materializeSessionFile(dir)
      session.sessionFilePath = jsonl

      expect(() => svc.handleTurnUsageSideEffects('s1')).not.toThrow()
      expect(existsSync(jsonl + '.model.json')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('d: 同 session 第二次 turn end 与 agent_end 兜底 → persist 只调一次（打标生效）', async () => {
    const dir = newDir()
    try {
      const { svc, client } = makeEnv()
      const session = await createInFlushWindow(svc, client)
      const jsonl = materializeSessionFile(dir)
      session.sessionFilePath = jsonl

      svc.handleTurnUsageSideEffects('s1') // 第一次 turn end：补写 + 打标
      expect(persistModelBinding).toHaveBeenCalledTimes(1)
      expect(existsSync(jsonl + '.model.json')).toBe(true)

      svc.handleTurnUsageSideEffects('s1') // 第二次 turn end：打标命中，不重复写
      svc.handleTurnEndSideEffects('s1') // agent_end 兜底：同上
      expect(persistModelBinding).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
