/**
 * applyEntry reducer 确定性防线（W20 建立「新旧双实现等价」，W21 断言升级——legacy
 * 家族随 message-converter.ts 删除，等价性防线移交两层）：
 *
 * 1. 本文件：同 fixture 序列两次喂入 reducer → state 全等（D5 纯函数确定性）+
 *    lift 保真（伪消息 lift == 手写等价 entry 直接喂入）。fixture 全集取自迁移前
 *    message-converter*.test.ts 家族的真实形态（用例集不缩水）。
 *    [steer-bubble u4 / AC-7] E5 组：steer/followUp 投递气泡（腿 1 / 腿 2 消费 /
 *    腿 2 纯文本降级）vs 文件重放投影——真 store 驱动 registry 消费链，按字段归一断言。
 * 2. runtime src/__tests__/equivalence/live-reload.test.ts：live≡reload store 级同构
 *    （真实 pi 子进程，实时 message_end 流与 get_entries 重放喂同一 reducer）。
 *
 * [u6-paging-protocol] 断言域 re-scope（crash-resilience §3.3 D4）：
 *   「live ≡ reload」不变量的比较域从「全量历史」re-scope 为「预算窗口内」——u4b 起
 *   session.history 响应按双预算（最近 20 turns 且 ≤640KB）切窗返回，窗口内两通路
 *   （live 累积 ≡ 重开重放）共用同一 reducer 与同一预算，等价性构造性成立；窗口外
 *   历史在场期间可见（累积）、重开后需「加载更早」游标翻页恢复，属行为变化而非
 *   等价性破坏（设计 D4 原文：「该不变量的比较域从『全量历史』re-scope 为『预算
 *   窗口内』……等价性测试的断言域同步调整归 U6」）。窗口域的机器化断言见文末
 *   「预算窗口内 live ≡ reload（u6 re-scope）」组：两侧同序列各自经
 *   applyHistoryBudgetWindow 切窗后仍 deep-equal，且窗口投影由同一函数构造
 *   （runtime 侧 sliceMessagesBeforeCursor + applyHistoryBudgetWindow 即生产实现）。
 *
 * 行为级具体断言（role 细分 / contentBlocks 顺序 / fileChanges / usage / skill 剖离）
 * 由 apply-entry.test.ts（W20 reducer 单测）承担。
 *
 * 运行：cd packages/core && pnpm exec vitest run src/domain/chat/__tests__/apply-entry-equivalence.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { effectScope, toRaw } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { replayEntries } from '../apply-entry'
import type { ChatViewState, PiEntry } from '../apply-entry'
import { toRenderItems } from '../message-turns'
import type { RenderItem } from '../message-turns'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
// [u3b 内核回执] 显示回执链的生产实现模块：session.delivery 投影（内核单一数据源）+
// morph 段捕获（回执按原段回填）——E5 组的 live 腿由这两个入口 + 真实 registry 帧驱动
import {
  captureMorphSegments,
  replaceDeliveryProjection,
  resetDeliveryProjectionForTest,
} from '../effects/user-delivery'
import type { Message, Segment, ServerMessage, SubagentRecord } from '@taiji/shared'
import {
  convertPiHistory,
  liftHistoryToEntries,
} from '../../../../../runtime/src/infra/pi/message-converter.js'
// [u6 re-scope] 预算窗口投影的生产实现（crash-resilience §3.3 D4）：session.history 响应的
// 实际切窗函数。跨包 import 先例 = 上方 message-converter（W20 D5）；Node-only 模块在
// vitest node 环境可加载（同先例）。
import {
  applyHistoryBudgetWindow,
  sliceMessagesBeforeCursor,
} from '../../../../../runtime/src/services/session/history-rebuild-cache.js'
// [two-state-convergence U7/P2] subagent-record 等价回放资产（跨包 import 先例 = 上方
// message-converter / history-rebuild-cache，同深度相对路径；fixture 与 SSOT 谓词均为
// 无 vue 依赖纯模块——core 与 renderer 双消费同一资产，无副本分叉）。
import { scanSubagentEntries } from '../../../../../runtime/src/services/session/subagent-extractor.js'
import { isRunningProjection } from '../../../../../renderer/src/lib/subagent-bucket'
import {
  SESSION_01A09F83_GHOST_FIXTURE,
  type GhostFixtureSpec,
} from '../../../../../renderer/src/__tests__/lib/subagent-ghost-fixture'

// ── fixture（取自既有测试的真实形态：message-converter*.test.ts 家族）──────────

/** 确定性断言：同序列两次（lift + reducer fold）→ 全量 state deep equal。 */
function expectDeterministic(raw: unknown[], entryIds?: string[]): ChatViewState {
  const first = replayEntries(liftHistoryToEntries(raw, entryIds))
  const second = replayEntries(liftHistoryToEntries(raw, entryIds))
  // 全量 state（messages + orphanToolResults + 配对锚点）非消息级抽样
  expect(first).toEqual(second)
  // Map 在 toEqual 中按内容比较 ✓；确定性含「无 Date.now/randomUUID 渗入」——
  // 同序列两次产出引用不同但内容全等，是 replay 重建（W21 对账）的构造性依据。
  return first
}

// ── 断言基建共享 helper（原各组逐字重复的本地副本收敛至此；只合并归一/时钟/假 id
// 生成器等断言策略设施。各组 fixture 消息体「两侧独立手写」的等价性惯例不受影响——
// 那条约束防的是假等价，本区不是等价性证据）────────────────────────────────────

/** ms → ISO（fixture 统一 timestamp 形态） */
const ts = (ms: number) => new Date(ms).toISOString()

/** uuidv7 形态假 id（replay 侧专用 fixture 约定，模拟 pi 持久化 id 空间） */
const piId = (n: number) => `0198aabb-ccdd-7e${n.toString().padStart(2, '0')}-8f00-00000000000${n}`

/**
 * id 口径澄清（全文同口径，勿误读）：真实 pi entryId = 8 位 hex（`randomUUID().slice(0, 8)`，
 * pi 实装 generateId；uuidv7 仅用于 pi session id）——本文件 fixture 的 uuidv7 形态假 id 只是
 * 测试内部约定（异源于真实 entryId 不影响等价性断言：归一按内容比对、id 形态本就两侧异源）。
 * 消息撤回 U8 的 8 位 hex 形态判别见 revoke-orchestrator BARE_UUID_RE。
 */

/**
 * 归一：剥消息 id 与 piEntryId（live 客户端前缀 id / reducer e<N> 派生 vs replay pi
 * uuidv7 entry id——id 空间异源属 W21 已裁决差异类，等价性按内容断言）。
 * 剥除后回填占位 id，保持 ChatViewState 形态（对比内容不受影响——两侧同规则剥除 + 同占位）。
 */
function normalizeIds(state: ChatViewState): ChatViewState {
  const messages = state.messages.map(({ id: _id, piEntryId: _piEntryId, ...rest }) => ({
    ...rest,
    id: 'normalized',
  })) as Message[]
  return { ...state, messages }
}

/** turn 骨架投影（分组断言：turn 数 / user / assistants / trigger / noticeCommands / 非消息项） */
const skeleton = (state: ChatViewState, msgs: Message[]) =>
  toRenderItems(normalizeIds({ ...state, messages: msgs }).messages)
    .map((item) =>
      item.kind === 'turn'
        ? {
            kind: 'turn' as const,
            user: item.turn.user?.content ?? null,
            assistants: item.turn.assistants.map((a) => a.content),
            trigger: item.turn.trigger ?? null,
            noticeCommands: (item.turn.notices ?? []).map((n) => n.bashExecution?.command ?? n.content),
          }
        : { kind: item.kind, content: item.message.content },
    )

describe('applyEntry reducer 确定性 —— 同序列两次喂入 state 全等', () => {
  it('user + assistant 文本消息（message-converter.test L6 fixture）', () => {
    expectDeterministic([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 1000 },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }], timestamp: 2000 },
    ])
  })

  it('toolResult 合并进 assistant toolCall + isError 置 error（L32/L59 fixture）', () => {
    expectDeterministic([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'readFile', arguments: { path: '/foo' } }], timestamp: 1000 },
      { role: 'toolResult', content: [{ type: 'text', text: 'file contents here' }], timestamp: 2000, toolCallId: 'tc1', toolName: 'readFile' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc2', name: 'bash', arguments: { cmd: 'exit 1' } }], timestamp: 3000 },
      { role: 'toolResult', content: [{ type: 'text', text: 'command failed' }], timestamp: 4000, toolCallId: 'tc2', toolName: 'bash', isError: true },
    ])
  })

  it('skill 反解析：pi 原生 block 存量等价 + 多 block 全还原（「只取首个」是升级前捕获组锚定 $ 的副产物，非契约）', () => {
    // 场景 4⑤ 存量回归形态：block 前置 + \n\nargs 在后 → [skill, args-text] 与升级前一致
    // 混排形态：多 block 全部还原，block 间与尾部正文保留（升级前第二个 block 沦为字面文本）
    const state = expectDeterministic([
      { role: 'user', content: [{ type: 'text', text: '<skill name="code-review" location="/abs/SKILL.md">skill body</skill>\n\ndo the thing' }], timestamp: 1000 },
      { role: 'user', content: [{ type: 'text', text: '<skill name="first">A</skill><skill name="second">B</skill>tail' }], timestamp: 2000 },
    ])
    expect((state.messages[0]!.content as Segment[])).toEqual([
      { type: 'skill', name: 'code-review', location: '/abs/SKILL.md' },
      { type: 'text', text: 'do the thing' },
    ])
    expect((state.messages[1]!.content as Segment[])).toEqual([
      { type: 'skill', name: 'first' },
      { type: 'skill', name: 'second' },
      { type: 'text', text: 'tail' },
    ])
  })

  it('skill 反解析：taiji 标记两形态（单标记混排 + 降级块）——标记前后正文全保留（D7 缺陷修复锁定）', () => {
    const state = expectDeterministic([
      { role: 'user', content: [{ type: 'text', text: '帮我 review<taiji-skill name="a" location="/a/SKILL.md"/> 这段代码' }], timestamp: 1000 },
      { role: 'user', content: [{ type: 'text', text: '正文\n<taiji-skills>\n<taiji-skill name="x" location="/x/SKILL.md"/>\n</taiji-skills>\nUse the read tool to load the skill files above before continuing the task\n收尾' }], timestamp: 2000 },
    ])
    expect((state.messages[0]!.content as Segment[])).toEqual([
      { type: 'text', text: '帮我 review' },
      { type: 'skill', name: 'a', location: '/a/SKILL.md' },
      { type: 'text', text: ' 这段代码' },
    ])
    expect((state.messages[1]!.content as Segment[])).toEqual([
      { type: 'text', text: '正文\n' },
      { type: 'skill', name: 'x', location: '/x/SKILL.md' },
      { type: 'text', text: '\n收尾' },
    ])
  })

  it('contentBlocks 到达顺序：thinking/text/toolCall 交错 + 多 text part 合并（order test fixture）', () => {
    expectDeterministic([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/x' } }, { type: 'text', text: 'answer' }], timestamp: 123 },
      { role: 'assistant', content: [{ type: 'text', text: 'part1 ' }, { type: 'toolCall', id: 'tc2', name: 'read', arguments: {} }, { type: 'text', text: 'part2' }], timestamp: 456 },
    ])
  })

  it('custom role：notify 单条 / display:false / display 缺失 / 其他 customType（L206-L366 fixture）', () => {
    expectDeterministic([
      { role: 'custom', customType: 'subagent-bg-notify', content: 'Subagent "coder" (job-1) completed.', details: { id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000, endedAt: 13000 }, timestamp: 13000 },
      { role: 'custom', customType: 'goal-context', content: '<goal_context>...</goal_context>', display: false, timestamp: 1000 },
      { role: 'custom', customType: 'legacy', content: 'old', timestamp: 2000 },
      { role: 'custom', customType: 'some-other-extension', content: 'hello', details: { foo: 'bar' }, timestamp: 3000 },
    ])
  })

  it('piEntryId：平行 entryIds 回填 / 无 entryIds 不回填 / __entryId 字符串回填（L370-L406 fixture）', () => {
    expectDeterministic(
      [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000 },
        { role: 'user', content: [{ type: 'text', text: 'hi2' }], timestamp: 2000 },
      ],
      ['entry-a'],
    )
    expectDeterministic([{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000 }])
    expectDeterministic([{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000, __entryId: 123 }])
    // __entryId 字符串（文件路径旧注入形态）回填——具体行为断言（非仅确定性）
    const withInline = [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000, __entryId: 'abc123' }]
    expect(convertPiHistory(withInline)[0].piEntryId).toBe('abc123')
    expect(convertPiHistory([{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000 }])[0].piEntryId).toBeUndefined()
  })

  it('compactionSummary / branchSummary role：完整字段 + 缺失 fallback（L410-L470 fixture）', () => {
    expectDeterministic([
      { role: 'compactionSummary', summary: '压缩摘要', tokensBefore: 10000, timestamp: 123 },
      { role: 'compactionSummary', timestamp: 100 },
      { role: 'branchSummary', summary: '分支摘要', fromId: 'msg-abc', timestamp: 456 },
      { role: 'branchSummary', timestamp: 200 },
    ])
  })

  it('bashExecution：完整字段 / exitCode undefined → null / excludeFromContext / 与 user 混合（bash test T9-T13 fixture）', () => {
    expectDeterministic([
      { role: 'bashExecution', command: 'ls', output: 'a\nb\n', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 123 },
      { role: 'bashExecution', command: 'x', output: '', exitCode: undefined, cancelled: true, truncated: false, timestamp: 1 },
      { role: 'bashExecution', command: 'pwd', output: '/x', exitCode: 0, cancelled: false, truncated: false, timestamp: 9 },
      { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 101 },
    ])
  })

  it('W5T2：assistant tool_use + tool_result 合并 + bashExecution 在后（bash test W5T2 fixture）', () => {
    expectDeterministic([
      { role: 'assistant', content: [{ type: 'text', text: 'running tests' }, { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'npm test' } }], timestamp: 200 },
      { role: 'toolResult', content: [{ type: 'text', text: 'all green' }], timestamp: 201, toolCallId: 'tc-1', toolName: 'bash' },
      { role: 'bashExecution', command: 'git status', output: 'clean', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 300 },
    ])
  })

  it('write/edit fileChanges 静态提取 + usage 还原 + tool_use 别名（converter 迁移规则全要素）', () => {
    expectDeterministic([
      { role: 'user', content: [{ type: 'text', text: '改一下' }], timestamp: 100 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '想想' },
          { type: 'tool_use', id: 'tc-w', name: 'write_file', arguments: { path: '/new.ts' } },
          { type: 'toolCall', id: 'tc-e', name: 'str_replace', arguments: { file_path: '/old.ts' } },
          { type: 'toolCall', id: 'tc-r', name: 'read', arguments: { path: '/x' } },
        ],
        usage: { input: 120, output: 80 },
        timestamp: 200,
      },
      { role: 'toolResult', content: [{ type: 'text', text: 'w' }], timestamp: 300, toolCallId: 'tc-w', toolName: 'write_file' },
    ])
  })

  it('孤儿 toolResult（无 preceding assistant）：messages 空 + orphan 收集', () => {
    const state = expectDeterministic([
      { role: 'toolResult', content: [{ type: 'text', text: 'orphan out' }], timestamp: 1000, toolCallId: 'tc-none', toolName: 'read' },
    ])
    expect(state.messages).toHaveLength(0)
    expect(state.orphanToolResults).toHaveLength(1)
  })

  it('全类型混合序列 + 平行 entryIds（display:false custom 不丢，关键规则 9）', () => {
    expectDeterministic(
      [
        { role: 'user', content: [{ type: 'text', text: '问题' }], timestamp: 100 },
        { role: 'custom', customType: 'todo-context', content: '<todo_context>x</todo_context>', display: false, timestamp: 200 },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-9', name: 'bash', arguments: { command: 'ls' } }], timestamp: 300 },
        { role: 'toolResult', content: [{ type: 'text', text: 'out' }], timestamp: 400, toolCallId: 'tc-9', toolName: 'bash' },
        { role: 'compactionSummary', summary: '压缩', tokensBefore: 9, timestamp: 500 },
        { role: 'branchSummary', summary: '分支', fromId: 'n-1', timestamp: 600 },
        { role: 'bashExecution', command: 'echo hi', output: 'hi\n', exitCode: 0, cancelled: false, truncated: false, timestamp: 700 },
        { role: 'assistant', content: [{ type: 'text', text: '回答' }], timestamp: 800 },
      ],
      ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'],
    )
  })
})

describe('lift 保真（shim 路径 == 直接 entry 喂入）', () => {
  it('同一序列：lift+reducer 与手写等价 entry 直接喂 reducer 产出一致', () => {
    const pseudo = [
      { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 1000 },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }, { type: 'toolCall', id: 'tc-1', name: 'write', arguments: { path: '/a' } }], timestamp: 2000 },
      { role: 'toolResult', content: [{ type: 'text', text: 'ok' }], timestamp: 3000, toolCallId: 'tc-1', toolName: 'write' },
      { role: 'bashExecution', command: 'ls', output: '', exitCode: 0, cancelled: false, truncated: false, timestamp: 4000 },
    ]
    const ids = ['m-1', 'm-2', 'm-3', 'm-4']
    // 手写等价 entry（真实 pi 形态：ISO timestamp / parentId 链）——独立于 lift 实现
    const handEntries: PiEntry[] = [
      { type: 'message', id: 'm-1', parentId: null, timestamp: new Date(1000).toISOString(), message: pseudo[0] },
      { type: 'message', id: 'm-2', parentId: 'm-1', timestamp: new Date(2000).toISOString(), message: pseudo[1] },
      { type: 'message', id: 'm-3', parentId: 'm-2', timestamp: new Date(3000).toISOString(), message: pseudo[2] },
      { type: 'message', id: 'm-4', parentId: 'm-3', timestamp: new Date(4000).toISOString(), message: pseudo[3] },
    ]
    const viaShim = replayEntries(liftHistoryToEntries(pseudo, ids))
    const viaDirect = replayEntries(handEntries)
    expect(viaShim).toEqual(viaDirect)
  })
})

// ── live ≡ reload 构造性等价（W6，conversation-turn-attribution G6）──────────────
//
// live 侧各构造点产出的 entry（客户端 id：user `u-` / bash `bash-` / custom `cm-` /
// compaction `cmp-` / assistant message_end 重构无 id）与 replay 侧同内容 pi uuidv7
// entry 序列，经同一 applyEntry reducer 的终态在「按字段归一（剥消息 id 与 piEntryId）」
// 后 deep-equal——「live ≡ reload 全类型构造性成立」的机器化断言。两侧消息体独立手写
// （lift 保真用例同款风格：等价性 = 两侧独立构造同内容，不共享字面量）。
// id 空间异源（客户端前缀 / e<N> 派生 vs pi uuidv7）与 timestamp 异源（客户端时钟 vs
// pi 落盘时刻，差值为投递延迟）均为 W21 已裁决并在各构造点注释登记的差异类——归一只
// 剥 id/piEntryId，timestamp 两侧 fixture 用同值隔离无关变量。
describe('live ≡ reload 构造性等价（W6 全类型）', () => {
  // ts / piId / normalizeIds / skeleton 用文件级共享 helper（见「断言基建共享 helper」区）

  /** live 侧 entry 序列：各构造点真实 id 形态（appendUser u- / bashResultEffect bash- / customStart cm- / compactionSummary cmp- / message_end 无 id） */
  const liveEntries: PiEntry[] = [
    { type: 'message', id: 'u-00000001-0000-4000-8000-000000000001', parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '跑一下测试' }], timestamp: 1000 } },
    { type: 'message', id: undefined, parentId: null, timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '开始执行' }, { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'npm test' } }], timestamp: 2000 } },
    // [R2-S1] toolResult 双入口：生产实际输入是 tool_call_end + message_end 两条帧各喂
    // reducer 一次（pi 对同一条 toolResult 双发 tool_execution_end + message_end{role:'toolResult'}，
    // 两构造点产出同内容同构 entry、均无 id）。原 fixture 只喂单条 message_end 构造——测试
    // 输入与生产输入不一致；幂等去重（deliveredToolResultIds）后双喂 ≡ 单喂，与 replay 侧
    // （pi 文件每 toolResult 只存一份 entry）deep-equal 依旧成立（断言见下方「双入口等价」组）。
    { type: 'message', id: undefined, parentId: null, timestamp: ts(3000), message: { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'all green' }], timestamp: 3000 } },
    { type: 'message', id: undefined, parentId: null, timestamp: ts(3000), message: { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'all green' }], timestamp: 3000 } },
    // bash：pi 落盘位置 = run 级联末（recordBashResult streaming 缓存 → finally flush），
    // taiji dispatcher 双分支延迟使 live 入流位置构造性对齐（W1）——两侧同位置
    { type: 'message', id: 'bash-00000002-0000-4000-8000-000000000002', parentId: null, timestamp: ts(4000), message: { role: 'bashExecution', command: 'ls -la', output: 'a\nb\n', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 4000 } },
    { type: 'message', id: undefined, parentId: null, timestamp: ts(5000), message: { role: 'assistant', content: [{ type: 'text', text: '完成' }], usage: { input: 10, output: 5 }, timestamp: 5000 } },
    { type: 'custom_message', id: 'cm-00000003-0000-4000-8000-000000000003', parentId: null, timestamp: ts(6000), customType: 'subagent-bg-notify', content: 'Subagent "coder" completed.', details: { id: 'job-1', status: 'done' } },
    { type: 'message', id: undefined, parentId: null, timestamp: ts(7000), message: { role: 'assistant', content: [{ type: 'text', text: '收到后台结果，继续处理' }], timestamp: 7000 } },
    { type: 'compaction', id: 'cmp-00000004-0000-4000-8000-000000000004', parentId: null, timestamp: ts(8000), summary: '压缩摘要', tokensBefore: 12345 },
    { type: 'message', id: 'u-00000005-0000-4000-8000-000000000005', parentId: null, timestamp: ts(9000), message: { role: 'user', content: [{ type: 'text', text: '继续' }], timestamp: 9000 } },
  ]

  /** replay 侧 entry 序列：同内容，id 全部 pi uuidv7 空间（含 live 侧无 id 的 assistant） */
  const replaySideEntries: PiEntry[] = [
    { type: 'message', id: piId(1), parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '跑一下测试' }], timestamp: 1000 } },
    { type: 'message', id: piId(2), parentId: piId(1), timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '开始执行' }, { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'npm test' } }], timestamp: 2000 } },
    { type: 'message', id: piId(3), parentId: piId(2), timestamp: ts(3000), message: { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'all green' }], timestamp: 3000 } },
    { type: 'message', id: piId(4), parentId: piId(3), timestamp: ts(4000), message: { role: 'bashExecution', command: 'ls -la', output: 'a\nb\n', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 4000 } },
    { type: 'message', id: piId(5), parentId: piId(4), timestamp: ts(5000), message: { role: 'assistant', content: [{ type: 'text', text: '完成' }], usage: { input: 10, output: 5 }, timestamp: 5000 } },
    { type: 'custom_message', id: piId(6), parentId: piId(5), timestamp: ts(6000), customType: 'subagent-bg-notify', content: 'Subagent "coder" completed.', details: { id: 'job-1', status: 'done' } },
    { type: 'message', id: piId(7), parentId: piId(6), timestamp: ts(7000), message: { role: 'assistant', content: [{ type: 'text', text: '收到后台结果，继续处理' }], timestamp: 7000 } },
    { type: 'compaction', id: piId(8), parentId: piId(7), timestamp: ts(8000), summary: '压缩摘要', tokensBefore: 12345 },
    { type: 'message', id: piId(9), parentId: piId(8), timestamp: ts(9000), message: { role: 'user', content: [{ type: 'text', text: '继续' }], timestamp: 9000 } },
  ]

  it('E1: live 全类型构造（客户端 id 前缀）与 replay（pi uuidv7）终态按 id/piEntryId 归一后 deep-equal', () => {
    const liveState = normalizeIds(replayEntries(liveEntries))
    const replayState = normalizeIds(replayEntries(replaySideEntries))
    // 全量 state（messages + orphanToolResults + 配对锚点）非消息级抽样
    expect(liveState).toEqual(replayState)
    // 用户可见内容非空守卫（防两侧同归于空 / 静默 no-op 造成假等价）：
    // user×2 / assistant×3 / bash notice / 隐藏完成通知 / 压缩行，全类型各就各位
    expect(liveState.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(liveState.messages.filter((m) => m.role === 'assistant')).toHaveLength(3)
    expect(liveState.messages.filter((m) => m.bashExecution !== undefined)).toHaveLength(1)
    expect(liveState.messages.filter((m) => m.customType === 'subagent-bg-notify' && m.display === false)).toHaveLength(1)
    expect(liveState.messages.filter((m) => m.compactionSummary !== undefined)).toHaveLength(1)
  })

  it('E2: 分组等价——同一序列 live 构造与文件重放的 toRenderItems 输出 deep-equal（turn 数 / trigger / notices / 边界行一致）', () => {
    const liveItems = toRenderItems(normalizeIds(replayEntries(liveEntries)).messages)
    const replayItems = toRenderItems(normalizeIds(replayEntries(replaySideEntries)).messages)
    expect(liveItems).toEqual(replayItems)

    // 用户可见行为等价的显式断言（非仅内部结构）：turn 数、trigger 续跑起点、
    // bash 归 turn 内 notice（不切断 turn）、compaction 独立边界行
    const turns = (items: RenderItem[]) =>
      items.flatMap((i) => (i.kind === 'turn' ? [i.turn] : []))
    const liveTurns = turns(liveItems)
    expect(liveTurns).toHaveLength(3) // user 锚 / bg-notify 续跑 / user 锚
    // 首 turn：bash 执行记录归 turn 内 notice（W3 规则 4 inline），不出独立渲染项
    expect(liveTurns[0]!.notices?.map((n) => n.bashExecution?.command)).toEqual(['ls -la'])
    expect(liveTurns[0]!.assistants.map((a) => a.content)).toEqual(['开始执行', '完成'])
    // 次 turn：隐藏完成通知触发 trigger:'bg-notify' 续跑 turn（无 user 气泡）
    expect(liveTurns[1]!.trigger).toBe('bg-notify')
    expect(liveTurns[1]!.user).toBeNull()
    expect(liveTurns[1]!.assistants.map((a) => a.content)).toEqual(['收到后台结果，继续处理'])
    // compaction：独立 systemNotice 边界行（关闭 turn，W3 规则 5 boundary）
    expect(liveItems.some((i) => i.kind === 'systemNotice' && i.message.compactionSummary !== undefined)).toBe(true)
    // 末 turn：压缩后新 user 开新组
    expect(liveTurns[2]!.user?.content).toEqual([{ type: 'text', text: '继续' }])
  })

  it('E3: abort 等价（D1 closure——sendBash 解除丢弃后真实 cancelled 结果照常发布 entry 化，两侧同位同值）', () => {
    // 语义链（dispatcher D1 closure 修订 + abortBash 兜底终态独立帧 message.bashAborted，
    // msg-pipeline-debloat D4-3）：
    // 用户 abort bash → abortBash 广播 message.bashAborted
    // → bashAbortedEffect 只清 executingBash 不产 entry；sendBash await 返回后 token 虽被
    // 旋转但**不再跳过**——真实 cancelled 结果（bash-executor abort 返回 cancelled 结果
    // 而非 throw）经双分支发布 → bashResultEffect entry 化。pi 侧 recordBashResult 同数据
    // 落盘 → live/replay 同位（run 级联末）同值，原登记例外①（live 无 / 文件有）消灭。
    const cancelledBashBody = { role: 'bashExecution' as const, command: 'sleep 300', output: '部分输出\n', exitCode: null, cancelled: true, truncated: false, timestamp: 3000 }
    // live 侧：真实 cancelled 帧 entry 化（bash- 前缀客户端 id，bashResultEffect 构造形态）
    const liveState = replayEntries([
      { type: 'message', id: 'u-1', parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '跑个长命令' }], timestamp: 1000 } },
      { type: 'message', id: undefined, parentId: null, timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '执行中' }], timestamp: 2000 } },
      { type: 'message', id: 'bash-00000003-0000-4000-8000-000000000003', parentId: null, timestamp: ts(3000), message: cancelledBashBody },
      { type: 'message', id: 'u-2', parentId: null, timestamp: ts(5000), message: { role: 'user', content: [{ type: 'text', text: '换个任务' }], timestamp: 5000 } },
      { type: 'message', id: undefined, parentId: null, timestamp: ts(6000), message: { role: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: 6000 } },
    ])
    // replay 侧：pi 文件 cancelled bash entry（uuidv7 id，落盘位置 = run 级联末）
    const replayState = replayEntries([
      { type: 'message', id: piId(1), parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '跑个长命令' }], timestamp: 1000 } },
      { type: 'message', id: piId(2), parentId: piId(1), timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '执行中' }], timestamp: 2000 } },
      { type: 'message', id: piId(3), parentId: piId(2), timestamp: ts(3000), message: cancelledBashBody },
      { type: 'message', id: piId(4), parentId: piId(3), timestamp: ts(5000), message: { role: 'user', content: [{ type: 'text', text: '换个任务' }], timestamp: 5000 } },
      { type: 'message', id: piId(5), parentId: piId(4), timestamp: ts(6000), message: { role: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: 6000 } },
    ])

    // ① 数量一致 + 归一 deep-equal（无任何剔除——等价性恢复到全量）
    expect(replayState.messages).toHaveLength(liveState.messages.length)
    expect(normalizeIds(liveState)).toEqual(normalizeIds(replayState))

    // ② 分组骨架一致：cancelled bash 是 turn 内 inline notice（W3 规则），两侧 turn 数 /
    //    user / assistants / notices 全等（含 noticeCommands——不再需要剥离分歧点）
    expect(skeleton(liveState, liveState.messages)).toEqual(skeleton(replayState, replayState.messages))
    expect(skeleton(liveState, liveState.messages)).toHaveLength(2) // 两个 user 锚 turn
    expect(skeleton(liveState, liveState.messages)[0]).toMatchObject({ kind: 'turn', noticeCommands: ['sleep 300'] }) // cancelled 归首 turn notices
  })

  it('E3b: transport 抛错例外锁定（收窄后唯一残余分歧——abort 且 await 抛错时 live 无 cancelled entry、pi 独立落盘有）', () => {
    // 语义链（收窄例外，dispatcher catch 分支维持 skip）：abort 后 sendBash await **抛错**
    // （transport 断 / pi 死——与正常 resolve 的 cancelled result 不同路径）→ 无真实数据可
    // 发布，catch 守卫跳过（bashAborted 帧已清态）。pi 进程若独立存活仍 recordBashResult 落盘 →
    // 重开侧多一条 cancelled bash 记录。触发条件「abort 且 transport 抛错」——比原例外①
    // 「任何 abort」窄，登记 data-source-registry #7。
    // live 侧：无 bash entry（bashAborted 帧不产 entry、catch 无数据）
    const liveState = replayEntries([
      { type: 'message', id: 'u-1', parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '跑个长命令' }], timestamp: 1000 } },
      { type: 'message', id: undefined, parentId: null, timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '执行中' }], timestamp: 2000 } },
      { type: 'message', id: 'u-2', parentId: null, timestamp: ts(5000), message: { role: 'user', content: [{ type: 'text', text: '换个任务' }], timestamp: 5000 } },
      { type: 'message', id: undefined, parentId: null, timestamp: ts(6000), message: { role: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: 6000 } },
    ])
    // replay 侧：pi 文件含 cancelled bash entry（落盘位置 = run 级联末，a1 之后 user2 之前）
    const replayState = replayEntries([
      { type: 'message', id: piId(1), parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '跑个长命令' }], timestamp: 1000 } },
      { type: 'message', id: piId(2), parentId: piId(1), timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '执行中' }], timestamp: 2000 } },
      { type: 'message', id: piId(3), parentId: piId(2), timestamp: ts(3000), message: { role: 'bashExecution', command: 'sleep 300', output: '', exitCode: null, cancelled: true, truncated: false, timestamp: 3000 } },
      { type: 'message', id: piId(4), parentId: piId(3), timestamp: ts(5000), message: { role: 'user', content: [{ type: 'text', text: '换个任务' }], timestamp: 5000 } },
      { type: 'message', id: piId(5), parentId: piId(4), timestamp: ts(6000), message: { role: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: 6000 } },
    ])

    // ① 差异恰为该 entry：数量恰差 1，且 replay 剔除该条后与 live 归一 deep-equal
    expect(replayState.messages).toHaveLength(liveState.messages.length + 1)
    const replayMinusCancelled = replayState.messages.filter((m) => m.bashExecution?.cancelled !== true)
    expect(replayMinusCancelled).toHaveLength(replayState.messages.length - 1)
    expect(normalizeIds(liveState)).toEqual(normalizeIds({ ...replayState, messages: replayMinusCancelled }))

    // ② 分组不因它变化：turn 骨架（turn 数 / user / assistants / trigger）两侧一致，
    //    差异仅首 turn 的 notices 多一条——bash 是 inline notice，不影响 turn 边界
    const liveSkeleton = skeleton(liveState, liveState.messages)
    const replaySkeleton = skeleton(replayState, replayState.messages)
    expect(liveSkeleton).toHaveLength(2) // 两个 user 锚 turn，两侧一致
    // 除 noticeCommands 外全等（结构 diff 收敛到唯一分歧点）
    const stripNotices = (s: typeof liveSkeleton) =>
      s.map((row) => (row.kind === 'turn' ? { ...row, noticeCommands: undefined } : row))
    expect(stripNotices(liveSkeleton)).toEqual(stripNotices(replaySkeleton))
    expect(liveSkeleton[0]).toMatchObject({ kind: 'turn', noticeCommands: [] })
    expect(replaySkeleton[0]).toMatchObject({ kind: 'turn', noticeCommands: ['sleep 300'] })
  })

  it('E4: compactionSummary 处置（W6 entry 化）——live 帧构造 entry 与 replay compaction entry 经 reducer 产出归一 deep-equal', () => {
    // live 侧：registry compactionSummary handler 从帧构造的 entry（cmp- 前缀客户端 id，
    // 形态契约见 handler 注释——帧数据源与 pi 落盘 entry 同源同值）
    const liveCompaction: PiEntry = {
      type: 'compaction',
      id: 'cmp-00000006-0000-4000-8000-000000000006',
      parentId: null,
      timestamp: ts(8000),
      summary: '压缩摘要',
      tokensBefore: 12345,
    }
    // replay 侧：pi 持久化 compaction entry（uuidv7 id）
    const replayCompaction: PiEntry = {
      type: 'compaction',
      id: piId(8),
      parentId: null,
      timestamp: ts(8000),
      summary: '压缩摘要',
      tokensBefore: 12345,
    }
    expect(normalizeIds(replayEntries([liveCompaction])))
      .toEqual(normalizeIds(replayEntries([replayCompaction])))
    // 用户可见行为：压缩记录作 system 消息（content = summary，compactionSummary 字段完整）
    const [msg] = normalizeIds(replayEntries([liveCompaction])).messages
    expect(msg).toMatchObject({
      role: 'system',
      content: '压缩摘要',
      status: 'complete',
      compactionSummary: { summary: '压缩摘要', tokensBefore: 12345 },
    })
    // 分组语义：compaction 作 boundary systemNotice 独立行（关闭当前 turn，W3 规则 5）
    const items = toRenderItems(normalizeIds(replayEntries([liveCompaction])).messages)
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('systemNotice')
  })

  it('E4b: compaction summary-less 处置（D2 closure——interpreter 恒发帧后，无摘要 compaction 两侧同产 fallback 行）', () => {
    // 语义链（conversation-turn-attribution-closure D2）：pi appendCompaction 无条件落盘，
    // summary 缺失（undefined）的成功 compaction——interpreter 恒发帧（payload.summary 缺省
    // 透传）→ registry readCompactionSummary 不设 summary 字段 → 构造的 entry 无 summary →
    // reducer `summary ?? '上下文已压缩'` fallback。replay 侧文件 entry 同样无 summary →
    // 同一 fallback。原登记例外④（live 无 / reload 有）消灭。
    // live 侧：帧构造 entry（cmp- 前缀客户端 id，无 summary 字段）
    const liveCompaction: PiEntry = {
      type: 'compaction',
      id: 'cmp-00000007-0000-4000-8000-000000000007',
      parentId: null,
      timestamp: ts(9000),
      tokensBefore: 99999,
    }
    // replay 侧：pi 持久化 compaction entry（uuidv7 id，同样无 summary 字段）
    const replayCompaction: PiEntry = {
      type: 'compaction',
      id: piId(9),
      parentId: null,
      timestamp: ts(9000),
      tokensBefore: 99999,
    }
    const liveState = normalizeIds(replayEntries([liveCompaction]))
    const replayState = normalizeIds(replayEntries([replayCompaction]))
    // 归一 deep-equal（含 fallback 投影两侧一致）
    expect(liveState).toEqual(replayState)
    // 用户可见行为：两侧都产出 fallback 文案行（原 live 无消息的差异消灭）
    expect(liveState.messages).toHaveLength(1)
    expect(liveState.messages[0]).toMatchObject({
      role: 'system',
      content: '上下文已压缩',
      status: 'complete',
      compactionSummary: { summary: undefined, tokensBefore: 99999 },
    })
    // 分组语义：同 E4——boundary systemNotice 独立行
    const items = toRenderItems(liveState.messages)
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('systemNotice')
  })

  it("E4c: compaction 空串 summary 处置（实施审查 MF-1——'' 经 readers 空串透传门保留，两侧同值同路径不分叉）", () => {
    // 语义链（closure 实施审查 r1 MF-1）：pi appendCompaction 无条件直写 summary 字段，
    // '' 落盘后 replay 侧 `'' ?? fallback` 不触发 → 保留空行。live 链原先在
    // readCompactionSummary 的 truthiness 门（`if (s)`）处把 '' 丢成 undefined → 走
    // fallback 文案 → 内容级分叉。修复 = readers 门改 `s !== undefined`（空串透传），
    // '' 与 undefined 两种形态各自两侧一致（undefined → 双侧 fallback，见 E4b；'' → 双侧空行）。
    // live 侧：帧 summary:'' → readers 透传 → entry summary:''（cmp- 前缀客户端 id）
    const liveCompaction: PiEntry = {
      type: 'compaction',
      id: 'cmp-00000008-0000-4000-8000-000000000008',
      parentId: null,
      timestamp: ts(9500),
      summary: '',
      tokensBefore: 123456,
    }
    // replay 侧：pi 持久化 entry（summary 字段 ''，`'' ?? fallback` 不触发）
    const replayCompaction: PiEntry = {
      type: 'compaction',
      id: piId(10),
      parentId: null,
      timestamp: ts(9500),
      summary: '',
      tokensBefore: 123456,
    }
    const liveState = normalizeIds(replayEntries([liveCompaction]))
    const replayState = normalizeIds(replayEntries([replayCompaction]))
    expect(liveState).toEqual(replayState)
    // 用户可见行为：两侧都是空 content 行（不走 fallback 文案——与 E4b 的 undefined 形态对照）
    expect(liveState.messages[0]).toMatchObject({ role: 'system', content: '' })
    expect(replayState.messages[0]).toMatchObject({ role: 'system', content: '' })
  })

  it('E5: branchSummary 处置（D13 entry 化）——live 帧构造 branch_summary entry 与 replay pi entry 经 reducer 产出归一 deep-equal', () => {
    // live 侧：registry branchSummary handler 从帧构造的 entry（br- 前缀客户端 id，
    // 形态契约见 handler 注释——summary/fromId 帧值透传，timestamp 帧 ms → ISO）
    const liveBranch: PiEntry = {
      type: 'branch_summary',
      id: 'br-00000009-0000-4000-8000-000000000009',
      parentId: null,
      timestamp: ts(6000),
      summary: '分支摘要',
      fromId: 'msg-9',
    }
    // replay 侧：pi 持久化 branch_summary entry（uuidv7 id）
    const replayBranch: PiEntry = {
      type: 'branch_summary',
      id: piId(9),
      parentId: null,
      timestamp: ts(6000),
      summary: '分支摘要',
      fromId: 'msg-9',
    }
    expect(normalizeIds(replayEntries([liveBranch]))).toEqual(normalizeIds(replayEntries([replayBranch])))
    // 用户可见行为：分支记录作 system 消息（content = summary，branchSummary 字段完整）
    const [m] = normalizeIds(replayEntries([liveBranch])).messages
    expect(m).toMatchObject({
      role: 'system',
      content: '分支摘要',
      status: 'complete',
      branchSummary: { summary: '分支摘要', fromId: 'msg-9', timestamp: 6000 },
    })
    // 分组语义：branchSummary 作 boundary systemNotice 独立行（W3 规则 5，同 compaction E4）
    const items = toRenderItems(normalizeIds(replayEntries([liveBranch])).messages)
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('systemNotice')
  })

  it("E5b: branchSummary summary-less 处置（D13——无摘要两侧同产空串行，live 'Branched' 占位消灭）", () => {
    // 语义链（renderer-deepening D13，本设计第二处有意行为变化）：live 侧原直插
    // `summary ?? 'Branched'` 与 reload 侧 reducer `rawSummary ?? ''` 分叉（live 显示
    // 'Branched'、重开为空串）。entry 化后两侧共用 reducer branch_summary case——
    // summary 缺失（undefined）时同走 `?? ''` 空串投影，行为不一致消灭。
    // live 侧：帧构造 entry（br- 前缀客户端 id，无 summary 字段）
    const liveBranch: PiEntry = {
      type: 'branch_summary',
      id: 'br-00000010-0000-4000-8000-000000000010',
      parentId: null,
      timestamp: ts(9600),
      fromId: 'n-1',
    }
    // replay 侧：pi 持久化 entry（uuidv7 id，同样无 summary 字段）
    const replayBranch: PiEntry = {
      type: 'branch_summary',
      id: piId(10),
      parentId: null,
      timestamp: ts(9600),
      fromId: 'n-1',
    }
    const liveState = normalizeIds(replayEntries([liveBranch]))
    const replayState = normalizeIds(replayEntries([replayBranch]))
    expect(liveState).toEqual(replayState)
    // 用户可见行为：两侧都产出空串行（原 live 'Branched' 的差异消灭）
    expect(liveState.messages).toHaveLength(1)
    expect(liveState.messages[0]).toMatchObject({
      role: 'system',
      content: '',
      status: 'complete',
      branchSummary: { summary: undefined, fromId: 'n-1', timestamp: 9600 },
    })
  })

  it("E5c: branchSummary 空串 summary 处置（readBranchSummary 空串门——'' 保留 '' 不丢成 undefined，两侧同值同路径）", () => {
    // 与 E4c（compaction 空串）同族：readBranchSummary 的 `s !== undefined` 门透传 ''，
    // reducer `'' ?? ''` 不触发——两侧同保留空行，与 E5b 的 undefined 形态对照。
    const liveBranch: PiEntry = {
      type: 'branch_summary',
      id: 'br-00000011-0000-4000-8000-000000000011',
      parentId: null,
      timestamp: ts(9700),
      summary: '',
      fromId: 'n-2',
    }
    const replayBranch: PiEntry = {
      type: 'branch_summary',
      id: piId(11),
      parentId: null,
      timestamp: ts(9700),
      summary: '',
      fromId: 'n-2',
    }
    const liveState = normalizeIds(replayEntries([liveBranch]))
    const replayState = normalizeIds(replayEntries([replayBranch]))
    expect(liveState).toEqual(replayState)
    expect(liveState.messages[0]).toMatchObject({ role: 'system', content: '', branchSummary: { summary: '', fromId: 'n-2' } })
    expect(replayState.messages[0]).toMatchObject({ role: 'system', content: '' })
  })

  it('E7: 标记消息两链路等价（D7 序列化变更）——taiji 标记/降级块文本 live 帧喂 reducer ≡ reload 文件重放', () => {
    // 含 skill 标记的 user 消息（两形态各一）：单标记混排（segmentsToText 产出形态：
    // 标记 + 补空格正文）与降级块 + 指引行。两侧消息体独立手写（本文件惯例），
    // JSONL 落盘文本同源——反解析（core parseSkillBlock SSOT）产出交错 segments，
    // live 与 reload 经同一 reducer 终态必须一致（架构关键规则 9 的标记消息扩展）。
    const mixedText = '帮我 review 这段代码<taiji-skill name="code-review-graph" location="/abs/SKILL.md"/> 继续任务'
    const fallbackText = '超大任务\n<taiji-skills>\n<taiji-skill name="big-one" location="/b/SKILL.md"/>\n</taiji-skills>\nUse the read tool to load the skill files above before continuing the task\n收尾正文'

    // live 侧：message_end(user) 帧构造形态（客户端 u- 前缀 id，同 E1 liveEntries）
    const liveState = normalizeIds(replayEntries([
      { type: 'message', id: 'u-00000011-0000-4000-8000-000000000011', parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: mixedText }], timestamp: 1000 } },
      { type: 'message', id: 'u-00000012-0000-4000-8000-000000000012', parentId: null, timestamp: ts(2000), message: { role: 'user', content: [{ type: 'text', text: fallbackText }], timestamp: 2000 } },
    ]))
    // replay 侧：同内容 pi uuidv7 entry（文件重放形态）
    const replayState = normalizeIds(replayEntries([
      { type: 'message', id: piId(11), parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: mixedText }], timestamp: 1000 } },
      { type: 'message', id: piId(12), parentId: null, timestamp: ts(2000), message: { role: 'user', content: [{ type: 'text', text: fallbackText }], timestamp: 2000 } },
    ]))
    // 全量 state 归一 deep-equal（标记消息与非标记消息走同一断言口径）
    expect(liveState).toEqual(replayState)

    // 用户可见行为显式断言：两形态均还原为交错 segments（非 badge 退化纯文本），
    // 且标记前后正文全保留（场景 4③ 断言语义）
    const [first, second] = liveState.messages
    expect(first!.content).toEqual([
      { type: 'text', text: '帮我 review 这段代码' },
      { type: 'skill', name: 'code-review-graph', location: '/abs/SKILL.md' },
      { type: 'text', text: ' 继续任务' },
    ])
    expect(second!.content).toEqual([
      { type: 'text', text: '超大任务\n' },
      { type: 'skill', name: 'big-one', location: '/b/SKILL.md' },
      { type: 'text', text: '\n收尾正文' },
    ])
  })

  it('E8: toolCall endTime 回填（chat-flow-timestamp A5/A7）——非对称时钟下 live（双帧）≡ replay（单帧），值 = 权威 body.timestamp', () => {
    // 真实时钟形态（Gate A 实测暴露）：live 侧 tool_call_end 重构帧先到（body.timestamp =
    // 客户端时钟 Date.now 语义，取 2999），后到 message_end 携带 pi 权威落盘时刻（3000）；
    // R2-S1 去重首条 wins 内容，但 endTime 走 U3 last-wins 例外 → 终态 = 权威值；
    // replay 侧：单条持久化 entry（权威 3000）。两通路终态 endTime 相等——历史 reload
    // 耗时持久的 core 侧构造性保证。
    const assistant: PiEntry = { type: 'message', id: 'asst-e8', parentId: null, timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-e8', name: 'bash', arguments: { cmd: 'ls' } }], timestamp: 2000 } }
    const toolCallEndFrame: PiEntry = { type: 'message', id: 'tce-e8', parentId: null, timestamp: ts(2999), message: { role: 'toolResult', toolCallId: 'tc-e8', toolName: 'bash', content: [{ type: 'text', text: 'done' }], timestamp: 2999 } }
    const messageEndFrame: PiEntry = { type: 'message', id: 'me-e8', parentId: null, timestamp: ts(3000), message: { role: 'toolResult', toolCallId: 'tc-e8', toolName: 'bash', content: [{ type: 'text', text: 'done' }], timestamp: 3000 } }
    const replayEntry: PiEntry = { type: 'message', id: piId(20), parentId: null, timestamp: ts(3000), message: { role: 'toolResult', toolCallId: 'tc-e8', toolName: 'bash', content: [{ type: 'text', text: 'done' }], timestamp: 3000 } }
    const liveState = normalizeIds(replayEntries([assistant, toolCallEndFrame, messageEndFrame]))
    const replayState = normalizeIds(replayEntries([
      { type: 'message', id: 'asst-e8', parentId: null, timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-e8', name: 'bash', arguments: { cmd: 'ls' } }], timestamp: 2000 } },
      replayEntry,
    ]))
    const liveTc = liveState.messages.find((m) => m.toolCalls?.some((t) => t.id === 'tc-e8'))!.toolCalls![0]!
    const replayTc = replayState.messages.find((m) => m.toolCalls?.some((t) => t.id === 'tc-e8'))!.toolCalls![0]!
    // 显式值断言（用户可见字段级：UI 耗时展示的数据源）：endTime = 权威值（非客户端时钟渗入）
    expect(liveTc.endTime).toBe(3000)
    expect(replayTc.endTime).toBe(3000)
    expect(liveTc.endTime).toBe(replayTc.endTime)
    // startTime 来自 assistant body.timestamp（既有语义，与 endTime 异源不同值）
    expect(liveTc.startTime).toBe(2000)
    expect(replayTc.startTime).toBe(2000)
    // 全量 state 归一 deep-equal（endTime 在内逐字段一致）
    expect(liveState).toEqual(replayState)
  })

  it('E9: 标记 + 末尾块消息两链路等价（R4 D11/D7）——正文标记 + <taiji-skill-data> 块 live 帧 ≡ reload 文件重放', () => {
    // R4 形态（D11 场景 1 正常形态 + 场景 2 降级形态各一）：正文占位标记原样保留 +
    // 末尾 <taiji-skill-data> 包裹块（正常 = <skill> 全文展开；降级 = 标记清单 + 指引行）。
    // 反解析三链路 SSOT（parseSkillBlock 三形态：①剥块 ②标记还原 ③存量兼容）——live
    // message_end(user) 帧与 reload 文件重放同经该函数，终态必须一致（架构关键规则 9）。
    const normalFormText = '帮我 review 这段代码 <taiji-skill name="code-review-graph" location="/abs/SKILL.md"/>\n\n<taiji-skill-data>\n<skill name="code-review-graph" location="/abs/SKILL.md">\nReferences are relative to /abs.\n\n（SKILL.md 全文…）\n</skill>\n</taiji-skill-data>'
    const degradedFormText = '帮我 review <taiji-skill name="a" location="/a/SKILL.md"/>\n\n<taiji-skill-data>\n<taiji-skill name="a" location="/a/SKILL.md"/>\nUse the read tool to load the skill files above before continuing the task\n</taiji-skill-data>'

    // live 侧：message_end(user) 帧构造形态（客户端 u- 前缀 id，同 E7）
    const liveState = normalizeIds(replayEntries([
      { type: 'message', id: 'u-00000013-0000-4000-8000-000000000013', parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: normalFormText }], timestamp: 1000 } },
      { type: 'message', id: 'u-00000014-0000-4000-8000-000000000014', parentId: null, timestamp: ts(2000), message: { role: 'user', content: [{ type: 'text', text: degradedFormText }], timestamp: 2000 } },
    ]))
    // replay 侧：同内容 pi uuidv7 entry（文件重放形态）
    const replayState = normalizeIds(replayEntries([
      { type: 'message', id: piId(13), parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: normalFormText }], timestamp: 1000 } },
      { type: 'message', id: piId(14), parentId: null, timestamp: ts(2000), message: { role: 'user', content: [{ type: 'text', text: degradedFormText }], timestamp: 2000 } },
    ]))
    // 全量 state 归一 deep-equal（含 skill 消息走同一断言口径）
    expect(liveState).toEqual(replayState)

    // 用户可见行为显式断言：剥块（块内全文/清单零残留）+ 正文标记还原 badge +
    // 块前正文全保留（场景 4③ 断言语义——正文不得因反解析丢失）
    const [first, second] = liveState.messages
    expect(first!.content).toEqual([
      { type: 'text', text: '帮我 review 这段代码 ' },
      { type: 'skill', name: 'code-review-graph', location: '/abs/SKILL.md' },
      { type: 'text', text: '\n\n' },
    ])
    expect(second!.content).toEqual([
      { type: 'text', text: '帮我 review ' },
      { type: 'skill', name: 'a', location: '/a/SKILL.md' },
      { type: 'text', text: '\n\n' },
    ])
  })
})

// ── steer/followUp 投递气泡 live ≡ reload（steer-bubble u4 / D3 + §4 AC-7）→ [投递所有权内核 u3b] 机制迁移 ──
//
// 锁定对象（断言强度不变）：steer/followUp 等非 direct 车道投递的用户气泡，live 通路与
// reload 通路逐字段等价。live 侧走**真实 store + 真实 registry 回执链 + session.delivery
// 投影**（applyMessageEvent，custom-start-equivalence 同款范式），重放侧 = 同内容 pi 持久化
// entry（uuidv7 id）直接 replayEntries——归一后逐字段 deep-equal。
//
// [u3b 机制迁移] 前身三腿（腿 1 queue_update 计数差集 → drainN / 腿 2 includes 兜底 / defer
// 分区 FIFO）随 defer 队列与 pendingBuffer 计数腿整体退役（设计 §3.1 删除面；D7 队列区数据源
// 改 session.delivery 状态帧单一源）。新机制的两条显示通路与原三例职责一一对应：
// - morph 回填（E5a/E5c）：统一 submit 的乐观气泡（appendUser，原 segments 引用）→
//   session.delivery 帧非 direct 车道 morph（truncateFrom 移出对话流 + captureMorphSegments
//   捕获原段）→ message_end(user) 裸标记 id 命中投影条目 → appendUser(原 segments) 回填
//   （非降级恢复）。morph 编排的锁定点 = useChat.test.ts「session.delivery 帧消费与气泡
//   morph」组（本文件只驱动同一组原语，不复制编排）。
// - 纯文本降级（E5b）：无本地乐观气泡的投递（外来注入 / reattach 恢复形态——前身 = 腿 2
//   includes 兜底的职责域）→ 回执命中投影且无 morph 段 → 按 reload 投影同规则剥标记入流。
//
// [D3 表述修正] live ref 气泡 id 是 appendUser 客户端 `u-<uuid>`（clientUuid 契约），重放投影
// id 是 pi uuidv7 entry id——属 W21 已裁决差异类。归一只剥 id / piEntryId / timestamp 三异源
// 字段，**断言 id 异源形态而非相等**；timestamp 用时钟窗容差（ref 侧 = appendUser 客户端时钟，
// 重放侧 = pi 落盘时刻，差值为投递延迟）。其余字段（role / content segments / status /
// contentBlocks …）逐字段相等。
//
// 内容前提（P2 探针 ✅ + u3b 契约桥）：帧文本尾 = 投递文本 + `\n<!--taiji:msg:<id>-->` 裸标记
// （标记 id = 条目 clientUuid 去 u- 前缀；u- 原文形态同样命中，见 effects/user-delivery 双形态
// 收口）。已知例外：file/mention 徽章 segments 无法从 entry 反解（重开降级纯文本，D5 已裁决
// 维持现状 + segments sidecar 回填）——不进本组断言范围。
describe('steer/followUp 投递气泡 live ≡ reload（steer-bubble u4 / D3 + AC-7）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // 内核投影是模块级 per-session 分区（ADR-0049 键控纪律）：用例间必须复位，否则上一用例
    // 的条目会让裸标记回执误命中（跨用例污染）。
    resetDeliveryProjectionForTest()
  })

  // ts 用文件级共享 helper；本组假 id 保留异形本地副本（尾组编码 = n×10，与共享版不同形，
  // 独立命名防混淆——不强行并入共享参数化，保 id 形态覆盖面）
  /** uuidv7 形态假 id（重放侧专用，模拟 pi 持久化 id 空间） */
  const steerPiId = (n: number) => `0198aabb-ccdd-7e${n.toString().padStart(2, '0')}-8f00-0000000000${n}0`

  /** 构造独立 store 实例（effectScope 包裹 onScopeDispose 注册 + 测试隔离）。 */
  function makeStore(): { store: ChatStoreInstance; dispose: () => void } {
    const scope = effectScope(true)
    const store = scope.run(() => createChatStore())!
    return { store, dispose: () => scope.stop() }
  }

  /** message_end(user) 帧构造（event-adapter handleMessageEnd 重构形态：entry **无 id**——
   * pi 在 emit 之后才 appendMessage 分配 uuidv7；content parts 数组为 P2 探针实证形态）。
   * markerId 非空时按内核出站形态在文本尾附加裸标记（`\n<!--taiji:msg:<id>-->`）。 */
  function userEndFrame(sid: string, text: string, at: number, markerId?: string): ServerMessage {
    return {
      type: 'message.message_end',
      payload: {
        sessionId: sid,
        entry: {
          type: 'message',
          parentId: null,
          timestamp: ts(at),
          message: {
            role: 'user',
            content: [{ type: 'text', text: markerId ? `${text}\n<!--taiji:msg:${markerId}-->` : text }],
            timestamp: at,
          },
        },
      },
    } as ServerMessage
  }

  /** 同内容单 text part 持久化 entry（重放侧 get_entries 返回形态：uuidv7 id + pi 落盘时刻） */
  function persistedUserEntry(id: string, text: string, at: number): PiEntry {
    return {
      type: 'message',
      id,
      parentId: null,
      timestamp: ts(at),
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: at },
    }
  }

  /** session.delivery 帧条目落位（handleSessionDelivery 第一步 = replaceDeliveryProjection，
   *  D7 单一数据源——回执的命中依据） */
  function seedDeliveryEntry(
    sid: string,
    clientUuid: string,
    lane: 'direct' | 'steer' | 'queued',
  ): void {
    replaceDeliveryProjection(sid, [{ clientUuid, preview: 'p', state: 'in-flight', lane }])
  }

  /** 非 direct 车道 morph（handleSessionDelivery 第二步：气泡移出对话流 + 原 segments 捕获；
   *  编排锁定点见 useChat.test.ts「session.delivery 帧消费与气泡 morph」组）。返回捕获引用。 */
  function morphBubbleOut(store: ChatStoreInstance, sid: string, clientUuid: string): Segment[] {
    const bubble = store.getMessages(sid).find((m) => m.id === clientUuid)
    expect(bubble, 'morph 前乐观气泡应在对话流中（appendUser 契约：气泡 id = clientUuid）').toBeDefined()
    const segments = toRaw(bubble!.content) as Segment[]
    store.truncateFrom(sid, clientUuid, true)
    captureMorphSegments(sid, clientUuid, segments)
    return segments
  }

  /** ref 气泡归一：剥 W21 已裁决三异源字段——id（live u-<uuid> vs 重放 uuidv7）、piEntryId
   *（appendUser 构造点已剥，对称防御性同剥）、timestamp（客户端时钟 vs pi 落盘时刻）。 */
  function stripHetero(m: Message): Record<string, unknown> {
    const { id: _id, piEntryId: _pid, timestamp: _ts, ...rest } = m
    return rest as Record<string, unknown>
  }

  /** id 异源形态断言（D3 表述修正：断言形态而非相等）+ ref timestamp 时钟窗容差断言 */
  function expectIdShapeAndTsWindow(
    live: Message,
    replay: Message,
    liveWindow: [number, number],
    replayTs: number,
  ): void {
    // live：appendUser 客户端 u-<uuid>（clientUuid 映射链契约形态）
    expect(live.id).toMatch(/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // 重放：pi uuidv7（version 7 + variant 位锚定）
    expect(replay.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // 形态同构、值异源：显式断言不等（异源是设计裁决，归一是断言策略而非测试妥协）
    expect(live.id).not.toBe(replay.id)
    // timestamp 容差：live = appendUser 调用点客户端时钟 ∈ 窗口；重放 = pi 落盘时刻（fixture 值）
    expect(live.timestamp).toBeGreaterThanOrEqual(liveWindow[0])
    expect(live.timestamp).toBeLessThanOrEqual(liveWindow[1])
    expect(replay.timestamp).toBe(replayTs)
  }

  it('E5a: morph 段回执（captureMorphSegments 捕获）ref 气泡 ≡ 重放投影——非降级恢复路径', () => {
    const s = makeStore()
    const sid = 's-morph-segments'
    const text = 'streaming 中追加的补充说明'
    const segments: Segment[] = [{ type: 'text', text }]
    // live 前置链：统一 submit 乐观气泡（appendUser + inflight 占位）→ 内核判定非 direct 车道
    // → session.delivery 帧 morph（气泡移出对话流，原段暂存待回执回填）
    const bubbleId = s.store.appendUser(sid, segments)
    s.store.incrementInflight(sid, 1)
    seedDeliveryEntry(sid, bubbleId, 'steer')
    expect(morphBubbleOut(s.store, sid, bubbleId)).toBe(segments)
    expect(s.store.getMessages(sid).some((m) => m.id === bubbleId)).toBe(false)

    // 内核送达：message_end(user) 帧携带裸标记（标记 id = clientUuid 去 u- 前缀）→ ① 命中投影
    // → 原 segments 回填入流
    const t0 = Date.now()
    s.store.applyMessageEvent(sid, userEndFrame(sid, text, t0, bubbleId.slice(2)))
    const t1 = Date.now()

    // G1 用户可见：气泡恰一条（G2：segments 回填非降级，且引用原样搬运——badge 不丢）
    const refUsers = s.store.getMessages(sid).filter((m) => m.role === 'user')
    expect(refUsers).toHaveLength(1)
    const live = refUsers[0]!
    expect(live).toMatchObject({ role: 'user', status: 'complete', content: segments })
    expect(toRaw(live.content)).toBe(segments)
    // 投递占位由回执回收（本帧即其确认帧；② 计数兜底不再重复扣）
    expect(s.store.getInflight(sid)).toBe(0)

    // 重放投影：同内容持久化 entry（uuidv7 id，pi 落盘 timestamp = 帧 timestamp）
    const replayState = replayEntries([persistedUserEntry(steerPiId(1), text, t0)])
    expect(replayState.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    const replay = replayState.messages[0]!

    // 按字段归一 deep-equal（content segments / role / status / contentBlocks 逐字段）
    expect(stripHetero(live)).toEqual(stripHetero(replay))
    expectIdShapeAndTsWindow(live, replay, [t0, t1], t0)

    // reducer 权威镜像同构：live 侧帧 entry（无 id → 位置派生 e<N>）与重放（uuidv7）
    // 剥 id/piEntryId 后逐字段一致——timestamp 两侧 fixture 同值可直比（差异只在 ref 侧
    // appendUser 客户端时钟，上方窗断言已覆盖）。此维度对三条路径共用（message_end 帧
    // 恒先喂 reducer，E5c 不再重复）。
    const liveReducer = s.store.testInternals._entryStatesForTest.get(sid)!.messages
    expect(liveReducer).toHaveLength(1)
    const { id: _li, piEntryId: _lp, ...liveReducerMsg } = liveReducer[0]!
    const { id: _ri, piEntryId: _rp, ...replayMsg } = replay
    expect(liveReducerMsg).toEqual(replayMsg)
    s.dispose()
  })

  it('E5b: 无本地气泡的投递（外来注入形态）→ 纯文本降级入流 ref 气泡 ≡ 重放投影——多 text part 拼接同源', () => {
    const s = makeStore()
    const sid = 's-foreign-plain'
    // 外来条目（session_manager send / 收养形态）：内核投影有条目、renderer 无乐观气泡
    //（未经本地 submit → 无 appendUser、无 morph 段）——显示责任由回执的纯文本降级分支
    // 承接（前身 = 腿 2 includes 兜底的职责域）。clientUuid 用内核裸 uuid 形态。
    const foreignId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    seedDeliveryEntry(sid, foreignId, 'steer')
    // 帧内容用多 text part：live extractUserContentText 顺序拼接与重放 reducer
    // collectTextPart 累加是同语义（apply-entry-convert，P2：pi 不 trim）
    const joined = 'first part ' + 'second part'
    const marker = `\n<!--taiji:msg:${foreignId}-->`
    const t0 = Date.now()
    s.store.applyMessageEvent(sid, {
      type: 'message.message_end',
      payload: {
        sessionId: sid,
        entry: {
          type: 'message',
          parentId: null,
          timestamp: ts(2000),
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'first part ' },
              { type: 'text', text: 'second part' + marker },
            ],
            timestamp: 2000,
          },
        },
      },
    } as ServerMessage)
    const t1 = Date.now()

    const refUsers = s.store.getMessages(sid).filter((m) => m.role === 'user')
    expect(refUsers).toHaveLength(1)
    const live = refUsers[0]!
    // G2 降级形态：拼接文本包成单 text segment（降级可见不静默）
    expect(live.content).toEqual([{ type: 'text', text: joined }])
    // 显示层纯度：内核裸标记不入气泡文本（与 reload 投影同规则剥离；上一条 toEqual 已含
    // 全等语义，此处对标记字面量再显式断言一条，防后续断言弱化时标记泄漏回气泡）
    expect(JSON.stringify(live.content)).not.toContain('<!--taiji:msg:')

    // 重放侧独立构造（本文件惯例：两侧消息体独立手写不共享字面量）：同内容多 part entry。
    // pi 落盘文本同样携带标记（标记随文本进 transcript），重放投影剥标记后与本侧同形——
    // 两侧剥标记同点同规则（apply-entry-convert DEFER_FLUSH_MARKER_RE 复用）即本断言对象。
    const replayState = replayEntries([{
      type: 'message',
      id: steerPiId(2),
      parentId: null,
      timestamp: ts(2000),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'first part ' },
          { type: 'text', text: 'second part' + `\n<!--taiji:msg:3f2504e0-4f89-41d3-9a0c-0305e82c3301-->` },
        ],
        timestamp: 2000,
      },
    }])
    const replay = replayState.messages[0]!

    expect(stripHetero(live)).toEqual(stripHetero(replay))
    // [消息撤回 U8] id 保号（外来形态单列断言，不走共享 helper 的 u- 形态断言）：live
    // 气泡 id = 内核条目 clientUuid（外来形态为裸 uuid——保号语义优先于 u- 形态约束，
    // store.appendUser 注释）；重放 id 沿用 fixture entry id（形态独立于真实 pi entryId
    // 的 8 位 hex 口径），异源不等
    expect(live.id).toBe(foreignId)
    expect(replay.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(live.id).not.toBe(replay.id)
    // timestamp 异源容差（共享 helper 同款断言）：live 客户端时钟窗 / 重放 pi 落盘时刻 2000
    expect(live.timestamp).toBeGreaterThanOrEqual(t0)
    expect(live.timestamp).toBeLessThanOrEqual(t1)
    expect(replay.timestamp).toBe(2000)

    // reducer 权威镜像同构（多 text part 拼接 + 标记剥离两处同源点的直接断言）
    const liveReducer = s.store.testInternals._entryStatesForTest.get(sid)!.messages
    expect(liveReducer).toHaveLength(1)
    const { id: _li, piEntryId: _lp, ...liveReducerMsg } = liveReducer[0]!
    const { id: _ri, piEntryId: _rp, ...replayMsg } = replay
    expect(liveReducerMsg).toEqual(replayMsg)
    s.dispose()
  })

  it('E5c: 回执入流后迟到确认帧不双插（① 已 delivered 拒命 + ② 计数兜底）ref 气泡 ≡ 重放投影', () => {
    const s = makeStore()
    const sid = 's-receipt-idempotent'
    const text = '注意用中文回复'
    const segments: Segment[] = [{ type: 'text', text }]
    // live 前置链：统一 submit 乐观气泡 → queued 车道帧 morph（气泡移出，段暂存）
    const bubbleId = s.store.appendUser(sid, segments)
    s.store.incrementInflight(sid, 1)
    seedDeliveryEntry(sid, bubbleId, 'queued')
    morphBubbleOut(s.store, sid, bubbleId)

    // 内核送达回执（首个确认帧）：投影转 delivered + 段回填入流 + 占位回收
    const t0 = Date.now()
    s.store.applyMessageEvent(sid, userEndFrame(sid, text, t0, bubbleId.slice(2)))
    const t1 = Date.now()
    expect(s.store.getInflight(sid)).toBe(0)
    expect(s.store.getMessages(sid).filter((m) => m.role === 'user')).toHaveLength(1)
    const live = s.store.getMessages(sid).filter((m) => m.role === 'user')[0]!

    // 迟到重复确认帧（pi 重复事件 / 帧重放形态）：① 条目已 delivered 不命中 → ② 计数兜底
    // （inflight 已归零 → 零动作）——不二次入流（多插盯防 = 前身「确认帧抵消无双插」同判据）
    s.store.applyMessageEvent(sid, userEndFrame(sid, text, t0, bubbleId.slice(2)))
    expect(s.store.getMessages(sid).filter((m) => m.role === 'user')).toHaveLength(1)
    expect(s.store.getInflight(sid)).toBe(0)

    // 回执 ref 气泡 vs 同 entry 重放投影（ref timestamp = 回执 appendUser 点时钟，窗口 t0/t1）
    const replayState = replayEntries([persistedUserEntry(steerPiId(3), text, t0)])
    const replay = replayState.messages[0]!
    expect(stripHetero(live)).toEqual(stripHetero(replay))
    expect(live).toMatchObject({ role: 'user', status: 'complete', content: segments })
    expectIdShapeAndTsWindow(live, replay, [t0, t1], t0)
    s.dispose()
  })
})

// ── 双入口等价（R1-S1 修复锁定 / R2-TC S1）──────────────────────────────────────
//
// 生产实际输入（runtime worker 对 pi 0.84.1 实证）：同一条 toolResult 双发
// tool_execution_end + message_end{role:'toolResult'} 两个事件 → taiji 两条帧
// （message.tool_call_end / message.message_end）各喂 applyEntry 一次（registry 两
// handler）。此前 reducer 无幂等：异常时序（assistant 帧丢失 / hydrate 空窗）下第二条帧
// 重复收集 orphan 或二次回填，orphan 永久残留 → live/reload 漂移。修复 = reducer
// deliveredToolResultIds 幂等（applyToolResultMessage：同 toolCallId 首次投递后二次 no-op）。
// 本组断言：双喂入序列终态 ≡ 单喂入序列终态（全量 state deep-equal，非抽样），且单入口
// 契约不被去重破坏——去重键是「已投递过该 toolCallId 的 toolResult」而非「存在该
// toolCallId」。entry 按生产构造点形态手写（tool_call_end：event-adapter
// handleToolExecutionEnd；message_end：handleMessageEnd——同内容同构、均无 entry id）。
describe('双入口等价（R2-TC S1）——同 toolCallId 双帧喂入 ≡ 单帧喂入', () => {
  // ts 用文件级共享 helper（见「断言基建共享 helper」区）

  const assistantWithTc1: PiEntry = {
    type: 'message',
    id: undefined,
    parentId: null,
    timestamp: ts(2000),
    message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'npm test' } }], timestamp: 2000 },
  }
  /** 同一条 toolResult 的帧 entry 构造（两入口构造点产出同内容同构 entry） */
  const toolResultEntry = (text: string): PiEntry => ({
    type: 'message',
    id: undefined,
    parentId: null,
    timestamp: ts(3000),
    message: { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text }], timestamp: 3000 },
  })
  const viaToolCallEnd = toolResultEntry('all green') // message.tool_call_end 帧（生产时序先到）
  const viaMessageEnd = toolResultEntry('all green') // message.message_end 帧（后到）

  it('S1a: 正常时序双喂入 ≡ 单喂入——回填恰一次、无 orphan、无重复消息', () => {
    const dual = replayEntries([assistantWithTc1, viaToolCallEnd, viaMessageEnd])
    const single = replayEntries([assistantWithTc1, viaToolCallEnd])
    expect(dual).toEqual(single) // 全量 state（messages + orphan + 簿记）deep-equal
    // 用户可见行为：host toolCall 不因双喂复制 / 二次改写，orphan 为零
    expect(dual.messages).toHaveLength(1)
    expect(dual.messages[0].toolCalls).toHaveLength(1)
    expect(dual.messages[0].toolCalls![0]).toMatchObject({ id: 'tc-1', output: 'all green', status: 'completed' })
    expect(dual.orphanToolResults).toHaveLength(0)
  })

  it('S1b: 异常时序（assistant 帧丢失）双喂入 ≡ 单喂入——orphan 恰一条不重复收集', () => {
    const dual = replayEntries([viaToolCallEnd, viaMessageEnd])
    const single = replayEntries([viaToolCallEnd])
    expect(dual).toEqual(single)
    expect(dual.messages).toHaveLength(0)
    expect(dual.orphanToolResults).toHaveLength(1) // 修复前为 2：重复收集且永久残留（漂移源）
  })

  it('S1c: 单入口契约——tool_call_end 帧丢失时 message_end 是唯一载体，照常投影', () => {
    const state = replayEntries([assistantWithTc1, viaMessageEnd])
    expect(state.messages[0].toolCalls![0]).toMatchObject({ id: 'tc-1', output: 'all green' })
    expect(state.orphanToolResults).toHaveLength(0)
  })

  it('S1d: 首投递优先——第二条帧内容不同（tool_call_end hook 改写 vs message_end 原始）不覆盖', () => {
    const state = replayEntries([assistantWithTc1, toolResultEntry('hook-rewritten'), toolResultEntry('original')])
    expect(state.messages[0].toolCalls![0].output).toBe('hook-rewritten') // no-op 保留首条（与 overlay 收口同值）
  })

  it('S1e: 同 turn 多 toolCall 各自双喂——按 id 各自回填恰一次，互不干扰', () => {
    const assistant: PiEntry = {
      type: 'message',
      id: undefined,
      parentId: null,
      timestamp: ts(2000),
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-a', name: 'read', arguments: { path: '/a' } },
          { type: 'toolCall', id: 'tc-b', name: 'bash', arguments: { command: 'ls' } },
        ],
        timestamp: 2000,
      },
    }
    const result = (id: string, text: string): PiEntry => ({
      type: 'message',
      id: undefined,
      parentId: null,
      timestamp: ts(3000),
      message: { role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text }], timestamp: 3000 },
    })
    // 生产时序：tc-a 双帧 → tc-b 双帧
    const dual = replayEntries([assistant, result('tc-a', 'A'), result('tc-a', 'A'), result('tc-b', 'B'), result('tc-b', 'B')])
    const single = replayEntries([assistant, result('tc-a', 'A'), result('tc-b', 'B')])
    expect(dual).toEqual(single)
    expect(dual.orphanToolResults).toHaveLength(0)
    expect(dual.messages[0].toolCalls!.map((t) => t.output)).toEqual(['A', 'B'])
  })
})

// ── 预算窗口内 live ≡ reload（u6 re-scope，crash-resilience §3.3 D4）──────────────
//
// 断言域声明（设计 D4 原文见文件头 re-scope 段）：比较域 = **预算窗口内**。窗口投影
// 直接复用 runtime 生产实现（applyHistoryBudgetWindow——session.history 响应的实际
// 切窗函数，活跃/离线/游标翻页三路径共用），等价性「构造性成立」由同一函数 +
// 同一 reducer 承担：live 累积（分区最终内容）与重开重放（get_entries 全量重放）对
// 同一 entry 序列，经同一窗口函数投影后必得同一页。
describe('预算窗口内 live ≡ reload（u6 re-scope）', () => {
  // ts / piId / normalizeIds 用文件级共享 helper（见「断言基建共享 helper」区）

  it('W1: 同序列两侧各自经预算窗口投影后仍 deep-equal（窗口外翻页恢复，不在等价域）', () => {
    // 多 turn 序列（每条 user 开新 turn），体量超默认窗口（RECENT_TURNS=20）——
    // 25 turns > 20，两侧都被切窗：窗口内（最近 20 turns）deep-equal。
    const mkLive = (n: number): PiEntry[] =>
      Array.from({ length: n }, (_, i) => ({
        type: 'message',
        id: `u-${i + 1}`,
        parentId: null,
        timestamp: ts((i + 1) * 1000),
        message: { role: 'user', content: [{ type: 'text', text: `turn ${i + 1}` }], timestamp: (i + 1) * 1000 },
      }))
    const mkReplay = (n: number): PiEntry[] =>
      Array.from({ length: n }, (_, i) => ({
        type: 'message',
        id: piId(i + 1),
        parentId: i === 0 ? null : piId(i),
        timestamp: ts((i + 1) * 1000),
        message: { role: 'user', content: [{ type: 'text', text: `turn ${i + 1}` }], timestamp: (i + 1) * 1000 },
      }))
    const liveFull = replayEntries(mkLive(25))
    const replayFull = replayEntries(mkReplay(25))
    // 全量域等价先成立（既有断言域——re-scope 的前提）
    expect(normalizeIds(liveFull)).toEqual(normalizeIds(replayFull))
    // 预算窗口域：同一生产切窗函数投影后（各留最近 20 turns）仍 deep-equal
    const liveWin = applyHistoryBudgetWindow(liveFull.messages)
    const replayWin = applyHistoryBudgetWindow(replayFull.messages)
    expect(normalizeIds({ ...liveFull, messages: liveWin.messages })).toEqual(
      normalizeIds({ ...replayFull, messages: replayWin.messages }),
    )
    // 窗口如实反映预算：20 turns 入窗 + truncated=true（窗口外 5 turns 需翻页恢复）
    expect(liveWin.loadedTurns).toBe(20)
    expect(liveWin.truncated).toBe(true)
    expect(liveWin.messages).toHaveLength(20)
  })

  it('W2: 窗口截断的起点恒对齐 turn 边界（entry 原子性——切分点不落 turn 中间）', () => {
    // turn 3 内含 assistant + toolResult（非 user 边界消息），窗口起点若落中间即破坏
    // parentId 链——re-scope 后该原子性由窗口函数构造保证，此处机器化锁定。
    const side = (turnPrefix: string, startTs: number): PiEntry[] => [
      { type: 'message', id: turnPrefix === 'L' ? `u-x${startTs}` : piId(startTs), parentId: null, timestamp: ts(startTs), message: { role: 'user', content: [{ type: 'text', text: `q-${startTs}` }], timestamp: startTs } },
      { type: 'message', id: undefined, parentId: null, timestamp: ts(startTs + 100), message: { role: 'assistant', content: [{ type: 'toolCall', id: `tc-${startTs}`, name: 'bash', arguments: { command: 'ls' } }], timestamp: startTs + 100 } },
      { type: 'message', id: undefined, parentId: null, timestamp: ts(startTs + 200), message: { role: 'toolResult', toolCallId: `tc-${startTs}`, toolName: 'bash', content: [{ type: 'text', text: 'ok' }], timestamp: startTs + 200 } },
    ]
    // 3 turns × 3 entries；窗口 1 turn 时起点必须落在 turn 边界（user 消息），不带前 turn 残段
    const liveState = replayEntries([...side('L', 1000), ...side('L', 4000), ...side('L', 7000)])
    const win = applyHistoryBudgetWindow(liveState.messages, { limitTurns: 1 })
    expect(win.loadedTurns).toBe(1)
    // 窗口首条 = turn 3 的 user（q-7000），其 assistant 完整随行（toolResult 已回填进
    // assistant 的 toolCall.output——reducer 合并语义，2 条消息 = user + assistant）
    expect(win.messages).toHaveLength(2)
    expect(win.messages[0]!.role).toBe('user')
    expect(win.truncated).toBe(true) // 前两个 turn 在窗口外（翻页恢复域）
  })

  it('W3: 游标前缀 + 窗口投影的构造性（翻页页 = 同一函数的复合，两通路页内容恒等）', () => {
    // 游标翻页语义（runtime sliceMessagesBeforeCursor + applyHistoryBudgetWindow 的复合
    // 在两侧同构适用）：对同序列，锚点之前的最近窗口 = 页内容。两侧独立构造同内容序列
    // （W6 lift 保真风格），页投影 deep-equal。
    const liveSeq = replayEntries([
      { type: 'message', id: 'u-1', parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '第一轮' }], timestamp: 1000 } },
      { type: 'message', id: 'u-2', parentId: null, timestamp: ts(2000), message: { role: 'user', content: [{ type: 'text', text: '第二轮' }], timestamp: 2000 } },
      { type: 'message', id: 'u-3', parentId: null, timestamp: ts(3000), message: { role: 'user', content: [{ type: 'text', text: '第三轮' }], timestamp: 3000 } },
    ])
    const replaySeq = replayEntries([
      { type: 'message', id: piId(1), parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '第一轮' }], timestamp: 1000 } },
      { type: 'message', id: piId(2), parentId: piId(1), timestamp: ts(2000), message: { role: 'user', content: [{ type: 'text', text: '第二轮' }], timestamp: 2000 } },
      { type: 'message', id: piId(3), parentId: piId(2), timestamp: ts(3000), message: { role: 'user', content: [{ type: 'text', text: '第三轮' }], timestamp: 3000 } },
    ])
    // 锚 = 两侧各自的第三轮身份（renderer 侧即分区最旧消息身份）
    const livePage = applyHistoryBudgetWindow(sliceMessagesBeforeCursor(liveSeq.messages, 'u-3')!, { limitTurns: 1 })
    const replayPage = applyHistoryBudgetWindow(sliceMessagesBeforeCursor(replaySeq.messages, piId(3))!, { limitTurns: 1 })
    expect(normalizeIds({ ...liveSeq, messages: livePage.messages })).toEqual(
      normalizeIds({ ...replaySeq, messages: replayPage.messages }),
    )
    // 页内容 = 第二轮（锚前最近 1 turn）；锚前无更早 turn 时窗口收敛为空（翻页到头）
    const firstText = (m: (typeof livePage.messages)[number]): string => {
      const c = m.content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) {
        const t = (c as Segment[]).find((seg) => seg.type === 'text')
        return t && t.type === 'text' ? t.text : ''
      }
      return ''
    }
    expect(livePage.messages.map(firstText)).toEqual(['第二轮'])
    const headPage = applyHistoryBudgetWindow(sliceMessagesBeforeCursor(liveSeq.messages, 'u-1')!, { limitTurns: 1 })
    expect(headPage.messages).toEqual([])
    expect(headPage.truncated).toBe(false)
  })
})

// ── [two-state-convergence U7 / P2 ⛔实施期门] subagent-record entry 等价回放 ──────────
//
// 设计 D7 P2：「subagent-record entry 的『轮终翻边 entry 序列』冷启动重放 ≡ live 派生
// （现构造性成立，测试防回归）」。投影面 = runtime scanSubagentEntries（冷启动全量与
// live 失效重拉是同一份代码——§2.4 构造性保证），本组测试钉住：
//   1. 翻边 entry 序列投影的确定性（同序列两次全量扫描 deep-equal）；
//   2. 冷启动全量 ≡ 逐条前缀增量折叠（后到覆盖语义下，live 任意时点的增量重拉态
//      与全量重放的同 id 投影一致）；
//   3. v2 条目族（registered 定身份 / settled 定终局）在重放/live 两通路结果一致；
//   4. 01a09f83 形态 fixture（U1/U2 批入库，renderer 与 core 双副本头注互指）回放
//      badge 计数 = 0（P1 门在 renderer subagent-bucket.test 的等价镜像——跨包消费
//      同一 SSOT 谓词，钉住 fixture 资产不因包边界漂移）。
//
// [v2 迁移] fixture 从 v1 全量快照单条 entry 迁到 v2「注册 + 终态」两条小条目（生产
// record-entry.ts 现行唯一形态）：identity 域（agent/slug/task/startedAt/…）在 registered，
// 终局域（status='idle'/stopReason/result/endedAt/…）在 settled；同 id 后到覆盖按条目族
// 各自取末条（collectV2SubagentPair 语义）。v1 条目载体字段（closed/closedReason/resumable
// 等）无 v2 carrier，其归一断言随读面删除（见各用例注释）。

/** v2 registered 条目构造（extension record-entry.ts v2 schema 的测试镜像）：身份 + 家族链锚点 */
function subagentRegisteredEntry(data: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    data: {
      v: 2,
      kind: 'registered',
      agent: 'worker',
      slug: 'fx',
      task: 'replay',
      origin: 'tool',
      rootSessionId: 'sess-fixture-root',
      depth: 0,
      startedAt: 1000,
      ...data,
    },
  }
}

/** v2 settled 条目构造（extension record-entry.ts v2 schema 的测试镜像）：终局 + 摘要（status 两态恒 idle） */
function subagentSettledEntry(data: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    data: {
      v: 2,
      kind: 'settled',
      status: 'idle',
      turns: 1,
      totalTokens: 10,
      model: 'fixture-model',
      thinkingLevel: 'medium',
      endedAt: 2000,
      ...data,
    },
  }
}

/** 同 id 后到覆盖折叠（scanSubagentEntries 的 live 增量合并语义镜像） */
function foldBySubagentId(records: SubagentRecord[]): Map<string, SubagentRecord> {
  return new Map(records.map((r) => [r.subagentId, r]))
}

describe('[two-state-convergence U7] subagent-record 轮终翻边 entry 序列等价回放（P2）', () => {
  /** 翻边序列（v2 条目族）：注册 → 轮终终态 → 第二轮注册（revive 轮始）→ 第二轮终态。
   *  v1「同 id 全量快照后到覆盖」在 v2 由 registered / settled 各自后到覆盖表达——identity
   *  取末条 registered、终局取末条 settled，两轮翻边语义等价（终态条目出现即 idle）。 */
  const FLIP_SEQUENCE: Record<string, unknown>[] = [
    subagentRegisteredEntry({ id: 'sa-flip' }),
    // 轮终终态（v2：settled 携带 result + stopReason + endedAt）
    subagentSettledEntry({ id: 'sa-flip', result: 'round 1 output', stopReason: 'completed', endedAt: 2000 }),
    // revive / 第 2 轮轮始（v2：再写一条 registered，后到覆盖 identity 与轮始时点）
    subagentRegisteredEntry({ id: 'sa-flip', startedAt: 3000 }),
    // 第 2 轮轮终（settled 后到覆盖终局）
    subagentSettledEntry({ id: 'sa-flip', result: 'round 2 output', stopReason: 'completed', endedAt: 4000 }),
  ]

  it('翻边序列投影确定性：同序列两次全量扫描 deep-equal（D5 纯函数范式镜像）', () => {
    const first = scanSubagentEntries(FLIP_SEQUENCE)
    const second = scanSubagentEntries(FLIP_SEQUENCE)
    expect(first).toEqual(second)
  })

  it('⛔门：冷启动全量 ≡ 逐条前缀增量折叠（live ≡ replay 构造性的回归钉）', () => {
    const coldStart = foldBySubagentId(scanSubagentEntries(FLIP_SEQUENCE))
    // live：从空表开始，逐条「增量重拉」（对前缀全量扫描——同一份投影代码），折叠进缓存
    const live = new Map<string, SubagentRecord>()
    for (let k = 1; k <= FLIP_SEQUENCE.length; k++) {
      for (const rec of scanSubagentEntries(FLIP_SEQUENCE.slice(0, k))) {
        live.set(rec.subagentId, rec)
      }
      // 已见 id 的投影与冷启动终态在该前缀内的应有形态一致：
      // 该 id 最后一条 entry 落在本前缀内 → 与全量终态一致；否则保持上一增量态（不回退）
      for (const [id, rec] of live) {
        const lastIdx = findLastIndex(FLIP_SEQUENCE, (e) => (e.data as Record<string, unknown>).id === id)
        if (lastIdx < k) {
          expect(rec, `prefix=${k} id=${id}`).toEqual(coldStart.get(id))
        }
      }
    }
    // 全量收敛：live 终态 ≡ 冷启动终态
    expect([...live.entries()]).toEqual([...coldStart.entries()])
  })

  it('[v2] 注册+终态条目对投影：registered 定身份 / settled 定终局，冷启动与增量折叠一致', () => {
    const records = foldBySubagentId(scanSubagentEntries(FLIP_SEQUENCE))
    // 翻边终态（v2 正常路径：终局取末条 settled——idle + result + stopReason 直投）
    const flip = records.get('sa-flip')!
    expect(flip.status).toBe('idle')
    expect(flip.result).toBe('round 2 output')
    expect(flip.stopReason).toBe('completed')
    // identity 域取末条 registered（第二轮轮始时点），终局域取末条 settled——两族后到覆盖各自独立
    expect(flip.startedAt).toBe(3000)
    expect(flip.endedAt).toBe(4000)
  })

  it('⛔门：01a09f83 fixture 回放 badge 计数 = 0（39 形态经 v2 注册+终态条目对投影 + renderer SSOT 谓词；跨包同源消费）', () => {
    /** fixture 脱敏规格 → v2 条目对（identity 在 registered / 终局在 settled）：
     *  终态形态（idle）= 注册 + 终态两条；在飞形态（running）只有注册条目（无 settled 即投影
     *  running，badge 判据非空——规格若混入 running 形态本门即红，与 renderer P1 门同口径）。 */
    function specToEntryPair(spec: GhostFixtureSpec): Record<string, unknown>[] {
      const registered = subagentRegisteredEntry({ id: spec.aliasId })
      if (spec.status === 'running') return [registered]
      return [
        registered,
        subagentSettledEntry({
          id: spec.aliasId,
          ...(spec.hasResult ? { result: '(redacted)' } : {}),
          ...(spec.stopReason !== undefined ? { stopReason: spec.stopReason } : {}),
        }),
      ]
    }
    const entries = SESSION_01A09F83_GHOST_FIXTURE.flatMap(specToEntryPair)
    // 冷启动全量
    const cold = scanSubagentEntries(entries)
    // live 增量折叠终态
    const live = new Map<string, SubagentRecord>()
    for (let k = 1; k <= entries.length; k++) {
      for (const rec of scanSubagentEntries(entries.slice(0, k))) live.set(rec.subagentId, rec)
    }
    expect(cold).toHaveLength(39)
    expect([...live.values()]).toEqual(cold)
    // ⛔P1 门镜像：严格口径（isRunningProjection SSOT）回放 badge = 0（幽灵 8→0）
    expect(cold.filter((r) => isRunningProjection(r))).toHaveLength(0)
  })
})

// ── plan-state entry 对话流行为（plan 模式重设计 A7）──────────────────────────
//
// plan-state 是 extension appendEntry 落盘的 type:'custom' 纯数据 entry（D1 schema：旧四
// 字段 isActive/planFilePath/requirement/templateName；新七字段 + skills/docs/reviewState
// 三 optional——D4 字段级判存在兼容）。两条通路的对话流语义：
// - live：event-adapter 对任意 string customType 产出失效信号（D5 放宽）→ runtime
//   scanPlanStateEntries 派生 → stateSnapshot('plan') 独立通道——不经 message_end 进对话流
//   reducer（D1 显式决策：plan 不进 chat reducer）；
// - reload：get_entries 重放序列含 plan-state entry → reducer case 'custom' 纯数据
//   no-op（跳过语义，D6-4 死簿记删除后对所有 customType 一致），同样零对话流投影。
// 「live ≡ reload 对话流呈现一致」由「reload 侧多出的 entry 被 reducer 忽略」构造性成立，
// 本组钉住且断言新旧两种 schema 行为一致（schema 扩展不改对话流——plan 投影走独立通道）。
describe('plan-state entry：不进对话流，live ≡ reload 构造性（A7）', () => {
  // ts / piId / normalizeIds 用文件级共享 helper（见「断言基建共享 helper」区）

  /** 旧四字段 plan-state entry（JSONL 落盘形态：type:'custom'，设计 §2.1 现状实态） */
  const legacyPlanEntry: PiEntry = {
    type: 'custom',
    id: piId(21),
    parentId: null,
    timestamp: ts(1500),
    customType: 'plan-state',
    data: {
      isActive: true,
      planFilePath: '/tmp/taiji-harness/auth-plan/plan.md',
      requirement: '重构 auth 模块',
      templateName: 'refactor',
    },
  }
  /** 新七字段 plan-state entry（三 optional 字段全量：skills/docs/reviewState，D4 扩展） */
  const extendedPlanEntry: PiEntry = {
    type: 'custom',
    id: piId(22),
    parentId: null,
    timestamp: ts(2500),
    customType: 'plan-state',
    data: {
      isActive: true,
      planFilePath: '/tmp/taiji-harness/auth-plan/plan.md',
      requirement: '重构 auth 模块',
      templateName: 'refactor',
      skills: ['tech-design', 'dev-flow'],
      docs: [
        { fileName: 'design.md', absPath: '/tmp/taiji-harness/auth-plan/design.md', sourceSkill: 'tech-design', version: 1 },
        { fileName: 'impl-plan.md', absPath: '/tmp/taiji-harness/auth-plan/impl-plan.md', sourceSkill: 'dev-flow', version: 2 },
      ],
      reviewState: 'awaiting',
    },
  }

  // 对话流载体（两侧独立构造，W6 惯例）：live = message_end 重构形态（u- 前缀客户端 id、
  // 无 id 的 assistant、parentId null）；reload = pi uuidv7 id + parentId 链
  const liveChat: PiEntry[] = [
    { type: 'message', id: 'u-00000021-0000-4000-8000-000000000021', parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '进入计划模式' }], timestamp: 1000 } },
    { type: 'message', id: undefined, parentId: null, timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '已进入计划模式' }], timestamp: 2000 } },
  ]
  const reloadChat: PiEntry[] = [
    { type: 'message', id: piId(21), parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '进入计划模式' }], timestamp: 1000 } },
    { type: 'message', id: piId(22), parentId: piId(21), timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '已进入计划模式' }], timestamp: 2000 } },
  ]

  /** reload 侧完整序列：对话流载体之间插入新旧两种 schema 的 plan-state entry */
  const reloadWithPlan: PiEntry[] = [reloadChat[0]!, legacyPlanEntry, reloadChat[1]!, extendedPlanEntry]

  it('新旧两种 schema 的 plan-state entry 均不进对话流，两 schema 对话流行为一致', () => {
    const state = replayEntries(reloadWithPlan)
    // 对话流只有 message entry 的投影（plan-state 零投影：无消息行、无 customType 行）
    expect(state.messages).toHaveLength(2)
    expect(state.messages.every((m) => m.customType !== 'plan-state')).toBe(true)
    // reducer 纯函数确定性：同序列两次重放全等（expectDeterministic 同款口径，entry 形态直喂）
    expect(state).toEqual(replayEntries(reloadWithPlan))
    // schema 扩展不改对话流：只换 entry 的 data（旧 ↔ 新）终态一致
    expect(replayEntries([reloadChat[0]!, extendedPlanEntry, reloadChat[1]!, legacyPlanEntry]).messages).toEqual(state.messages)
  })

  it('live ≡ reload：live 序列（失效信号通道不进 reducer，无 plan-state）≡ reload 序列（重放含新旧 entry）', () => {
    const liveState = replayEntries(liveChat)
    const reloadState = replayEntries(reloadWithPlan)
    // reload 侧多出的 plan-state entry 被 reducer 忽略——两侧对话流归一 deep-equal（全量 state）
    expect(normalizeIds(liveState)).toEqual(normalizeIds(reloadState))
    // 对话流呈现（toRenderItems 分组：turn 边界 / 气泡）同样一致
    expect(toRenderItems(normalizeIds(liveState).messages)).toEqual(toRenderItems(normalizeIds(reloadState).messages))
  })
})

// ── pi 1.0.0 新 entry 类型（B1）：usage / context_edit / role:'system' message ──

describe('pi 1.0.0 新 entry 类型（真实样本 fixture）', () => {
  // 样本生成方式（形态权威）：pi 1.0.0 实装 dist 的 SessionManager API 落盘产物——
  // appendMessage(user) → appendMessage(assistant+usage) → appendUsage('cache_warm',...)
  // → appendMessage({role:'system'}) → appendContextEdit(...)，与 pi 写盘走同一 append* 代码
  // 路径。fixture 逐行为 pi 1.0.0 权威 JSONL 落盘形态（uuid/timestamp 为生成时点值）。
  const fixtureEntries: PiEntry[] = readFileSync(
    new URL('./__fixtures__/pi-1.0.0-new-entries.jsonl', import.meta.url),
    'utf-8',
  )
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as PiEntry)

  it('装置：fixture 含 session header + 三类新 entry（usage / context_edit / system message）', () => {
    const types = fixtureEntries.map((e) => (e as { type: string }).type)
    expect(types[0]).toBe('session')
    expect(types).toContain('usage')
    expect(types).toContain('context_edit')
    const systemMsg = fixtureEntries.find(
      (e) => (e as { type: string }).type === 'message' && (e as { message?: { role?: string } }).message?.role === 'system',
    )
    expect(systemMsg).toBeDefined()
  })

  it('三类新 entry 零对话流投影、不崩：messages 恒 user+assistant 两条，重放确定性', () => {
    const state = replayEntries(fixtureEntries)
    // usage / context_edit / system message 三类均不产对话流消息（system 与 live 侧
    // event-adapter 跳过同语义）；user/assistant 两条正常渲染
    expect(state.messages).toHaveLength(2)
    expect(state.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    // reducer 纯函数确定性：同序列两次重放全等
    expect(state).toEqual(replayEntries(fixtureEntries))
    // 对话流呈现（toRenderItems 分组）正常产出
    expect(toRenderItems(state.messages).length).toBeGreaterThan(0)
  })

  it('单独喂入 usage/context_edit entry：零投影不崩（reducer 无 case 走 default no-op）', () => {
    const onlyNew = fixtureEntries.filter((e) => {
      const t = (e as { type: string }).type
      return t === 'usage' || t === 'context_edit'
    })
    const state = replayEntries(onlyNew)
    expect(state.messages).toHaveLength(0)
  })
})

/** Array.prototype.findLastIndex 的内联实现（测试内避免对 Node 版本的库依赖） */
function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i
  return -1
}
