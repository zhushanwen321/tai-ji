/**
 * 会话消息计数单元测试（悬停详情卡消息计数）。
 *
 * 覆盖 countSessionMessagesInFile 纯文件读侧：
 * - 混合条目计数正确：user/assistant message entry 计入；toolResult/system role、
 *   thinking_level_change / model_change / usage / compaction / session_info / custom /
 *   custom_message / context_edit / label / session header 不计入（口径证据 =
 *   pi 1.0 实装 session-manager.d.ts:128-129 SessionEntry 联合 + :23-26
 *   SessionMessageEntry；core apply-entry-convert.ts:382 同口径跳过非 user/assistant）
 * - 文件不存在（pi 延迟写入窗口）→ 0 不报错
 * - 损坏行跳过不中断计数
 * - 多行大文件流式计数正确（实现面 = createReadStream + readline 恒定内存）
 * - 目录路径（EISDIR）→ 上抛（读失败错误回传语义，区别于 ENOENT 归 0）
 *
 * 夹具全部落在 `mkdtempSync(tmpdir())` 自建自删（仓规测试红线：禁触碰真实数据目录）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-message-count.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { countSessionMessagesInFile } from '../session-message-count.js'

let base: string | null = null

function fixturePath(name: string): string {
  if (!base) base = mkdtempSync(join(tmpdir(), 'taiji-session-message-count-'))
  return join(base, name)
}

afterEach(() => {
  if (base) {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    base = null
  }
})

/** pi 1.0 FileEntry 形态的最小 JSONL 行构造（SessionHeader / SessionEntry 联合各成员） */
const lines = {
  header: { type: 'session', version: 3, id: 'sess-1', timestamp: '2026-10-12T00:00:00Z', cwd: '/p' },
  userMessage: { type: 'message', id: 'e1', parentId: null, timestamp: 't', message: { role: 'user', content: '你好', timestamp: 1 } },
  assistantMessage: { type: 'message', id: 'e2', parentId: 'e1', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: '回复' }], model: 'm', provider: 'p', usage: {}, timestamp: 2 } },
  toolResultMessage: { type: 'message', id: 'e3', parentId: 'e2', timestamp: 't', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 } },
  systemMessage: { type: 'message', id: 'e4', parentId: 'e2', timestamp: 't', message: { role: 'system', content: 'sys', timestamp: 4 } },
  thinkingLevelChange: { type: 'thinking_level_change', id: 'e5', parentId: 'e2', timestamp: 't', thinkingLevel: 'high' },
  modelChange: { type: 'model_change', id: 'e6', parentId: 'e2', timestamp: 't', provider: 'p', modelId: 'm2' },
  usage: { type: 'usage', id: 'e7', parentId: 'e2', timestamp: 't', kind: 'cache_warm', provider: 'p', model: 'm', usage: {} },
  compaction: { type: 'compaction', id: 'e8', parentId: 'e2', timestamp: 't', summary: '摘要', firstKeptEntryId: 'e1', tokensBefore: 100 },
  sessionInfo: { type: 'session_info', id: 'e9', parentId: null, timestamp: 't', name: '我的会话' },
  custom: { type: 'custom', id: 'e10', parentId: 'e2', timestamp: 't', customType: 'x', data: {} },
  customMessage: { type: 'custom_message', id: 'e11', parentId: 'e2', timestamp: 't', customType: 'x', content: 'ctx', display: false },
  contextEdit: { type: 'context_edit', id: 'e12', parentId: 'e2', timestamp: 't', targetId: 'e1', replacement: null },
  label: { type: 'label', id: 'e13', parentId: null, timestamp: 't', targetId: 'e1', label: '书签' },
} as const

function jsonlOf(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

describe('countSessionMessagesInFile 计数口径', () => {
  it('混合条目：只计 user/assistant message entry（header/toolResult/system/其余 entry 类型不计）', async () => {
    const file = fixturePath('mixed.jsonl')
    writeFileSync(file, jsonlOf(
      lines.header,
      lines.userMessage,
      lines.assistantMessage,
      lines.toolResultMessage,
      lines.systemMessage,
      lines.thinkingLevelChange,
      lines.modelChange,
      lines.usage,
      lines.compaction,
      lines.sessionInfo,
      lines.custom,
      lines.customMessage,
      lines.contextEdit,
      lines.label,
    ))

    await expect(countSessionMessagesInFile(file)).resolves.toBe(2)
  })

  it('多轮交替消息：每条 user/assistant 各计 1', async () => {
    const file = fixturePath('turns.jsonl')
    writeFileSync(file, jsonlOf(
      lines.header,
      lines.userMessage,
      lines.toolResultMessage,
      lines.assistantMessage,
      lines.userMessage,
      lines.assistantMessage,
    ))

    await expect(countSessionMessagesInFile(file)).resolves.toBe(4)
  })

  it('损坏行（非法 JSON / 半写尾行）跳过不中断计数', async () => {
    const file = fixturePath('corrupted.jsonl')
    writeFileSync(file, jsonlOf(lines.header, lines.userMessage) + '{"type":"message","id":"half",\n' + jsonlOf(lines.assistantMessage))

    await expect(countSessionMessagesInFile(file)).resolves.toBe(2)
  })

  it('空行与空白行不计（合法 JSONL 形态容忍）', async () => {
    const file = fixturePath('blank-lines.jsonl')
    writeFileSync(file, '\n' + JSON.stringify(lines.userMessage) + '\n\n   \n' + JSON.stringify(lines.assistantMessage) + '\n')

    await expect(countSessionMessagesInFile(file)).resolves.toBe(2)
  })

  it('纯 header 文件（pi 延迟写入后未产生消息的合法形态）→ 0', async () => {
    const file = fixturePath('header-only.jsonl')
    writeFileSync(file, jsonlOf(lines.header))

    await expect(countSessionMessagesInFile(file)).resolves.toBe(0)
  })
})

describe('countSessionMessagesInFile 失败语义', () => {
  it('文件不存在（pi 延迟写入窗口）→ 0 不报错', async () => {
    const file = fixturePath('not-exist.jsonl')
    rmSync(file, { force: true }) // 确保不存在

    await expect(countSessionMessagesInFile(file)).resolves.toBe(0)
  })

  it('目录路径（EISDIR 读失败）→ 上抛（错误回传 renderer 占位，非 ENOENT 归 0）', async () => {
    const dir = fixturePath('a-dir.jsonl')
    mkdirSync(dir, { recursive: true })

    await expect(countSessionMessagesInFile(dir)).rejects.toThrow()
  })
})

describe('countSessionMessagesInFile 大文件流式读', () => {
  it('多行 fixture（6000 entry）流式计数正确（实现面 createReadStream+readline 恒定内存）', async () => {
    const file = fixturePath('large.jsonl')
    const parts: string[] = [JSON.stringify(lines.header)]
    // 2000 轮对话 = 4000 条计数消息 + 2000 条 toolResult（不计）+ header
    for (let i = 0; i < 2000; i++) {
      parts.push(JSON.stringify(lines.userMessage))
      parts.push(JSON.stringify(lines.toolResultMessage))
      parts.push(JSON.stringify(lines.assistantMessage))
    }
    writeFileSync(file, parts.join('\n') + '\n')

    await expect(countSessionMessagesInFile(file)).resolves.toBe(4000)
  })
})
