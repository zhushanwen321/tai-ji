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
import { SUBAGENT_RECORD_CUSTOM_TYPE } from '@zhushanwen/subagent-core'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'

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
                      model: 'mimo-router/mimo-v2.6-flash',
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
          model: 'mimo-router/mimo-v2.6-flash',
          startedAt: 1783751909029,
          endedAt: 1783752218705,
        },
        timestamp: '2026-07-11T07:03:38Z',
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const { records } = extractSubagentsFromSessionFile(sessionFile)

    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.subagentId).toBe(bgSubagentId)
    // [U6/D5] legacy done 归一为 idle + stopReason:'completed' 合成
    expect(r.status).toBe('idle')
    expect(r.stopReason).toBe('completed')
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

    const { records } = extractSubagentsFromSessionFile(sessionFile)
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

    const { records } = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(0)
  })

  it('returns empty array for non-existent file', () => {
    const { records, oversize } = extractSubagentsFromSessionFile('/nonexistent/path/file.jsonl')
    expect(records).toHaveLength(0)
    // ENOENT 走原读路径（stat 预检失败不引入新抛错/新标记）——非降级形态
    expect(oversize).toBe(false)
  })

  it('[G3] READ_PRECHECK 预检：>32MB 降级返回空列表 + oversize 标记（不读全文）', () => {
    const sessionFile = join(tempDir, 'oversize-session.jsonl')
    // 首行是合法 v2 注册条目（预检失效被误读时会产出 1 条记录——若本用例断言翻红即
    // 说明预检未挡住读路径）；其余为 >32MB 单行填充（JSON.parse 失败行，仅撑体积）
    const recordLine = JSON.stringify({
      type: 'custom',
      customType: SUBAGENT_RECORD_CUSTOM_TYPE,
      id: 'e-oversize',
      parentId: null,
      timestamp: '2026-09-26T00:00:00Z',
      data: {
        v: 2,
        kind: 'registered',
        id: 'sub-oversize-guard',
        agent: 'worker',
        task: 'huge',
        slug: 'huge',
        origin: 'tool',
        rootSessionId: 's1',
        depth: 0,
        startedAt: 1000,
      },
    })
    // 阈值 + 1B 超限（READ_PRECHECK_MAX_BYTES = 32MB，shared SSOT——导入引用而非写死，
    // 阈值调整时本用例跟随）
    const paddingBytes = READ_PRECHECK_MAX_BYTES + 1 - (Buffer.byteLength(recordLine) + 1)
    writeFileSync(sessionFile, recordLine + '\n' + 'x'.repeat(paddingBytes))

    const { records, oversize } = extractSubagentsFromSessionFile(sessionFile)

    // 降级契约：不读全文 → 记录空列表 + oversize 正交标记（侧栏面板据此显示「会话过大」）
    expect(oversize).toBe(true)
    expect(records).toEqual([])
  })

  it('[G3] 预检阈值内（<32MB）正常提取：oversize=false', () => {
    const sessionFile = join(tempDir, 'normal-session.jsonl')
    const entries = [
      {
        type: 'custom',
        customType: SUBAGENT_RECORD_CUSTOM_TYPE,
        id: 'e-normal',
        parentId: null,
        timestamp: '2026-07-11T06:00:00Z',
        data: {
          v: 2,
          kind: 'registered',
          id: 'sub-normal',
          agent: 'worker',
          task: 't',
          slug: 't',
          origin: 'tool',
          rootSessionId: 's1',
          depth: 0,
          startedAt: 1000,
        },
      },
    ]
    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const { records, oversize } = extractSubagentsFromSessionFile(sessionFile)

    expect(oversize).toBe(false)
    expect(records).toHaveLength(1)
    expect(records[0].subagentId).toBe('sub-normal')
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

    const { records } = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    // [U6/D5] legacy failed 归一为 idle + stopReason:'failed' 合成
    expect(records[0].status).toBe('idle')
    expect(records[0].stopReason).toBe('failed')
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

    const { records } = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    // [U6/D5] legacy closed 归一为 idle + closedReason 保留（诊断位）+ deriveClosedDisplay
    // 派生 stopReason（gc + error → failed）
    expect(records[0].status).toBe('idle')
    expect(records[0].closedReason).toBe('gc')
    expect(records[0].stopReason).toBe('failed')
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
                startParam: { agent: 'worker', slug: 'chat-loop', task: 'Chat task' },
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

    const { records } = extractSubagentsFromSessionFile(sessionFile)
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

    const { records } = extractSubagentsFromSessionFile(sessionFile)
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
    const { records } = extractSubagentsFromSessionFile(sessionFile)

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
    const { records } = extractSubagentsFromSessionFile(sessionFile)

    expect(records).toHaveLength(2)
    const a = records.find((r) => r.subagentId === idA)
    const b = records.find((r) => r.subagentId === idB)
    // batch 形态下两个 subagent 都被更新为终态（不再整批丢弃）[U6/D5] done → idle
    expect(a?.status).toBe('idle')
    expect(a?.agent).toBe('worker')
    expect(a?.endedAt).toBe(1783752000000)
    expect(b?.status).toBe('idle')
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
    const { records } = extractSubagentsFromSessionFile(sessionFile)

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

    const { records } = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].sessionFile).not.toBeNull()
    expect(records[0].sessionFile).toBe(subagentJsonl)
    expect(records[0].status).toBe('idle')
    expect(records[0].slug).toBe('scan-dir')
  })

  // [W1 / D3] record 事件文件族（<sa-id>.events，无 .jsonl 后缀）结构性忽略断言：
  // 后缀白名单天然排除；显式断言防未来通配规则回归把事件行当 session 行误读。
  it('[W1] 目录内 *.events 文件族被结构性忽略（匹配不命中事件文件；纯 .events 目录 → null）', () => {
    // 共存形态：jsonl 与 .events 同目录（records 目录与本目录同 cwd 树相邻）——匹配只落 jsonl
    writeFileSync(join(mockSubagentDir.dir, 'sa-9.events'), '{"type":"record-journal","id":"sa-9"}\n')
    const subagentJsonl = join(mockSubagentDir.dir, '2026-07-12T17-09-01-293Z_019f574d-c0ed.jsonl')
    writeFileSync(subagentJsonl, JSON.stringify({ type: 'session', id: 'sub-1', cwd: '/proj', timestamp: '2026-07-12T17:09:01Z' }) + '\n')
    const sessionFile = join(tempDir, 'events-coexist.jsonl')
    writeFileSync(sessionFile, [
      JSON.stringify({ type: 'session', id: 'main-ev', cwd: '/proj', timestamp: '2026-07-12T17:08:53Z' }),
      JSON.stringify({
        type: 'message', id: 'msg-1',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call_ev', name: 'subagent', arguments: { action: 'start', startParam: { agent: 'worker', slug: 's', task: 't' } } }],
        },
      }),
      JSON.stringify({
        type: 'message', id: 'msg-2',
        message: {
          role: 'toolResult', toolCallId: 'call_ev', toolName: 'subagent',
          content: [{ type: 'text', text: JSON.stringify({ action: 'start', subagentId: 'bg-ev-1-1783876141075', sessionFile: null, bgResponse: { status: 'running' } }) }],
        },
      }),
    ].join('\n'))

    const { records } = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].sessionFile).toBe(subagentJsonl)

    // 纯 .events 目录：无 jsonl 可匹配 → null（事件文件不被时间戳匹配捡起）
    rmSync(subagentJsonl, { force: true, maxRetries: 5, retryDelay: 20 })
    const after = extractSubagentsFromSessionFile(sessionFile)
    expect(after.records[0].sessionFile).toBeNull()
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

    const { records } = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].sessionFile).toBeNull()
  })
})


// ── scanSubagentEntries（entry 扫描器：v2 自描述优先 + legacy 兜底）─────────────
describe('scanSubagentEntries（entry 扫描器：v2 自描述优先 + legacy 兜底）', () => {
  /** v2 注册条目 entry（身份域定身份；data 覆写供透传用例） */
  function registeredEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'custom',
      customType: SUBAGENT_RECORD_CUSTOM_TYPE,
      id: 'e-1',
      parentId: null,
      timestamp: '2026-08-19T00:00:00Z',
      data: {
        v: 2,
        kind: 'registered',
        id: 'sa-1',
        agent: 'worker',
        task: 'Do work',
        slug: 'work',
        origin: 'tool',
        rootSessionId: 's1',
        depth: 0,
        startedAt: 1000,
        ...overrides,
      },
    }
  }

  /** v2 终态条目 entry（终局域；终态条目在场即 idle，条目 status 值不参与判据） */
  function settledEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'custom',
      customType: SUBAGENT_RECORD_CUSTOM_TYPE,
      id: 'e-2',
      parentId: null,
      timestamp: '2026-08-19T00:00:01Z',
      data: {
        v: 2,
        kind: 'settled',
        id: 'sa-1',
        status: 'idle',
        stopReason: 'interrupted',
        endedAt: 61000,
        turns: 9,
        totalTokens: 1234,
        model: 'p/m',
        thinkingLevel: 'low',
        sessionFile: '/data/sa-1.jsonl',
        result: 'full result text',
        ...overrides,
      },
    }
  }

  it('自描述命中：v2 条目对 → SubagentRecord 全字段投影（身份 / 终局 / 统计 / 引擎锚）', () => {
    const engineHandle = { sessionRef: { sessionId: 'z-1', dbPath: '/db/z.sqlite' }, poolKey: 'shared' }
    const records = scanSubagentEntries([
      { type: 'session', id: 's', cwd: '/proj', timestamp: '2026-08-19T00:00:00Z' },
      registeredEntry({ origin: 'workflow', parentRunId: 'run-1', stepIndex: 2 }),
      settledEntry({ stopReason: 'completed', error: 'boom', engine: 'zcode', engineHandle }),
    ])

    // toEqual 忽略显式 undefined 键；v1 专有字段（closedReason / engineFallback 等）
    // 在 v2 条目无载体——不在本断言内
    expect(records).toEqual([{
      subagentId: 'sa-1',
      sessionFile: '/data/sa-1.jsonl',
      agent: 'worker',
      slug: 'work',
      task: 'Do work',
      status: 'idle',
      stopReason: 'completed',
      turns: 9,
      totalTokens: 1234,
      model: 'p/m',
      thinkingLevel: 'low',
      startedAt: 1000,
      endedAt: 61000,
      // elapsedSeconds 派生：条目无 duration 字段，从 startedAt/endedAt 差值（60s）
      elapsedSeconds: 60,
      error: 'boom',
      result: 'full result text',
      origin: 'workflow',
      parentRunId: 'run-1',
      stepIndex: 2,
      engine: 'zcode',
      engineHandle,
    }])
  })

  it('同 id 后到覆盖：同族条目各取最后一条（注册定身份 / 终态定终局），仅有注册条目 → running', () => {
    const records = scanSubagentEntries([
      registeredEntry({ agent: 'w1' }),
      registeredEntry({ agent: 'w2' }),
      settledEntry({ stopReason: 'interrupted' }),
      settledEntry({ stopReason: 'completed' }),
      registeredEntry({ id: 'sa-running', agent: 'w3' }),
    ])

    expect(records).toHaveLength(2)
    const settled = records.find((r) => r.subagentId === 'sa-1')
    expect(settled?.agent).toBe('w2') // 后到的注册条目定身份
    expect(settled?.stopReason).toBe('completed') // 后到的终态条目定终局
    expect(settled?.status).toBe('idle')

    const running = records.find((r) => r.subagentId === 'sa-running')
    expect(running?.status).toBe('running')
    expect(running?.stopReason).toBeUndefined()
    expect(running?.endedAt).toBeUndefined()
    expect(running?.sessionFile).toBeNull()
  })

  it('两态投影：终态条目在场 → idle + stopReason 原样下行；无终态条目 → running 且终局字段全空', () => {
    const idle = scanSubagentEntries([
      registeredEntry({ id: 'sa-idle' }),
      settledEntry({ id: 'sa-idle', stopReason: 'interrupted-by-restart' }),
    ])
    expect(idle[0]!.status).toBe('idle')
    expect(idle[0]!.stopReason).toBe('interrupted-by-restart')

    const running = scanSubagentEntries([registeredEntry({ id: 'sa-running' })])
    expect(running[0]!.status).toBe('running')
    expect(running[0]!.stopReason).toBeUndefined()
    expect(running[0]!.error).toBeUndefined()
    expect(running[0]!.result).toBeUndefined()
  })

  it('stopReason 来源单一（仅终态条目）：注册条目上的 stopReason 不读；终态值 string 宽透传不派生/不收窄', () => {
    // W4 死亡纳管态（running + stopReason）在 v2 无载体：running 判据 = 无终态条目，
    // 故「running + stopReason」脏组合读侧构造性不可达
    const running = scanSubagentEntries([registeredEntry({ id: 'sa-rf', stopReason: 'failed' })])
    expect(running[0]!.status).toBe('running')
    expect(running[0]!.stopReason).toBeUndefined()

    // 词表外/新增展示值 string 宽透传（shared 契约不因收窄丢字段）
    const settled = scanSubagentEntries([
      registeredEntry({ id: 'sa-s' }),
      settledEntry({ id: 'sa-s', stopReason: 'some-future-reason' }),
    ])
    expect(settled[0]!.status).toBe('idle')
    expect(settled[0]!.stopReason).toBe('some-future-reason')
  })

  it('不认识的版本/形态 entry 跳过（v1 已删快照 → future-v；v2 无 kind → unknown-kind）→ 全部无效落 legacy 兜底', () => {
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
    // warn 留证（版本漂移可观测）——静音输出，形状断言归 guards 文件
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    try {
      const records = scanSubagentEntries([
        // v1 全量快照形态（已删）：按版本判别跳过而非猜测
        { type: 'custom', customType: SUBAGENT_RECORD_CUSTOM_TYPE, data: { v: 1, id: 'sa-v1', status: 'running' } },
        // 当前版本但 kind 不在词表（半写/形态损坏）
        { type: 'custom', customType: SUBAGENT_RECORD_CUSTOM_TYPE, data: { v: 2, id: 'sa-no-kind' } },
        ...legacyEntries,
      ])

      // 自描述无命中 → legacy 兜底产出（数据滞后但可用）
      expect(records).toHaveLength(1)
      expect(records[0]!.subagentId).toBe('bg-legacy-1')
      expect(records[0]!.status).toBe('running')
    } finally {
      warn.mockRestore()
    }
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

  it('混合时自描述优先（同批 legacy 配对存在但有 v2 自描述命中即不走 legacy）', () => {
    const records = scanSubagentEntries([
      registeredEntry({ id: 'sa-self' }),
      // 完整 legacy 配对（toolCall + toolResult）——若走 legacy 兜底会产出 bg-legacy-3
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
