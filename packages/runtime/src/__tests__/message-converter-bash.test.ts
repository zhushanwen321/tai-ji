/**
 * message-converter bashExecution 分支测试（composer-bash-execute W1）。
 *
 * 锁定 convertPiHistory 的 bashExecution 分支：
 * - role:'bashExecution' → 转成 role:'system' + bashExecution 字段的 Message（W3 WC5：bash 是元信息非用户输入）
 * - exitCode undefined → null（防 JSON 丢值，与 dispatcher 广播时 ?? null 对称）
 * - excludeFromContext 透传（!! 归一为 boolean）
 *
 * 对应 AGENTS.md 关键规则 9 持久化链路：重开 session 时 bash 执行记录经此分支还原为
 * 带 bashExecution 字段的 system 消息，前端统一走 BashOutputBlock 渲染（与实时 effect 路径一致）。
 *
 * 运行：npx vitest run src/__tests__/message-converter-bash.test.ts
 */
import { describe, it, expect } from 'vitest'
import { convertPiHistory } from '../infra/pi/message-converter.js'

// bashExecution entry 的最小结构（与 pi get_messages 返回结构对齐）
interface PiBashExecutionEntry {
  role: 'bashExecution'
  command: string
  output: string
  exitCode?: number
  cancelled: boolean
  truncated: boolean
  excludeFromContext?: boolean
  timestamp: number
}

describe('convertPiHistory —— bashExecution 分支（W1 持久化链路）', () => {
  // T9: 完整字段映射
  it('T9: bashExecution entry → 1 条 system Message，bashExecution 字段完整映射', () => {
    const entry: PiBashExecutionEntry = {
      role: 'bashExecution',
      command: 'ls',
      output: 'a\nb\n',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
      timestamp: 123,
    }
    const messages = convertPiHistory([entry])

    expect(messages).toHaveLength(1)
    const msg = messages[0]
    expect(msg.role).toBe('system')
    expect(msg.content).toBe('')
    expect(msg.status).toBe('complete')
    // bashExecution 完整字段
    expect(msg.bashExecution).toBeDefined()
    expect(msg.bashExecution!.command).toBe('ls')
    expect(msg.bashExecution!.output).toBe('a\nb\n')
    expect(msg.bashExecution!.exitCode).toBe(0)
    expect(msg.bashExecution!.cancelled).toBe(false)
    expect(msg.bashExecution!.truncated).toBe(false)
    expect(msg.bashExecution!.timestamp).toBe(123)
  })

  // T10: exitCode undefined → null（防 JSON 丢值）
  it('T10: exitCode undefined → bashExecution.exitCode === null（不是 undefined，防 JSON 丢值）', () => {
    const entry: PiBashExecutionEntry = {
      role: 'bashExecution',
      command: 'x',
      output: '',
      exitCode: undefined,
      cancelled: true,
      truncated: false,
      timestamp: 1,
    }
    const messages = convertPiHistory([entry])
    expect(messages[0].bashExecution!.exitCode).toBeNull()
    // cancelled 仍透传
    expect(messages[0].bashExecution!.cancelled).toBe(true)
  })

  // T11: excludeFromContext=true 透传
  it('T11: excludeFromContext=true → bashExecution.excludeFromContext === true', () => {
    const entry: PiBashExecutionEntry = {
      role: 'bashExecution',
      command: 'secret',
      output: '',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: true,
      timestamp: 5,
    }
    const messages = convertPiHistory([entry])
    expect(messages[0].bashExecution!.excludeFromContext).toBe(true)
  })

  // T12: excludeFromContext 未提供（undefined）→ 归一为 false（!!bm.excludeFromContext）
  it('T12: excludeFromContext 未提供 → 归一为 false（默认）', () => {
    const entry = {
      role: 'bashExecution',
      command: 'pwd',
      output: '/x',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      // excludeFromContext 缺失
      timestamp: 9,
    } as PiBashExecutionEntry
    const messages = convertPiHistory([entry])
    expect(messages[0].bashExecution!.excludeFromContext).toBe(false)
  })

  // T13: bashExecution entry 与普通 user message 混合——顺序与互不干扰
  it('T13: bashExecution 与 user message 混合，各自转换不串扰', () => {
    const messages = convertPiHistory([
      {
        role: 'bashExecution',
        command: 'echo hi',
        output: 'hi\n',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 100,
      } as PiBashExecutionEntry,
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        id: 'u1',
        timestamp: 101,
      },
    ])

    expect(messages).toHaveLength(2)
    // 第一条：bashExecution system 消息（W3 WC5：bash 是元信息非用户输入）
    expect(messages[0].role).toBe('system')
    expect(messages[0].bashExecution).toBeDefined()
    expect(messages[0].bashExecution!.command).toBe('echo hi')
    // 第二条：普通 user 文本消息，无 bashExecution
    expect(messages[1].role).toBe('user')
    expect(messages[1].bashExecution).toBeUndefined()
  })
})

/**
 * W5T2: pi flush 后 bash entry 在 assistant turn 之后的还原顺序（M3 回归）。
 *
 * 场景（spec M3 已知限制的「可还原部分」）：pi agent_end 正常 flush 后，JSONL 里
 * assistant turn entries（含 tool_use / tool_result）在前、bashExecution entry 在后。
 * 重开 session 读 JSONL 调 convertPiHistory 时，bash 消息必须排在 assistant 消息之后
 * （与实时链路 bash 消息 append 到对话流末尾的顺序对齐），且 bashExecution 字段完整还原。
 *
 * 不覆盖的已知限制：进程强杀时 pi 来不及 flush 致历史丢失（非 converter 职责，不测）。
 */
describe('convertPiHistory —— pi flush 后 bash 在 assistant turn 之后（W5 M3 回归）', () => {
  it('W5T2: [assistant tool_use + tool_result, bashExecution] → assistant 在前、bash system 在后，字段完整还原', () => {
    const messages = convertPiHistory([
      // 1) assistant turn entry：含 tool_use（pi 历史 assistant message，content 数组带 toolCall）
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'running tests' },
          { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'npm test' } },
        ],
        id: 'a1',
        timestamp: 200,
      },
      // 2) tool_result entry：合并进上面的 assistant message 的 toolCall（不产出独立 Message）
      {
        role: 'toolResult',
        toolCallId: 'tc-1',
        content: [{ type: 'text', text: 'all green' }],
        timestamp: 201,
      },
      // 3) bashExecution entry：composer 直接执行 bash 的元信息（非 LLM turn），排在 assistant turn 之后
      {
        role: 'bashExecution',
        command: 'git status',
        output: 'clean',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 300,
      } as PiBashExecutionEntry,
    ])

    // 长度：assistant(1) + toolResult 合并不产出 + bash(1) = 2
    expect(messages).toHaveLength(2)

    // 顺序：assistant 在前（index 0），bash 在后（index 1）—— 锁定 M3「pi flush 后顺序正确」
    const [assistant, bash] = messages
    expect(assistant.role).toBe('assistant')
    expect(assistant.bashExecution).toBeUndefined()
    // assistant 的 tool_use 已合并 tool_result（output 填回 toolCall）
    expect(assistant.toolCalls).toHaveLength(1)
    expect(assistant.toolCalls![0]!.output).toBe('all green')

    expect(bash.role).toBe('system')
    expect(bash.bashExecution).toBeDefined()
    // bashExecution 完整字段还原（command/output/exitCode/excludeFromContext）
    expect(bash.bashExecution!.command).toBe('git status')
    expect(bash.bashExecution!.output).toBe('clean')
    expect(bash.bashExecution!.exitCode).toBe(0)
    expect(bash.bashExecution!.excludeFromContext).toBe(true)
    expect(bash.bashExecution!.cancelled).toBe(false)
    expect(bash.bashExecution!.truncated).toBe(false)
    expect(bash.bashExecution!.timestamp).toBe(300)
  })
})
