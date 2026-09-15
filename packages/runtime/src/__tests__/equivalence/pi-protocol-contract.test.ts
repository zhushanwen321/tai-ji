/**
 * W25 pi 协议契约测试（data-source-governance P4.3 收官件）。
 *
 * 职责：pi 版本升级时（root package.json devDependencies 的 @earendil-works/pi-coding-agent
 * 变更——注意：plan 写 packages/runtime/package.json，实际声明在 root，接线检测两者）自动跑
 * 本测试，防上游事件语义漂移悄悄制造新分叉。接线点：scripts/check-version-bump.sh（merge
 * 阶段 3.5 版本校验门，pi 依赖相对最新 release tag 变更时先跑本测试再放行 bump）。
 *
 * 契约三断言（w25-acceptance.md 交付物 1）：
 * - ① RPC 命令面：set_session_name / get_state / get_session_stats / get_entries / get_commands
 *   全部可调 + reply 形状 guard（Record<ContractRpcCommand, Guard> 对命令 union 编译期穷举——
 *   union 增删成员而 guard 不同步 → tsc 报错，ADR-0037 exhaustive 手法）。
 * - ② 事件面：本设计依赖的五个事件真实发射（fixture 触发实测，非 mock）：
 *   session_info_changed（set_session_name 触发）/ thinking_level_changed（set_thinking_level
 *   实际变更触发）/ queue_update（steer 入队触发）/ message_end（prompt 对话触发）/
 *   entry_appended（见 D5 固化——扩展 appendEntry 是唯一发射路径，pi 源码 agent-session.ts
 *   appendEntry 上下文 API 独占发射；fixture spawn 形态锁定无 --extension 参数，正向发射
 *   无法在本 fixture 触发，契约面固化为下方 D5 负向断言）。
 * - ③ entry 面：get_entries 返回的 entry 类型 union（shared/pi-entry.ts PiEntry，W21 wire
 *   契约 SSOT）穷举覆盖 reducer（core applyEntry）的 case——assertReducerCaseCoverage 的
 *   never-default 分支 + case 可比性双向编译期保证（tsc --noEmit 通过即证）；运行时侧对
 *   真实 get_entries 产物做成员资格断言（pi 出现清单外新 entry 类型 → 红）。
 *
 * D5 探针定论固化（交付物 2）：真实对话 N 事件 0 条 message 载体 entry_appended——「entry_appended 对
 * message entry 不发射」是当前契约。上游若补发射此断言红 → 触发 W21 预留的换源适配
 * （message_end 流不再是等价源），而非静默分叉。
 *
 * faux LLM 轨（L2.5 翻轨，2026-09-15）：验证对象是 RPC/事件/entry 三个协议面（pi 自身
 * 行为），非模型智能——LLM turn 由 fauxResponses 脚本固定（it2 用 reasoning 演员
 * faux/faux-1-reasoning，档位 ⊇ {off, low} 确定性成立，摆脱宿主 models.json 依赖），
 * 断言语义与翻轨前一致。门控 FAUX_PI_READY（只判 binary，凭证无关、CI 可跑，已从
 * REAL_PI_TESTS 分池移出）。**pi bump 时需真实轨重放一次**（本文件断言的 RPC reply
 * 形状/事件面/D5 负向断言是对 pi wire 协议的契约锁定，bump 触发的重放登记由后续
 * e2e-map 承接）。
 *
 * 禁 mock pi（真实 fixture）；skip-if 约定见 pi-fixture.ts 文件头。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import {
  spawnPiFixture,
  FAUX_PI_READY,
  FAUX_PI_SKIP_REASON,
  type PiFixture,
  type PiRpcResponse,
} from './pi-fixture.js'
import type { PiEntry } from '@taiji/shared'
import type { GetEntriesResponse, PiEvent, PiSessionEntry } from '../../infra/pi/pi-protocol.js'

/** 等 turn 完成的上限（真实 LLM 调用；对齐 live-reload.test.ts 余量口径） */
const TURN_TIMEOUT_MS = 120_000
/** 用例总超时 = 冷启动 + 1 轮 LLM turn + 多次 RPC + dispose 的和再留余量 */
const TEST_TIMEOUT_MS = 240_000

/**
 * 事件面实测的事件名清单。satisfies 编译期锚定到生产 PiEvent 联合（pi-protocol.ts，
 * ADR-0037 真契约）：上游事件改名的类型同步先落 pi-protocol.ts，此处立即跟着红——
 * 防「类型层已同步、契约断言仍用旧名」的静默脱钩。entry_appended 的特殊性见 D5 固化。
 */
const CONTRACT_EVENT_TYPES = [
  'session_info_changed',
  'thinking_level_changed',
  'queue_update',
  'message_end',
  'entry_appended',
] as const satisfies readonly PiEvent['type'][]

// ── ① RPC 命令面：契约命令 union + reply 形状 guard（编译期穷举）──────────────

/** 数据治理消费面锁定的 RPC 命令 union（rpc-client.ts 实际调用的子集） */
type ContractRpcCommand =
  | 'set_session_name'
  | 'get_state'
  | 'get_session_stats'
  | 'get_entries'
  | 'get_commands'

/** unknown → Record 守卫 */
function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new Error(`expected object, got: ${String(v)}`)
  return v as Record<string, unknown>
}

/**
 * reply 形状 guard：Record<ContractRpcCommand, ...> 对命令 union 编译期穷举——
 * union 增删成员而本表不同步 → tsc 报错（缺 key / 多余 key 双向）。
 * 违反形状时 throw（测试红 = 契约漂移信号）。
 */
const REPLY_GUARDS: Record<ContractRpcCommand, (resp: PiRpcResponse) => void> = {
  set_session_name: (resp) => {
    expect(resp.success).toBe(true)
    // pi rpc-mode success(id, "set_session_name") 不带 data（void 命令）
    if (resp.data !== undefined) throw new Error('set_session_name reply unexpectedly carries data')
  },
  get_state: (resp) => {
    // 镜像 pi RpcSessionState 必填字段（rpc-types.ts:94-107）——W7/W8 scalar 实例的消费面
    const data = asRecord(resp.data)
    expect(typeof data.sessionId).toBe('string')
    expect(typeof data.thinkingLevel).toBe('string')
    expect(typeof data.isStreaming).toBe('boolean')
    expect(typeof data.messageCount).toBe('number')
    expect(typeof data.pendingMessageCount).toBe('number')
  },
  get_session_stats: (resp) => {
    // 镜像 pi SessionStats（agent-session.ts:225-242）；contextUsage 可选（无 turn 时缺省），
    // 出现时形状必须符合 usage 实例投影口径（tokens/percent 可为 null = 合法「无值」态）
    const data = asRecord(resp.data)
    expect(typeof data.sessionId).toBe('string')
    expect(typeof data.userMessages).toBe('number')
    expect(typeof data.assistantMessages).toBe('number')
    expect(typeof data.totalMessages).toBe('number')
    if (data.contextUsage !== undefined) {
      const cu = asRecord(data.contextUsage)
      const tokens = cu.tokens
      if (tokens !== null && typeof tokens !== 'number') {
        throw new Error(`contextUsage.tokens must be number|null, got: ${typeof tokens}`)
      }
      expect(typeof cu.contextWindow).toBe('number')
      const percent = cu.percent
      if (percent !== null && typeof percent !== 'number') {
        throw new Error(`contextUsage.percent must be number|null, got: ${typeof percent}`)
      }
    }
  },
  get_entries: (resp) => {
    // 编译期锚定生产契约类型 GetEntriesResponse（pi-protocol.ts：entries + leafId）
    const data = asRecord(resp.data)
    if (!Array.isArray(data.entries)) throw new Error('get_entries reply has no entries array')
    for (const e of data.entries) asRecord(e)
    // 形状对齐赋值：fixture 实测形态 ⊇ 生产类型声明（生产类型收紧 → 此处 tsc 红）
    const typed: GetEntriesResponse = {
      entries: data.entries as PiSessionEntry[],
      leafId: (data.leafId === null ? null : String(data.leafId)) as string | null,
    }
    expect(Array.isArray(typed.entries)).toBe(true)
  },
  get_commands: (resp) => {
    // pi rpc-mode get_commands：{ commands: [{ name, description, source, ... }] }
    const data = asRecord(resp.data)
    if (!Array.isArray(data.commands)) throw new Error('get_commands reply has no commands array')
    for (const c of data.commands) {
      const cmd = asRecord(c)
      expect(typeof cmd.name).toBe('string')
      expect(typeof cmd.source).toBe('string')
    }
  },
}

// ── ③ entry 面：PiEntry 联合穷举覆盖 reducer case（编译期 exhaustive）─────────

/** reducer（core applyEntry）的 case 清单（apply-entry.ts switch 分支一一对应） */
const REDUCER_CASE_TYPES = [
  'message',
  'custom',
  'label',
  'compaction',
  'branch_summary',
  'custom_message',
] as const

/**
 * 编译期 exhaustive（ADR-0037 手法）：switch 穷举 shared PiEntry 联合（get_entries wire
 * 契约 SSOT）。双向保证——
 * - PiEntry 联合新增成员而 reducer 无 case → default 分支 never 赋值 tsc 报错（漏类型）；
 * - 联合删成员而 reducer case 残留 → case 字面量可比性 tsc 报错（死 case）。
 * tsc --noEmit 通过即证穷举无漏（验收命令 1）。
 */
function assertReducerCaseCoverage(entry: PiEntry): void {
  switch (entry.type) {
    case 'message':
    case 'custom':
    case 'label':
    case 'compaction':
    case 'branch_summary':
    case 'custom_message':
      return
    default: {
      const uncovered: never = entry
      throw new Error(`PiEntry 联合成员未被 reducer case 覆盖: ${JSON.stringify(uncovered)}`)
    }
  }
}

/** taiji 刻意未建模的 pi entry 类型（pi-entry.ts 文件头注释清单；reducer default no-op） */
const DOCUMENTED_UNMODELED_ENTRY_TYPES = new Set([
  'thinking_level_change',
  'model_change',
  'session_info',
])

/** 真实 get_entries 产物的 entry.type 成员资格（清单外新类型 = 契约漂移 → 红） */
function assertObservedEntryTypesKnown(observedTypes: string[]): Set<string> {
  const known = new Set<string>([...REDUCER_CASE_TYPES, ...DOCUMENTED_UNMODELED_ENTRY_TYPES])
  for (const t of observedTypes) {
    if (!known.has(t)) {
      throw new Error(
        `pi get_entries 返回了建模清单外的 entry 类型 "${t}"（已知：${[...known].join(', ')}）` +
        '——pi 升级新增 entry 类型，须在 shared/pi-entry.ts 建模 + reducer 加 case 后再升级',
      )
    }
  }
  return new Set(observedTypes)
}

describe.skipIf(!FAUX_PI_READY)(
  `pi 协议契约（faux-pi 子进程，W25${FAUX_PI_SKIP_REASON ? `｜skip：${FAUX_PI_SKIP_REASON}` : ''}）`,
  () => {
  let fixture: PiFixture | null = null

  afterEach(async () => {
    if (fixture) {
      await fixture.dispose()
      fixture = null
    }
  })

  it(
    '① RPC 命令面：五个契约命令全部可调 + reply 形状 guard 全过（无 LLM 调用，空 session）',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      // faux 轨空队列：本用例全程无 LLM turn（纯 RPC 面），队列耗尽即报错是意外 turn 的 fail-fast
      const fx = await spawnPiFixture({ fauxResponses: [] })
      fixture = fx
      // 契约锁定的 binary 版本证据（漂移归因用）
      const piVersion = execSync(`"${fx.piPath}" --version`, { encoding: 'utf-8' }).trim()
      console.log(`[W25 contract] pi binary: ${fx.piPath} (${piVersion})`)

      const commands: ContractRpcCommand[] = [
        'get_state',
        'get_session_stats',
        'get_entries',
        'get_commands',
        'set_session_name',
      ]
      for (const command of commands) {
        const params: Record<string, unknown> = command === 'set_session_name' ? { name: 'w25-rpc-face' } : {}
        const resp = await fx.sendCommand(command, params)
        // reply 配对契约：type response + command 回显 + success
        expect(resp.type).toBe('response')
        expect(resp.command).toBe(command)
        expect(resp.success).toBe(true)
        // 形状 guard（Record 编译期穷举 + 运行时逐字段）
        REPLY_GUARDS[command](resp)
      }

      // 新 session 的 get_entries 边界形态。实测定论（W25 固化）：pi 启动即为新 session
      // 写入元数据 entry（sdk.ts:367-373：model_change + thinking_level_change），故空对话
      // session 的 get_entries **不为空**、leafId 非空——真正的空态边界是「无 message entry」。
      // 顺序约束：set_session_name 会立即追加 session_info entry，本段边界断言在其之前测。
      const boundaryResp = await fx.sendCommand('get_entries')
      const boundaryData = asRecord(boundaryResp.data)
      const freshEntries = boundaryData.entries
      if (!Array.isArray(freshEntries)) throw new Error('get_entries reply has no entries array')
      const freshTypes = assertObservedEntryTypesKnown(
        freshEntries.map((e: unknown) => String(asRecord(e).type)),
      )
      expect(freshTypes.has('message')).toBe(false)
      expect(typeof boundaryData.leafId).toBe('string')

      await fx.dispose()
      fixture = null
    },
  )

  it(
    '② 事件面五事件真实发射 + D5 固化（N 事件 0 条 message 载体 entry_appended）+ ③ entry 面穷举',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      // faux 轨 reasoning 演员（thinking-level 二档互切的确定性前提）；一轮 turn 的
      // 响应由脚本固定
      const fx = await spawnPiFixture({ model: 'faux/faux-1-reasoning', fauxResponses: [{ text: 'w25-contract' }] })
      fixture = fx

      // ── 事件 1：session_info_changed（set_session_name RPC 触发）──
      await fx.sendCommand('set_session_name', { name: 'w25-event-face' })
      const sessionInfo = await fx.waitForEvent((e) => e.type === 'session_info_changed')
      expect(sessionInfo.name).toBe('w25-event-face')

      // ── 事件 2：thinking_level_changed（set_thinking_level 实际变更才发射，pi 源码
      //    setThinkingLevel 的 isChanging 守卫——先读当前值再切到不同档）──
      const stateResp = await fx.sendCommand('get_state')
      const stateData = asRecord(stateResp.data)
      const currentLevel = stateData.thinkingLevel
      if (typeof currentLevel !== 'string') throw new Error(`get_state.thinkingLevel 非 string: ${String(currentLevel)}`)
      // 演员锁定 faux/faux-1-reasoning（reasoning: true，无 thinkingLevelMap → 档位
      // ['off','minimal','low','medium','high']，faux-llm-ext 注册面），二档互切必产生实际变更
      const targetLevel = currentLevel === 'off' ? 'low' : 'off'
      await fx.sendCommand('set_thinking_level', { level: targetLevel })
      const thinking = await fx.waitForEvent((e) => e.type === 'thinking_level_changed')
      expect(thinking.level).toBe(targetLevel)

      // ── 事件 3：message_end（真实 prompt 对话，user + assistant 各至少一条）──
      await fx.runTurn({ message: 'Reply with exactly the word: w25-contract' }, TURN_TIMEOUT_MS)
      const messageEnds = fx.collectEvents((e) => e.type === 'message_end')
      expect(messageEnds.length).toBeGreaterThanOrEqual(2)
      const messageEndRoles = messageEnds.map((e) => e.message?.role)
      expect(messageEndRoles).toContain('user')
      expect(messageEndRoles).toContain('assistant')

      // ── 事件 4：queue_update（steer 入队触发；放在 prompt 之后，避免排队消息注入对话）──
      await fx.sendCommand('steer', { message: 'w25-queue-probe' })
      const queue = await fx.waitForEvent((e) => e.type === 'queue_update')
      expect(queue.steering).toContain('w25-queue-probe')

      // 事件面收口：契约清单除 entry_appended（下方 D5 负向断言）外全部实测出现
      for (const t of CONTRACT_EVENT_TYPES) {
        if (t === 'entry_appended') continue
        expect(fx.collectEvents((e) => e.type === t).length).toBeGreaterThan(0)
      }

      // ── D5 固化（交付物 2）：message entry 不经 entry_appended 广播是当前契约。
      //    上面整段操作（改名 → entry 持久化、切 thinking → entry 持久化、真实对话 →
      //    message entry 持久化）产生 N 条事件流 + M 条持久化 entry，其中不得出现 message
      //    载体的 entry_appended——上游若补发射，此断言红 → 走 W21 预留换源适配，而非静默分叉。
      //    [2026-08 pi 0.84.4 升级核实] 断言从「0 条 entry_appended」收窄为「0 条 message 载体」：
      //    fixture 虽锁定无 --extension 参数，pi 全局扩展发现仍会加载 ~/.pi/agent 下已装扩展
      //    （如实测环境的 cache-probe），其 appendEntry 的 custom 载体广播属 extension 行为，
      //    不构成上游 message 语义漂移——A/B 对照（0.84.1 vs 0.84.4）确认 pi 两侧均未补发。
      const allEvents = fx.collectEvents()
      expect(allEvents.length).toBeGreaterThanOrEqual(10) // 非空转守卫（实测 ~25+）
      const messageEntryAppended = fx
        .collectEvents((e) => e.type === 'entry_appended')
        .filter((e) => (e['entry'] as Record<string, unknown> | undefined)?.['type'] === 'message')
      expect(messageEntryAppended).toHaveLength(0)

      // ── ③ entry 面：真实 get_entries 产物 ──
      const entriesResp = await fx.sendCommand('get_entries')
      const entriesData = asRecord(entriesResp.data)
      const entries = entriesData.entries
      if (!Array.isArray(entries)) throw new Error('get_entries reply has no entries array')
      // 持久化非空守卫：启动元数据 2 条（model_change + thinking_level_change）+ 改名 1 条 +
      // 切档 1 条 + 对话 ≥2 条（user/assistant message）——「M 条 entry 持久化 + 0 条
      // entry_appended」的 M 侧证据
      expect(entries.length).toBeGreaterThanOrEqual(5)
      const rawEntries = entries.map((e: unknown) => asRecord(e))

      const observedTypes = assertObservedEntryTypesKnown(rawEntries.map((e) => String(e.type)))
      // 本操作序列的必达集合：message（对话）+ session_info（改名 RPC 直写）
      expect(observedTypes.has('message')).toBe(true)
      expect(observedTypes.has('session_info')).toBe(true)

      // 编译期 exhaustive 的运行时侧证：真实 message entry 走 assertReducerCaseCoverage
      // 必命中 case；六个建模类型各自的最小形态也逐个过 switch（case 全集可达性）
      const messageEntry = rawEntries.find((e) => e.type === 'message')
      expect(messageEntry).toBeDefined()
      assertReducerCaseCoverage(messageEntry as unknown as PiEntry)
      const minimalEntries: PiEntry[] = [
        { type: 'message', timestamp: 't', message: { role: 'user' } },
        { type: 'custom', timestamp: 't', customType: 'probe' },
        { type: 'label', timestamp: 't' },
        { type: 'compaction', timestamp: 't' },
        { type: 'branch_summary', timestamp: 't' },
        { type: 'custom_message', timestamp: 't', customType: 'probe' },
      ]
      for (const e of minimalEntries) {
        expect(() => assertReducerCaseCoverage(e)).not.toThrow()
      }

      console.log(
        `[W25 contract] D5 固化证据：${allEvents.length} 事件 0 条 entry_appended | ` +
        `get_entries ${entries.length} 条（类型：${[...observedTypes].join(', ')}）`,
      )

      await fx.dispose()
      fixture = null
    },
  )
})
