/**
 * G5 faux-pi 用例：思考等级生效回执端到端保险丝（pi-boundary-reliability D7-G5 / U7a，
 * L2.5 faux 轨翻轨：真 pi 进程 + 真 extension 加载 + 假 LLM）。
 *
 * 验收断言（设计 §3.3 D7 表 G5）：
 * - 真实 pi 下 reasoning:false 模型 set 'high' → runtime 回执 = get_state 实值 = 'off'；
 * - 正常（reasoning:true 且支持 high）模型 → 回执 = 请求值。
 * 这是「config ≡ pi effective」的端到端保险丝：runtime 侧回执链（settings-message-handler
 * 的 session.thinkingLevelSet reply 消费 session-service.setThinkingLevel 的返回值——
 * set 后 get_state 读 effective，非请求值）必须在真实 pi 两级门控/钳制下仍成立。
 * renderer protocol 修型（reply void → {sessionId, level}）是并行单元 U6 的领地，本测试
 * 断言 runtime 层（SessionService 生产代码）的返回值语义，不依赖 U6。
 *
 * 与探针族（src/infra/pi/__tests__/pi-semantics-*.test.ts）的分工：探针静态断言 pi dist
 * 代码形态/同源函数行为；本文件起真实 pi 子进程验证 runtime 生产链路在真实钳制下的回执真值
 * （PS-02/PS-12 的运行时实证）。
 *
 * faux 轨装配（原真实 LLM 通道翻轨，断言语义不变）：全程无 LLM turn（set/get 皆本地 RPC），
 * 演员由 faux provider 双模型承担（faux-llm-ext 注册，见 fixtures/faux-llm-ext.ts 文件头）：
 * - faux/faux-1（reasoning:false）= 钳制用例演员（getSupportedThinkingLevels 恒 ['off']）；
 * - faux/faux-1-reasoning（reasoning:true，无 thinkingLevelMap）= 正常档位用例演员
 *   （档位 ['off','minimal','low','medium','high']，含 high）。
 * 双演员取代旧「宿主 models.json 撞运气 + injectReasoningOffProbe 注入 openai 演员」两套
 * 来源——用例确定性自足，且凭证无关（门控 FAUX_PI_READY 只判 binary，CI 可跑）。
 * pi 的 setThinkingLevel 档位变化时写全局 settings（setDefaultThinkingLevel）落在
 * spawnPiFixture faux 通道的临时 agentDir，dispose 删除，不污染 ~/.pi/agent。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/equivalence/thinking-level-effective-e2e.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { SessionService } from '../../services/session/session-service.js'
import type { IPiEngine, IProcessManager } from '../../services/ports/pi-engine.js'
import type { IMessageBroker } from '../../interfaces.js'
import { spawnPiFixture, FAUX_PI_READY, FAUX_PI_SKIP_REASON, type PiFixture } from './pi-fixture.js'

const SID = 'g5-thinking-level'

/** get_available_models 返回项的消费面（pi-ai Model 的宽形态，只声明用到的字段）。 */
interface AvailableModel {
  id: string
  provider: string
  reasoning?: boolean
}

// ==================== 演员常量（faux provider 双模型，确定性自足） ====================

/** 钳制用例演员：reasoning:false → pi 两级门控钳回 off（getSupportedThinkingLevels 恒 ['off']） */
const CLAMP_ACTOR = { provider: 'faux', id: 'faux-1' } as const
/** 正常档位用例演员：reasoning:true 且无 thinkingLevelMap → 档位含 high，set high 生效 */
const NORMAL_ACTOR = { provider: 'faux', id: 'faux-1-reasoning' } as const

/** 把 fixture 的原始 JSONL RPC 适配成 SessionService 消费的 IPiEngine 语义面（唯一适配点）。 */
function makeEngine(fx: PiFixture): IPiEngine {
  return {
    getCommands: async () => [],
    getState: async () => (await fx.sendCommand('get_state')).data as Record<string, unknown>,
    setThinkingLevel: async (level: string) =>
      await fx.sendCommand('set_thinking_level', { level }),
    setModel: async (provider: string, modelId: string) =>
      await fx.sendCommand('set_model', { provider, modelId }),
  } as unknown as IPiEngine
}

/** 最小 SessionService 装置（参考 scalar-state-invalidation.test.ts 的构造形态；pm/broker 全 stub）。 */
function makeSessionService(engine: IPiEngine): SessionService {
  const broker = { broadcast: vi.fn() } as unknown as IMessageBroker
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => engine),
  } as unknown as IProcessManager
  return new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
  )
}

describe.skipIf(!FAUX_PI_READY)(
  `G5 equivalence: 思考等级生效回执（faux-pi 子进程${FAUX_PI_SKIP_REASON ? `｜skip：${FAUX_PI_SKIP_REASON}` : ''}）`,
  () => {
    let fixture: PiFixture | null = null
    let svc: SessionService | null = null

    beforeAll(async () => {
      // faux 通道（空数组 = 全程无 LLM turn，faux 队列耗尽即报错是意外 turn 的 fail-fast）
      fixture = await spawnPiFixture({ fauxResponses: [] })
      const engine = makeEngine(fixture)
      svc = makeSessionService(engine)
      await svc.initializeManagedSession(SID, engine, fixture.sessionDir, 'g5')
    }, 30_000)

    afterAll(async () => {
      try {
        svc?.removeSessionEntry(SID)
      } finally {
        if (fixture) await fixture.dispose()
      }
    })

    /** 当前 pi 合并清单（get_available_models，PS-10 面）。 */
    async function availableModels(): Promise<AvailableModel[]> {
      const resp = await fixture!.sendCommand('get_available_models')
      return ((resp.data as { models?: AvailableModel[] } | undefined)?.models ?? []) as AvailableModel[]
    }

    /** 切到满足谓词的模型并验证 pi 实际支持档位（get_available_thinking_levels 为准）。
     * target 是失败消息里的人类可读目标（演员写显式名字），便于一眼看出依赖哪个演员。 */
    async function switchToModel(
      predicate: (m: AvailableModel) => boolean,
      wantLevel: string,
      target: string,
    ): Promise<AvailableModel> {
      const models = await availableModels()
      const candidate = models.find(predicate)
      expect(
        candidate,
        `get_available_models 中找不到 ${target}（清单 ${models.length} 个：${models.map((m) => `${m.provider}/${m.id}`).join(', ')}）`,
      ).toBeDefined()
      await fixture!.sendCommand('set_model', { provider: candidate!.provider, modelId: candidate!.id })
      const levels = (await fixture!.sendCommand('get_available_thinking_levels')) as unknown as {
        data?: { levels?: string[] }
      }
      expect(
        levels.data?.levels,
        `切换到 ${candidate!.provider}/${candidate!.id} 后 pi 报告的可用档位异常`,
      ).toContain(wantLevel)
      return candidate!
    }

    it('正常模型（reasoning:true 且支持 high）：runtime 回执 = 请求值 = get_state 实值', { timeout: 60_000 }, async () => {
      await switchToModel(
        (m) => m.provider === NORMAL_ACTOR.provider && m.id === NORMAL_ACTOR.id,
        'high',
        `faux 演员 ${NORMAL_ACTOR.provider}/${NORMAL_ACTOR.id}（reasoning:true）`,
      )

      const reply = await svc!.setThinkingLevel(SID, 'high')
      expect(reply, 'runtime 回执应等于请求值（该档位受支持，无钳制）').toBe('high')

      const raw = (await fixture!.sendCommand('get_state')).data as { thinkingLevel?: string }
      expect(raw.thinkingLevel, 'G5 核心等式：回执 = get_state 实值（pi 生效档）').toBe(reply)
    })

    it('reasoning:false 模型 set high：pi 两级门控钳回 off，runtime 回执如实返回 off（非请求值）', { timeout: 60_000 }, async () => {
      // 钳制演员（faux provider 注册的 reasoning:false 模型），按显式名字定位：
      // 用例不依赖宿主 models.json 内容，凭证无关。
      const actor = await switchToModel(
        (m) => m.provider === CLAMP_ACTOR.provider && m.id === CLAMP_ACTOR.id,
        'off',
        `faux 演员 ${CLAMP_ACTOR.provider}/${CLAMP_ACTOR.id}（reasoning:false）`,
      )
      expect(actor.reasoning, 'pi 的模型清单应把钳制演员报为 reasoning:false（extension 注册内容已生效）').toBe(false)

      const reply = await svc!.setThinkingLevel(SID, 'high')
      expect(reply, 'runtime 回执必须是 pi 生效值 off（PS-02 两级门控），乐观回显请求值 = 事故 B 形态').toBe('off')

      const raw = (await fixture!.sendCommand('get_state')).data as {
        thinkingLevel?: string
        model?: { provider?: string; id?: string }
      }
      // 演员身份核对：pi 当前生效模型就是钳制演员（排除「切模型静默失败、仍停在上一用例模型」的假通过）
      expect(raw.model?.provider, 'pi 当前模型应为钳制演员 provider').toBe(CLAMP_ACTOR.provider)
      expect(raw.model?.id, 'pi 当前模型应为钳制演员 model id').toBe(CLAMP_ACTOR.id)
      expect(raw.thinkingLevel, 'G5 核心等式：回执 = get_state 实值（钳制后真值）').toBe('off')
    })
  },
)
