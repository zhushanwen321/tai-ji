import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { SUBAGENT_RECORD_CUSTOM_TYPE } from '@zhushanwen/subagent-core'

import { findZcodeEntryAnchor, type ZcodeAnchor } from '../discovery/entry-anchor.js'

// ============================================================
// 变体 E（设计 §4 场景 1a）：manifest 缺席时 entry 兜底定位（F16 每轮覆写 → 取文件
// 顺序末条，collectLastRecordEntries 同构）。
//
// 单元边界：本文件只测「定位」（sa-id → sessionRef 锚）；「读到 sess-B 行集内容」的
// 库读取断言属 U9 集成测试（场景 1a 变体 E 全量断言），此处不引入 sqlite 依赖。
// sess-A / sess-B 本身即两个可区分的锚值——取首条或合并的实现会直接失败。
// ============================================================

const DB_PATH = '/data/agent/engines/zcode/session-db/db.sqlite'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'entry-anchor-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** subagent-record custom entry 行（顶层 id = entry id；data.id = record id 即 sa-id）。 */
function recordLine(
  entryId: string,
  saId: string,
  sessionRef: Record<string, string>,
  v = 1,
): string {
  return JSON.stringify({
    type: 'custom',
    customType: 'subagent-record',
    id: entryId,
    parentId: null,
    data: { v, id: saId, engine: 'zcode', engineHandle: { sessionRef, poolKey: 'shared' } },
  })
}

/** pi 形态 message 行（真实感填充）。 */
function messageLine(entryId: string, text: string): string {
  return JSON.stringify({
    type: 'message',
    id: entryId,
    parentId: null,
    message: { role: 'user', content: text },
  })
}

/** 缺 dbPath 的 sessionRef（pi record 形态：只有 sessionId 单键）。 */
const REF_NO_DBPATH = { sessionId: 'sess-pi-x' }

/** 缺 sessionId 的 sessionRef（半键）。 */
const REF_NO_SESSION_ID = { dbPath: DB_PATH }

function writeMainSession(name: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  return file
}

describe('变体 E：同 sa-id 多条 entry 取文件顺序末条（F16 覆写）', () => {
  it('首条 sess-A / 末条 sess-B → 命中 sess-B 且 ≠ sess-A（取首条/合并必失败）', async () => {
    const file = writeMainSession('main.jsonl', [
      JSON.stringify({ type: 'session', id: 'main-1', cwd: '/tmp/proj' }),
      messageLine('m1', 'dispatch subagent'),
      recordLine('e1', 'sa-1', { sessionId: 'sess-A', dbPath: DB_PATH }),
      messageLine('m2', 'round 1 done'),
      recordLine('e2', 'sa-1', { sessionId: 'sess-B', dbPath: DB_PATH }),
    ])

    const anchor = await findZcodeEntryAnchor([file], 'sa-1')

    // 非平凡断言：两个不同锚值使「末条 vs 首条」结果可区分
    expect(anchor).toBeDefined()
    expect(anchor?.sessionId).toBe('sess-B')
    expect(anchor?.sessionId).not.toBe('sess-A')
    expect(anchor?.dbPath).toBe(DB_PATH)
  })

  it('多条不同 sa-id 交错：只命中目标 id 的末条，不串锚', async () => {
    const file = writeMainSession('main.jsonl', [
      JSON.stringify({ type: 'session', id: 'main-1' }),
      recordLine('e1', 'sa-1', { sessionId: 'sa1-r1', dbPath: DB_PATH }),
      recordLine('e2', 'sa-2', { sessionId: 'sa2-r1', dbPath: DB_PATH }),
      recordLine('e3', 'sa-1', { sessionId: 'sa1-r2', dbPath: DB_PATH }),
      recordLine('e4', 'sa-2', { sessionId: 'sa2-r2', dbPath: DB_PATH }),
      recordLine('e5', 'sa-1', { sessionId: 'sa1-r3', dbPath: DB_PATH }),
    ])

    expect((await findZcodeEntryAnchor([file], 'sa-1'))?.sessionId).toBe('sa1-r3')
    expect((await findZcodeEntryAnchor([file], 'sa-2'))?.sessionId).toBe('sa2-r2')
  })
})

describe('行级容错（best-effort，不因一行坏 JSON 失败整文件）', () => {
  it('坏行穿插 + 末行半行：正常命中末条完整条目', async () => {
    const file = writeMainSession('main.jsonl', [
      JSON.stringify({ type: 'session', id: 'main-1' }),
      'not-json-at-all{{{',
      recordLine('e1', 'sa-1', { sessionId: 'sess-A', dbPath: DB_PATH }),
      '{"type":"custom","customType":"subagent-record","data":{"broken"',
    ])

    const anchor = await findZcodeEntryAnchor([file], 'sa-1')
    expect(anchor?.sessionId).toBe('sess-A')
  })
})

describe('形状校验窄而严：缺键条目不算命中，继续找更早条目', () => {
  it('末条 sessionRef 缺 dbPath → 命中更早的完整条目', async () => {
    const file = writeMainSession('main.jsonl', [
      JSON.stringify({ type: 'session', id: 'main-1' }),
      recordLine('e1', 'sa-1', { sessionId: 'sess-EARLY', dbPath: DB_PATH }),
      recordLine('e2', 'sa-1', REF_NO_DBPATH),
    ])

    const anchor = await findZcodeEntryAnchor([file], 'sa-1')
    expect(anchor?.sessionId).toBe('sess-EARLY')
  })

  it('全部条目缺双键 → not-found（undefined）', async () => {
    const file = writeMainSession('main.jsonl', [
      JSON.stringify({ type: 'session', id: 'main-1' }),
      recordLine('e1', 'sa-1', REF_NO_DBPATH),
      recordLine('e2', 'sa-1', REF_NO_SESSION_ID),
    ])

    expect(await findZcodeEntryAnchor([file], 'sa-1')).toBeUndefined()
  })

  it('sessionRef 键为空串 → 不算命中（非空 string 才算锚）', async () => {
    const file = writeMainSession('main.jsonl', [
      JSON.stringify({ type: 'session', id: 'main-1' }),
      recordLine('e1', 'sa-1', { sessionId: '', dbPath: DB_PATH }),
      recordLine('e2', 'sa-1', { sessionId: 'sess-A', dbPath: '' }),
    ])

    expect(await findZcodeEntryAnchor([file], 'sa-1')).toBeUndefined()
  })

  it('data.v ≠ 1 的条目不算命中，更早 v=1 条目仍可命中', async () => {
    const file = writeMainSession('main.jsonl', [
      JSON.stringify({ type: 'session', id: 'main-1' }),
      recordLine('e1', 'sa-1', { sessionId: 'sess-A', dbPath: DB_PATH }),
      recordLine('e2', 'sa-1', { sessionId: 'sess-V2', dbPath: DB_PATH }, 2),
    ])

    const anchor = await findZcodeEntryAnchor([file], 'sa-1')
    expect(anchor?.sessionId).toBe('sess-A')
    expect(anchor?.sessionId).not.toBe('sess-V2')
  })
})

describe('无关条目不命中', () => {
  it('非 subagent-record 的 custom entry、id 不匹配的 record 均跳过', async () => {
    const todoLine = JSON.stringify({
      type: 'custom',
      customType: 'todo',
      id: 't1',
      parentId: null,
      data: { v: 1, id: 'sa-1', engineHandle: { sessionRef: { sessionId: 'sess-TODO', dbPath: DB_PATH } } },
    })
    const file = writeMainSession('main.jsonl', [
      JSON.stringify({ type: 'session', id: 'main-1' }),
      todoLine,
      recordLine('e1', 'sa-other', { sessionId: 'sess-OTHER', dbPath: DB_PATH }),
    ])

    expect(await findZcodeEntryAnchor([file], 'sa-1')).toBeUndefined()
    expect((await findZcodeEntryAnchor([file], 'sa-other'))?.sessionId).toBe('sess-OTHER')
  })
})

describe('候选文件列表：顺序回退 + 命中即止（越界语义由调用方承载）', () => {
  it('前一候选未命中 → 后一候选命中', async () => {
    const empty = writeMainSession('empty.jsonl', [JSON.stringify({ type: 'session', id: 's0' })])
    const withAnchor = writeMainSession('with-anchor.jsonl', [
      JSON.stringify({ type: 'session', id: 'main-2' }),
      recordLine('e1', 'sa-1', { sessionId: 'sess-B', dbPath: DB_PATH }),
    ])

    const anchor: ZcodeAnchor | undefined = await findZcodeEntryAnchor([empty, withAnchor], 'sa-1')
    expect(anchor?.sessionId).toBe('sess-B')
  })

  it('前一候选命中即止：不跨文件合并（后一候选的更新条目不覆盖）', async () => {
    const first = writeMainSession('first.jsonl', [
      JSON.stringify({ type: 'session', id: 'main-1' }),
      recordLine('e1', 'sa-1', { sessionId: 'sess-A', dbPath: DB_PATH }),
    ])
    const second = writeMainSession('second.jsonl', [
      JSON.stringify({ type: 'session', id: 'main-2' }),
      recordLine('e2', 'sa-1', { sessionId: 'sess-B', dbPath: DB_PATH }),
    ])

    const anchor = await findZcodeEntryAnchor([first, second], 'sa-1')
    expect(anchor?.sessionId).toBe('sess-A')
    expect(anchor?.sessionId).not.toBe('sess-B')
  })

  it('候选不可读（不存在）→ 跳过继续，全不可读 → not-found', async () => {
    const withAnchor = writeMainSession('with-anchor.jsonl', [
      JSON.stringify({ type: 'session', id: 'main-1' }),
      recordLine('e1', 'sa-1', { sessionId: 'sess-B', dbPath: DB_PATH }),
    ])

    expect((await findZcodeEntryAnchor([join(dir, 'missing.jsonl'), withAnchor], 'sa-1'))?.sessionId).toBe('sess-B')
    expect(await findZcodeEntryAnchor([join(dir, 'missing.jsonl')], 'sa-1')).toBeUndefined()
    expect(await findZcodeEntryAnchor([], 'sa-1')).toBeUndefined()
  })
})

describe('协议字面量漂移守卫（跨包契约）', () => {
  it('entry-anchor 本地 customType 字面量 === subagent-core 写侧单源', () => {
    // 源码本地持有磁盘协议字符串（生产依赖面不引 subagent-core），此处锚定两侧同值
    expect(SUBAGENT_RECORD_CUSTOM_TYPE).toBe('subagent-record')
  })
})
