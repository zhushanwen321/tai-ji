/**
 * Session 域 ports —— pi session 文件的发现/扫描/持久化 + 历史翻译。
 *
 * 🔒 三层架构：services 定义 port，infra/pi/session-store.ts 实现。
 * 封装 session-file-utils 的 session 相关函数 + message-converter 的 convertPiHistory
 * + system/trash。session 域的 pi 文件/状态操作，service 经此 port 访问。
 */

import type { Message, SegmentsMetadataFile } from '@taiji/shared'

/** scanPiSessions 返回的 session 元信息（持久化会话扫描结果）。 */
export interface ScannedSessionMeta {
  id: string
  filePath: string
  cwd: string
  timestamp: string
  name: string | null
  lastModified: number
  size: number
  /** session 终态（W4，ADR 0042）；无 session_end entry（历史/未结束）→ null。 */
  outcome: SessionOutcome | null
  /** 父 session 血缘键（FR-3，与 infra/pi/session-file-utils 版本对齐）。 */
  parentSession?: string
  /** fork 锚点 entry id（FR-3，与 infra/pi/session-file-utils 版本对齐）。 */
  forkEntryId?: string
  /** handoff 目标 session id（FR-5，与 infra/pi/session-file-utils 版本对齐）。 */
  handedOffTo?: string
  /** launch preset 绑定（从 .preset.json sidecar 读，与 infra/pi/session-file-utils 版本对齐）。 */
  launchPresetId?: string
  /** 归属 project id（从 .project.json sidecar 读，D14 语义修正 2026-08-04）。 */
  projectId?: string
  /** session 来源标记（从 .agent.json sidecar 读，agent-managed-session，与 infra/pi/session-file-utils 版本对齐——readAgentBinding 守卫已收窄枚举）。 */
  spawnSource?: 'user' | 'agent'
  /** 父 agent session id（从 .agent.json sidecar 读，agent-managed-session，与 infra/pi/session-file-utils 版本对齐）。 */
  parentAgentSessionId?: string
  /** session 绑定的模型 id（从 .model.json sidecar 读，model binding，与 infra/pi/session-file-utils 版本对齐）。 */
  modelId?: string
  /** session 绑定的思考等级（从 .model.json sidecar 读，model binding，与 infra/pi/session-file-utils 版本对齐）。 */
  thinkingLevel?: string
}

/** session 终态类型（W4，ADR 0042）。与 infra/pi/session-file-utils 的 SessionOutcome 结构对齐。 */
export type SessionOutcome = 'done' | 'error' | 'stopped'

/**
 * readSessionJsonlText 的超限标记（D5④，crash-resilience §3.3）。
 *
 * 文件超 READ_PRECHECK_MAX_BYTES 时实现端不读全文，返回本标记——与
 * null（文件缺失/读失败）显式区分，消费方（trace-sync Trace 视图）渲染专属降级态。
 */
export interface SessionJsonlOversizeMark {
  oversize: true
  /** 文件实际字节数（statSync.size），供降级文案展示体积。 */
  bytes: number
  /** 触发阈值（READ_PRECHECK_MAX_BYTES），供文案/日志对照。 */
  maxBytes: number
}

/**
 * 流式归一化的行级纯变换回调（D5⑤ 变换腿）。
 *
 * 返回变换后的行文本；返回 null = 剔除该行。纯函数契约：只做字符串变换，不触 IO——
 * IO（分块读/临时名写入/rename-over）全部归 port 实现，services 层调用方经本 port
 * 消费（check_services_infra_import 的分层通道），回调不进 port 边界。
 */
export type SessionJsonlLineTransform = (line: string, isFirstKeptLine: boolean) => string | null

/**
 * session .jsonl 首行 header entry（type=session）解析结果。
 *
 * 纯数据类型（全 string 字段），从 infra/pi/session-file-utils.ts 提升到 port：
 * parseSessionHeader 收口到 port 后其返回类型必须 port 可见。
 * infra 原 SessionHeader 与之结构兼容（TS 结构类型，infra 侧无需改 import 源
 * 即可被 PiSessionStore 委托返回）。
 */
export interface SessionHeader {
  id: string
  cwd: string
  timestamp: string
  /** 父 session 血缘键（fork 出的 session header 指回源文件/源 sessionId）。 */
  parentSession?: string
  /** fork 锚点 entry id（截断点）。 */
  forkEntryId?: string
}

/** sidecar `.jsonl.meta.json` 的 session_end 完整元数据（session-trace 用；infra readSessionEndMeta 返回）。 */
export interface SessionEndSidecarMeta {
  type: 'session_end'
  outcome: SessionOutcome
  reason?: string
  timestamp?: string
}

/**
 * entry 树重建历史结果。
 *
 * 纯数据类型（Message[] + Map），从 infra/pi/entry-tree-builder.ts 提升到 port：
 * rebuildHistoryFromEntries 收口到 port 后其返回类型必须 port 可见。
 * 保留 clientUuidMap（userEntryId→clientUuid 映射）——未来增量拉取
 * （getEntries(since=leafId)）/ branch 完整性判断需用，收口不降级原函数能力。
 * ⚠️ 映射是稀疏的（最小写入）：仅含非纯文本消息（send 端 needsBackfill 谓词门控），
 * steer/followUp/compact 重放消息历来无映射。上述未来特性不得假设映射覆盖全部 user entry。
 */
export interface RebuiltHistory {
  messages: Message[]
  /** userEntryId → clientUuid 映射（来自 "taiji.client-msg-id" custom entry）。 */
  clientUuidMap: Map<string, string>
  /**
   * 窗口内无法配对的孤儿 toolResult（W20 review Fix-1）。全量窗口正常时序恒空；
   * 增量窗口以 toolResult 开头时非空——增量合并阶段按 toolCallId 回填到缓存消息。
   * 类型收 unknown[]（pi 结构不越过 port 边界），透传给 message-converter 的
   * applyOrphanToolResults 消费。
   */
  orphanToolResults: unknown[]
}

/**
 * scanSessions 的分层选项（wave:perf-w26，05-scan-caching D9-1 消费方分层）。
 *
 * 列表构建消费方（侧栏列表）不传 opts 走目录 TTL 缓存；单 session 路径解析消费方
 * （历史/子代理/workflow/fork 源等按 id 查文件路径）传 force 强制刷新——pi 是外部进程
 * 写文件，刚落盘 session 在 TTL 窗口内也必须解析到，否则静默返回空（plan M-3）。
 */
export interface ScanSessionsOptions {
  /** 绕过目录列举 TTL 缓存强制刷新（单 session 路径解析消费方专用）。 */
  force?: boolean
}

/**
 * session 存储 port。service 经此 port 访问，不直接 import infra。
 */
export interface ISessionStore {
  /**
   * 扫描 pi sessions 目录，返回持久化会话列表。
   * opts.force=true 绕过目录 TTL 缓存（单 session 路径解析消费方）；缺省走缓存（列表构建）。
   */
  scanSessions(opts?: ScanSessionsOptions): ScannedSessionMeta[]
  /**
   * 显式失效目录列举 TTL 缓存（wave:perf-w26 D9-1）。
   * session delete / fork / rename（runtime 自写文件的操作）后调用；create 走 pi 延迟
   * 落盘靠 TTL 自然过期，不调。
   */
  invalidateScanCache(): void
  /** 刷新 pi 配置缓存（models + settings 全量重读）。 */
  refreshAll(): void
  /** 持久化 session 终态（W4，ADR 0042）。 */
  persistSessionEnd(filePath: string, outcome: SessionOutcome, reason?: string): void
  /** 持久化 launch preset 绑定到 .preset.json sidecar（设计文档 §4）。opts.skipJsonlExistsGuard 仅限 create 路径（V9-④ 根修）。 */
  persistPresetBinding(filePath: string, presetId: string, opts?: { skipJsonlExistsGuard?: boolean }): void
  /** 持久化归属 project 到 .project.json sidecar（D14 语义修正，2026-08-04）。opts.skipJsonlExistsGuard 仅限 create 路径（V9-④ 根修）。 */
  persistProjectBinding(filePath: string, projectId: string, opts?: { skipJsonlExistsGuard?: boolean }): void
  /** 持久化 agent-managed 标记到 .agent.json sidecar（G-1，重启恢复链路）。opts.skipJsonlExistsGuard 仅限 create 路径（V9-④ 根修）。 */
  persistAgentBinding(filePath: string, spawnSource: 'user' | 'agent', parentAgentSessionId: string | undefined, opts?: { skipJsonlExistsGuard?: boolean }): void
  /** 读取 session 终态（W5）；无 session_end entry 返回 null（历史 session）。 */
  extractSessionOutcome(filePath: string): SessionOutcome | null
  /** 清除 session 元信息缓存的 stale 条目（session 删除/重命名后调用，避免无界增长）。 */
  invalidateMetaCache(filePath: string): void
  /**
   * 翻译 pi 历史（unknown[] → Message[]）。pi 结构只在此实现内部断言。
   *
   * entryIds 与 raw 平行对齐的来源 entry id（文件路径经 mapSessionEntries 产出），
   * 透传给 convertPiHistory 使 user/assistant message 带 piEntryId（fork 定位截断点用，MF5）。
   * 不传时行为不变（兼容旧调用方 / 不需 piEntryId 的场景）。
   */
  convertHistory(raw: unknown[], entryIds?: string[]): import('@taiji/shared').Message[]
  /**
   * 从 pi get_entries 返回的 entry 树重建 taiji Message[]。
   *
   * entries 降级为 unknown[]（port 不暴露 PiSessionEntry，PiSessionStore 实现内
   * cast 回 PiSessionEntry[]，与 convertHistory 处理 unknown[] 同模式）。
   * segmentsMetadata 为 segments.json sidecar（null=无 sidecar，全降级为占位文本，
   * 非硬错误）。返回 RebuiltHistory{messages, clientUuidMap}。
   */
  rebuildHistoryFromEntries(entries: unknown[], segmentsMetadata: SegmentsMetadataFile | null): RebuiltHistory
  /**
   * 解析 session .jsonl 首行（type=session 的 header entry）。
   *
   * 首行非 session 类型 / 文件不存在 / JSON.parse 失败 → catch 返回 null（不抛）。
   */
  parseSessionHeader(filePath: string): SessionHeader | null
  /**
   * 读取 session .jsonl 首行**原文**（session-trace 路径 A 补 header 用，design D4：
   * RPC get_entries 不含 header，由端口补读文件首行）。
   *
   * 返回首行文本；文件不存在 / 空文件 / 读失败 → null（不抛）。解析归调用方
   * （session-trace 模块——需要 header 完整 JSON，含 version 等未建模字段）。
   */
  readSessionHeaderLine(filePath: string): string | null
  /**
   * 读取 session .jsonl 全文文本（session-trace 路径 B 文件直读用）。
   *
   * 文件不存在（pi 延迟写入窗口，规则 6）/ 读失败 → null（不抛——空态判定依据）。
   * D5④（crash-resilience §3.3）：文件超 READ_PRECHECK_MAX_BYTES 时不读全文，返回
   * 明确的 oversize 标记（**不返回 null**——「文件过大」与「文件缺失」是两种用户可见
   * 语义，混淆会把超大 Trace 误显示为「尚未落盘」空态）。string | null 返回类型的历史
   * 调用方/测试 stub 因返回类型协变保持编译兼容；消费方需窄化 string 后再按文本消费。
   */
  readSessionJsonlText(filePath: string): string | SessionJsonlOversizeMark | null
  /**
   * 分块流式归一化 session JSONL 并 rename-over 原子替换原文件（D5⑤ 变换腿，crash-resilience
   * §3.3 降级形态：超 READ_PRECHECK_MAX_BYTES 文件的附着前最小规范化，不构造全文件字符串）。
   *
   * IO（分块读 / '.tmp-migrate-' 临时名写入 / rename / 失败回滚）全部在本 port 实现内；
   * transformLine 为纯行变换回调（SessionJsonlLineTransform），isFirstKeptLine 游标语义
   * = 「strip 后产物首行」。调用方 = restore-seeding（restore / renameSession 非活跃附着
   * 共用），经构造注入消费（services 层 IO 须经 port，C-comm-03）。
   *
   * @param filePath     原 session JSONL 绝对路径（内容被原子覆盖，路径不变）
   * @param transformLine 行级纯变换
   * @param chunkBytes   读块字节数（缺省 1MB，D5② 标定；测试注入小值覆盖跨块/多字节分支）
   */
  normalizeSessionFileStreaming(filePath: string, transformLine: SessionJsonlLineTransform, chunkBytes?: number): void
  /**
   * 读取 sidecar `.jsonl.meta.json` 的 session_end 完整元数据（session-trace BOUNDARY 行，
   * ADR 0042）。无 sidecar / JSON 损坏 / outcome 非法 → null（不抛）。
   */
  readSessionEndMeta(filePath: string): SessionEndSidecarMeta | null
  /**
   * 将 handoff 标记持久化到 sidecar `.handoff.json`（W11 迁移，scanner 经
   * extractHandedOff 尾读提取 handedOffTo）。
   *
   * filePath 为空 / JSONL 文件不存在（pi 延迟写入窗口，规则 #6）→ console.warn +
   * 静默跳过（绝不创建文件，与 pi 0.80.3 _persist openSync('wx') 竞态防护）。
   * 写失败 catch → console.error 不抛；写后失效 meta 缓存。
   * [HISTORICAL] 原实现向 JSONL 直写 handoff_marker entry（活跃交接时与源 pi 进程
   * 同文件双写方），W11 迁 sidecar（D3b 裁决）。
   */
  persistHandoffSidecar(filePath: string, newSessionId: string): void
  /**
   * 删除文件/目录到废纸篓（session 资源清理）。
   * Promise 语义（G4）：移废纸篓失败保留文件并 reject——rejection 必须传播给调用方
   * （session-lifecycle），禁止断头成 unhandledRejection（timeout-audit-hygiene-batch u-h4）。
   */
  trash(path: string): Promise<void>
}
