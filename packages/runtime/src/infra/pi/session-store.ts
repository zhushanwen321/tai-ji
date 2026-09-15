/**
 * ISessionStore 的 infra 实现 —— 封装 pi session 文件操作 + 历史翻译 + 废纸篓。
 *
 * 🔒 归属（R3e1，三层架构）：infra/pi/，实现 services/ports.ts 的 ISessionStore。
 * 聚合 session-file-utils 的 session 函数（scanPiSessions/persistSessionEnd/
 * persistHandoffSidecar 等 sidecar 家族）+ pi-provider-store 的 refreshAll +
 * message-converter 的 convertPiHistory + system/trash。
 * service 经此 port 访问这些 session 域操作，不直接 import 各 infra 模块。
 * [HISTORICAL] persistSessionName / patchSessionCwd 转发已随 W11 删除（绝对写规则：
 * taiji 对 pi session JSONL 的直写归零，分别迁 pi RPC 与 restore tmp 管线）。
 */
import type { ISessionStore, ScannedSessionMeta, SessionOutcome, SessionHeader, SessionEndSidecarMeta, RebuiltHistory, ScanSessionsOptions, SessionJsonlOversizeMark, SessionJsonlLineTransform } from '../../services/ports/session.js'
import type { Message, SegmentsMetadataFile } from '@taiji/shared'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
import { readFileSync, statSync } from 'node:fs'
import type { PiSessionEntry } from './pi-protocol.js'
import {
  scanPiSessions,
  persistSessionEnd,
  persistPresetBinding,
  persistProjectBinding,
  persistAgentBinding,
  extractSessionOutcome,
  invalidateSessionMetaCache,
  invalidateScanDirCache,
  parseSessionHeader,
  readFirstJsonlLine,
  readSessionEndMeta as readSessionEndMetaInfra,
  persistHandoffSidecar,
} from './session-file-utils.js'
import { normalizeSessionFileStreamingInPlace } from './session-file-streaming.js'
import { refreshAll } from './pi-provider-store.js'
import { convertPiHistory } from './message-converter.js'
import { rebuildHistoryFromEntries } from './entry-tree-builder.js'
import { trash } from '../system/trash.js'

export class PiSessionStore implements ISessionStore {
  scanSessions(opts?: ScanSessionsOptions): ScannedSessionMeta[] {
    return scanPiSessions(opts)
  }

  invalidateScanCache(): void {
    invalidateScanDirCache()
  }

  refreshAll(): void {
    refreshAll()
  }

  persistSessionEnd(filePath: string, outcome: SessionOutcome, reason?: string): void {
    persistSessionEnd(filePath, outcome, reason)
  }

  persistPresetBinding(filePath: string, presetId: string, opts?: { skipJsonlExistsGuard?: boolean }): void {
    persistPresetBinding(filePath, presetId, opts)
  }

  persistProjectBinding(filePath: string, projectId: string, opts?: { skipJsonlExistsGuard?: boolean }): void {
    persistProjectBinding(filePath, projectId, opts)
  }

  persistAgentBinding(filePath: string, spawnSource: 'user' | 'agent', parentAgentSessionId: string | undefined, opts?: { skipJsonlExistsGuard?: boolean }): void {
    persistAgentBinding(filePath, spawnSource, parentAgentSessionId, opts)
  }

  extractSessionOutcome(filePath: string): SessionOutcome | null {
    return extractSessionOutcome(filePath)
  }

  invalidateMetaCache(filePath: string): void {
    invalidateSessionMetaCache(filePath)
  }

  convertHistory(raw: unknown[], entryIds?: string[]): Message[] {
    // MF5：透传平行 entryIds 给 convertPiHistory，使文件路径产出的 user/assistant message
    // 带 piEntryId（fork 定位用）。entryIds 与 raw 按 index 对齐（mapSessionEntries 产出）。
    return convertPiHistory(raw, entryIds)
  }

  rebuildHistoryFromEntries(entries: unknown[], segmentsMetadata: SegmentsMetadataFile | null): RebuiltHistory {
    // port 入参降级为 unknown[]（不暴露 PiSessionEntry），实现内 cast 回 PiSessionEntry[]
    // 透传 infra 同名函数（TS 编译期类型擦除，运行时无断言开销）。
    return rebuildHistoryFromEntries(entries as PiSessionEntry[], segmentsMetadata)
  }

  parseSessionHeader(filePath: string): SessionHeader | null {
    return parseSessionHeader(filePath)
  }

  readSessionHeaderLine(filePath: string): string | null {
    return readFirstJsonlLine(filePath)
  }

  readSessionJsonlText(filePath: string): string | SessionJsonlOversizeMark | null {
    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      // 规则 6：pi 延迟写入窗口内文件不存在是常态（非错误），空态判定归调用方
      return null
    }
    // D5④（crash-resilience §3.3）：超读取预检阈值不读全文——返回明确 oversize 标记，
    // 不返回 null（「文件过大」≠「文件缺失」，混淆会把超大 Trace 误显示为未落盘空态）。
    if (size > READ_PRECHECK_MAX_BYTES) {
      return { oversize: true, bytes: size, maxBytes: READ_PRECHECK_MAX_BYTES }
    }
    try {
      return readFileSync(filePath, 'utf-8')
    } catch {
      return null
    }
  }

  normalizeSessionFileStreaming(filePath: string, transformLine: SessionJsonlLineTransform, chunkBytes?: number): void {
    // D5⑤ 变换腿的 IO 骨架委托（infra 同层；transformLine 是 services 层注入的纯回调，
    // IO 全在本实现内——C-comm-03 分层通道）
    normalizeSessionFileStreamingInPlace(filePath, transformLine, chunkBytes)
  }

  readSessionEndMeta(filePath: string): SessionEndSidecarMeta | null {
    return readSessionEndMetaInfra(filePath)
  }

  persistHandoffSidecar(filePath: string, newSessionId: string): void {
    persistHandoffSidecar(filePath, newSessionId)
  }

  // await 传播 infra trash() 的 rejection（G4/P4-1：trash 失败必须经 session-lifecycle
  // 上抛到 server.ts 外层收口 → renderer；此前 void 签名丢弃 Promise 断头成
  // unhandledRejection，renderer 误收删除成功 reply——timeout-audit-hygiene-batch u-h4 修复轮）
  async trash(path: string): Promise<void> {
    await trash(path)
  }
}
