/**
 * applyEntry reducer 单元测试（data-source-governance W20）。
 *
 * 覆盖矩阵（w20-acceptance.md 规格锁定 4：全 entry 类型覆盖，每类型 ≥1 用例）：
 * - pi SessionEntry 全集 9 类型：message / custom / label / compaction / branch_summary /
 *   custom_message / thinking_level_change / model_change / session_info（后三者未建模 → default no-op）
 * - message entry 的 role 细分（pi AgentMessage 联合）：user / assistant / toolResult /
 *   bashExecution / compactionSummary / custom / branchSummary
 * - 确定性（D5 纯函数核心断言）：同 entry 序列两次喂入 state 全等；输入不被 mutate。
 *
 * 与 apply-entry-equivalence.test.ts 的分工：本文件断言 reducer 单体行为；
 * 等价性文件断言新旧路径（reducer vs 迁移前 convertPiHistory）deep equal。
 *
 * 运行：cd packages/core && pnpm exec vitest run src/domain/chat/__tests__/apply-entry.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { Message } from '@xyz-agent/shared'
import {
  applyEntry,
  createInitialChatViewState,
  replayEntries,
} from '../apply-entry'
import type { PiEntry, PiMessageEntry } from '../apply-entry'

/**
 * [W5] 读取 spread 保字段的 images（shared.ToolCall/Message 暂无 images 类型声明，
 * 运行时窄化后读取——断言不裸 as）。形态：Array<{ data: string; mimeType: string }>。
 */
function readImagesField(obj: object): Array<{ data: string; mimeType: string }> | undefined {
  const v = (obj as Record<string, unknown>).images
  if (!Array.isArray(v)) return undefined
  return v.map((x) => {
    const r = x as Record<string, unknown>
    return { data: String(r.data), mimeType: String(r.mimeType) }
  })
}

// ── 测试数据工厂（真实形态：ISO timestamp / parentId 链 / uuid 风格 id）──────────

function msgEntry(
  id: string,
  body: Record<string, unknown>,
  overrides?: { parentId?: string | null; timestamp?: string },
): PiMessageEntry {
  return {
    type: 'message',
    id,
    parentId: overrides?.parentId ?? null,
    timestamp: overrides?.timestamp ?? '2026-08-19T10:00:00.000Z',
    message: body,
  }
}

const ISO = (ms: number): string => new Date(ms).toISOString()

describe('applyEntry —— entry 类型逐类型覆盖', () => {
  // ── message entry：user ──────────────────────────────────────────
  it('message/user：text → role user + Segment[] content + piEntryId 回填', () => {
    const state = replayEntries([
      msgEntry('e-user-1', { role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1000 }, { timestamp: ISO(1000) }),
    ])
    expect(state.messages).toHaveLength(1)
    const m = state.messages[0]
    expect(m.role).toBe('user')
    expect(m.status).toBe('complete')
    expect(m.timestamp).toBe(1000)
    expect(m.content).toEqual([{ type: 'text', text: '你好' }])
    expect(m.piEntryId).toBe('e-user-1')
  })

  it('message/user：skill block 剖离为 skill segment + 余文 text segment', () => {
    const state = replayEntries([
      msgEntry('e-user-2', {
        role: 'user',
        content: [{ type: 'text', text: '<skill name="code-review" location="/abs/SKILL.md">body</skill>do it' }],
        timestamp: 1000,
      }),
    ])
    expect(state.messages[0].content).toEqual([
      { type: 'skill', name: 'code-review', location: '/abs/SKILL.md' },
      { type: 'text', text: 'do it' },
    ])
  })

  it('message/user：[簇 A2] defer flush 确认标记剥除——投影片段不含实现标记（live 帧 / reload 重放同点）', () => {
    // flush 提交文本尾附加 `<!--xyz:msg:<entry.id>-->`（user-delivery ①a 身份通道），pi 落盘
    // entry 带标记 → 投影层单点剥除：live reducer 喂入与重开 replay 同经 convertMessageBody
    // → 对话流不暴露标记，且剥后文本 = confirmDelivery overlay 文本（文本去重命中不双计）。
    const state = replayEntries([
      msgEntry('e-user-dm1', {
        role: 'user',
        content: [{ type: 'text', text: '排队消息正文\n<!--xyz:msg:3f2504e0-4f89-41d3-9a0c-0305e82c3301-->' }],
        timestamp: 1000,
      }),
    ])
    expect(state.messages[0].content).toEqual([{ type: 'text', text: '排队消息正文' }])
  })

  it('message/user：[簇 A2] skill 展开文本 + 尾部确认标记——标记剥除不破坏 skill block 剖离', () => {
    // 改写场景（skill-injector 展开拼接把标记推到文本尾）：剥标记与 skill 反解析的叠加
    const state = replayEntries([
      msgEntry('e-user-dm2', {
        role: 'user',
        content: [{ type: 'text', text: '<skill name="review" location="/abs/SKILL.md">body</skill>\n\n帮我审查\n<!--xyz:msg:3f2504e0-4f89-41d3-9a0c-0305e82c3301-->' }],
        timestamp: 1000,
      }),
    ])
    expect(state.messages[0].content).toEqual([
      { type: 'skill', name: 'review', location: '/abs/SKILL.md' },
      { type: 'text', text: '帮我审查' },
    ])
  })

  // ── 两形态反解析（D7 兜底通道，composer 多 skill 注入 u3）──────────────────────
  // 反解析 SSOT = apply-entry-convert parseSkillBlock（live 帧 / 历史重建 / 文件重放
  // 三链路共用）。形态① xyz 私有标记（本设计序列化产物）、形态② pi 原生 block（存量）。
  it('message/user：xyz 私有标记混排中文正文——标记前后正文全保留为交错 segments（专防前置正文丢失回归）', () => {
    const state = replayEntries([
      msgEntry('e-user-mk1', {
        role: 'user',
        content: [{ type: 'text', text: '帮我<xyz-skill name="code-review" location="/abs/SKILL.md"/>审查这段代码' }],
        timestamp: 1000,
      }),
    ])
    expect(state.messages[0].content).toEqual([
      { type: 'text', text: '帮我' },
      { type: 'skill', name: 'code-review', location: '/abs/SKILL.md' },
      { type: 'text', text: '审查这段代码' },
    ])
  })

  it('message/user：xyz 多标记 + 首尾正文——全部还原且正文无丢失', () => {
    const state = replayEntries([
      msgEntry('e-user-mk2', {
        role: 'user',
        content: [{ type: 'text', text: '前置<xyz-skill name="a"/><xyz-skill name="b" location="/b/SKILL.md"/>后置' }],
        timestamp: 1000,
      }),
    ])
    expect(state.messages[0].content).toEqual([
      { type: 'text', text: '前置' },
      { type: 'skill', name: 'a' },
      { type: 'skill', name: 'b', location: '/b/SKILL.md' },
      { type: 'text', text: '后置' },
    ])
  })

  it('message/user：xyz 降级块夹正文——块整体还原为各 skill segment，块前后正文保留、指引行不作正文残留', () => {
    // 块形态 = buildSkillsFallbackBlock 产物（SSOT 构建 + 手写锚定格式双保险；指引行
    // C5 改英文）：
    // <xyz-skills>\n<标记行…/>\n</xyz-skills>\nUse the read tool to load the skill files above before continuing the task
    const state = replayEntries([
      msgEntry('e-user-mk3', {
        role: 'user',
        content: [{
          type: 'text',
          text: '正文开始\n<xyz-skills>\n<xyz-skill name="a" location="/a/SKILL.md"/>\n<xyz-skill name="b"/>\n</xyz-skills>\nUse the read tool to load the skill files above before continuing the task\n正文结束',
        }],
        timestamp: 1000,
      }),
    ])
    expect(state.messages[0].content).toEqual([
      { type: 'text', text: '正文开始\n' },
      { type: 'skill', name: 'a', location: '/a/SKILL.md' },
      { type: 'skill', name: 'b' },
      { type: 'text', text: '\n正文结束' },
    ])
  })

  it('message/user：空正文纯标记消息——产出纯 skill segment 无 text（u3 断言④）', () => {
    const state = replayEntries([
      msgEntry('e-user-mk4', {
        role: 'user',
        content: [{ type: 'text', text: '<xyz-skill name="solo" location="/s/SKILL.md"/>' }],
        timestamp: 1000,
      }),
    ])
    expect(state.messages[0].content).toEqual([{ type: 'skill', name: 'solo', location: '/s/SKILL.md' }])
  })

  it('message/user：存量 pi 原生格式回归等价（场景 4⑤）——block 前置 + \\n\\nargs 在后 → [skill, args-text]', () => {
    const state = replayEntries([
      msgEntry('e-user-pi1', {
        role: 'user',
        content: [{ type: 'text', text: '<skill name="code-review" location="/abs/SKILL.md">skill body</skill>\n\ndo the thing with args' }],
        timestamp: 1000,
      }),
    ])
    expect(state.messages[0].content).toEqual([
      { type: 'skill', name: 'code-review', location: '/abs/SKILL.md' },
      { type: 'text', text: 'do the thing with args' },
    ])
    // 无 args 纯 block：单 skill segment（升级前 match[3].trim() 空串不产 text 的等价形态）
    const solo = replayEntries([
      msgEntry('e-user-pi2', {
        role: 'user',
        content: [{ type: 'text', text: '<skill name="x">body</skill>' }],
        timestamp: 1000,
      }),
    ])
    expect(solo.messages[0].content).toEqual([{ type: 'skill', name: 'x' }])
  })

  it('message/user：pi block 前正文保留（升级前该场景正文直接丢，缺陷修复）', () => {
    const state = replayEntries([
      msgEntry('e-user-pi3', {
        role: 'user',
        content: [{ type: 'text', text: '看看这个<skill name="x">body</skill>\n\nargs 部分' }],
        timestamp: 1000,
      }),
    ])
    expect(state.messages[0].content).toEqual([
      { type: 'text', text: '看看这个' },
      { type: 'skill', name: 'x' },
      { type: 'text', text: 'args 部分' },
    ])
  })

  it('message/user：两形态同文优先级——xyz 标记与 pi block 共存时按位置交错全还原（顺序锁定）', () => {
    const state = replayEntries([
      msgEntry('e-user-mix', {
        role: 'user',
        content: [{ type: 'text', text: '前<xyz-skill name="a"/><skill name="b">body</skill>\n\nargs' }],
        timestamp: 1000,
      }),
    ])
    expect(state.messages[0].content).toEqual([
      { type: 'text', text: '前' },
      { type: 'skill', name: 'a' },
      { type: 'skill', name: 'b' },
      { type: 'text', text: 'args' },
    ])
    // 降级块优先级：块内嵌套标记由块整体消费，不二次命中（无重复 segment、无标记文本残留）
    const nested = replayEntries([
      msgEntry('e-user-mix2', {
        role: 'user',
        content: [{ type: 'text', text: '<xyz-skills>\n<xyz-skill name="a" location="/a/SKILL.md"/>\n</xyz-skills>\nUse the read tool to load the skill files above before continuing the task' }],
        timestamp: 1000,
      }),
    ])
    expect(nested.messages[0].content).toEqual([{ type: 'skill', name: 'a', location: '/a/SKILL.md' }])
  })

  it('message/user：手打残缺/错序标记不还原（D8 透传语义——反解析不宽松）', () => {
    const state = replayEntries([
      msgEntry('e-user-broken', {
        role: 'user',
        content: [{ type: 'text', text: '正文 <xyz-skill name="a" 讨论标记语法' }],
        timestamp: 1000,
      }),
    ])
    // 无命中 → 整条消息纯 text（textToSegments 回退，与升级前行为一致）
    expect(state.messages[0].content).toEqual([{ type: 'text', text: '正文 <xyz-skill name="a" 讨论标记语法' }])
    // 属性顺序错乱（location 在前）不识别——u1 解析器固定 name → location 顺序
    const wrongOrder = replayEntries([
      msgEntry('e-user-broken2', {
        role: 'user',
        content: [{ type: 'text', text: '<xyz-skill location="/x" name="a"/>' }],
        timestamp: 1000,
      }),
    ])
    expect(wrongOrder.messages[0].content).toEqual([{ type: 'text', text: '<xyz-skill location="/x" name="a"/>' }])
  })

  it('message/user：content 含 image part → images 保字段不丢（W5，pi UserMessage content 可含 ImageContent）', () => {
    const state = replayEntries([
      msgEntry('e-user-img', {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image', data: 'YmFzZTY0', mimeType: 'image/jpeg' },
          { type: 'image', data: '', mimeType: '' }, // 双空块过滤
        ],
        timestamp: 1000,
      }),
    ])
    expect(state.messages).toHaveLength(1)
    const m = state.messages[0]
    // text part 正常转 Segment（image 不混入文本）
    expect(m.content).toEqual([{ type: 'text', text: '看这张图' }])
    // image part → images 运行时字段（shared.Message 暂无类型声明，spread 保字段）
    expect(readImagesField(m)).toEqual([{ data: 'YmFzZTY0', mimeType: 'image/jpeg' }])
  })

  it('message/user：无 image part → 不设 images 字段（既有消息形态不变）', () => {
    const state = replayEntries([
      msgEntry('e-user-plain', { role: 'user', content: [{ type: 'text', text: '纯文本' }], timestamp: 1000 }),
    ])
    expect(readImagesField(state.messages[0])).toBeUndefined()
    expect('images' in state.messages[0]).toBe(false)
  })

  // ── message entry：assistant ─────────────────────────────────────
  it('message/assistant：thinking+toolCall+text parts → contentBlocks 顺序 / toolCalls / usage / fileChanges', () => {
    const state = replayEntries([
      msgEntry('e-asst-1', {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先思考' },
          { type: 'toolCall', id: 'tc-1', name: 'write', arguments: { path: '/a.ts' } },
          { type: 'toolCall', id: 'tc-2', name: 'edit', arguments: { file_path: '/b.ts' } },
          { type: 'text', text: '结论' },
        ],
        usage: { input: 120, output: 80 },
        timestamp: 2000,
      }),
    ])
    const m = state.messages[0]
    expect(m.role).toBe('assistant')
    expect(m.content).toBe('结论')
    expect(m.thinking).toEqual([{ id: 'e-asst-1-th0', content: '先思考', collapsed: true }])
    expect(m.contentBlocks?.map((b) => b.type)).toEqual(['thinking', 'toolCall', 'toolCall', 'text'])
    expect(m.contentBlocks?.[1]).toEqual({ type: 'toolCall', refId: 'tc-1', contentIndex: 1 })
    expect(m.toolCalls).toEqual([
      { id: 'tc-1', toolName: 'write', input: { path: '/a.ts' }, status: 'completed', startTime: 2000 },
      { id: 'tc-2', toolName: 'edit', input: { file_path: '/b.ts' }, status: 'completed', startTime: 2000 },
    ])
    expect(m.usage).toEqual({ inputTokens: 120, outputTokens: 80 })
    // write/edit 静态提取（历史无 cwd：一律 modified）
    expect(m.fileChanges).toEqual([
      { filePath: '/a.ts', status: 'modified' },
      { filePath: '/b.ts', status: 'modified' },
    ])
  })

  // ── message entry：toolResult ────────────────────────────────────
  it('message/toolResult：回填到 preceding assistant 的匹配 toolCall（output/outputRaw/isError/details）', () => {
    const state = replayEntries([
      msgEntry('e-asst-2', {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-x', name: 'bash', arguments: { command: 'ls' } }],
        timestamp: 1000,
      }),
      msgEntry('e-tr-1', {
        role: 'toolResult',
        toolCallId: 'tc-x',
        toolName: 'bash',
        isError: true,
        content: [{ type: 'text', text: '\x1b[31mfailed\x1b[0m' }],
        details: { __gui__: { v: 1 } },
        timestamp: 2000,
      }),
    ])
    expect(state.messages).toHaveLength(1)
    const tc = state.messages[0].toolCalls![0]
    expect(tc.output).toBe('failed') // stripAnsi 版本
    expect(tc.outputRaw).toBe('\x1b[31mfailed\x1b[0m') // 原始 ANSI
    expect(tc.status).toBe('error')
    expect(tc.details).toEqual({ __gui__: { v: 1 } })
  })

  it('message/toolResult：content 含 image 块 → 回填 images（W5 live≡replay，对齐 runtime 版语义）', () => {
    const state = replayEntries([
      msgEntry('e-asst-img', {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-img', name: 'read', arguments: { path: 'a.png' } }],
        timestamp: 1000,
      }),
      msgEntry('e-tr-img', {
        role: 'toolResult',
        toolCallId: 'tc-img',
        toolName: 'read',
        content: [
          { type: 'text', text: 'screenshot' },
          { type: 'image', data: 'aWNn', mimeType: 'image/png' },
          { type: 'image', data: '', mimeType: '' }, // 双空块过滤（对齐 runtime 版）
        ],
        timestamp: 2000,
      }),
    ])
    expect(state.messages).toHaveLength(1)
    const tc = state.messages[0].toolCalls![0]
    // output 只含 text join（image 不混入文本，与 runtime normalizePiToolResult 逐字对齐）
    expect(tc.output).toBe('screenshot')
    expect(tc.status).toBe('completed')
    expect(readImagesField(tc)).toEqual([{ data: 'aWNn', mimeType: 'image/png' }])
  })

  it('message/toolResult：纯 text content → 不设 images 字段（既有回填形态不变）', () => {
    const state = replayEntries([
      msgEntry('e-asst-plain', {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-plain', name: 'read', arguments: { path: 'x' } }],
        timestamp: 1000,
      }),
      msgEntry('e-tr-plain', {
        role: 'toolResult',
        toolCallId: 'tc-plain',
        toolName: 'read',
        content: [{ type: 'text', text: 'ok' }],
        timestamp: 2000,
      }),
    ])
    const tc = state.messages[0].toolCalls![0]
    expect(readImagesField(tc)).toBeUndefined()
    expect('images' in tc).toBe(false)
  })

  it('message/toolResult：窗口内无 preceding assistant → 收集为孤儿不产消息', () => {
    const state = replayEntries([
      msgEntry('e-tr-orphan', {
        role: 'toolResult',
        toolCallId: 'tc-none',
        toolName: 'read',
        content: [{ type: 'text', text: 'out' }],
        timestamp: 1000,
      }),
    ])
    expect(state.messages).toHaveLength(0)
    expect(state.orphanToolResults).toEqual([
      { role: 'toolResult', toolCallId: 'tc-none', toolName: 'read', content: [{ type: 'text', text: 'out' }], timestamp: 1000 },
    ])
  })

  // ── [R2-S1 双入口幂等] pi 0.84.1 对同一 toolResult 双发 tool_execution_end +
  // message_end{role:'toolResult'} 两事件 → 两条帧各喂 reducer 一次。deliveredToolResultIds
  // 簿记保证双喂入 ≡ 单喂入（第二条同 id 帧整体 no-op，保留首条版本）。
  it('message/toolResult：同 toolCallId 二次投递 no-op（幂等去重：不重放回填、孤儿不重复收集、保留首条版本）', () => {
    const base = [
      msgEntry('e-asst-dup', {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-dup', name: 'read', arguments: { path: '/x' } }],
        timestamp: 1000,
      }),
    ]
    const first = applyEntry(
      replayEntries(base),
      msgEntry('e-tr-dup-1', {
        role: 'toolResult',
        toolCallId: 'tc-dup',
        toolName: 'read',
        content: [{ type: 'text', text: 'first-version' }],
        timestamp: 2000,
      }),
    )
    expect(first.messages[0].toolCalls![0].output).toBe('first-version')

    // 第二条同 id 帧（message_end 载体，内容版本不同）：内容不重放回填
    //（保留首条版本）；endTime 例外走 U3 last-wins（见下方断言）；簿记集合引用不变
    const messagesBefore = first.messages
    const deliveredBefore = first.deliveredToolResultIds
    const second = applyEntry(
      first,
      msgEntry('e-tr-dup-2', {
        role: 'toolResult',
        toolCallId: 'tc-dup',
        toolName: 'read',
        content: [{ type: 'text', text: 'second-version-loses' }],
        timestamp: 3000,
      }),
    )
    expect(second.messages[0].toolCalls![0].output).toBe('first-version')
    // [chat-flow-timestamp U3] endTime last-wins：第二帧（权威 pi 时刻）覆盖首条客户端时钟；
    // 其余字段保持首条。覆盖产新 message 引用（copy-on-write：输入零污染，其余元素保引用）
    expect(second.messages[0].toolCalls![0].endTime).toBe(3000)
    expect(second.messages).not.toBe(messagesBefore)
    expect(second.messages.length).toBe(messagesBefore.length)
    expect(second.deliveredToolResultIds).toBe(deliveredBefore)
    expect(second.orphanToolResults).toHaveLength(0)

    // 孤儿分支同款幂等：窗口内无匹配时首投收集孤儿，同 id 二投不再重复收集
    const orphanFirst = applyEntry(
      createInitialChatViewState(),
      msgEntry('e-tr-orphan-1', {
        role: 'toolResult',
        toolCallId: 'tc-orphan',
        toolName: 'read',
        content: [{ type: 'text', text: 'out' }],
        timestamp: 1000,
      }),
    )
    expect(orphanFirst.orphanToolResults).toHaveLength(1)
    const orphanSecond = applyEntry(
      orphanFirst,
      msgEntry('e-tr-orphan-2', {
        role: 'toolResult',
        toolCallId: 'tc-orphan',
        toolName: 'read',
        content: [{ type: 'text', text: 'out-again' }],
        timestamp: 2000,
      }),
    )
    expect(orphanSecond.orphanToolResults).toHaveLength(1)
    expect(orphanSecond.orphanToolResults[0].content).toEqual([{ type: 'text', text: 'out' }])
  })

  it('message/toolResult：无 toolCallId 的畸形 body 无键可去重——每次投递都收集为孤儿（原语义保留）', () => {
    const mkOrphan = (id: string) => msgEntry(id, {
      role: 'toolResult',
      toolName: 'read',
      content: [{ type: 'text', text: 'no-call-id' }],
      timestamp: 1000,
    })
    const state = replayEntries([mkOrphan('e-tr-noid-1'), mkOrphan('e-tr-noid-2')])
    // 无 toolCallId 不进 deliveredToolResultIds（无键可去重）→ 两条都收集，不静默丢数据
    expect(state.messages).toHaveLength(0)
    expect(state.orphanToolResults).toHaveLength(2)
    expect(state.deliveredToolResultIds.size).toBe(0)
  })

  // ── message entry：bashExecution role ────────────────────────────
  it('message/bashExecution：→ system 消息，bashExecution 字段完整映射，exitCode undefined → null', () => {
    const state = replayEntries([
      msgEntry('e-bash-1', {
        role: 'bashExecution',
        command: 'git status',
        output: 'clean',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        fullOutputPath: '/tmp/full.log',
        timestamp: 3000,
      }),
      msgEntry('e-bash-2', {
        role: 'bashExecution',
        command: 'x',
        output: '',
        cancelled: true,
        truncated: false,
        timestamp: 3100,
      }),
    ])
    expect(state.messages).toHaveLength(2)
    const [b1, b2] = state.messages
    expect(b1.role).toBe('system')
    expect(b1.bashExecution).toEqual({
      command: 'git status',
      output: 'clean',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: true,
      timestamp: 3000,
      fullOutputPath: '/tmp/full.log',
    })
    expect(b2.bashExecution!.exitCode).toBeNull() // 防 JSON 丢值
    expect(b2.bashExecution!.cancelled).toBe(true)
    expect(b2.bashExecution!.excludeFromContext).toBe(false) // 缺失归一 false
  })

  // ── message entry：特殊 role（与专用 entry 类型双形态存储）──────────
  it('message/compactionSummary role：→ system 消息 + compactionSummary 字段', () => {
    const state = replayEntries([
      msgEntry('e-cs-1', { role: 'compactionSummary', summary: '压缩摘要', tokensBefore: 10000, timestamp: 123 }, { timestamp: ISO(123) }),
    ])
    const m = state.messages[0]
    expect(m.role).toBe('system')
    expect(m.content).toBe('压缩摘要')
    expect(m.compactionSummary).toEqual({ summary: '压缩摘要', tokensBefore: 10000, timestamp: 123 })
  })

  it('message/custom role：→ system 消息 + customType/details/display 透传（不覆写）', () => {
    const state = replayEntries([
      msgEntry('e-cm-1', {
        role: 'custom',
        customType: 'subagent-bg-notify',
        content: 'done',
        details: { id: 'job-1', status: 'done' },
        display: true,
        timestamp: 1000,
      }),
    ])
    const m = state.messages[0]
    expect(m.role).toBe('system')
    expect(m.customType).toBe('subagent-bg-notify')
    expect(m.details).toEqual({ id: 'job-1', status: 'done' })
    // message-role 形态不覆写 display（覆写归 custom_message entry case，mapSessionEntries 同规则）
    expect(m.display).toBe(true)
  })

  it('message/branchSummary role：→ system 消息 + branchSummary 字段', () => {
    const state = replayEntries([
      msgEntry('e-bs-1', { role: 'branchSummary', summary: '分支摘要', fromId: 'msg-abc', timestamp: 456 }, { timestamp: ISO(456) }),
    ])
    const m = state.messages[0]
    expect(m.role).toBe('system')
    expect(m.content).toBe('分支摘要')
    expect(m.branchSummary).toEqual({ summary: '分支摘要', fromId: 'msg-abc', timestamp: 456 })
  })

  // ── custom entry（纯数据，不进对话流）─────────────────────────────
  it('custom entry：xyz.client-msg-id → clientUuidMap 累积', () => {
    const state = replayEntries([
      { type: 'custom', id: 'c-1', parentId: null, timestamp: ISO(1), customType: 'xyz.client-msg-id', data: { clientUuid: 'u-1', userEntryId: 'e-user-1' } },
    ])
    expect(state.messages).toHaveLength(0)
    expect(state.clientUuidMap.get('e-user-1')).toBe('u-1')
  })

  it('custom entry：data 形状不匹配（缺字段/类型错）→ 跳过不崩溃', () => {
    const state = replayEntries([
      { type: 'custom', id: 'c-2', parentId: null, timestamp: ISO(2), customType: 'xyz.client-msg-id', data: { clientUuid: 123 } },
      { type: 'custom', id: 'c-3', parentId: null, timestamp: ISO(3), customType: 'other.extension', data: { foo: 'bar' } },
    ])
    expect(state.clientUuidMap.size).toBe(0)
    expect(state.messages).toHaveLength(0)
  })

  it('custom entry：同 userEntryId 冲突 later-wins', () => {
    const state = replayEntries([
      { type: 'custom', id: 'c-4', parentId: null, timestamp: ISO(4), customType: 'xyz.client-msg-id', data: { clientUuid: 'u-a', userEntryId: 'e-x' } },
      { type: 'custom', id: 'c-5', parentId: null, timestamp: ISO(5), customType: 'xyz.client-msg-id', data: { clientUuid: 'u-b', userEntryId: 'e-x' } },
    ])
    expect(state.clientUuidMap.get('e-x')).toBe('u-b')
  })

  // ── label entry ──────────────────────────────────────────────────
  it('label entry：显式 no-op——state 引用不变（不丢弃、不崩溃、不产消息）', () => {
    const initial = createInitialChatViewState()
    const afterUser = applyEntry(initial, msgEntry('e-l-1', { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }))
    const afterLabel = applyEntry(afterUser, {
      type: 'label', id: 'l-1', parentId: 'e-l-1', timestamp: ISO(2), label: 'bookmark', targetId: 'e-l-1',
    })
    expect(afterLabel).toBe(afterUser) // 同一引用：纯 no-op
    expect(afterLabel.messages).toHaveLength(1)
  })

  // ── compaction entry（专用形态）──────────────────────────────────
  it('compaction entry：→ system 消息 + compactionSummary 字段（可重开恢复，关键规则 9）', () => {
    const state = replayEntries([
      { type: 'compaction', id: 'cp-1', parentId: null, timestamp: ISO(777), summary: '压缩了', tokensBefore: 5000 },
    ])
    expect(state.messages).toHaveLength(1)
    const m = state.messages[0]
    expect(m.role).toBe('system')
    expect(m.content).toBe('压缩了')
    expect(m.compactionSummary).toEqual({ summary: '压缩了', tokensBefore: 5000, timestamp: 777 })
    expect(m.timestamp).toBe(777)
  })

  // ── branch_summary entry（专用形态）──────────────────────────────
  it('branch_summary entry：→ system 消息 + branchSummary 字段', () => {
    const state = replayEntries([
      { type: 'branch_summary', id: 'br-1', parentId: null, timestamp: ISO(888), fromId: 'node-9', summary: '分支摘要' },
    ])
    expect(state.messages).toHaveLength(1)
    const m = state.messages[0]
    expect(m.content).toBe('分支摘要')
    expect(m.branchSummary).toEqual({ summary: '分支摘要', fromId: 'node-9', timestamp: 888 })
  })

  // ── custom_message entry（专用形态）──────────────────────────────
  it('custom_message entry：→ system 消息 + customType/content/details/display', () => {
    const state = replayEntries([
      {
        type: 'custom_message', id: 'cmb-1', parentId: null, timestamp: ISO(999),
        customType: 'goal-context', content: '<goal_context>x</goal_context>', display: false, details: { k: 1 },
      },
    ])
    const m = state.messages[0]
    expect(m.role).toBe('system')
    expect(m.customType).toBe('goal-context')
    expect(m.content).toBe('<goal_context>x</goal_context>')
    expect(m.details).toEqual({ k: 1 })
    expect(m.display).toBe(false)
  })

  it('custom_message entry：完成通知类 customType（COMPLETE_NOTIFY_CUSTOM_TYPES）display 覆写 false', () => {
    const state = replayEntries([
      {
        type: 'custom_message', id: 'cmb-2', parentId: null, timestamp: ISO(1000),
        customType: 'subagent-bg-notify', content: 'done', display: true,
      },
    ])
    // pi 可能持久化 display:true，xyz-agent 统一隐藏（mapSessionEntries 同 SSOT 规则）
    expect(state.messages[0].display).toBe(false)
  })

  // ── 未建模 entry 类型（default no-op，规则 #9 不丢弃）──────────────
  it('未建模类型 thinking_level_change / model_change / session_info：no-op 不崩溃不产消息', () => {
    // 这三个类型不在 xyz-agent 建模联合内（pi session-manager.ts SessionEntry 全集成员），
    // 通过结构形态直接喂入以覆盖 default 分支——reducer 对未建模类型静默跳过且不中断重放
    const unmodeled = [
      { type: 'thinking_level_change', id: 't1', parentId: null, timestamp: ISO(1), thinkingLevel: 'high' },
      { type: 'model_change', id: 't2', parentId: null, timestamp: ISO(2), provider: 'p', modelId: 'm' },
      { type: 'session_info', id: 't3', parentId: null, timestamp: ISO(3), name: 'n' },
      { type: 'future_unknown_type', id: 't4', parentId: null, timestamp: ISO(4) },
    ] as unknown as PiEntry[]
    const state = replayEntries(unmodeled)
    expect(state.messages).toHaveLength(0)
    expect(state).toEqual(createInitialChatViewState())
  })
})

describe('applyEntry —— 确定性（D5 纯函数断言）', () => {
  /** 混合真实形态序列：custom 映射 + user + assistant(toolCalls+usage) + toolResult 回填 + bash + compaction */
  function mixedSequence(): PiEntry[] {
    return [
      { type: 'custom', id: 'c-1', parentId: null, timestamp: ISO(1), customType: 'xyz.client-msg-id', data: { clientUuid: 'u-1', userEntryId: 'e-1' } },
      msgEntry('e-1', { role: 'user', content: [{ type: 'text', text: '问题' }], timestamp: 100 }, { timestamp: ISO(100) }),
      msgEntry('e-2', {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '推理' },
          { type: 'toolCall', id: 'tc-1', name: 'write', arguments: { path: '/x.ts' } },
          { type: 'toolCall', id: 'tc-2', name: 'read', arguments: { path: '/y.ts' } },
        ],
        usage: { input: 10, output: 5 },
        timestamp: 200,
      }, { parentId: 'e-1', timestamp: ISO(200) }),
      msgEntry('e-3', { role: 'toolResult', toolCallId: 'tc-1', toolName: 'write', content: [{ type: 'text', text: 'ok' }], timestamp: 300 }, { parentId: 'e-2', timestamp: ISO(300) }),
      msgEntry('e-4', { role: 'bashExecution', command: 'ls', output: 'a', exitCode: 0, cancelled: false, truncated: false, timestamp: 400 }, { parentId: 'e-3', timestamp: ISO(400) }),
      { type: 'compaction', id: 'e-5', parentId: 'e-4', timestamp: ISO(500), summary: 's', tokensBefore: 1 },
    ]
  }

  it('同 entry 序列两次喂入 → state 全等（messages/clientUuidMap/orphan 全部）', () => {
    const a = replayEntries(mixedSequence())
    const b = replayEntries(mixedSequence())
    expect(a).toEqual(b)
    // 消息 id 也是确定性的（entry 派生，非 randomUUID）——两次产出逐字相等
    expect(a.messages.map((m: Message) => m.id)).toEqual(b.messages.map((m: Message) => m.id))
  })

  it('applyEntry 不 mutate 输入 state（copy-on-write）', () => {
    const state = replayEntries(mixedSequence())
    const snapshot = structuredClone(state)
    // 在已含 toolCalls 的 state 上追加一条 toolResult（触发回填 copy-on-write 路径）。
    // [R2-S1] toolCallId 必须用未投递过的（'tc-2'）：同 id 二次投递已被
    // deliveredToolResultIds 幂等去重（no-op，不再走回填路径）。
    const next = applyEntry(state, msgEntry('e-6', { role: 'toolResult', toolCallId: 'tc-2', toolName: 'read', content: [{ type: 'text', text: 'again' }], timestamp: 600 }, { parentId: 'e-5', timestamp: ISO(600) }))
    expect(state).toEqual(snapshot) // 原 state 深度不变
    expect(next.messages[1].toolCalls![1].output).toBe('again') // 新 state 可见回填
  })

  it('无 entry.id 的 entry：确定性派生 id（两次相同）且 piEntryId 不回填', () => {
    const entry: PiMessageEntry = {
      type: 'message',
      parentId: null,
      timestamp: ISO(1000),
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000 },
    }
    const a = replayEntries([entry])
    const b = replayEntries([entry])
    expect(a.messages[0].id).toBe('e0') // 下标派生
    expect(a.messages[0].piEntryId).toBeUndefined() // 无真实 entry id 不回填
    expect(a).toEqual(b)
  })
})

// ═══════════════════════════════════════════════════════════════
// [u4d-truncated-ui] D3 push 截断占位文案的 reducer 归一（crash-resilience §3.3 D3/D4）
// ═══════════════════════════════════════════════════════════════
describe('applyEntry —— u4a push 截断占位 content 数组归一（需求④：正常渲染无特殊处理）', () => {
  const PLACEHOLDER = '内容过大（32.0 MB）已在传输层截断，完整内容见 session 文件：/tmp/s.jsonl'

  it('assistant 定稿 content 被截断为 [{type:text,text:占位}] → 归一为占位字符串（text 渲染链路直接可用）', () => {
    const state = replayEntries([
      msgEntry(
        'e-a-1',
        { role: 'assistant', content: [{ type: 'text', text: PLACEHOLDER }], timestamp: 1000 },
        { timestamp: ISO(1000) },
      ),
    ])
    expect(state.messages).toHaveLength(1)
    const m = state.messages[0]
    expect(m.role).toBe('assistant')
    // content 数组按既有宽形态归一走 text part 累积 → Message.content = 占位字符串
    expect(m.content).toBe(PLACEHOLDER)
  })

  it('user entry content 被截断为 [{type:text,text:占位}] → Segment[] 含占位 text 段（UserBubble 文本分支）', () => {
    const state = replayEntries([
      msgEntry('e-u-1', { role: 'user', content: [{ type: 'text', text: PLACEHOLDER }], timestamp: 1000 }, { timestamp: ISO(1000) }),
    ])
    const m = state.messages[0]
    expect(m.role).toBe('user')
    expect(m.content).toEqual([{ type: 'text', text: PLACEHOLDER }])
  })
})
