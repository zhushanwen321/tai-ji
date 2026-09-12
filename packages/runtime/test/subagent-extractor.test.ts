import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeCwd } from '../src/infra/pi/pi-paths.js'

// mock getSubagentSessionDir 让回退查找测试用临时目录
const mockSubagentDir = { dir: '' }
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSubagentSessionDir: () => mockSubagentDir.dir,
  }
})

import { extractSubagentsFromSessionFile, scanSubagentEntries } from '../src/services/session/subagent-extractor.js'

describe('encodeCwd', () => {
  it('encodes Unix cwd path correctly', () => {
    expect(encodeCwd('/Users/x/proj')).toBe('--Users-x-proj--')
  })

  it('encodes Windows cwd path correctly', () => {
    // C:\Users\x\proj → 去首斜杠（首字符 C 不匹配）→ : 和 \ 都替换为 - → C--Users-x-proj
    expect(encodeCwd('C:\\Users\\x\\proj')).toBe('--C--Users-x-proj--')
  })

  it('encodes path with colon', () => {
    expect(encodeCwd('/a:b/c')).toBe('--a-b-c--')
  })
})

describe('extractSubagentsFromSessionFile', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'subagent-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('extracts background subagent with bg-notify status update', () => {
    const sessionFile = join(tempDir, 'bg-session.jsonl')
    const subagentSessionFile = '/data/subagents/sessions/bg1.jsonl'
    const bgSubagentId = 'bg-xxx-1-1234567890'

    const toolCallId = 'call_bg1'
    const entries = [
      { type: 'session', id: 'main-2', cwd: '/proj', timestamp: '2026-07-11T06:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        timestamp: '2026-07-11T06:38:29Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: toolCallId,
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: {
                  agent: 'worker',
                  slug: 'modify-gate',
                  task: 'Modify gate.ts',
                },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        timestamp: '2026-07-11T06:38:30Z',
        message: {
          role: 'toolResult',
          toolCallId: toolCallId,
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: bgSubagentId,
                sessionFile: null,
                bgResponse: {
                  status: 'running',
                  message: 'detached, will notify on completion',
                },
              }),
            },
          ],
        },
      },
      // list response updates sessionFile + status
      {
        type: 'message',
        id: 'msg-3',
        timestamp: '2026-07-11T06:40:00Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_list1',
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'list',
                subagentId: null,
                sessionFile: null,
                listResponse: {
                  running: 1,
                  items: [
                    {
                      subagentId: bgSubagentId,
                      agent: 'worker',
                      status: 'running',
                      sessionFile: subagentSessionFile,
                      model: 'mimo-router/mimo-v2.5-pro',
                      totalTokens: 567852,
                      duration: 86,
                    },
                  ],
                },
              }),
            },
          ],
        },
      },
      // bg-notify marks as done
      {
        type: 'custom_message',
        customType: 'subagent-bg-notify',
        content: 'Subagent "worker" completed.',
        details: {
          id: bgSubagentId,
          status: 'done',
          agent: 'worker',
          model: 'mimo-router/mimo-v2.5-pro',
          startedAt: 1783751909029,
          endedAt: 1783752218705,
        },
        timestamp: '2026-07-11T07:03:38Z',
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)

    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.subagentId).toBe(bgSubagentId)
    expect(r.status).toBe('done')
    expect(r.sessionFile).toBe(subagentSessionFile)
    expect(r.agent).toBe('worker')
    expect(r.slug).toBe('modify-gate')
    expect(r.task).toBe('Modify gate.ts')
    expect(r.totalTokens).toBe(567852)
    expect(r.elapsedSeconds).toBe(86)
    expect(r.startedAt).toBe(1783751909029)
    expect(r.endedAt).toBe(1783752218705)
  })

  it('slug 缺失时兜底空串（旧 session JSONL 兼容）', () => {
    const sessionFile = join(tempDir, 'no-slug.jsonl')
    const bgSubagentId = 'bg-noslug-1'
    const toolCallId = 'call_ns1'

    const entries = [
      { type: 'session', id: 'main-ns', cwd: '/proj', timestamp: '2026-07-11T06:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: toolCallId,
              name: 'subagent',
              // 旧格式：startParam 无 slug
              arguments: { action: 'start', startParam: { agent: 'worker', task: 'Old task' } },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult',
          toolCallId,
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: bgSubagentId,
                sessionFile: null,
                bgResponse: { status: 'running', message: 'detached' },
              }),
            },
          ],
        },
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].slug).toBe('')
    expect(records[0].task).toBe('Old task')
  })

  it('returns empty array for file with no subagent calls', () => {
    const sessionFile = join(tempDir, 'no-subagent.jsonl')
    const entries = [
      { type: 'session', id: 'main-3', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there' }],
        },
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(0)
  })

  it('returns empty array for non-existent file', () => {
    const records = extractSubagentsFromSessionFile('/nonexistent/path/file.jsonl')
    expect(records).toHaveLength(0)
  })

  it('handles failed background subagent (bg-notify status=failed)', () => {
    const sessionFile = join(tempDir, 'failed-bg.jsonl')
    const bgSubagentId = 'bg-fail-1-9999999999'
    const toolCallId = 'call_fail1'

    const entries = [
      { type: 'session', id: 'main-4', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: toolCallId,
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: { agent: 'reviewer', slug: 'review-code', task: 'Review code' },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult',
          toolCallId,
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: bgSubagentId,
                sessionFile: null,
                bgResponse: { status: 'running', message: 'detached' },
              }),
            },
          ],
        },
      },
      // bg-notify marks as failed
      {
        type: 'custom_message',
        customType: 'subagent-bg-notify',
        content: 'Subagent failed.',
        details: {
          id: bgSubagentId,
          status: 'failed',
          agent: 'reviewer',
          error: 'Model timeout',
          startedAt: 1783751909029,
          endedAt: 1783752218705,
        },
        timestamp: '2026-07-11T07:03:38Z',
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('failed')
    expect(records[0].error).toBe('Model timeout')
    expect(records[0].slug).toBe('review-code')
  })

  // v4 B-1：closed 统一终态携带 closedReason，extractor 投影到 SubagentRecord 供 renderer 派生展示
  it('v4 closed 终态 bg-notify（closedReason=gc + error）→ 投影 status=closed + closedReason + error', () => {
    const sessionFile = join(tempDir, 'closed-bg.jsonl')
    const bgSubagentId = 'bg-closed-1-8888888888'
    const toolCallId = 'call_closed1'

    const entries = [
      { type: 'session', id: 'main-5', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: toolCallId,
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: { agent: 'reviewer', slug: 'review-v4', task: 'Review code' },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult',
          toolCallId,
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: bgSubagentId,
                sessionFile: null,
                bgResponse: { status: 'running', message: 'detached' },
              }),
            },
          ],
        },
      },
      {
        type: 'custom_message',
        customType: 'subagent-bg-notify',
        content: 'Subagent closed.',
        details: {
          id: bgSubagentId,
          status: 'closed',
          closedReason: 'gc',
          agent: 'reviewer',
          error: 'provider 429',
          startedAt: 1783751909029,
          endedAt: 1783752218705,
        },
        timestamp: '2026-07-11T07:03:38Z',
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('closed')
    expect(records[0].closedReason).toBe('gc')
    expect(records[0].error).toBe('provider 429')
  })

  // 与实时路径（event-interpreter handleSubagentBgNotify）同构守卫：closedReason 仅
  // status === 'closed' 时投影。最后一条 notify 为 running（轮次完成通知）时：
  // 1) notify 自身异常携带的 closedReason 被丢弃；2) 不从早先 list item（closed）兜底。
  it('running 终态守卫：最后 notify 为 running 时 closedReason 不投影（无 running + closedReason 脏组合）', () => {
    const sessionFile = join(tempDir, 'running-guard.jsonl')
    const bgSubagentId = 'bg-run-guard-1-7777777777'
    const toolCallId = 'call_runguard'
    const entries = [
      { type: 'session', id: 'main-rg', cwd: '/proj', timestamp: '2026-07-11T06:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: toolCallId,
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: { agent: 'worker', slug: 'chat-loop', task: 'Chat task', conversation: true },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult',
          toolCallId,
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: bgSubagentId,
                sessionFile: null,
                bgResponse: { status: 'running', message: 'detached' },
              }),
            },
          ],
        },
      },
      // 早先 list：item 已 closed + closedReason（此后的轮次通知会覆盖为 running）
      {
        type: 'message',
        id: 'msg-3',
        message: {
          role: 'toolResult',
          toolCallId: 'call_list_rg',
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'list',
                subagentId: null,
                sessionFile: null,
                listResponse: {
                  running: 0,
                  items: [
                    {
                      subagentId: bgSubagentId,
                      agent: 'worker',
                      status: 'closed',
                      closedReason: 'user-close',
                    },
                  ],
                },
              }),
            },
          ],
        },
      },
      // 最后一条 notify：status running（对话模式轮次完成通知），异常携带 closedReason 残留
      {
        type: 'custom_message',
        customType: 'subagent-bg-notify',
        details: { id: bgSubagentId, status: 'running', closedReason: 'gc', agent: 'worker', round: 2, startedAt: 1783751909029 },
        timestamp: '2026-07-11T07:00:00Z',
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('running')
    // 守卫生效：notify 异常残留与 listItem 兜底都不进入输出
    expect(records[0].closedReason).toBeUndefined()
  })

  it('extracts multiple background subagents', () => {
    const sessionFile = join(tempDir, 'multi-bg.jsonl')

    const entries = [
      { type: 'session', id: 'main-5', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      // first subagent
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_a',
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: { agent: 'reviewer', slug: 'task-a', task: 'Task A' },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult',
          toolCallId: 'call_a',
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: 'bg-a-1-111',
                sessionFile: '/data/a.jsonl',
                bgResponse: { status: 'running', message: 'detached' },
              }),
            },
          ],
        },
      },
      // second subagent
      {
        type: 'message',
        id: 'msg-3',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_b',
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: { agent: 'general-purpose', slug: 'task-b', task: 'Task B' },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-4',
        message: {
          role: 'toolResult',
          toolCallId: 'call_b',
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: 'bg-b-2-222',
                sessionFile: '/data/b.jsonl',
                bgResponse: { status: 'running', message: 'detached' },
              }),
            },
          ],
        },
      },
      // bg-notify for both
      {
        type: 'custom_message',
        customType: 'subagent-bg-notify',
        details: { id: 'bg-a-1-111', status: 'done', agent: 'reviewer', startedAt: 1783751000000, endedAt: 1783751060000 },
        timestamp: '2026-07-10T10:10:00Z',
      },
      {
        type: 'custom_message',
        customType: 'subagent-bg-notify',
        details: { id: 'bg-b-2-222', status: 'done', agent: 'general-purpose', startedAt: 1783751100000, endedAt: 1783751220000 },
        timestamp: '2026-07-10T10:20:00Z',
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(2)
    expect(records[0].subagentId).toBe('bg-a-1-111')
    expect(records[0].agent).toBe('reviewer')
    expect(records[0].slug).toBe('task-a')
    expect(records[1].subagentId).toBe('bg-b-2-222')
    expect(records[1].agent).toBe('general-purpose')
    expect(records[1].slug).toBe('task-b')
  })

  it('startParam.agent 缺失时 agent 兜底为 general-purpose（对齐 pi DEFAULT_AGENT_NAME）', () => {
    const sessionFile = join(tempDir, 'no-agent.jsonl')
    const subagentId = 'bg-noagent-1'
    const toolCallId = 'call-noagent'
    const entries = [
      { type: 'session', id: 'main', cwd: '/proj', timestamp: '2026-07-11T06:00:00Z' },
      {
        type: 'message', id: 'm1', timestamp: '2026-07-11T06:38:29Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall', id: toolCallId, name: 'subagent',
            // startParam 不带 agent —— 模拟 LLM 省略 agent 参数（实测最常见情况）
            arguments: { action: 'start', startParam: { slug: 'task-x', task: 'Do X' } },
          }],
        },
      },
      {
        type: 'message', id: 'm2', timestamp: '2026-07-11T06:38:30Z',
        message: {
          role: 'toolResult', toolCallId, toolName: 'subagent',
          content: [{ type: 'text', text: JSON.stringify({
            action: 'start', subagentId, sessionFile: null,
            bgResponse: { status: 'running', message: 'detached' },
          }) }],
        },
      },
      {
        type: 'custom_message', customType: 'subagent-bg-notify',
        details: { id: subagentId, status: 'running', agent: 'general-purpose', startedAt: 1783751909029 },
        timestamp: '2026-07-11T06:38:31Z',
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))
    const records = extractSubagentsFromSessionFile(sessionFile)

    expect(records).toHaveLength(1)
    // 不再是 'unknown'，对齐 pi 的 DEFAULT_AGENT_NAME
    expect(records[0].agent).toBe('general-purpose')
  })

  it('batch 形态 bg-notify → 多个 subagent 终态都被更新（pi notifier 60s 合并窗口）', () => {
    const sessionFile = join(tempDir, 'batch-notify.jsonl')
    const idA = 'bg-batch-a'
    const idB = 'bg-batch-b'
    const entries = [
      { type: 'session', id: 'main', cwd: '/proj', timestamp: '2026-07-11T06:00:00Z' },
      // subagent A
      {
        type: 'message', id: 'm1', timestamp: '2026-07-11T06:38:29Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-a', name: 'subagent',
          arguments: { action: 'start', startParam: { agent: 'worker', slug: 'a', task: 'A' } } }] },
      },
      {
        type: 'message', id: 'm2', timestamp: '2026-07-11T06:38:30Z',
        message: { role: 'toolResult', toolCallId: 'call-a', toolName: 'subagent',
          content: [{ type: 'text', text: JSON.stringify({
            action: 'start', subagentId: idA, sessionFile: null,
            bgResponse: { status: 'running', message: 'detached' },
          }) }] },
      },
      // subagent B
      {
        type: 'message', id: 'm3', timestamp: '2026-07-11T06:38:31Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-b', name: 'subagent',
          arguments: { action: 'start', startParam: { agent: 'researcher', slug: 'b', task: 'B' } } }] },
      },
      {
        type: 'message', id: 'm4', timestamp: '2026-07-11T06:38:32Z',
        message: { role: 'toolResult', toolCallId: 'call-b', toolName: 'subagent',
          content: [{ type: 'text', text: JSON.stringify({
            action: 'start', subagentId: idB, sessionFile: null,
            bgResponse: { status: 'running', message: 'detached' },
          }) }] },
      },
      // batch bg-notify —— 60s 内两个 subagent 完成合并成 {batch:true, items:[...]}
      {
        type: 'custom_message', customType: 'subagent-bg-notify',
        details: { batch: true, items: [
          { id: idA, status: 'done', agent: 'worker', startedAt: 1783751900000, endedAt: 1783752000000 },
          { id: idB, status: 'done', agent: 'researcher', startedAt: 1783751901000, endedAt: 1783752001000 },
        ] },
        timestamp: '2026-07-11T07:00:00Z',
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))
    const records = extractSubagentsFromSessionFile(sessionFile)

    expect(records).toHaveLength(2)
    const a = records.find((r) => r.subagentId === idA)
    const b = records.find((r) => r.subagentId === idB)
    // batch 形态下两个 subagent 都被更新为 done（不再整批丢弃）
    expect(a?.status).toBe('done')
    expect(a?.agent).toBe('worker')
    expect(a?.endedAt).toBe(1783752000000)
    expect(b?.status).toBe('done')
    expect(b?.agent).toBe('researcher')
    expect(b?.endedAt).toBe(1783752001000)
  })

  it('bg-notify.agent 优先于 startParam.agent（pi 执行期回传覆盖 LLM 入参）', () => {
    const sessionFile = join(tempDir, 'agent-override.jsonl')
    const subagentId = 'bg-override-1'
    const toolCallId = 'call-override'
    const entries = [
      { type: 'session', id: 'main', cwd: '/proj', timestamp: '2026-07-11T06:00:00Z' },
      {
        type: 'message', id: 'm1', timestamp: '2026-07-11T06:38:29Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'subagent',
          // LLM 声明 general-purpose
          arguments: { action: 'start', startParam: { agent: 'general-purpose', slug: 'x', task: 'X' } } }] },
      },
      {
        type: 'message', id: 'm2', timestamp: '2026-07-11T06:38:30Z',
        message: { role: 'toolResult', toolCallId, toolName: 'subagent',
          content: [{ type: 'text', text: JSON.stringify({
            action: 'start', subagentId, sessionFile: null,
            bgResponse: { status: 'running', message: 'detached' },
          }) }] },
      },
      {
        type: 'custom_message', customType: 'subagent-bg-notify',
        // pi 回传的真实 agent 是 'researcher'，覆盖 startParam 的 'general-purpose'
        details: { id: subagentId, status: 'done', agent: 'researcher', startedAt: 1783751900000, endedAt: 1783752000000 },
        timestamp: '2026-07-11T07:00:00Z',
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))
    const records = extractSubagentsFromSessionFile(sessionFile)

    expect(records).toHaveLength(1)
    // agent 是 notify.agent（真实值），不是 startParam.agent
    expect(records[0].agent).toBe('researcher')
  })
})

describe('extractSubagentsFromSessionFile — background sessionFile 回退查找', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'subagent-fallback-'))
    mockSubagentDir.dir = join(tempDir, 'subagents-sessions')
    mkdirSync(mockSubagentDir.dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    mockSubagentDir.dir = ''
  })

  it('sessionFile=null 时用 startedAt 时间戳匹配 subagent JSONL 文件', () => {
    const sessionFile = join(tempDir, 'bg-no-sessionfile.jsonl')
    const subagentJsonl = join(mockSubagentDir.dir, '2026-07-12T17-09-01-293Z_019f574d-c0ed.jsonl')
    writeFileSync(subagentJsonl, JSON.stringify({ type: 'session', id: 'sub-1', cwd: '/proj', timestamp: '2026-07-12T17:09:01Z' }) + '\n')

    const bgSubagentId = 'bg-fallback-1-1783876141075'
    const toolCallId = 'call_fb1'
    const entries = [
      { type: 'session', id: 'main-fb', cwd: '/proj', timestamp: '2026-07-12T17:08:53Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall', id: toolCallId, name: 'subagent',
            arguments: { action: 'start', startParam: { agent: 'general-purpose', slug: 'scan-dir', task: 'Scan directory' } },
          }],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult', toolCallId, toolName: 'subagent',
          content: [{ type: 'text', text: JSON.stringify({
            action: 'start', subagentId: bgSubagentId, sessionFile: null,
            bgResponse: { status: 'running', message: 'detached' },
          }) }],
        },
      },
      {
        type: 'custom_message',
        customType: 'subagent-bg-notify',
        content: 'Subagent completed.',
        details: {
          id: bgSubagentId, status: 'done', agent: 'general-purpose',
          model: 'test/model', startedAt: 1783876141075, endedAt: 1783876149814,
        },
        timestamp: '2026-07-12T17:09:09Z',
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].sessionFile).not.toBeNull()
    expect(records[0].sessionFile).toBe(subagentJsonl)
    expect(records[0].status).toBe('done')
    expect(records[0].slug).toBe('scan-dir')
  })

  it('目录不存在时 sessionFile 保持 null', () => {
    const sessionFile = join(tempDir, 'no-dir.jsonl')
    mockSubagentDir.dir = join(tempDir, 'nonexistent-dir')

    const bgSubagentId = 'bg-nodir-1'
    const toolCallId = 'call_nd1'
    const entries = [
      { type: 'session', id: 'main-nd', cwd: '/proj', timestamp: '2026-07-12T17:08:53Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall', id: toolCallId, name: 'subagent',
            arguments: { action: 'start', startParam: { agent: 'worker', slug: 'do-stuff', task: 'Do stuff' } },
          }],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult', toolCallId, toolName: 'subagent',
          content: [{ type: 'text', text: JSON.stringify({
            action: 'start', subagentId: bgSubagentId, sessionFile: null,
            bgResponse: { status: 'running', message: 'detached' },
          }) }],
        },
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].sessionFile).toBeNull()
  })
})


// ── W18：scanSubagentEntries（entry 扫描器：自描述优先 + legacy 兜底）─────────────
describe('scanSubagentEntries（W18 entry 扫描器）', () => {
  /** 构造自描述 subagent-record entry（W16 v1 完整快照形态，对齐 extension record-entry.ts schema） */
  function subagentRecordEntry(data: Record<string, unknown>): Record<string, unknown> {
    return {
      type: 'custom',
      customType: 'subagent-record',
      id: 'e-1',
      parentId: null,
      timestamp: '2026-08-19T00:00:00Z',
      data: {
        v: 1,
        agent: 'worker',
        task: 'Do work',
        slug: 'work',
        status: 'running',
        startedAt: 1000,
        ...data,
      },
    }
  }

  it('自描述命中：v1 entry → SubagentRecord 投影（id/status/时间戳/closedReason 终态投影）', () => {
    const records = scanSubagentEntries([
      { type: 'session', id: 's', cwd: '/proj', timestamp: '2026-08-19T00:00:00Z' },
      subagentRecordEntry({
        id: 'sa-1',
        status: 'closed',
        closedReason: 'gc',
        endedAt: 61000,
        totalTokens: 1234,
        model: 'p/m',
        sessionFile: '/data/sa-1.jsonl',
        error: 'boom',
        // R3-1：origin 进全量快照断言——投影白名单漏字段时本用例 toEqual 红
        origin: 'workflow',
      }),
    ])

    expect(records).toEqual([{
      subagentId: 'sa-1',
      sessionFile: '/data/sa-1.jsonl',
      agent: 'worker',
      slug: 'work',
      task: 'Do work',
      status: 'closed',
      closedReason: 'gc',
      turns: undefined,
      totalTokens: 1234,
      model: 'p/m',
      thinkingLevel: undefined,
      startedAt: 1000,
      endedAt: 61000,
      // elapsedSeconds 派生：entry 无 duration，从 startedAt/endedAt 差值（60s）
      elapsedSeconds: 60,
      error: 'boom',
      origin: 'workflow',
    }])
  })

  it('同 id 后到覆盖（状态迁移 append 序列：running → closed 取最后快照）+ running 无 closedReason', () => {
    const records = scanSubagentEntries([
      subagentRecordEntry({ id: 'sa-1', status: 'running' }),
      subagentRecordEntry({ id: 'sa-1', status: 'closed', closedReason: 'user-close', endedAt: 2000 }),
    ])

    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe('closed')
    expect(records[0]!.closedReason).toBe('user-close')
  })

  it('版本守卫：v≠1 的自描述 entry 跳过（全部无效 → 落 legacy 兜底）', () => {
    const legacyEntries = [
      {
        type: 'message', id: 'm-0', timestamp: '2026-07-11T06:38:28Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'subagent', arguments: { action: 'start', startParam: { agent: 'worker', slug: 's', task: 't' } } }],
        },
      },
      {
        type: 'message', id: 'm-1', timestamp: '2026-07-11T06:38:29Z',
        message: {
          role: 'toolResult', toolCallId: 'call-1', toolName: 'subagent',
          content: [{ type: 'text', text: JSON.stringify({ action: 'start', subagentId: 'bg-legacy-1', sessionFile: null, bgResponse: { status: 'running' } }) }],
        },
      },
    ]
    const records = scanSubagentEntries([
      subagentRecordEntry({ id: 'sa-new', v: 2, status: 'running' }),
      ...legacyEntries,
    ])

    // v2 entry 全部无效 → 自描述无命中 → legacy 兜底产出（数据滞后但可用）
    expect(records).toHaveLength(1)
    expect(records[0]!.subagentId).toBe('bg-legacy-1')
    expect(records[0]!.status).toBe('running')
  })

  it('无自描述 entry 的旧 session → legacy 解析（toolCall/toolResult 配对路径，D4 降级表现）', () => {
    const records = scanSubagentEntries([
      {
        type: 'message', id: 'm-0', timestamp: '2026-07-11T06:38:29Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'subagent', arguments: { action: 'start', startParam: { agent: 'worker', slug: 's', task: 't' } } }],
        },
      },
      {
        type: 'message', id: 'm-1', timestamp: '2026-07-11T06:38:30Z',
        message: {
          role: 'toolResult', toolCallId: 'call-1', toolName: 'subagent',
          content: [{ type: 'text', text: JSON.stringify({ action: 'start', subagentId: 'bg-legacy-2', sessionFile: null, bgResponse: { status: 'running' } }) }],
        },
      },
    ])

    expect(records).toHaveLength(1)
    expect(records[0]!.subagentId).toBe('bg-legacy-2')
    expect(records[0]!.agent).toBe('worker')
  })

  it('混合时自描述优先（同批 legacy entry 存在但有自描述命中即不走 legacy）', () => {
    const records = scanSubagentEntries([
      subagentRecordEntry({ id: 'sa-self', status: 'running' }),
      {
        type: 'message', id: 'm-1', timestamp: '2026-07-11T06:38:30Z',
        message: {
          role: 'toolResult', toolCallId: 'call-1', toolName: 'subagent',
          content: [{ type: 'text', text: JSON.stringify({ action: 'start', subagentId: 'bg-legacy-3', sessionFile: null, bgResponse: { status: 'running' } }) }],
        },
      },
    ])

    expect(records.map((r) => r.subagentId)).toEqual(['sa-self'])
  })

  it('空 entry 列表返回空数组（两条路径都不产出）', () => {
    expect(scanSubagentEntries([])).toEqual([])
  })
})
