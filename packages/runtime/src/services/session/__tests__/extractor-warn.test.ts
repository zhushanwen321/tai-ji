/**
 * extractor 读侧降级 warn 显形测试（code-harden RT-5#6）。
 *
 * 锁定三处 catch→null 降级不再静默（共享 utils/warn-once 的按 key 去重范式）：
 * - workflow-extractor：state 文件损坏/为空 → 该 run 从列表消失前 warn（含路径）；
 * - history-rebuild-cache：segments.json sidecar 损坏 → 全降级占位文本前 warn；
 * - warn-once 去重：同 key 第二次降级不重复出声。
 * （subagent-extractor 的同款 warn 与前两处共用同一 helper；其链路级集成测试因 legacy
 * entries 构造成本未覆盖，由 utils/warn-once 单测保证机制。）
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/services/session/__tests__/extractor-warn.test.ts
 */
import { describe, it, expect, vi, type MockInstance, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractWorkflowsFromSessionFile } from '../workflow-extractor.js'
import { SessionHistoryReader } from '../history-rebuild-cache.js'
import { scanSubagentEntries } from '../subagent-extractor.js'
import { getAttachmentsDir } from '@taiji/shared/paths'
import { getPiAgentDir } from '../../../infra/pi/pi-paths.js'
import type { ISessionStore } from '../../ports/session.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import { _resetWarnOnceForTest } from '../../../utils/warn-once.js'

let dir: string
let warnSpy: MockInstance<typeof console.warn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'extractor-warn-rt5-'))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  _resetWarnOnceForTest()
})

afterEach(() => {
  warnSpy.mockRestore()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function stateLinkEntry(runId: string, path: string): string {
  return JSON.stringify({
    type: 'custom',
    id: 'e1',
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    customType: 'workflow-state-link',
    data: { runId, path },
  })
}

describe('workflow-extractor：state 文件降级 warn（RT-5#6）', () => {
  it('损坏 JSON 的 state 文件 → run 不再列出前 warn（含路径），同路径去重', () => {
    const statePath = join(dir, 'wf-state.jsonl')
    writeFileSync(statePath, '{not-json', 'utf-8')
    const jsonl = join(dir, 'session.jsonl')
    writeFileSync(jsonl, `${stateLinkEntry('run-1', statePath)}\n`, 'utf-8')

    const first = extractWorkflowsFromSessionFile(jsonl)
    expect(first.records).toEqual([])
    const msg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('JSON parse failed'))
    expect(msg).toBeDefined()
    expect(msg).toContain(statePath)

    // warn-once：同路径第二次降级不重复出声
    warnSpy.mockClear()
    extractWorkflowsFromSessionFile(jsonl)
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('JSON parse failed'))).toHaveLength(0)
  })

  it('空 state 文件（rewrite mode 异常形态）→ warn；ENOENT（已清理）保持安静', () => {
    const emptyState = join(dir, 'wf-empty.jsonl')
    writeFileSync(emptyState, '', 'utf-8')
    const jsonlEmpty = join(dir, 'session-empty.jsonl')
    writeFileSync(jsonlEmpty, `${stateLinkEntry('run-2', emptyState)}\n`, 'utf-8')
    extractWorkflowsFromSessionFile(jsonlEmpty)
    expect(warnSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes('is empty'))).toBe(true)

    // ENOENT：state 文件被清理链删除是常态，不告警
    warnSpy.mockClear()
    const jsonlGone = join(dir, 'session-gone.jsonl')
    writeFileSync(jsonlGone, `${stateLinkEntry('run-3', join(dir, 'cleaned-up.jsonl'))}\n`, 'utf-8')
    extractWorkflowsFromSessionFile(jsonlGone)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('history-rebuild-cache：segments.json sidecar 降级 warn（RT-5#6）', () => {
  it('sidecar 结构损坏（entries 非数组）→ 全降级占位文本前 warn（含路径）', async () => {
    const sessionId = 'warn-rt5-s1'
    // getAttachmentsDir(sessionId) 落在测试钉死的 tmp dataDir（白名单内），mkdtemp 额外
    // 证据目录由 fixture 语义自持：直接写坏 sidecar
    const sidecarDir = getAttachmentsDir(sessionId)
    mkdirSync(sidecarDir, { recursive: true })
    const sidecarPath = join(sidecarDir, 'segments.json')
    writeFileSync(sidecarPath, JSON.stringify({ entries: 'not-an-array' }), 'utf-8')

    const client = {
      getEntries: vi.fn(async () => ({
        data: { entries: [{ type: 'message', id: 'e1', parentId: null, timestamp: '2026-01-01T00:00:00Z' }], leafId: 'e1' },
      })),
    }
    const sessionStore = {
      scanSessions: vi.fn(() => []),
      rebuildHistoryFromEntries: vi.fn(() => ({ messages: [], orphanToolResults: [] })),
    } as unknown as ISessionStore
    const reader = new SessionHistoryReader({
      pm: { getClient: vi.fn(() => client) } as unknown as IProcessManager,
      sessionStore,
    })

    const result = await reader.getHistory(sessionId)
    expect(result.messages).toEqual([]) // 降级不炸重建
    const msg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('segments.json sidecar'))
    expect(msg).toBeDefined()
    expect(msg).toContain('结构损坏')
    expect(msg).toContain(sidecarPath)
  })
})

describe('subagent-extractor：session 目录读失败 warn（RT-5#6）', () => {
  it('subagent session 目录不可读（EACCES）→ warn 含目录，历史条目仍产出（sessionFile 为 null）', () => {
    const mainCwd = join(dir, 'main-cwd')
    // 预置 <piAgentDir>/subagents/--<encoded>--/sessions 目录并锁权限 → readdirSync EACCES
    const encoded = '--' + mainCwd.replace(/^\//, '').replace(/[/\\:]/g, '-') + '--'
    const sessionsDir = join(getPiAgentDir(), 'subagents', encoded, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    chmodSync(sessionsDir, 0o000)

    // legacy entries 最小链：session(cwd) + assistant(subagent toolCall) + toolResult(bgResponse)
    const entries: Array<Record<string, unknown>> = [
      { type: 'session', cwd: mainCwd },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', name: 'subagent', id: 'tc-1', arguments: { action: 'start', startParam: { task: 't' } } },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'subagent',
          toolCallId: 'tc-1',
          content: [{ type: 'text', text: JSON.stringify({ bgResponse: { status: 'completed' }, subagentId: 'sub-1' }) }],
        },
      },
    ]

    try {
      const records = scanSubagentEntries(entries)
      expect(records).toHaveLength(1) // 降级不炸提取
      expect(records[0]!.sessionFile).toBe(null)
      const msg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('subagent session dir unreadable'))
      expect(msg).toBeDefined()
      expect(msg).toContain(sessionsDir)
    } finally {
      chmodSync(sessionsDir, 0o755) // 恢复权限；目录在测试 dataDir 下由 guard 管辖，恢复后可清理
    }
  })
})
