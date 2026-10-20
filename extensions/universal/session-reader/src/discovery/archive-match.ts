/**
 * [session-archive D7] 归档片段匹配编排 + 归档态 ToolResult 构造。
 *
 * 独立模块的原因（不并入 archive-ledger.ts）：匹配复用 find.ts 的
 * normalizeUuidKey（uuid 归一化口径单一源，§6.7 子决策 1），而 archive-ledger
 * 被 roots.ts 单向消费——并入会构成 archive-ledger→find→roots→archive-ledger
 * 的值级循环 import。本模块依赖方向：find（纯函数）+ archive-ledger（扫描/
 * 渲染）+ tool-handler（仅 type import，同 tool-format 先例），无环。
 *
 * 消费方：tool-handler 的 resolveByFragment（归档回退层）与 result-action
 * （archivedResult）、tool-format 的 resolveNonOkResult（multi 消歧与归档态的
 * 统一 non-ok 分发）。
 */
import { normalizeUuidKey } from './find.js'
import {
  formatArchivedDisambiguation,
  formatArchivedText,
  resolveArchiveDir,
  scanArchiveLedgers,
  type ArchiveLedgerEntry,
} from './archive-ledger.js'
import type { ToolResult } from '../tool-handler.js'

/** 归档命中的两支形态（ResolveResult 对应支的结构子集）。 */
export type ArchiveResolve =
  | { kind: 'archived'; archive: ArchiveLedgerEntry }
  | { kind: 'archived-multi'; query: string; entries: ArchiveLedgerEntry[] }

/**
 * 归档簿记片段匹配：sessionId（等值/子串/归一化，复用 find 的 normalizeUuidKey
 * 两级口径）+ 簿记 name（名称片段的免解压数据源，D3）。归档根不存在/无簿记 →
 * 空数组（无匹配路径零变化）。
 */
export async function matchArchiveLedgers(
  query: string,
  agentDir: string,
): Promise<ArchiveLedgerEntry[]> {
  const archiveRoot = resolveArchiveDir(agentDir)
  const entries = await scanArchiveLedgers(archiveRoot)
  const nq = normalizeUuidKey(query)
  return entries.filter((e) => {
    if (e.sessionId === query) return true
    if (e.sessionId.includes(query)) return true
    if (nq.length > 0 && normalizeUuidKey(e.sessionId).includes(nq)) return true
    return e.name !== undefined && e.name.includes(query)
  })
}

/**
 * 归档回退层的解析入口（resolveByFragment 在场零命中后调用）：单命中 →
 * archived；多命中 → archived-multi（消歧）；无簿记命中 → undefined（落 F1）。
 */
export async function resolveArchiveFragment(
  query: string,
  agentDir: string,
): Promise<ArchiveResolve | undefined> {
  const hits = await matchArchiveLedgers(query, agentDir)
  if (hits.length === 1) {
    return { kind: 'archived', archive: hits[0]! }
  }
  if (hits.length > 1) {
    return { kind: 'archived-multi', query, entries: hits }
  }
  return undefined
}

/**
 * 归档命中的统一 ToolResult（单条 + 多命中消歧）：正文 = archive-ledger 两态
 * 渲染（头部标注 + 摘要 turns + 尾注 / staging 占位），不读压缩体（D7）。details
 * 顶层 `archived: true` 供程序化消费方一眼区分归档态与常规结果。
 */
export function archivedResult(resolved: ArchiveResolve): ToolResult {
  return resolved.kind === 'archived'
    ? {
        content: [{ type: 'text', text: formatArchivedText(resolved.archive) }],
        details: { archived: true, entry: resolved.archive },
      }
    : {
        content: [
          { type: 'text', text: formatArchivedDisambiguation(resolved.query, resolved.entries) },
        ],
        details: { archived: true, candidates: resolved.entries },
      }
}
