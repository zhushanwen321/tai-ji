/**
 * W22 混沌注入等价性用例（data-source-governance P4.1，G3 长期回归基线）。
 *
 * 验收对照（.taiji-harness/2026-08-19-data-source-governance-p1p4/acceptance/w22-acceptance.md 交付物 2）：
 * 混沌三态——乱序（打乱非 streaming 事件顺序）/ 丢失（拦截不下发）/ 重放（同事件发两次）——
 * 每种 ≥1 用例，全部断言收敛到权威快照（拉取自愈的结构性验证，父文档 §3.6 第 3 层）：
 * 投递层混沌只造成可检测的脏 state，权威拉取（get_entries → replayEntries，reducer 确定性）
 * 恒得同一权威 state——重连/刷新以权威拉取重建视图即自愈，不依赖投递顺序。
 *
 * 注入层级 = 帧（ServerMessage）：真实 pi 事件经完整生产帧链（adapter translate →
 * EventInterpreter 编排 → send）产出的非 transient 帧语料（message_end / tool_call_start /
 * tool_call_end / message_start / complete 等），经 core store 生产入口 applyMessageEvent
 * 投递——与 W21 的 entry 级混沌（live-reload.test.ts 用例 3）相比本文件在 wire 帧层级注入，
 * 覆盖 registry 喂入路径与生产双喂形态（tool_call_end + message_end 两帧投递同一 toolResult，
 * W21 verifier 备忘 1 的显式收敛用例；tool_call_end 帧由 interpreter 产出，translate 只出
 * 中间事件——这是语料必须走完整帧链的原因）。
 *
 * fixture 进程复用（验收 4）：整 describe 一个 pi 进程；beforeAll 跑一轮带工具调用的 turn 生成
 * 帧语料，三用例纯计算复用（无第二次 LLM 调用），总时长预算内（<120s）。
 *
 * 乱序注入的确定性：倒序投递（非随机 shuffle）——任意相邻对换位，保证非恒等置换（可复现，
 * 不依赖随机种子）；脏化信号 = toolResult 先于 owner assistant 到达 → 孤儿收集（applyEntry
 * 窗口局部配对语义，console.warn 为预期可观测噪声）。
 *
 * faux LLM 轨（L2.5 翻轨）：验证对象是帧链编排与投递层混沌收敛，非模型智能——语料 turn 的
 * 响应由 fauxResponses 脚本固定（bash toolCall + 文本回复，--approve 真实执行），断言语义与
 * 翻轨前一致。门控 FAUX_PI_READY（只判 binary，凭证无关、CI 可跑，约定见 pi-fixture.ts 文件头）。
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { effectScope } from 'vue'
import type { ServerMessage } from '@taiji/shared'
import { spawnPiFixture, FAUX_PI_READY, FAUX_PI_SKIP_REASON, type PiFixture } from './pi-fixture.js'
import { translate } from '../../infra/pi/event-adapter.js'
import type { PiEvent } from '../../infra/pi/pi-protocol.js'
import { EventInterpreter } from '../../services/session/event-interpreter.js'
import { createChatStore } from '../../../../core/src/domain/chat/store.js'
import { replayEntries, type ChatViewState, type PiEntry } from '../../../../core/src/domain/chat/apply-entry.js'

/** 等 turn 完成的上限（faux 轨实际毫秒级；名义上限保留翻轨前余量口径防 flake） */
const TURN_TIMEOUT_MS = 120_000
/** 语料生成 = 冷启动 + 1 个带工具调用的 turn */
const CORPUS_TIMEOUT_MS = 180_000
/** 三混沌用例为纯计算（语料已生成），30s 上限富余 */
const CHAOS_TEST_TIMEOUT_MS = 30_000

/** message_end 帧携带的 entry（运行时守卫收窄；非 message_end 帧返回 undefined） */
function entryOfMessageEndFrame(frame: ServerMessage): PiEntry | undefined {
  if (frame.type !== ('message.message_end' as string)) return undefined
  const payload = (frame as { payload?: unknown }).payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const entry = (payload as Record<string, unknown>).entry
  if (typeof entry !== 'object' || entry === null) return undefined
  return entry as PiEntry
}

/** assistant message entry 是否含 toolCall content block（host 判定，运行时守卫收窄；
 *  双类型对齐 reducer apply-entry.ts assistant 分支的接受集——pi wire 用 'toolCall'） */
function hasToolUse(entry: PiEntry): boolean {
  if (entry.type !== 'message') return false
  const content = entry.message.content
  if (!Array.isArray(content)) return false
  return content.some(
    (c) =>
      typeof c === 'object' &&
      c !== null &&
      ((c as { type?: unknown }).type === 'toolCall' || (c as { type?: unknown }).type === 'tool_use'),
  )
}

describe.skipIf(!FAUX_PI_READY)(
  `W22 equivalence: 混沌注入 → 收敛权威快照（faux-pi 子进程${FAUX_PI_SKIP_REASON ? `｜skip：${FAUX_PI_SKIP_REASON}` : ''}）`,
  () => {
  let fixture: PiFixture | null = null

  // 失败兜底（设计 U3/G1）：beforeAll 装置阶段失败后在途 turn 由 recover 截断，
  // 防传染同文件后续用例；非 busy 时零操作幂等
  afterEach(async () => {
    await fixture?.recover()
  })
  /** 非 transient 帧语料（translate 产出的全部 message kind 帧，到达序） */
  let frames: ServerMessage[] = []
  /** message_end 帧重构的 entry 序列（与 frames 内 entry 对象同引用，供帧 ↔ entry 对位） */
  let endEntries: PiEntry[] = []
  /** 权威 entry 全量（get_entries 剥 id——对齐 live-reload.test.ts 口径） */
  let authoritativeEntries: PiEntry[] = []
  /** 权威快照（get_entries → replayEntries；三用例的收敛目标） */
  let authoritativeState: ChatViewState | undefined
  const sid = 'w22-chaos'

  beforeAll(async () => {
    // faux 脚本：一轮带 bash toolCall 的 turn（真实执行 echo chaos-w22）+ 总结文本——
    // 帧语料生成源（user / assistant(toolCalls) / toolResult / assistant 序列）
    fixture = await spawnPiFixture({
      fauxResponses: [
        { toolCalls: [{ name: 'bash', args: { command: 'echo chaos-w22' } }] },
        { text: 'chaos-w22' },
      ],
    })
    const fx = fixture

    // 一轮带工具调用的 turn：产出 user / assistant(toolCalls) / toolResult / assistant 序列
    await fx.runTurn(
      {
        message: "Use the bash tool to run the command `echo chaos-w22` and reply with its exact output.",
      },
      TURN_TIMEOUT_MS,
    )

    // 帧语料：完整生产帧链（pi 事件 → adapter translate → EventInterpreter 编排 → send 帧）。
    // 只用 send 依赖（cwd/fileChangeDiff 缺省 → 跳过 file_changes，无 git 调用；其余回调可选）。
    // 逐事件后 flush 一个 macrotask：tool-call-end 的 hook 异步路径在下一事件前完成 send，
    // 保持帧序与真实 ws 投递一致（生产中 stdout readline 事件间隔 >> 微任务）。
    const collectedFrames: ServerMessage[] = []
    const interpreter = new EventInterpreter(sid, {
      send: (msg) => {
        collectedFrames.push(msg)
      },
    })
    for (const ev of fx.collectEvents()) {
      interpreter.interpret(translate(ev as unknown as PiEvent, sid))
      await new Promise((r) => setTimeout(r, 0))
    }
    frames = collectedFrames
    endEntries = frames.flatMap((f) => {
      const entry = entryOfMessageEndFrame(f)
      return entry === undefined ? [] : [entry]
    })
    // 语料非空守卫：至少 user + assistant(toolCalls) + toolResult + assistant 序列 +
    // 双通道帧在位（tool_call_end 由 interpreter 产出——translate 只出中间事件，
    // 此守卫同时锁定语料确实经生产帧链生成）
    expect(endEntries.length).toBeGreaterThanOrEqual(3)
    expect(frames.some((f) => f.type === 'message.tool_call_end')).toBe(true)

    // 权威快照
    const reloadResp = await fx.sendCommand('get_entries')
    const rawEntries: unknown = reloadResp.data?.entries
    if (!Array.isArray(rawEntries)) throw new Error('get_entries reply has no entries array')
    authoritativeEntries = rawEntries
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .map((e) => {
        const { id: _id, ...rest } = e
        return rest as unknown as PiEntry
      })
    authoritativeState = replayEntries(authoritativeEntries)

    // 语料同构守卫（W21 同构在本语料上成立——后续混沌断言的合法前提）：
    // message_end 单通道重放 == 权威全量重放（本语料无 bash RPC；未建模 entry 类型走 reducer
    // default no-op）
    expect(replayEntries(endEntries)).toEqual(authoritativeState)
    const toolOwner = authoritativeState.messages.find((m) => (m.toolCalls?.length ?? 0) > 0)
    expect(toolOwner).toBeDefined()
    expect(toolOwner?.toolCalls?.[0]?.output).toContain('chaos-w22')
  }, CORPUS_TIMEOUT_MS)

  afterAll(async () => {
    if (fixture) {
      await fixture.dispose()
      fixture = null
    }
  })

  /** 帧序列经 core store 生产入口（applyMessageEvent → registry → applyEntryFrame）投递。 */
  function feedFrames(feed: ServerMessage[]): ChatViewState {
    const scope = effectScope(true)
    try {
      const store = scope.run(() => createChatStore())!
      for (const f of feed) store.applyMessageEvent(sid, f)
      // u6.1 收编：_entryStatesForTest 已并入 testInternals 命名空间（对齐 core custom-start-equivalence.test.ts 的嵌套路径）
      const state = store.testInternals._entryStatesForTest.get(sid)
      expect(state).toBeDefined()
      return state!
    } finally {
      scope.stop()
    }
  }

  it(
    '乱序：非 streaming 帧倒序投递 → 孤儿收集可检测脏化；权威拉取恒得同一权威快照（拉取自愈）',
    { timeout: CHAOS_TEST_TIMEOUT_MS },
    () => {
      // 乱序注入：倒序（确定性非恒等置换）——toolResult / complete 等先于 owner / start 到达
      const chaotic = feedFrames([...frames].reverse())

      // 脏化可检测：toolResult 先于带 toolCalls 的 assistant 到达 → 窗口内无配对 → 孤儿收集
      //（applyEntry 孤儿分支的 console.warn 为预期可观测噪声，非缺陷）
      expect(chaotic.orphanToolResults.length).toBeGreaterThan(0)
      expect(chaotic.messages).not.toEqual(authoritativeState!.messages)

      // 收敛断言（拉取自愈的结构性验证）：投递混沌不影响权威拉取——get_entries 重放（reducer
      // 确定性）恒得同一权威 state，是重连/刷新重建视图的自愈依据
      expect(replayEntries(authoritativeEntries)).toEqual(authoritativeState)
      // 且按到达序重投（恢复正常投递）即恢复权威视图（脏 state 无残留毒化 reducer 输入）
      expect(feedFrames(frames).messages).toEqual(authoritativeState!.messages)
    },
  )

  it(
    '丢失：拦截 assistant(toolCalls) 的 message_end 帧不下发 → 缺一条消息 + toolResult 孤儿可检测；权威拉取完整',
    { timeout: CHAOS_TEST_TIMEOUT_MS },
    () => {
      // 丢失注入：定位带 tool_use 的 host assistant entry，找到承载它的 message_end 帧并拦截
      const hostIdx = endEntries.findIndex(
        (e) => e.type === 'message' && e.message.role === 'assistant' && hasToolUse(e),
      )
      expect(hostIdx).toBeGreaterThan(0)
      const hostEntry = endEntries[hostIdx]!
      const hostFrameIdx = frames.findIndex((f) => entryOfMessageEndFrame(f) === hostEntry)
      expect(hostFrameIdx).toBeGreaterThanOrEqual(0)

      const droppedState = feedFrames(frames.filter((_, i) => i !== hostFrameIdx))

      // 脏化可检测：host assistant 缺失（消息数 -1）+ toolResult 失去配对窗口 → 孤儿
      expect(droppedState.messages).toHaveLength(authoritativeState!.messages.length - 1)
      expect(droppedState.orphanToolResults.length).toBeGreaterThan(0)

      // 收敛断言（拉取自愈）：权威拉取不受丢失影响——完整重放含被拦截的 entry
      expect(replayEntries(authoritativeEntries)).toEqual(authoritativeState)
      expect(replayEntries(endEntries).messages).toHaveLength(authoritativeState!.messages.length)
    },
  )

  it(
    '重放：同帧二次投递 → 冗余消息可检测；生产双通道（tool_call_end + message_end 同一 toolResult）双喂收敛无冗余',
    { timeout: CHAOS_TEST_TIMEOUT_MS },
    () => {
      // ── 重放注入 a（字面重放）：同一 user message_end 帧投递两次 ──
      const userIdx = endEntries.findIndex((e) => e.type === 'message' && e.message.role === 'user')
      expect(userIdx).toBeGreaterThanOrEqual(0)
      const userFrame = frames.find((f) => entryOfMessageEndFrame(f) === endEntries[userIdx])
      expect(userFrame).toBeDefined()
      const replayed = feedFrames([...frames, userFrame!])

      // 冗余可检测：user entry 是 append 语义（非覆盖式），二次投递 → 消息数 +1（派生 id 不同，
      // 两条都保留）——脏化信号成立，非静默
      expect(replayed.messages).toHaveLength(authoritativeState!.messages.length + 1)

      // ── 重放注入 b（生产双通道形态）：frames 全量投递已含 toolResult 双喂——tool_call_end 帧
      // 与 message_end 帧承载同一 toolResult（不同事件、同一逻辑结果）。断言双喂收敛：
      // 全量帧（双通道）≡ 权威快照（toolResult 覆盖式配对回填幂等，无冗余无残留）
      const dualChannel = feedFrames(frames)
      expect(dualChannel.messages).toEqual(authoritativeState!.messages)
      expect(dualChannel.orphanToolResults).toEqual(authoritativeState!.orphanToolResults)
      expect(dualChannel.orphanToolResults).toHaveLength(0)

      // 收敛断言（拉取自愈）：权威拉取恒等
      expect(replayEntries(authoritativeEntries)).toEqual(authoritativeState)
    },
  )
})
