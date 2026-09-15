/**
 * W22 broadcast ≡ get_state 等价性用例（data-source-governance P4.1，G3 长期回归基线）。
 *
 * 验收对照（.taiji-harness/2026-08-19-data-source-governance-p1p4/acceptance/w22-acceptance.md 交付物 1/4）：
 * - 「fixture 发事件风暴（多轮对话 + 切模型 + 队列操作），断言实例快照 + stateSnapshot 广播内容
 *   == get_state + get_session_stats + get_commands 逐字段」→ it 1：四实例（W7/W8 生产配置，
 *   label / queue 深度实例已随 PR #185 MF1/MF2 撤销）+
 *   MessageBus（生产类）经真实 pi RPC 喂入；state topic 三类消息按 session-service 既有发布口径
 *   （fetchContext / fetchAndBroadcastCommands / broadcastSessionState 投影）构造 publish。
 *   断言的是「广播 last-value == 发布后的独立第二次权威拉取」——W12 把发布源切实例快照后
 *   断言仍成立（任何内部源都必须等于权威 RPC 投影）。
 * - W21 定案联动（store 纯累积，W21 verifier 裁决 2 硬前置）→ it 2：事件帧经 core store 生产
 *   入口（applyMessageEvent → registry → applyEntryFrame）喂入后，断言 reducer state（权威镜像）
 *   ≡ get_entries 重放；渲染 ref（overlay 路径）与重开视图（hydrate 权威重放）的消息条数 +
 *   role 序列 deep equal（原 console.log 探针已升级为真实断言；id 形态差异是 W21 裁决的
 *   遗留态，收敛投影归后续 wave）。
 *
 * 双喂形态（W21 verifier 备忘 1）：生产 registry 中 toolResult 经 tool_call_end + message_end
 * 两帧都喂 reducer（it 2 帧语料天然含双通道），applyEntry toolResult 覆盖式配对回填幂等——
 * it 2 的收敛断言显式覆盖该双喂。
 *
 * fixture 进程复用（验收 4，总时长 <120s 预算）：整 describe 一个 pi 进程（beforeAll/afterAll），
 * 两用例共享累积事件流；it 2 以事件起点标记切分本用例增量（it 1 的事件不进本次 live 侧）。
 *
 * faux LLM 轨（L2.5 翻轨）：验证对象是「实例快照/广播 == 权威 RPC 投影」与 store 喂入
 * 同构，非模型智能——事件风暴的三轮 turn 响应与 it2 的 bash 工具轮由 fauxResponses 脚本
 * 固定（单一队列逐轮消费，消费序 = r1 → r2 → followup → bash toolCall → 总结文本），
 * 断言语义与翻轨前一致。usage 数值按 faux 估算口径断言 typeof number + 与权威拉取逐字段
 * 一致（禁精确值）。门控 FAUX_PI_READY（只判 binary，凭证无关、CI 可跑）。
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { effectScope } from 'vue'
import { textToSegments } from '@taiji/shared'
import type { ServerMessage } from '@taiji/shared'
import { spawnPiFixture, FAUX_PI_READY, FAUX_PI_SKIP_REASON, type PiFixture } from './pi-fixture.js'
import { translate } from '../../infra/pi/event-adapter.js'
import type { PiEvent } from '../../infra/pi/pi-protocol.js'
import { EventInterpreter } from '../../services/session/event-interpreter.js'
import { MessageBus } from '../../services/message-bus/message-bus.js'
import type { BusClient } from '../../services/message-bus/types.js'
import { ReplicatedState } from '../../services/session/replicated-state.js'
import {
  createThinkingLevelStateConfig,
  createModelIdStateConfig,
  createUsageStateConfig,
  createCommandsStateConfig,
} from '../../services/session/replicated-states.config.js'
import type { PiCommandInfo } from '../../services/ports/pi-engine.js'
import { createChatStore } from '../../../../core/src/domain/chat/store.js'
import { replayEntries, type PiEntry } from '../../../../core/src/domain/chat/apply-entry.js'

/** 等 turn 完成的上限（真实 LLM 调用；对齐 live-reload.test.ts 余量口径） */
// 预算校准 [HISTORICAL]：满载环境下（premerge 实测 test:runtime 832s vs 空闲 144s ≈ 5.8×）
// mimo 单轮可超 120s，旧预算被真实慢击穿（红例 seen types 均含完整 turn 序列）。取 300s
// 与 attach-lifecycle 口径一致；用例级 timeout 同步上调
const TURN_TIMEOUT_MS = 300_000
/** it 1 = 冷启动 + 3 个 turn（2 轮 prompt + followUp 投递）+ set_model + 实例收敛 + 双次权威拉取 */
const STORM_TEST_TIMEOUT_MS = 600_000
/** it 2 = 1 个带工具调用的 turn + 全量帧投递 + get_entries */
const STORE_TEST_TIMEOUT_MS = 600_000

/** 真实 timers 轮询等待（真实 pi 用例；fake timers 禁用于真实子进程 IO——W7/W8 同款） */
async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${label}`)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** unknown → Record 运行时守卫收窄（宽 wire 形态断言用，禁 any 契约） */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** message_end 帧携带的 entry（运行时守卫收窄；非 message_end 帧返回 undefined） */
function entryOfMessageEndFrame(frame: ServerMessage): PiEntry | undefined {
  if (frame.type !== ('message.message_end' as string)) return undefined
  const payload = (frame as { payload?: unknown }).payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const entry = (payload as Record<string, unknown>).entry
  if (typeof entry !== 'object' || entry === null) return undefined
  return entry as PiEntry
}

describe.skipIf(!FAUX_PI_READY)(
  `W22 equivalence: broadcast ≡ get_state（faux-pi 子进程${FAUX_PI_SKIP_REASON ? `｜skip：${FAUX_PI_SKIP_REASON}` : ''}）`,
  () => {
  let fixture: PiFixture | null = null

  beforeAll(async () => {
    // 流控（faux 轨特有）：TAIJI_FAUX_TPS=5 + r2 长文本 → r2 轮 ~16s 流式窗口，保证
    // follow_up 落在 turn 进行中（pi 在跑 → 入队 + queue_update 事件；idle 后投递无
    // 非空队列生命周期，队列断言假失败）。spawn 前设置，afterAll 恢复。
    process.env.TAIJI_FAUX_TPS = '5'
    // faux 队列消费序：it1 三轮（r1 → r2 长轮 → followup run 内 drain）+ it2 一轮
    // bash 工具（toolCall → --approve 真实执行 echo → 下一轮总结文本）
    fixture = await spawnPiFixture({
      fauxResponses: [
        { text: 'w22-r1' },
        { text: `w22-r2 ${Array.from({ length: 30 }, (_, i) => `segment-${i}`).join(' ')}` },
        { text: 'w22-followup' },
        { toolCalls: [{ name: 'bash', args: { command: 'echo w22-store' } }] },
        { text: 'w22-store' },
      ],
    })
  }, 15_000)

  afterAll(async () => {
    try {
      if (fixture) {
        await fixture.dispose()
        fixture = null
      }
    } finally {
      delete process.env.TAIJI_FAUX_TPS
    }
  })

  // 失败兜底（设计 U3/G1）：上一用例失败后在途 turn 由 recover 截断，防 Agent is already
  // processing 毒死同文件后续用例；非 busy 时零操作幂等，不影响正常用例
  afterEach(async () => {
    await fixture?.recover()
  })

  it(
    '事件风暴（多轮对话 + followUp 队列 + 切模型）后实例快照与 stateSnapshot 广播 == 三 RPC 权威快照逐字段',
    { timeout: STORM_TEST_TIMEOUT_MS },
    async () => {
      const fx = fixture!
      const sid = 'w22-broadcast'

      // ── 装置：四实例（W7/W8 生产配置，fetch 直连 fixture RPC）+ MessageBus（生产类）──
      const fetchState = async (): Promise<Record<string, unknown>> =>
        asRecord((await fx.sendCommand('get_state')).data)
      const fetchStats = async (): Promise<Record<string, unknown>> =>
        asRecord((await fx.sendCommand('get_session_stats')).data)
      const fetchCommands = async (): Promise<PiCommandInfo[]> => {
        const resp = await fx.sendCommand('get_commands')
        const data = asRecord(resp.data)
        // pi get_commands 响应形态 = { commands: [...] }（rpc-mode.ts:683；生产 rpc-client.getCommands
        // 已解包数组，fixture 直发 RPC 需自行取 data.commands 对齐——W8 同款口径）
        return Array.isArray(data.commands) ? (data.commands as PiCommandInfo[]) : []
      }

      const thinkingLevelState = new ReplicatedState(createThinkingLevelStateConfig(fetchState))
      const modelIdState = new ReplicatedState(createModelIdStateConfig(fetchState))
      const usageState = new ReplicatedState(createUsageStateConfig(fetchStats))
      const commandsState = new ReplicatedState(createCommandsStateConfig(fetchCommands))
      // 四实例（label / queue 深度实例已撤销，PR #185 MF1/MF2：.get() 生产零消费——
      // label 真值 = session.renamed 帧事件 payload + setLabelCache 直写；深度真值 =
      // queue_update 帧内 pendingMessageCount 推送投影，两者均不经实例快照）
      const states = [thinkingLevelState, modelIdState, usageState, commandsState]
      const bus = new MessageBus()

      // 播种（生产：registerReplicatedStates 的 refetch）
      for (const s of states) s.refetch()
      await waitUntil('seed instances', () => states.every((s) => s.get() !== undefined))

      // ── 事件风暴 ──
      const agentEnds = () => fx.collectEvents((e) => e.type === 'agent_end').length
      const agentEndsBefore = agentEnds()
      const countOf = (type: string) => fx.collectEvents((e) => e.type === type).length
      const thinkingLevelChangedBefore = countOf('thinking_level_changed')

      // 第 1 轮对话（runTurn：原子化打点→prompt→只等本轮 agent_end，取代手工计数防御；
      // agentEndsBefore 保留供第 2 轮复合断言累计口径引用）
      await fx.runTurn({ message: 'Reply with exactly: w22-r1' }, TURN_TIMEOUT_MS)
      // 生产接线：agent_end → applyContextUpdate 汇聚点 → usage markDirty
      usageState.markDirty()

      // 第 2 轮对话 + 队列操作（turn 进行中 follow_up 入队 → queue_update 事件 → run 内投递；
      // pi agent-session._queueFollowUp 恒 push + _emitQueueUpdate → 队列事件真实性有协议保证。
      // agent_end 计数口径：followUp 在 run 内 drain（agent「本要停」时队列非空 → 继续下一 turn），
      // r2 + followup 同属一个 run = 1 个 agent_end——与 W5 探针/生产语义一致，勿按「每消息一个」计）
      await fx.sendCommand('prompt', { message: 'Reply with exactly: w22-r2' })
      await fx.sendCommand('follow_up', { message: 'Reply with exactly: w22-followup' })
      const queueUpdates = () => fx.collectEvents((e) => e.type === 'queue_update')
      const queueUpdatesBefore = queueUpdates().length
      await waitUntil('followUp queue_update', () => queueUpdates().length > queueUpdatesBefore, TURN_TIMEOUT_MS)
      // 队列深度经帧内 pendingMessageCount 推送（PR #185 MF2：无实例失效接线，帧即深度权威推送）
      await waitUntil(
        'round-2(run 含 followup 投递) agent_end',
        () => agentEnds() >= agentEndsBefore + 2,
        TURN_TIMEOUT_MS,
      )
      // 投递证据守卫：队列经历「非空 → 清空」完整生命周期（pi drain 时 dequeue + _emitQueueUpdate；
      // 清空事件必须在非空事件之后，防止 session 启动期的空队列事件造成假阳性）
      await waitUntil(
        'followup drain queue_update (depth back to 0)',
        () => {
          const all = queueUpdates()
          const nonEmptyIdx = all.findIndex((e) => Array.isArray(e.followUp) && e.followUp.length > 0)
          return (
            nonEmptyIdx !== -1 &&
            all.slice(nonEmptyIdx + 1).some((e) => Array.isArray(e.followUp) && e.followUp.length === 0)
          )
        },
        TURN_TIMEOUT_MS,
      )
      usageState.markDirty()

      // 风暴含队列操作守卫（防空转）：确实观测到非空 followUp 的 queue_update 事件
      expect(queueUpdates().some((e) => Array.isArray(e.followUp) && e.followUp.length > 0)).toBe(true)

      // 切模型（同模型幂等 set_model——W7 同款安全形态；生产接线：switchModel RPC 成功响应 →
      // modelId markDirty。pi set_model 参数 = 裸 provider + 裸 modelId）
      const switchState = await fetchState()
      const switchModel = asRecord(switchState.model)
      const provider = typeof switchModel.provider === 'string' ? switchModel.provider : ''
      const modelIdRaw = typeof switchModel.id === 'string' ? switchModel.id : ''
      expect(provider).toBeTruthy()
      expect(modelIdRaw).toBeTruthy()
      await fx.sendCommand('set_model', { provider, modelId: modelIdRaw })
      modelIdState.markDirty()

      // commands 查询即失效（生产接线：getCommands 全部调用路径 = 失效源）
      await fetchCommands()
      commandsState.markDirty()

      // 事件驱动失效（生产接线：interpreter 的 thinkingLevelState 解析器；
      // session_info_changed 不再触发实例失效——label 实例已撤销，PR #185 MF1）
      if (countOf('thinking_level_changed') > thinkingLevelChangedBefore) thinkingLevelState.markDirty()

      // ── 风暴期生产发布点：state topic 三类消息按 session-service 既有投影口径 publish ──
      const publishStats = await fetchStats()
      const publishCu = asRecord(publishStats.contextUsage)
      if (typeof publishCu.tokens !== 'number') {
        throw new Error('get_session_stats.contextUsage.tokens 非 number（3 个 agent_end 后必有 assistant usage）')
      }
      const cuTokens: number = publishCu.tokens
      const cuWindow = typeof publishCu.contextWindow === 'number' ? publishCu.contextWindow : 0
      const cuPercent = typeof publishCu.percent === 'number' ? publishCu.percent : 0
      const publishState = await fetchState()
      const publishThinking =
        typeof publishState.thinkingLevel === 'string' ? publishState.thinkingLevel : undefined

      // context.update（session-service.fetchContext 投影口径）
      bus.publish(sid, {
        type: 'context.update',
        payload: {
          sessionId: sid,
          inputTokens: cuTokens,
          contextLimit: cuWindow,
          usagePercent: Math.round(cuPercent),
        },
      })
      // session.commands（fetchAndBroadcastCommands 口径）
      bus.publish(sid, {
        type: 'session.commands',
        payload: { sessionId: sid, commands: await fetchCommands() },
      })
      // session.state_changed（publish 口径：modelId 'provider/model' 组合字符串；D1 协议收敛后
      // 不携带 usage 三字段——usage 只经 context.update 帧）
      bus.publish(sid, {
        type: 'session.state_changed',
        payload: {
          sessionId: sid,
          modelId: `${provider}/${modelIdRaw}`,
          thinkingLevel: publishThinking,
        },
      })

      // ── 全实例收敛（防抖 300ms + 快照 RPC，真实 timers）──
      await waitUntil('all instances converge', () => states.every((s) => !s.isDirty()), 30_000)

      // ── 权威三 RPC（发布后的独立第二次拉取——与发布时无变更间隔，值必须一致）──
      const authState = await fetchState()
      const authStats = await fetchStats()
      const authCommands = await fetchCommands()
      const authCu = asRecord(authStats.contextUsage)
      if (typeof authCu.tokens !== 'number') throw new Error('authoritative contextUsage.tokens 非 number')
      const authModel = asRecord(authState.model)
      expect(typeof authModel.provider).toBe('string')
      expect(typeof authModel.id).toBe('string')
      const authModelId = `${authModel.provider as string}/${authModel.id as string}`
      const authPercent = typeof authCu.percent === 'number' ? authCu.percent : 0

      // ── 实例快照逐字段 == 权威投影 ──
      expect(modelIdState.get()).toEqual({ modelId: authModelId })
      expect(thinkingLevelState.get()).toEqual({
        thinkingLevel: typeof authState.thinkingLevel === 'string' ? authState.thinkingLevel : undefined,
      })
      // usage 投影口径 = 实例配置（min(round, 100) clamp，对齐 MAX_USAGE_PERCENT）
      expect(usageState.get()).toEqual({
        inputTokens: authCu.tokens,
        contextLimit: typeof authCu.contextWindow === 'number' ? authCu.contextWindow : 0,
        usagePercent: Math.min(Math.round(authPercent), 100),
      })
      expect(commandsState.get()?.commands).toEqual(authCommands)

      // 风暴后队列清空守卫（followUp 已投递 = 深度回 0 的合法态）
      expect(authState.pendingMessageCount).toBe(0)

      // ── stateSnapshot 广播内容逐字段 == 权威投影（late subscriber 视角：重连恢复通道）──
      const ws: BusClient = { readyState: 1, send: () => {} }
      const { stateSnapshot } = bus.subscribe(sid, ws)
      const byType = new Map(stateSnapshot.map((m) => [m.type, m]))
      expect(stateSnapshot.length).toBeGreaterThanOrEqual(3) // context / commands / state_changed 全在

      const ctxMsg = byType.get('context.update')
      expect(ctxMsg?.payload).toEqual({
        sessionId: sid,
        inputTokens: authCu.tokens,
        contextLimit: typeof authCu.contextWindow === 'number' ? authCu.contextWindow : 0,
        usagePercent: Math.round(authPercent),
      })

      const cmdsMsg = byType.get('session.commands')
      expect(cmdsMsg?.payload).toEqual({ sessionId: sid, commands: authCommands })

      const stateMsg = byType.get('session.state_changed')
      expect(stateMsg?.payload).toEqual({
        sessionId: sid,
        modelId: authModelId,
        thinkingLevel: typeof authState.thinkingLevel === 'string' ? authState.thinkingLevel : undefined,
      })

      // 清理
      bus.unsubscribe(sid, ws)
      bus.clearSession(sid)
      for (const s of states) s.dispose()
    },
  )

  it(
    'store 级生产喂入：事件帧经 applyMessageEvent 后 reducer state ≡ get_entries 重放（双喂收敛）+ ref 收敛断言（重开视图 deep equal）',
    { timeout: STORE_TEST_TIMEOUT_MS },
    async () => {
      const fx = fixture!
      const sid = 'w22-store-feed'
      const scope = effectScope(true)
      const store = scope.run(() => createChatStore())!

      // 本用例事件起点（fixture 复用——it 1 的事件不进本次 live 侧）
      const startIdx = fx.collectEvents().length

      // 一轮带工具调用的 turn；生产 useChat 发送语义：pendingSend + 乐观 appendUser（overlay 路径）
      const text = 'Use the bash tool to run the command `echo w22-store` and reply with its exact output.'
      store.addPendingSend(sid)
      store.appendUser(sid, textToSegments(text))
      // runTurn 原语取代手工计数基线：空闲起步 prompt → 只等本轮 agent_end
      await fx.runTurn({ message: text }, TURN_TIMEOUT_MS)

      // live 侧：起点后事件经完整生产帧链（adapter translate → EventInterpreter 编排 → send 帧），
      // 帧按产出序喂 store 单一入口（生产链路 interpreter send → ws → renderer applyMessageEvent；
      // 本测试直连 store，跳过 ws 序列化）。逐事件后 flush 一个 macrotask：tool-call-end 的
      // hook 异步路径在下一事件前完成 send，帧序与真实 ws 投递一致。
      const slice = fx.collectEvents().slice(startIdx)
      const liveEndEntries: PiEntry[] = []
      const interpreter = new EventInterpreter(sid, {
        send: (msg) => {
          store.applyMessageEvent(sid, msg)
          const entry = entryOfMessageEndFrame(msg)
          if (entry !== undefined) liveEndEntries.push(entry)
        },
      })
      for (const ev of slice) {
        interpreter.interpret(translate(ev as unknown as PiEvent, sid))
        await new Promise((r) => setTimeout(r, 0))
      }
      expect(liveEndEntries.length).toBeGreaterThanOrEqual(2) // 非空守卫（防 0==0 空转）

      // u6.1 收编：_entryStatesForTest 已并入 testInternals 命名空间（对齐 core custom-start-equivalence.test.ts 的嵌套路径）
      const reducerLive = store.testInternals._entryStatesForTest.get(sid)
      expect(reducerLive).toBeDefined()

      // 单通道参照：仅 message_end 流重放（W21 同构基底）
      const liveSingleState = replayEntries(liveEndEntries)

      // 权威侧：get_entries 全量，取 message entry 尾部 N 条（N = 本轮 message_end 数；
      // message_end ≡ appendMessage 协议事实 → 尾部对齐；剥 id 对齐 e<N> 派生规则——W21 同款）
      const reloadResp = await fx.sendCommand('get_entries')
      const rawEntries: unknown = reloadResp.data?.entries
      if (!Array.isArray(rawEntries)) throw new Error('get_entries reply has no entries array')
      const messageReload = rawEntries
        .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
        .map((e) => {
          const { id: _id, ...rest } = e
          return rest as unknown as PiEntry
        })
        .filter((e) => e.type === 'message')
      expect(messageReload.length).toBeGreaterThanOrEqual(liveEndEntries.length)
      const reloadTail = messageReload.slice(-liveEndEntries.length)
      const reloadTailState = replayEntries(reloadTail)

      // ── 断言 1：生产 registry 喂入（含 toolResult 双喂：tool_call_end + message_end 两帧）≡
      //   message_end 单通道重放 ≡ get_entries 尾部重放（覆盖式配对回填幂等 → 双喂收敛）
      //   [W2 后修] user entry 经真实 message_end(user) 帧入流（appendUser 乐观 entry 不喂
      //   reducer——防双计），两侧同为权威帧派生：id 位置派生、timestamp 同源，严格 deep-equal。
      expect(reducerLive!.messages).toEqual(liveSingleState.messages)
      expect(reducerLive!.messages).toEqual(reloadTailState.messages)
      expect(reducerLive!.clientUuidMap).toEqual(reloadTailState.clientUuidMap)
      expect(reducerLive!.orphanToolResults).toEqual(reloadTailState.orphanToolResults)
      expect(reducerLive!.orphanToolResults).toHaveLength(0)
      expect(reducerLive!.lastAssistantWithToolCalls).toBe(reloadTailState.lastAssistantWithToolCalls)

      // 工具链路覆盖守卫：assistant 带 toolCalls 且 toolResult 已回填（输出含探针串）
      const toolOwner = reloadTailState.messages.find((m) => (m.toolCalls?.length ?? 0) > 0)
      expect(toolOwner).toBeDefined()
      expect(toolOwner?.toolCalls?.[0]?.output).toContain('w22-store')

      // ── 断言 2（W21 定案联动·ref 收敛，真实断言）：实时渲染 ref（overlay 路径：乐观 user +
      //   流式 assistant 气泡）与「重开视图」（生产重开链路 get_entries → replayEntries → hydrate
      //   首入）的消息条数 + role 序列 deep equal——live 喂入与权威重放在用户可见对话流层面一致。
      //   （原 console.log 探针恒真，已升级为断言；id 形态不比——overlay 乐观 u-<uuid> 与
      //   reducer e<N> 派生是 W21 裁决的遗留差异，收敛投影归后续 wave。）
      const refMsgs = store.getMessages(sid)
      const reopenScope = effectScope(true)
      const reopenStore = reopenScope.run(() => createChatStore())!
      reopenStore.hydrate(sid, reloadTailState.messages)
      const reopenMsgs = reopenStore.getMessages(sid)
      expect(reopenMsgs.length).toBe(refMsgs.length)
      expect(reopenMsgs.map((m) => m.role)).toEqual(refMsgs.map((m) => m.role))
      reopenScope.stop()

      // 探针有效性守卫（防 0==0 空转）：overlay 路径确已产出实体（乐观 user + assistant 气泡）
      expect(refMsgs.length).toBeGreaterThanOrEqual(2)
      expect(refMsgs.some((m) => m.role === 'user' && m.id.startsWith('u-'))).toBe(true)

      scope.stop()
    },
  )
})
