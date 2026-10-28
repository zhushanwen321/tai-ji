/**
 * SubagentExtractor（encodeCwd / extractSubagents / background 回退 / scanSubagentEntries v2+legacy / guards 检查 / engine 派生视图 / 畸形输入 / 终局 result）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - subagent-extractor.test.ts
 * - subagent-extractor-guards.test.ts
 * - subagent-extractor-engine.test.ts
 * - subagent-extractor-legacy-malformed.test.ts
 * - subagent-extractor-result.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run test/subagent-extractor.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubagentRecord } from '@taiji/shared'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
import { SUBAGENT_RECORD_CUSTOM_TYPE } from '@zhushanwen/subagent-core'
import { encodeCwd } from '../src/infra/pi/pi-paths.js'
import { extractRecordEngine } from '../src/services/session/subagent-engine-history'
import { extractSubagentsFromSessionFile, scanSubagentEntries } from '../src/services/session/subagent-extractor.js'

vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSubagentSessionDir: () => mockSubagentDir.dir,
  }
})

const mockSubagentDir = { dir: '' }


describe('subagent-extractor', () => {
// mock getSubagentSessionDir 让回退查找测试用临时目录


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

  // v4 B-1：closed 统一终态携带 closedReason，extractor 映射到 SubagentRecord 供 renderer 派生展示
  it('v4 closed 终态 bg-notify（closedReason=gc + error）→ 映射出 status=closed + closedReason + error', () => {
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

  // 与实时路径（event-interpreter handleSubagentBgNotify）同构检查：closedReason 仅
  // status === 'closed' 时派生视图。最后一条 notify 为 running（轮次完成通知）时：
  // 1) notify 自身异常携带的 closedReason 被丢弃；2) 不从早先 list item（closed）兜底。
  it('running 终态检查：最后 notify 为 running 时 closedReason 不映射（无 running + closedReason 脏组合）', () => {
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
    // 检查生效：notify 异常残留与 listItem 兜底都不进入输出
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

  it('自描述命中：v2 条目对 → SubagentRecord 全字段派生视图（身份 / 终局 / 统计 / 引擎锚）', () => {
    const engineHandle = { sessionRef: { sessionId: 'z-1', dbPath: '/db/z.sqlite' }, poolKey: 'shared' }
    const records = scanSubagentEntries([
      { type: 'session', id: 's', cwd: '/proj', timestamp: '2026-08-19T00:00:00Z' },
      registeredEntry({ origin: 'workflow', parentRunId: 'run-1', stepIndex: 2 }),
      settledEntry({ stopReason: 'completed', error: 'boom', engine: 'zcode', engineHandle }),
    ])

    // toEqual 忽略显式 undefined 键；v1 专有字段（closedReason 等）
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

  it('两态派生视图：终态条目在场 → idle + stopReason 原样下行；无终态条目 → running 且终局字段全空', () => {
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
})

describe('subagent-extractor-guards', () => {
/**
 * subagent-extractor 畸形输入 / 派生视图检查定向测试（CRAP 检查清单：collectV2SubagentPair /
 * projectV2SubagentRecord / parseLegacyToolCallBlock / projectSubagentStartArgs /
 * projectLegacyToolResultData / buildLegacySubagentRecord）。
 *
 * [登记 §3.3] v1 全量快照派生视图（projectSelfDescribedSubagentRecord）与 v1 entry 扫描已随
 * 兼容层整体删除（项目未上线、无 v1 数据）——自描述派生视图用例改用现行 v2「注册 + 终态」
 * 条目对播种，断言收敛到幸存派生视图：身份域透传（origin 字面量检查 / parentRunId /
 * stepIndex）、缺省可选字段 → undefined / null（不发明默认值）、elapsedSeconds 派生、
 * engine/engineHandle 透传、同 id 后到覆盖。
 *
 * 已有 subagent-extractor.test.ts 覆盖正常路径（条目对派生视图 / bg-notify 终态 /
 * sessionFile 回退扫描）；本文件专测形状检查族——输入源是 LLM 生成的 toolCall
 * arguments / toolResult 文本 JSON.parse 产物 / extension 写入的 entry data（全部
 * 不可信），畸形值不得以谎报类型直达 SubagentRecord（下游 readFileSync 对非 string
 * sessionFile 会 throw）。
 *
 * 运行：cd packages/runtime && npx vitest run test/subagent-extractor-guards.test.ts
 */
/** v2 注册条目 entry 构造（type:'custom' 是 pi JSONL 持久化层形态；身份域基线）。 */
function registeredEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: SUBAGENT_RECORD_CUSTOM_TYPE,
    id: 'e-registered',
    parentId: null,
    timestamp: '2026-09-26T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      id: 'sub-1',
      agent: 'worker',
      task: 'do',
      slug: 'w1',
      origin: 'tool',
      rootSessionId: 's1',
      depth: 0,
      startedAt: 1000,
      ...overrides,
    },
  }
}

/** v2 终态条目 entry 构造（终局域基线，畸形字段逐个覆写）。 */
function settledEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: SUBAGENT_RECORD_CUSTOM_TYPE,
    id: 'e-settled',
    parentId: null,
    timestamp: '2026-09-26T00:00:01Z',
    data: {
      v: 2,
      kind: 'settled',
      id: 'sub-1',
      status: 'idle',
      stopReason: 'completed',
      endedAt: 61000,
      turns: 3,
      totalTokens: 100,
      model: 'p/m',
      thinkingLevel: 'low',
      ...overrides,
    },
  }
}

/** v1 专有字段在 v2 派生视图上无载体：键不出现（不是「键在场值为 undefined」）。 */
function expectAbsentKey(record: SubagentRecord, key: string): void {
  expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(false)
}

/** [legacy] assistant toolCall block 构造。 */
function toolCallBlock(args: unknown, id = 'tc-1'): Record<string, unknown> {
  return { type: 'toolCall', name: 'subagent', id, arguments: args }
}

/** [legacy] toolResult message entry 构造（content[0].text = JSON 字符串）。 */
function toolResultEntry(toolCallId: string, text: string): Record<string, unknown> {
  return {
    type: 'message',
    message: { role: 'toolResult', toolName: 'subagent', toolCallId, content: [{ type: 'text', text }] },
  }
}

const find = (records: SubagentRecord[], id: string): SubagentRecord | undefined =>
  records.find((r) => r.subagentId === id)

/** [legacy] assistant start toolCall block（module 级共享 fixture）。 */
const startBlock = toolCallBlock({ action: 'start', startParam: { agent: 'worker', task: 't' } })

/** [legacy] toolCall × toolResult 配对 entries（module 级共享 fixture）。 */
function pair(toolResultText: string, block: Record<string, unknown> = startBlock): Array<Record<string, unknown>> {
  return [
    { type: 'message', message: { role: 'assistant', content: [block] } },
    toolResultEntry('tc-1', toolResultText),
  ]
}

describe('v2 subagent-record 条目派生视图检查（collectV2SubagentPair / projectV2SubagentRecord）', () => {
  it('注册条目 id 非字符串 → 该条目跳过，同批其余合法注册条目照常产出（在途态）', () => {
    const records = scanSubagentEntries([
      registeredEntry({ id: 123 }), // id 畸形：number
      registeredEntry({ id: 'sub-ok' }),
    ])
    expect(records.map((r) => r.subagentId)).toEqual(['sub-ok'])
    // 无终态条目 → 两态判据落 running
    expect(records[0].status).toBe('running')
  })

  it('缺注册条目的终态条目不成实体（身份无所出）→ 无自描述命中（同批无 legacy 配对时空数组）', () => {
    expect(scanSubagentEntries([settledEntry({ id: 'sub-orphan' })])).toEqual([])
  })

  it('缺省可选字段 → undefined / null（不发明默认值），身份字段恒取注册条目原值', () => {
    const records = scanSubagentEntries([registeredEntry({ origin: 'bogus' })]) // 无终态条目
    const r = records[0]
    expect(r.status).toBe('running')
    expect(r.sessionFile).toBeNull() // 无终态条目 → null（不猜路径）
    expect(r.stopReason).toBeUndefined()
    expect(r.turns).toBeUndefined()
    expect(r.totalTokens).toBeUndefined()
    expect(r.model).toBeUndefined()
    expect(r.thinkingLevel).toBeUndefined()
    expect(r.endedAt).toBeUndefined()
    expect(r.elapsedSeconds).toBeUndefined()
    expect(r.error).toBeUndefined()
    expect(r.result).toBeUndefined()
    expect(r.parentRunId).toBeUndefined()
    expect(r.stepIndex).toBeUndefined()
    // origin 字面量检查：非法值 → undefined（= tool 语义，不发明出处）
    expect(r.origin).toBeUndefined()
    // v1 派生视图的 agent/slug/task 兜底（general-purpose / 空串）已随兼容层删除：
    // v2 身份域原样透传注册条目值
    expect(r.agent).toBe('worker')
    expect(r.slug).toBe('w1')
    expect(r.task).toBe('do')
    expect(r.startedAt).toBe(1000)
  })

  it('v1 专有字段无 v2 载体：closedReason/eventLog/displayItems/batchFinalized/worktree/round/patchFile/resumable/chatMode 键不出现', () => {
    const v1OnlyFields = {
      closedReason: 'gc',
      eventLog: [{ type: 'record-created' }],
      displayItems: ['x'],
      batchFinalized: true,
      worktree: true,
      round: 2,
      patchFile: '/tmp/x.patch',
      resumable: true,
      chatMode: 'chat',
    }
    const records = scanSubagentEntries([
      registeredEntry(v1OnlyFields),
      settledEntry(v1OnlyFields),
    ])
    expect(records).toHaveLength(1)
    for (const key of Object.keys(v1OnlyFields)) expectAbsentKey(records[0], key)
    // 终态条目在场 → idle；stopReason 原样下行（不派生展示值）
    expect(records[0].status).toBe('idle')
    expect(records[0].stopReason).toBe('completed')
  })

  it('elapsedSeconds 派生：endedAt ≥ startedAt 按差值取整秒；负时长/缺任一端不派生', () => {
    const ok = scanSubagentEntries([
      registeredEntry({ startedAt: 1000 }),
      settledEntry({ endedAt: 61000 }),
    ])
    expect(ok[0].elapsedSeconds).toBe(60) // 60000ms → 60s

    // 负时长是脏数据 → 不派生
    const dirty = scanSubagentEntries([
      registeredEntry({ startedAt: 61000 }),
      settledEntry({ endedAt: 1000 }),
    ])
    expect(dirty[0].elapsedSeconds).toBeUndefined()

    // 无终态条目（无 endedAt）→ 不派生
    const running = scanSubagentEntries([registeredEntry({ startedAt: 1000 })])
    expect(running[0].elapsedSeconds).toBeUndefined()
  })

  // R3-1（H2 阶段 3 一致性审查修复）：origin 透传断言——此前派生视图白名单漏 origin，
  // renderer 过滤面（badge 计数 / hasRunning / 列表桶）origin 恒 undefined，workflow
  // record 运行期虚亮。检查语义对齐 core readEntryOriginFields：仅认 'tool'|'workflow'
  // 字面量，非法值/缺省 → undefined（= tool 语义，存量 record 零迁移）。
  it('身份域透传：origin 字面量检查 + parentRunId/stepIndex 透传（renderer 过滤面 / run 视图数据源契约）', () => {
    const projected = scanSubagentEntries([
      registeredEntry({ id: 'sub-wf', origin: 'workflow', parentRunId: 'run-1', stepIndex: 2 }),
      registeredEntry({ id: 'sub-tool', origin: 'tool' }),
      registeredEntry({ id: 'sub-bogus', origin: 'bogus' }), // 非法字面量
      registeredEntry({ id: 'sub-absent', origin: undefined }), // 缺省（契约外存量）
    ])
    const byId = (id: string): SubagentRecord | undefined => projected.find((r) => r.subagentId === id)
    expect(byId('sub-wf')?.origin).toBe('workflow')
    expect(byId('sub-wf')?.parentRunId).toBe('run-1')
    expect(byId('sub-wf')?.stepIndex).toBe(2)
    expect(byId('sub-tool')?.origin).toBe('tool')
    expect(byId('sub-tool')?.parentRunId).toBeUndefined()
    expect(byId('sub-tool')?.stepIndex).toBeUndefined()
    expect(byId('sub-bogus')?.origin).toBeUndefined()
    expect(byId('sub-absent')?.origin).toBeUndefined()
  })

  it('engine/engineHandle 透传：终态条目携带则原样派生视图，缺省则键不出现（不填默认值）', () => {
    const engineHandle = {
      sessionRef: { sessionId: 'z-1', dbPath: '/db/z.sqlite' },
      eventsPath: '/journal/z.jsonl',
      poolKey: 'shared',
    }
    const withEngine = scanSubagentEntries([
      registeredEntry(),
      settledEntry({ engine: 'zcode', engineHandle }),
    ])
    expect(withEngine[0].engine).toBe('zcode')
    expect(withEngine[0].engineHandle).toEqual(engineHandle)

    const withoutEngine = scanSubagentEntries([registeredEntry(), settledEntry()])
    expectAbsentKey(withoutEngine[0], 'engine')
    expectAbsentKey(withoutEngine[0], 'engineHandle')
  })

  it('版本/形态不认识的 entry 跳过并 warn 留证（v1 已删形态 → future-v；v2 无 kind → unknown-kind）', () => {
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    try {
      const records = scanSubagentEntries([
        { type: 'custom', customType: SUBAGENT_RECORD_CUSTOM_TYPE, data: { v: 1, id: 'sub-old', status: 'running' } },
        { type: 'custom', customType: SUBAGENT_RECORD_CUSTOM_TYPE, data: { v: 2, id: 'sub-no-kind' } },
      ])
      expect(records).toEqual([])
      expect(warn).toHaveBeenCalledTimes(2)
      expect(String(warn.mock.calls[0][0])).toContain('future-v')
      expect(String(warn.mock.calls[1][0])).toContain('unknown-kind')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('legacy toolCall arguments 检查（parseLegacyToolCallBlock + projectSubagentStartArgs）', () => {
  const startArgs = { action: 'start', startParam: { agent: 'worker', slug: 'w', task: 't' } }
  const bgResult = JSON.stringify({ action: 'start', subagentId: 'sub-bg', sessionFile: null, bgResponse: { status: 'running' } })

  it('action 非 start（list/status 等）→ 跳过该 block 不产出记录', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', content: [toolCallBlock({ action: 'list' }, 'tc-1')] } },
    ]
    expect(scanSubagentEntries(entries)).toEqual([])
  })

  it('startParam 非对象（string / array / null / 缺失）→ 跳过（LLM 畸形参数不进派生视图）', () => {
    for (const bad of ['just-a-string', ['array'], null, undefined]) {
      const entries = [
        { type: 'message', message: { role: 'assistant', content: [toolCallBlock({ action: 'start', startParam: bad })] } },
        // 有 bgResponse 的配对 toolResult（无 toolCall 配对则本就无记录——需成对验证检查拆散配对）
        { type: 'message', message: { role: 'toolResult', toolName: 'subagent', toolCallId: 'tc-1', content: [{ type: 'text', text: bgResult }] } },
      ]
      expect(scanSubagentEntries(entries)).toEqual([])
    }
  })

  it('startParam 字段畸形（agent 非字符串）→ 字段缺省兜底（agent 兜底 general-purpose）', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', content: [toolCallBlock({ action: 'start', startParam: { agent: 99, slug: ['x'], task: null } })] } },
      { type: 'message', message: { role: 'toolResult', toolName: 'subagent', toolCallId: 'tc-1', content: [{ type: 'text', text: bgResult }] } },
    ]
    const records = scanSubagentEntries(entries)
    expect(records).toHaveLength(1)
    expect(records[0].agent).toBe('general-purpose') // 畸形 agent 缺省 → DEFAULT_AGENT_NAME 兜底
    expect(records[0].slug).toBe('')
    expect(records[0].task).toBe('')
  })
})

describe('legacy toolResult 文本 JSON 检查（projectLegacyToolResultData）', () => {
  function withToolResult(text: string): Array<Record<string, unknown>> {
    return pair(text)
  }

  it('JSON.parse 产物非 plain object（string / number / array / null）→ 整条丢弃不产出', () => {
    // 任意合法 JSON 都能 parse 成功——parse 成功 ≠ 形状正确，检查在此
    expect(scanSubagentEntries(withToolResult('"just a string"'))).toEqual([])
    expect(scanSubagentEntries(withToolResult('42'))).toEqual([])
    expect(scanSubagentEntries(withToolResult('[1,2,3]'))).toEqual([])
    expect(scanSubagentEntries(withToolResult('null'))).toEqual([])
  })

  it('bgResponse.status / message 畸形 → status 兜底空串、message 缺省（不透传谎报类型）', () => {
    const records = scanSubagentEntries(withToolResult(JSON.stringify({
      action: 'start',
      subagentId: 'sub-bg',
      sessionFile: 123, // 畸形：number（裸断言会让 readFileSync 对非 string throw）
      bgResponse: { status: 7, message: ['nope'] },
    })))
    expect(records).toHaveLength(1)
    // 配对成立（bgResponse 存在即产出记录），畸形字段归检查缺省
    expect(records[0].subagentId).toBe('sub-bg')
    expect(records[0].sessionFile).toBeNull() // 畸形 sessionFile → null（不透传 number）
  })

  it('listResponse 畸形族：items 非数组 / running 非数字 / 元素级畸形——全部检查不崩，配对 bgResponse 时合法 item 照常映射', () => {
    // items 非数组 + running 畸形：parse 映射为 { running: 0, items: [] }，不崩不产记录
    expect(scanSubagentEntries(pair(JSON.stringify({
      action: 'list',
      listResponse: { running: 'many', items: 'not-an-array' },
    })))).toEqual([])

    // items 元素级畸形（'garbage-item' 字符串 / 无 subagentId 的坏 item）：过滤后合法
    // sub-a 照常映射（bgResponse 配对成立 → 记录产出，listItem 状态/sessionFile 生效）
    const records = scanSubagentEntries(pair(JSON.stringify({
      action: 'start',
      subagentId: 'sub-x',
      sessionFile: null,
      bgResponse: { status: 'running' },
      listResponse: {
        running: 1,
        items: [
          { subagentId: 'sub-a', status: 'running', sessionFile: '/sub-a.jsonl', totalTokens: 100, duration: 5 },
          'garbage-item',
          { status: 'closed' }, // 无 subagentId：合并时被 subagentId 空串键跳过（listItems 只收非空 id）
        ],
      },
    })))
    expect(records).toHaveLength(1)
    expect(records[0].subagentId).toBe('sub-x')
    // sub-x 自身无 listItem（sub-a 是别人的）→ 状态回落 bgResponse.status='running' 归一
    expect(records[0].status).toBe('running')
    expect(records[0].sessionFile).toBeNull()
  })
})

describe('legacy record 构造检查（buildLegacySubagentRecord：sessionFile 三级回退链）', () => {
  it('sessionFile 回退链：listItem.sessionFile 优先于 toolResult.sessionFile', () => {
    const records = scanSubagentEntries(pair(JSON.stringify({
      action: 'start',
      subagentId: 'sub-x',
      sessionFile: '/from-toolResult.jsonl',
      bgResponse: { status: 'running' },
      listResponse: { running: 1, items: [{ subagentId: 'sub-x', status: 'running', sessionFile: '/from-listItem.jsonl' }] },
    })))
    expect(records[0].sessionFile).toBe('/from-listItem.jsonl')
  })

  it('两级都缺（null）且无 mainCwd → 保持 null（不猜路径）', () => {
    const records = scanSubagentEntries(pair(JSON.stringify({
      action: 'start',
      subagentId: 'sub-y',
      sessionFile: null,
      bgResponse: { status: 'running' },
    })))
    expect(records[0].sessionFile).toBeNull()
  })

  it('同 subagentId 的重复配对去重（首个配对胜出，不产重复记录）', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', content: [startBlock, toolCallBlock({ action: 'start', startParam: { agent: 'w', task: 't2' } }, 'tc-2')] } },
      toolResultEntry('tc-1', JSON.stringify({ action: 'start', subagentId: 'sub-dup', sessionFile: null, bgResponse: { status: 'running' } })),
      toolResultEntry('tc-2', JSON.stringify({ action: 'start', subagentId: 'sub-dup', sessionFile: null, bgResponse: { status: 'running' } })),
    ]
    const records = scanSubagentEntries(entries)
    expect(records).toHaveLength(1)
    expect(find(records, 'sub-dup')).toBeDefined()
  })
})
})

describe('subagent-extractor-engine', () => {
/**
 * subagent-extractor engine 字段派生视图（v2 条目对：engine/engineHandle 只在终态条目上）。
 *
 * 背景（v1 全量快照条目兼容层已随「项目未上线、无 v1 数据」删除）：scanSubagentEntries
 * 只认 v2 条目对——每个 id = 一条 registered（身份）+ 可选一条 settled（终局）。
 * engine / engineHandle 是终态条目的字段（v2 schema 见 core record-entry.ts），派生视图层
 * 逐字透传（不做形状/值检查）。缺省=pi 由读侧 extractRecordEngine 映射，派生视图层不填默认值。
 *
 * 锁定：
 * - 终态条目 engine/engineHandle 逐项映射（sessionRef 键不枚举整体透传）
 * - engineHandle 无 eventsPath → 该键缺席（可选字段）
 * - 仅注册条目（未终态）→ engine/engineHandle 均 undefined，status=running
 * - 派生视图产物喂读侧 extractRecordEngine：缺省/空串 → 'pi'，非空透传（读写两侧对齐）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/subagent-extractor-engine.test.ts
 */
/** v2 注册条目（身份；engine 系字段不在此条目上——v2 schema 归属终态条目）。 */
function registeredEntry(id: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `e-${id}-reg`,
    parentId: null,
    timestamp: '2026-08-25T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      id,
      agent: 'worker',
      task: 'Do work',
      slug: 'work',
      origin: 'tool',
      rootSessionId: 'root-1',
      depth: 0,
      startedAt: 1000,
      ...data,
    },
  }
}

/** v2 终态条目（终局 + 摘要 + 引擎绑定；engine/engineHandle 的唯一载体）。 */
function settledEntry(id: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `e-${id}-set`,
    parentId: null,
    timestamp: '2026-08-25T00:01:00Z',
    data: {
      v: 2,
      kind: 'settled',
      id,
      status: 'idle',
      stopReason: 'completed',
      endedAt: 2000,
      turns: 1,
      totalTokens: 10,
      model: 'test-model',
      thinkingLevel: 'low',
      ...data,
    },
  }
}

describe('scanSubagentEntries · engine/engineHandle 派生视图（v2：终态条目承载）', () => {
  it('终态条目完整形态 → engine/engineHandle 逐项映射（sessionRef 键不枚举整体透传）', () => {
    const records = scanSubagentEntries([
      registeredEntry('sa-1'),
      settledEntry('sa-1', {
        engine: 'zcode',
        engineHandle: {
          sessionRef: { sessionId: 's-1', dbPath: 'pool/zcode.db' },
          eventsPath: '/abs/engines/zcode/p1/journal.jsonl',
          poolKey: 'p1',
        },
      }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0].engine).toBe('zcode')
    expect(records[0].engineHandle).toEqual({
      sessionRef: { sessionId: 's-1', dbPath: 'pool/zcode.db' },
      eventsPath: '/abs/engines/zcode/p1/journal.jsonl',
      poolKey: 'p1',
    })
  })

  it('终态条目 engineHandle 无 eventsPath → 映射省略该键（可选字段）', () => {
    const records = scanSubagentEntries([
      registeredEntry('sa-2'),
      settledEntry('sa-2', {
        engine: 'zcode',
        engineHandle: { sessionRef: { sessionId: 's-2' }, poolKey: 'p2' },
      }),
    ])
    expect(records[0].engineHandle).toEqual({ sessionRef: { sessionId: 's-2' }, poolKey: 'p2' })
    expect(records[0].engineHandle?.eventsPath).toBeUndefined()
  })

  it('仅注册条目（未终态）→ engine/engineHandle 均 undefined（绑定只随终态条目落盘）', () => {
    const records = scanSubagentEntries([registeredEntry('sa-3')])
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('running')
    expect(records[0].engine).toBeUndefined()
    expect(records[0].engineHandle).toBeUndefined()
  })

  it('终态条目无 engine 系字段 → engine/engineHandle 均 undefined（派生视图层不填默认值）', () => {
    const records = scanSubagentEntries([registeredEntry('sa-4'), settledEntry('sa-4')])
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('idle')
    expect(records[0].engine).toBeUndefined()
    expect(records[0].engineHandle).toBeUndefined()
  })
})

describe('派生视图产物 ↔ 读侧 extractRecordEngine 对齐（subagent-engine-history 兼容）', () => {
  it('无终态条目（无 engine）派生视图 → 读侧缺省映射 pi', () => {
    const [record] = scanSubagentEntries([registeredEntry('sa-20')])
    expect(extractRecordEngine(record)).toBe('pi')
  })

  it('终态条目 engine 空串（派生视图逐字透传）→ 读侧归一 pi（缺省判定在读侧）', () => {
    const [record] = scanSubagentEntries([
      registeredEntry('sa-21'),
      settledEntry('sa-21', { engine: '' }),
    ])
    expect(record.engine).toBe('')
    expect(extractRecordEngine(record)).toBe('pi')
  })

  it('非空 engine 派生视图 → 读侧透传（zcode 路由可达）', () => {
    const [record] = scanSubagentEntries([
      registeredEntry('sa-22'),
      settledEntry('sa-22', { engine: 'zcode' }),
    ])
    expect(extractRecordEngine(record)).toBe('zcode')
  })
})
})

describe('subagent-extractor-legacy-malformed', () => {
/**
 * subagent-extractor legacy 路径畸形输入测试（R2-TC S4）。
 *
 * 锁定 legacy 兜底解析（extractSubagentsFromEntriesLegacy）对不可信输入的逐层 shape 检查：
 * 1. toolCall block action!=='start'（如 list）→ projectSubagentStartArgs 返回 null，块跳过
 * 2. toolResult content[0].text 非 JSON（如错误消息纯文本）→ parse 失败 null，条目跳过
 * 3. assistant content / 顶层 entries 含非 object 元素 → parseLegacyToolCallBlock null，不抛错
 *
 * 三例均不抛异常、坏输入静默跳过、同批好输入正常产出（坏块不污染好块）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/subagent-extractor-legacy-malformed.test.ts
 */
/** assistant message entry（content blocks 自由拼装） */
function assistantEntry(content: unknown[]): Record<string, unknown> {
  return { type: 'message', message: { role: 'assistant', content } }
}

/** subagent toolResult message entry（text 为 JSON 字符串） */
function toolResultEntry(toolCallId: string, text: string): Record<string, unknown> {
  return {
    type: 'message',
    message: { role: 'toolResult', toolName: 'subagent', toolCallId, content: [{ type: 'text', text }] },
  }
}

/** 合法 start toolCall block */
function startBlock(id: string, startParam: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'toolCall', name: 'subagent', id, arguments: { action: 'start', startParam } }
}

/** 合法 background start toolResult 文本 */
const BG_START_RESULT = JSON.stringify({
  action: 'start',
  subagentId: 'bg-ok-1',
  sessionFile: null,
  bgResponse: { status: 'running', message: 'detached' },
})

describe('scanSubagentEntries · legacy 路径畸形输入（R2-TC S4）', () => {
  it('toolCall block action!==start（list）→ 跳过该块，不产出 record；同批合法 start 块正常配对', () => {
    const records = scanSubagentEntries([
      assistantEntry([
        // action: 'list' 的 subagent toolCall——非 start，须被 projectSubagentStartArgs 丢弃。
        // 故意带合法 startParam + bgResponse toolResult：若 action 检查缺失，该块会通过
        // startParam 形状检查（重叠防护穿透）凭空产出 ghost record——此构造使 action 检查独立可观测。
        {
          type: 'toolCall',
          name: 'subagent',
          id: 'tc-list',
          arguments: { action: 'list', startParam: { agent: 'worker', task: 'List tasks', slug: 'ls' } },
        },
        startBlock('tc-ok', { agent: 'worker', task: 'Do work', slug: 'work' }),
      ]),
      // tc-list 的 toolResult 带 bgResponse（若 toolCall 未被丢弃即可配对成 record）
      toolResultEntry('tc-list', JSON.stringify({ action: 'list', subagentId: 'bg-ghost', sessionFile: null, bgResponse: { status: 'running', message: 'detached' } })),
      toolResultEntry('tc-ok', BG_START_RESULT),
    ])

    // 只产出合法 start 配对的 1 条；list 块被跳过（无 bg-ghost）
    expect(records).toHaveLength(1)
    expect(records[0].subagentId).toBe('bg-ok-1')
    expect(records[0].task).toBe('Do work')
    expect(records.some((r) => r.subagentId === 'bg-ghost')).toBe(false)
  })

  it('toolResult text 非 JSON（错误消息纯文本）/ 空 content / 无 text block → 条目跳过，不抛错', () => {
    const records = scanSubagentEntries([
      assistantEntry([startBlock('tc-1', { task: 'T1' })]),
      // 非 JSON：pi 工具错误消息（如 "startParam is required"），JSON.parse 抛 → null
      toolResultEntry('tc-1', 'startParam is required'),
      // 空 content 数组 → null
      { type: 'message', message: { role: 'toolResult', toolName: 'subagent', toolCallId: 'tc-1', content: [] } },
      // 首块非 text → null
      {
        type: 'message',
        message: { role: 'toolResult', toolName: 'subagent', toolCallId: 'tc-1', content: [{ type: 'image', url: 'x' }] },
      },
    ])

    expect(records).toEqual([])
  })

  it('toolResult text 合法 JSON 但非 object（string/array）→ 整条丢弃；不产出 record', () => {
    // JSON.parse 成功 ≠ 形状正确：'"just a string"' / '[1,2]' 都是合法 JSON
    const records = scanSubagentEntries([
      assistantEntry([startBlock('tc-s', { task: 'S' })]),
      toolResultEntry('tc-s', '"just a string"'),
      assistantEntry([startBlock('tc-a', { task: 'A' })]),
      toolResultEntry('tc-a', '[1,2,3]'),
    ])

    expect(records).toEqual([])
  })

  it('assistant content / 顶层 entries 含非 object 元素（string/number/null/数组 arguments）→ 不抛错，全跳过', () => {
    const records = scanSubagentEntries([
      // 顶层非 object entry
      42,
      'not-an-entry',
      null,
      // content 混入非 object block + arguments 非 plain object（string/数组）
      assistantEntry([
        'plain string block',
        42,
        null,
        { type: 'toolCall', name: 'subagent', id: 'tc-args-str', arguments: 'not-an-object' },
        { type: 'toolCall', name: 'subagent', id: 'tc-args-arr', arguments: ['action', 'start'] },
        { type: 'text', text: 'assistant 说的话' },
      ]),
    ])

    expect(records).toEqual([])
  })
})
})

describe('subagent-extractor-result', () => {
/**
 * subagent-extractor 终局 result 派生视图（v2 条目对）。
 *
 * 锁定：result 是 v2 终态条目（settled）的字段——终局结果全文一次性写（事件文件只存
 * 摘要锚，本条目是全文唯一落点），派生视图层逐字透传（subagent-core record-entry.ts
 * SubagentRecordSettledEntryData.result）。终态条目在场即 status 归一 idle（两态词表：
 * 终局收敛 idle + stopReason 表达「为什么停」）；无 result 字段 → undefined
 * （settled 条目未携带 / 未终态）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/subagent-extractor-result.test.ts
 */
/** v2 注册条目（身份）。 */
function registeredEntry(id: string): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `e-${id}-reg`,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      id,
      agent: 'worker',
      task: 'Do work',
      slug: 'work',
      origin: 'tool',
      rootSessionId: 'root-1',
      depth: 0,
      startedAt: 1000,
    },
  }
}

/** v2 终态条目（result 的唯一载体；同 id 多次补写时后到覆盖）。 */
function settledEntry(id: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `e-${id}-set`,
    parentId: null,
    timestamp: '2026-08-19T00:00:01Z',
    data: {
      v: 2,
      kind: 'settled',
      id,
      status: 'idle',
      stopReason: 'completed',
      endedAt: 2000,
      turns: 1,
      totalTokens: 10,
      model: 'test-model',
      thinkingLevel: 'low',
      ...data,
    },
  }
}

describe('scanSubagentEntries · 终局 result 派生视图（v2 终态条目）', () => {
  it('终态条目 result 有值 → SubagentRecord.result 派生视图（status 归一 idle）', () => {
    const records = scanSubagentEntries([
      registeredEntry('bg-1'),
      settledEntry('bg-1', { result: '本轮产出正文' }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('idle')
    expect(records[0].result).toBe('本轮产出正文')
  })

  it('同 id 后到的终态条目覆盖先到的：result 以最后一条为准（收编幂等补写语义）', () => {
    const records = scanSubagentEntries([
      registeredEntry('bg-1'),
      settledEntry('bg-1', { result: '(no output this round)' }),
      settledEntry('bg-1', { result: '补写的终局正文' }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0].result).toBe('补写的终局正文')
  })

  it('无 result 字段 → undefined（未终态 / 终态条目未携带全文）', () => {
    const records = scanSubagentEntries([
      registeredEntry('bg-2'),
      registeredEntry('bg-3'),
      settledEntry('bg-3'),
    ])
    expect(records).toHaveLength(2)
    expect(records.find((r) => r.subagentId === 'bg-2')?.result).toBeUndefined()
    expect(records.find((r) => r.subagentId === 'bg-3')?.result).toBeUndefined()
  })
})
})
