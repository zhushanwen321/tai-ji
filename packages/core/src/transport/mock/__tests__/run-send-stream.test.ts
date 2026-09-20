/**
 * mock 流式序列单测 —— run-send-stream.ts 生命周期 + run-send-stream-branches.ts 三分支。
 * 用零延迟 stub deps（sleep 直通）驱动确定性序列，断言帧序：message_start →
 * [auto_retry] → thinking → 分支 tool_call（read/todo/goal）→ text_delta →
 * file_changes（accumulating/ready）→ [extension.ui_request] → complete（usage 回填）。
 * 同时覆盖取消提前返回（isCancelled 全程 true 只发 message_start）。
 */
import { describe, it, expect } from 'vitest'
import type { ServerMessageUnion } from '@taiji/shared'
import {
  runSendStream,
  type SendStreamDeps,
  type Timing,
} from '../run-send-stream'
import { detectBranch } from '../run-send-stream-branches'

const ZERO_TIMING: Timing = {
  ack: 0, startGap: 0, chunk: 0, done: 0, switchCmd: 0,
  thinkingGap: 0, toolGap: 0, fileChangesGap: 0, retryGap: 0, steerDrain: 0, bashDelay: 0,
}

interface Harness {
  deps: SendStreamDeps
  emitted: ServerMessageUnion[]
  pushed: ServerMessageUnion[]
}

function makeHarness(cancelled = false): Harness {
  const emitted: ServerMessageUnion[] = []
  const pushed: ServerMessageUnion[] = []
  let seq = 0
  const deps: SendStreamDeps = {
    nextId: (prefix: string) => `${prefix}-${++seq}`,
    emit: (_sid, msg) => {
      emitted.push(msg)
    },
    sleep: async () => {},
    pushSession: (_sid, msg) => {
      pushed.push(msg)
    },
    isCancelled: () => cancelled,
    TIMING: ZERO_TIMING,
  }
  return { deps, emitted, pushed }
}

const types = (msgs: Array<{ type: string }>) => msgs.map((m) => m.type)

describe('detectBranch 关键词分发', () => {
  it('todo / goal / 默认 read', () => {
    expect(detectBranch('please update the TODO list')).toBe('todo')
    expect(detectBranch('管理任务')).toBe('todo')
    expect(detectBranch('set a goal')).toBe('goal')
    expect(detectBranch('设定目标')).toBe('goal')
    expect(detectBranch('read this file')).toBe('read')
  })
})

describe('run-send-stream 默认（read）分支', () => {
  it('完整生命周期：thinking → read tool_call（含 GUI）→ text → file_changes → complete', async () => {
    const h = makeHarness()
    await runSendStream('s1', 'hello', h.deps)
    const seq = types(h.emitted)
    expect(seq[0]).toBe('message.message_start')
    // thinking 块
    expect(seq).toContain('message.thinking_start')
    expect(seq.filter((t) => t === 'message.thinking_delta').length).toBeGreaterThan(0)
    expect(seq).toContain('message.thinking_end')
    // read 分支 tool_call（GUI card 嵌套在 tool_call_end entry details.__gui__）
    const startIdx = seq.indexOf('message.tool_call_start')
    expect(startIdx).toBeGreaterThan(-1)
    const endFrame = h.emitted.find((m) => m.type === 'message.tool_call_end')
    expect(endFrame).toBeDefined()
    // 文本流式 + file_changes 两态 + complete（usage 回填）
    expect(seq.filter((t) => t === 'message.text_delta').length).toBeGreaterThan(0)
    const fcFrames = h.emitted.filter((m) => m.type === 'message.file_changes')
    expect(fcFrames.map((f) => (f.payload as { changeSetStatus: string }).changeSetStatus)).toEqual([
      'accumulating',
      'ready',
    ])
    const ready = fcFrames[1]?.payload as { fileChanges: Array<{ status: string }> }
    expect(ready.fileChanges.map((f) => f.status)).toEqual(['modified', 'added', 'unmerged'])
    const complete = h.emitted.find((m) => m.type === 'message.complete')
    expect((complete?.payload as { usage?: { totalTokens: number } }).usage).toMatchObject({ totalTokens: 1922 })
    // 默认分支推 session 通道 widget/widgetGui ×2 + status
    const pushedTypes = types(h.pushed)
    expect(pushedTypes).toContain('extension:widget')
    expect(pushedTypes.filter((t) => t === 'extension:widgetGui')).toHaveLength(2)
    expect(pushedTypes).toContain('extension:status')
  })

  it('取消（isCancelled 恒 true）：仅 message_start 后提前返回', async () => {
    const h = makeHarness(true)
    await runSendStream('s1', 'hello', h.deps)
    expect(types(h.emitted)).toEqual(['message.message_start'])
    expect(h.pushed).toHaveLength(0)
  })
})

describe('run-send-stream 关键词触发帧', () => {
  it("含 'retry'：auto_retry_start → auto_retry_end", async () => {
    const h = makeHarness()
    await runSendStream('s1', 'retry please', h.deps)
    const seq = types(h.emitted)
    expect(seq).toContain('message.auto_retry_start')
    expect(seq.indexOf('message.auto_retry_end')).toBeGreaterThan(seq.indexOf('message.auto_retry_start'))
  })

  it("含 'todo'：todo tool_call 序列（details.todos + list-tree GUI），不推 extension widget", async () => {
    const h = makeHarness()
    await runSendStream('s1', 'update todo', h.deps)
    const start = h.emitted.find((m) => m.type === 'message.tool_call_start')
    const entry = (start?.payload as { entry?: { toolName?: string } }).entry
    expect(entry?.toolName).toBe('todo')
    expect(h.pushed).toHaveLength(0)
  })

  it("含 'goal'：goal_control tool_call + goal ANSI widget", async () => {
    const h = makeHarness()
    await runSendStream('s1', 'set goal', h.deps)
    const start = h.emitted.find((m) => m.type === 'message.tool_call_start')
    const entry = (start?.payload as { entry?: { toolName?: string } }).entry
    expect(entry?.toolName).toBe('goal_control')
    const widget = h.pushed.find((m) => m.type === 'extension:widget')
    expect((widget?.payload as { widgetKey?: string }).widgetKey).toBe('goal')
  })

  it("含 'ui-select'：complete 前推 extension.ui_request（select 方法 + 选项）", async () => {
    const h = makeHarness()
    await runSendStream('s1', 'ui-select deploy', h.deps)
    const req = h.pushed.find((m) => m.type === 'extension.ui_request')
    expect((req?.payload as { method?: string }).method).toBe('select')
    expect(((req?.payload as { options?: string[] }).options ?? []).length).toBe(3)
  })

  it("含 'md-table'：text_delta 拼回 markdown 宽表（列宽地板 e2e 守卫数据源）", async () => {
    const h = makeHarness()
    await runSendStream('s1', 'md-table', h.deps)
    const text = h.emitted
      .filter((m) => m.type === 'message.text_delta')
      .map((m) => (m.payload as { delta: string }).delta)
      .join('')
    // 表头 + 分隔行 + 数据行齐全（GFM 表格三要素，缺一 markdown-it 不建表）
    expect(text).toContain('| 维度 | pi | zcode | 风险 |')
    expect(text).toContain('| --- | --- | --- | --- |')
    expect(text).toContain('| 报告目录 |')
    expect(text).toContain('| 参数面 |')
    // 管道行数 = 表头 + 分隔 + 2 数据行（trim 后的守卫数据源，勿加行——每 CJK 字一个
    //   text_delta 帧 ×70ms，行数直接决定 L1 smoke 用例耗时）
    expect(text.split('\n').filter((l) => l.startsWith('|')).length).toBe(4)
    // 哨兵词只换回复体：生命周期其余帧不变（complete 含 usage 回填）
    expect(types(h.emitted)).toContain('message.complete')
    const complete = h.emitted.find((m) => m.type === 'message.complete')
    expect((complete?.payload as { usage?: { totalTokens: number } }).usage).toMatchObject({ totalTokens: 1922 })
  })

  it("不含哨兵词：回复体仍是固定前缀（md-table 分支不污染普通输入）", async () => {
    const h = makeHarness()
    await runSendStream('s1', '普通输入', h.deps)
    const text = h.emitted
      .filter((m) => m.type === 'message.text_delta')
      .map((m) => (m.payload as { delta: string }).delta)
      .join('')
    expect(text).toContain('好的，我来处理这个请求。（mock 模拟回复）')
    expect(text).not.toContain('| 维度 |')
  })
})
