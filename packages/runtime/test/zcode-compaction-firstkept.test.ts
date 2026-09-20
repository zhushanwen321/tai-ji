/**
 * P-1 行为锚（探针 P-1 结论固化，impl-plan §2-U0 ②）：pi `buildContextEntries`
 * 消费 `compaction.firstKeptEntryId` 切上下文的行为断言。
 *
 * 权威源 = @earendil-works/pi-coding-agent 0.84.4 实装 dist/core/session-manager.js
 * （`npm ls` 口径见 AGENTS.md「pi 语义断言的权威源 = node_modules 实装版」）。实装语义
 * （d.ts 签名 `buildContextEntries(entries, leafId?, byId?): SessionEntry[]`）：
 *   - path = leafId（缺省取末条 entry）沿 parentId 链回溯到根的线性路径；
 *   - path 内取**最后一条** compaction entry 为压缩点；
 *   - context = [compaction] + path 中「firstKeptEntryId 首次命中处 .. 压缩点之前」
 *     + 压缩点之后的全部 entry；
 *   - firstKeptEntryId 在压缩点之前无命中（悬空 id / 空串 / 字段物理缺失）→
 *     压缩点之前的 entry **全部静默丢弃**（无告警）。
 * 设计文档 §6-D2 / §7.5-P-1 据此裁决：任何情况不发射悬空 firstKeptEntryId（⛔ 拒发门），
 * 不可解时走三级降级路径。本文件把上述行为固化为断言，pi 升级若改变切片语义即红。
 *
 * 职责边界：只含 P-1 锚段，**不 import 任何 zcode-import 模块**——converter 侧拒发门 /
 * 三级降级用例由 U4 同文件续写。
 *
 * 实装加载：经 locatePiCodingAgentDist 动态 import dist JS（pi-semantics 探针族先例，
 * 运行时不经 runtime 包声明依赖面）。与探针族的差异：本文件是行为锚而非登记探针，
 * dist 不可达 = 语义权威缺失，硬失败而非 skipIf——skip 会让锚静默失效。
 *
 * 运行：cd packages/runtime && pnpm test -- zcode-compaction-firstkept
 * 纯内存构造，零 fs 写（不触真实数据目录）。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  CompactionEntry,
  SessionEntry,
  SessionMessageEntry,
} from '@earendil-works/pi-coding-agent'

import { locatePiCodingAgentDist } from '../src/infra/pi/__tests__/helpers/pi-semantics-probe'

const PI_DIST = locatePiCodingAgentDist()
if (!PI_DIST) {
  throw new Error(
    'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）：' +
      '行为锚的语义权威缺失，不 skip、直接红。先 `pnpm install` 或核对 pi 版本。',
  )
}

/** d.ts 精确签名（dist/core/session-manager.d.ts buildContextEntries）。 */
type BuildContextEntries = (
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>,
) => SessionEntry[]

const { buildContextEntries } = (await import(
  pathToFileURL(join(PI_DIST, 'core', 'session-manager.js')).href
)) as { buildContextEntries: BuildContextEntries }

const TS = '2026-01-01T00:00:00.000Z'
const SUMMARY_TEXT = 'This session is being continued from a previous conversation…'

function msgEntry(id: string, parentId: string | null): SessionMessageEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: TS,
    message: { role: 'user', content: `content of ${id}`, timestamp: 0 },
  }
}

/**
 * compaction entry 构造。`firstKeptEntryId` 缺省时**字段物理缺失**——pi 运行时不做
 * schema 校验（dist JS 直读属性），「缺省」负例无法用满足 CompactionEntry 声明的
 * 字面量表达，经草稿类型收窄后单点断言补齐（只此一处，不给 any 开口子）。
 */
function compactionEntry(parentId: string, firstKeptEntryId?: string): CompactionEntry {
  const draft: Omit<CompactionEntry, 'firstKeptEntryId'> & { firstKeptEntryId?: string } = {
    type: 'compaction',
    id: 'c',
    parentId,
    timestamp: TS,
    summary: SUMMARY_TEXT,
    tokensBefore: 10000,
  }
  if (firstKeptEntryId !== undefined) draft.firstKeptEntryId = firstKeptEntryId
  return draft as CompactionEntry
}

/** 线性链 m1→m2→m3→c→m4；压缩点 c 挂在 m3 之后，firstKeptEntryId 由用例注入。 */
function buildSession(firstKeptEntryId?: string): SessionEntry[] {
  const m1 = msgEntry('m1', null)
  const m2 = msgEntry('m2', m1.id)
  const m3 = msgEntry('m3', m2.id)
  const c = compactionEntry(m3.id, firstKeptEntryId)
  const m4 = msgEntry('m4', c.id)
  return [m1, m2, m3, c, m4]
}

function ids(entries: SessionEntry[]): string[] {
  return entries.map((entry) => entry.id)
}

describe('P-1 行为锚：pi buildContextEntries 消费 compaction.firstKeptEntryId（pi 0.84.4 实装）', () => {
  it('合法锚（指向压缩点之前的 entry）→ 上下文 = [compaction, 锚起…压缩点前全部, 压缩点后全部]', () => {
    const context = buildContextEntries(buildSession('m2'))
    expect(ids(context)).toEqual(['c', 'm2', 'm3', 'm4'])
  })

  it('锚指向紧邻压缩点的前驱 → 压缩点之前仅保留该前驱', () => {
    const context = buildContextEntries(buildSession('m3'))
    expect(ids(context)).toEqual(['c', 'm3', 'm4'])
  })

  it('compaction entry 是上下文首元素（摘要先行）', () => {
    const context = buildContextEntries(buildSession('m2'))
    expect(context[0]?.type).toBe('compaction')
    expect(context[0]?.id).toBe('c')
  })

  it('悬空锚（指向不存在的 entry）→ 压缩点之前 entry 全部静默丢弃', () => {
    const context = buildContextEntries(buildSession('dangling-id'))
    expect(ids(context)).toEqual(['c', 'm4'])
  })

  it('空串锚 → 同悬空（压缩点之前全部丢弃）', () => {
    const context = buildContextEntries(buildSession(''))
    expect(ids(context)).toEqual(['c', 'm4'])
  })

  it('字段缺省（firstKeptEntryId 物理缺失）→ 同悬空（压缩点之前全部丢弃）', () => {
    const context = buildContextEntries(buildSession(undefined))
    expect(ids(context)).toEqual(['c', 'm4'])
  })

  it('无 compaction entry → 完整路径原样返回', () => {
    const m1 = msgEntry('m1', null)
    const m2 = msgEntry('m2', m1.id)
    const m3 = msgEntry('m3', m2.id)
    expect(ids(buildContextEntries([m1, m2, m3]))).toEqual(['m1', 'm2', 'm3'])
  })
})
