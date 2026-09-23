/**
 * TraceSync — session trace / system-prompt 同步域（S4 从 SessionService 迁出，
 * 与原 session-trace.ts 纯函数合并：一个概念一个模块，纯函数与编排半截同居）。
 *
 * 上半（纯函数，原 session-trace.ts 逐字随迁）：session trace 台账的**读取与归一化**——
 *   - 路径 A（活跃 session）：RPC get_entries 权威解析（pi 原生，entry 结构演进跟随 pi
 *     升级）+ 文件首行补 header（pi getEntries() 明确不含 header，session-manager docstring）
 *     + 文件解析补 malformed（pi 静默跳坏行，G1 占位可见）。
 *   - 路径 B（非活跃/降级）：JSONL 直读（复用 core parse-jsonl——损坏行占位可见，不静默
 *     丢失，design §3.1 失败路径）+ sidecar `.meta.json` 合并（session_end BOUNDARY 行）。
 *   - 空态：session 未落盘（pi 延迟写入窗口，规则 6）→ source='empty' 标记，前端显示
 *     「session 尚未落盘」空态；不创建/触碰文件。
 *
 * 下半（编排半截，原 SessionService trace 域方法族逐字随迁，S4 前零直接测试——
 * 本模块化为 G2「stub 面 = 消费面」创造了直接测试面，见 __tests__/trace-sync.test.ts）：
 * getTraceEntries（全量拉取 + RPC→文件→empty 混合路由）/ syncTraceEntries（增量腿
 * 串行链 + traceEntryAppended 广播）/ fetchCurrentSystemPrompt（常驻扩展现取通道轮询）
 * + 私有状态 traceLeafCache / traceSyncChains（per-session 基线与串行链，销毁经
 * onSessionDisposed 由 Facade removeSessionEntry 第 ⑤ 步直调清理）。
 *
 * SessionService 保留一行委托（ISessionService 对外契约不变，D3 形态）。日志前缀保留
 * `[session-trace]`（G3 行为等价：错误诊断流也是可观察行为，迁出不改写日志归属）。
 */
import type {
  ServerMessageMap,
  SessionTraceHeaderPayload,
  SessionTraceMalformedLine,
  SessionTraceSessionEndPayload,
} from '@taiji/shared'
import { parseSessionTraceJsonl } from '@taiji/core/domain/session-trace'
import { BYTES_PER_MB } from '@taiji/shared'
import type { IProcessManager, IPiEngine } from '../ports/pi-engine.js'
import type { ISessionStore } from '../ports/session.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import type { IManagedSessionView } from './types.js'
import { toErrorMessage } from '../../utils/errors.js'

// ══════════ 上半：纯函数（原 session-trace.ts 逐字随迁）══════════

/** trace 增量推送 id 序列（单调递增 + 时间戳，同 ms 内不碰撞；无魔数字面量）。 */
let tracePushSeq = 0
export function nextTracePushId(): string {
  tracePushSeq++
  return `push_trace_${Date.now()}_${tracePushSeq}`
}

/**
 * 现取 system prompt 的 custom entry customType。写入方 = builtin agent-ext 包
 *（infrastructure 不可禁）的 /__taiji_get_system_prompt__ 命令 handler（字面量锤定，不 import
 * 本模块）；读取方 = fetchCurrentSystemPrompt 轮询匹配。与留痕包的 taiji:system-prompt（core
 * SYSTEM_PROMPT_CUSTOM_TYPE）语义不同：这是「当前值现取」，非留痕历史。
 */
export const CURRENT_SYSTEM_PROMPT_CUSTOM_TYPE = 'taiji:current-system-prompt'

/** trace 台账快照（= session.traceEntries WS payload）。 */
export interface SessionTraceSnapshot {
  sessionId: string
  /** 数据通路：rpc（活跃，权威解析）/ file（非活跃或 RPC 失败降级）/ empty（未落盘空态）/ oversize（D5④ 超预检阈值降级）。 */
  source: 'rpc' | 'file' | 'empty' | 'oversize'
  /** session JSONL 绝对路径（reveal 按钮数据源；empty 未落盘/路径未知时缺省）。 */
  filePath?: string | null
  /** JSONL 首行 header 完整 entry（parentSession 两形态原样透传）；未落盘/首行损坏时缺省。 */
  header?: SessionTraceHeaderPayload
  /** entry 全集（不含 header）。RPC 权威解析或文件解析（含 handoff_marker 等自定义行）。 */
  entries: unknown[]
  /** 损坏行占位（两路径均产出：文件解析提取行号与原文；RPC 路径补齐 pi 静默跳过的坏行）。 */
  malformed: SessionTraceMalformedLine[]
  /** sidecar session_end 终态（两路径都读 sidecar——终态与活跃性正交）。 */
  sessionEnd?: SessionTraceSessionEndPayload
  /** 当前叶子 entry id（RPC 路径；增量腿 since 基准）。文件路径无 leaf 概念，缺省。 */
  leafId?: string | null
  /** D5④ oversize 降级文案（source='oversize' 时提供，含体积与源文件绝对路径）。 */
  oversizeMessage?: string
}

/**
 * 解析 header 首行原文为完整 entry（路径 A 用）。
 *
 * 首行非 JSON / 非 type=session → null（session 文件延迟写入窗口内首行可能是半行——
 * 容错不抛，header 缺省是可接受的降级，SESSION 行由前端按缺省处理）。
 */
export function parseTraceHeaderLine(line: string | null): SessionTraceHeaderPayload | undefined {
  if (!line) return undefined
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && (parsed as { type?: unknown }).type === 'session') {
      return parsed as SessionTraceHeaderPayload
    }
  } catch {
    void 0 /* 首行损坏 → header 缺省（trace 容错语义） */
  }
  return undefined
}

/**
 * 文件文本 → 损坏行占位（路径 A RPC 补齐专用：pi get_entries 静默跳坏行，本函数从文件
 * 文本提取坏行行号与原文）。路径 B 文件直读在 buildTraceSnapshotFromFile 单趟解析中
 * 内联提取（免二次解析），不经过本函数。
 *
 * G1（design「损坏行必须以占位行可见、不静默丢失」）：RPC 路径若不补齐则活跃 session
 * 的坏行对 Trace 视图彻底不可见（GUI 实测回归：非活跃时注入的坏行在 session 重新激活后
 * MALFORMED 行消失）。文本 null（未落盘/读失败）→ 空数组。
 */
export function collectMalformedLines(text: string | null): SessionTraceMalformedLine[] {
  if (text === null) return []
  const malformed: SessionTraceMalformedLine[] = []
  for (const line of parseSessionTraceJsonl(text)) {
    if (!line.ok) malformed.push({ lineNumber: line.lineNumber, raw: line.raw })
  }
  return malformed
}

/**
 * D5④ oversize 降级文案（crash-resilience §3.3 错误规格表「历史文件超 32MB」行）。
 *
 * 设计定版文案形态：「Trace 过大无法渲染（XX MB），源文件：<绝对路径>」——恢复指引
 * 内嵌（文件系统直接查看源文件），不与「尚未落盘」空态文案混淆。
 */
export function formatTraceOversizeMessage(bytes: number, filePath: string): string {
  return `Trace 过大无法渲染（${(bytes / BYTES_PER_MB).toFixed(1)} MB），源文件：${filePath}`
}

/**
 * 路径 B：从 JSONL 文件直读构建 trace 快照。
 *
 * 文件不存在（未落盘）→ source='empty' 空态（规则 6：不创建文件）；文件超 runtime
 * 读取预检阈值 → source='oversize' 降级态（D5④，不读全文——与 empty 显式区分）；
 * 读出后逐行解析（core parse-jsonl：损坏行占位保留行号与原文），首条 type=session 行
 * 提 header，其余 ok 行按序作 entries；sidecar session_end 合并。
 */
export function buildTraceSnapshotFromFile(
  sessionId: string,
  filePath: string | null,
  sessionStore: ISessionStore,
): SessionTraceSnapshot {
  if (filePath === null) {
    return { sessionId, source: 'empty', entries: [], malformed: [] }
  }
  const text = sessionStore.readSessionJsonlText(filePath)
  if (text === null) {
    // 未落盘（pi 延迟写入：首条 assistant 消息前文件不存在）或读失败（EACCES 等）——
    // 统一空态标记，前端显示「尚未落盘，落盘后自动加载」。
    return { sessionId, source: 'empty', entries: [], malformed: [] }
  }
  if (typeof text !== 'string') {
    // D5④ oversize（crash-resilience §3.3 D5④）：超 READ_PRECHECK_MAX_BYTES 不读全文，
    // 渲染降级态——文案含体积与源文件绝对路径，entries/malformed 恒空（非空态混淆：
    // source 单独成档，前端按 oversizeMessage 渲染专属提示）。
    return {
      sessionId,
      source: 'oversize',
      filePath,
      entries: [],
      malformed: [],
      oversizeMessage: formatTraceOversizeMessage(text.bytes, filePath),
    }
  }
  const lines = parseSessionTraceJsonl(text)
  let header: SessionTraceHeaderPayload | undefined
  const entries: unknown[] = []
  const malformed: SessionTraceMalformedLine[] = []
  for (const line of lines) {
    if (!line.ok) {
      malformed.push({ lineNumber: line.lineNumber, raw: line.raw })
      continue
    }
    if ((line.entry as { type?: unknown }).type === 'session') {
      // header 固定首行；防御后续再遇 session 行（理论不可达）取首见
      if (header === undefined) header = line.entry as SessionTraceHeaderPayload
      continue
    }
    entries.push(line.entry)
  }
  const sessionEnd = sessionStore.readSessionEndMeta(filePath) ?? undefined
  return { sessionId, source: 'file', filePath, ...(header !== undefined ? { header } : {}), entries, malformed, ...(sessionEnd !== undefined ? { sessionEnd } : {}) }
}

// ══════════ 下半：编排半截（原 SessionService trace 域，S4 迁出）══════════

/** 现取 system prompt 轮询参数：命令 handler 毫秒级完成，250ms 间隔 1-2 轮命中；
 * 8s 超时上限覆盖慢盘/慢命令（超时地 fetch_current_prompt_timeout，前端可重试）。 */
const FETCH_CURRENT_PROMPT_POLL_MS = 250
const FETCH_CURRENT_PROMPT_TIMEOUT_MS = 8000

/**
 * 判定 getEntries(since) 的 "Entry not found" 错误（wave:perf-w20 D6-4 fallback 触发条件）。
 *
 * pi 实测文案（2026-08-16，pi 0.84.0）：`Entry not found: <since-id>`——E 大写 not 小写
 * （pi rpc-mode.ts:615 模板字符串）。rpc-client 对 success:false 的响应 reject
 * `new Error(msg.error)`，错误原文进 Error.message。匹配用大小写宽容的 includes
 * （防御 pi 上游微调文案大小写）+ 前缀锚定（避免误吞其他含 "entry" 字样的错误）。
 *
 * S4 起随 trace 域导出：Facade 残余的 history / record 域（getHistory 增量腿与 record
 * entries 游标自愈）同判 pi 该错误，import 本模块（单一定义，双向共享）。
 */
export function isEntryNotFoundError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /^entry not found/i.test(msg)
}

/** fetchCurrentSystemPrompt 单轮轮询产物；'retry' = 基线跨 pi 进程失效，需全量重建后再轮。 */
type PromptPollStep =
  | 'retry'
  | { hit: unknown; delta: unknown[]; newLeafId: string | null }

/**
 * get_entries(since) 响应的消费面结构（C-comm-02：pi 协议类型 PiMessage 不出 infra/pi——
 * 本文件是新模块不进 hook 存量 allowlist，消费点只用 entries/leafId 两字段，本别名即
 * trace 域的协议收窄边界；getEntriesSince 返回后无需再 as 收窄）。
 */
type EntriesSinceResult = { data?: { entries?: unknown[]; leafId?: string | null } }

/** 从命中的 taiji:current-system-prompt custom entry 提取响应载荷（缺字段降级为空值）。 */
function extractCurrentPromptHit(sessionId: string, hit: unknown): ServerMessageMap['session.currentSystemPrompt'] {
  const data = (hit as { data?: Record<string, unknown> }).data
  const fullText = typeof data?.fullText === 'string' ? data.fullText : ''
  const charCount = typeof data?.charCount === 'number' ? data.charCount : fullText.length
  const fetchedAt = typeof data?.fetchedAt === 'string' ? data.fetchedAt : ''
  return { sessionId, fullText, charCount, fetchedAt }
}

/**
 * TraceSync 装配依赖（窄注入，S4/D2 风格：deps 面构造期固定，messageBus 经 getter
 * 每次调用动态读——与 Facade setter 晚期注入语义逐字等价）。
 */
export interface TraceSyncDeps {
  /** pi 进程管理（getClient：活跃判定 + RPC client）。 */
  pm: IProcessManager
  /** session 存储端口（文件读取三读 + 扫描发现）。 */
  sessionStore: ISessionStore
  /** sessions Map 只读查询（lifecycle 所有者）：trace 文件路径解析 + busy 预检。 */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** MessageBus 当前值（Facade setter 晚期注入，未注入时 null → 广播 no-op）。 */
  getMessageBus(): IMessageBus | null
}

export class TraceSync {
  /**
   * session-trace 增量腿基线（A33）：per-session 上次全量拉取的 leafId（since 基准）。
   * getTraceEntries 活跃路径写入；syncTraceEntries 读取后 get_entries(since) 拉 delta 并
   * 滚动更新。无基线（trace 视图未打开过）→ 增量腿 no-op（前端打开时会全量拉取建立基线）。
   * 哨兵 ''（review round1 MUST_FIX）：空 session（pi leafId=null）也要建立基线，语义 =
   * 「基线已建立但当前无叶子」——后续 sync 经 getEntriesSince 无参全量拉（'' 不是合法
   * entry id，不可下传 pi 当 since），拉到真实 leaf 后推进；否则空 session 台账冻结空态
   * 且无恢复出口。removeSessionEntry 第 ⑤ 步经 onSessionDisposed 清除（与 historyCache
   * 同汇聚点）。
   */
  private readonly traceLeafCache = new Map<string, string>()
  /**
   * session-trace 增量腿串行链（A33）：per-session promise 链，同 session 触发事件按到达序
   * 串行拉取（message_end + agent_settled 几乎同时到达 → 链式串行后第二次 since 已是新
   * leaf，空 delta 不广播；burst 天然合并）。每段 catch 兑底，链永不 reject（diffChain 同款）。
   */
  private readonly traceSyncChains = new Map<string, Promise<void>>()

  constructor(private readonly deps: TraceSyncDeps) {}

  /**
   * session-trace 台账全量拉取（design D4 数据通路 A1，A31/A32）。
   *
   * 路由：① 活跃（pm 有 client）→ RPC get_entries（pi 权威解析）+ 文件首行补 header
   * （getEntries() 不含 header）+ 文件解析补 malformed（pi 静默跳坏行，G1 占位可见）
   * + sidecar session_end；成功后写 traceLeafCache（增量腿
   * since 基线）。② RPC 失败（pi 进程异常）或无 client → 路径 B 文件直读（core parse-jsonl
   * 坏行容错 + sidecar 合并；design §3.1 降级路径：前端 banner「来自磁盘文件」）。
   * ③ 未落盘（pi 延迟写入窗口）→ source='empty' 空态标记。
   *
   * 文件路径解析：活跃 session 优先内存 sessionFilePath（pi spawn 后回填，免扫描），
   * 否则 scanSessions({force:true})（路径解析消费方旁路 TTL，plan M-3 单 session 形态）。
   */
  async getTraceEntries(sessionId: string): Promise<SessionTraceSnapshot> {
    const client = this.deps.pm.getClient(sessionId)
    if (client) {
      try {
        const result = await client.getEntries() as EntriesSinceResult
        const entries = result.data?.entries ?? []
        const leafId = result.data?.leafId ?? null
        // 空 session（仅 header，pi _buildIndex 置 leafId=null）也必须建立基线（哨兵 ''），
        // 否则 doSyncTraceEntries 恒 no-op——台账冻结空态且无恢复出口（review round1 MUST_FIX）
        this.traceLeafCache.set(sessionId, leafId ?? '')
        const filePath = this.resolveTraceFilePath(sessionId)
        const header = parseTraceHeaderLine(filePath !== null ? this.deps.sessionStore.readSessionHeaderLine(filePath) : null)
        // G1 坏行可见性：pi get_entries 静默跳坏行，RPC 路径必须补文件解析占位（否则活跃
        // session 的坏行对 Trace 视图彻底不可见）；读失败（未落盘窗口）→ 恒空数组降级。
        // D5④：文件超预检阈值时同样恒空数组——malformed 补齐是增强项（权威 entries 走
        // RPC 已返回），不为它绕过全文件读取预算。
        const fileText = filePath !== null ? this.deps.sessionStore.readSessionJsonlText(filePath) : null
        const malformed = typeof fileText === 'string' ? collectMalformedLines(fileText) : []
        const sessionEnd = filePath !== null ? (this.deps.sessionStore.readSessionEndMeta(filePath) ?? undefined) : undefined
        return {
          sessionId,
          source: 'rpc',
          filePath,
          ...(header !== undefined ? { header } : {}),
          entries,
          malformed,
          ...(sessionEnd !== undefined ? { sessionEnd } : {}),
          leafId,
        }
      } catch (e) {
        // design §3.1 失败路径：RPC 失败（pi 进程异常）降级路径 B 文件直读
        console.warn(`[session-trace] getTraceEntries via RPC failed (sid=${sessionId}), falling back to file read: ${toErrorMessage(e)}`)
      }
    }
    return buildTraceSnapshotFromFile(sessionId, this.resolveTraceFilePath(sessionId), this.deps.sessionStore)
  }

  /**
   * session-trace 增量腿补拉（A33）：触发事件（message_end/compaction_end/agent_settled/
   * entry_appended，经 event-interpreter onTraceSync）或 lifecycle RPC（set_model/
   * set_thinking_level 成功后未方法内直调）到达后调用。
   *
   * 流程：查 traceLeafCache 基线（无 → no-op，trace 未打开过）→ get_entries(since=基线)
   * → 滚动更新基线 → delta 非空时 bus.publish session.traceEntryAppended（含 sessionId，
   * 规则 7）。“Entry not found”（基线跨进程失效，如 pi 重启）→ 清基线 + warn（下次
   * getTraceEntries 重建，不广播错序数据）。串行链防 burst 重复拉取（见 traceSyncChains）。
   */
  syncTraceEntries(sessionId: string, trigger: string): void {
    const prev = this.traceSyncChains.get(sessionId) ?? Promise.resolve()
    const next = prev.then(() => this.doSyncTraceEntries(sessionId, trigger)).catch((e: unknown) => {
      // 链段兑底：单次同步失败不断链（diffChain 同款）；错误已在 doSync 内分类处理，
      // 此处仅防 unhandledRejection 逃逸。
      console.warn(`[session-trace] sync chain segment failed (sid=${sessionId}, trigger=${trigger}):`, e)
    })
    this.traceSyncChains.set(sessionId, next)
    void next.then(() => {
      // 链尾自清理：settled 且仍是链尾时释放 Map 槽位（burst 期间新段已接管，不误删）
      if (this.traceSyncChains.get(sessionId) === next) this.traceSyncChains.delete(sessionId)
    })
  }

  private async doSyncTraceEntries(sessionId: string, trigger: string): Promise<void> {
    const baseline = this.traceLeafCache.get(sessionId)
    if (baseline === undefined) return // 无基线（trace 视图未打开过）→ 增量腿 no-op
    const client = this.deps.pm.getClient(sessionId)
    if (!client) return // 无活跃 client → 无 RPC 增量源（文件路径无 leaf 概念）
    let delta: unknown[] = []
    let newLeafId: string | null = null
    try {
      // 哨兵 ''（空 session 基线）→ 无参全量拉：空 session delta 空 = 正常稳态；有新 entry
      // 后全量 delta 即全部 entry（消费端按 entry.id 去重），拉到真实 leaf 后基线推进
      const result = await this.getEntriesSince(client, baseline)
      delta = result.data?.entries ?? []
      newLeafId = result.data?.leafId ?? null
    } catch (e) {
      if (isEntryNotFoundError(e)) {
        // 基线失效（缓存跨 pi 进程存活 / session 文件被外部改写）：清基线，下次全量重建。
        // 恢复动作：前端重新打开 Trace 视图调 session.getTraceEntries（或下次触发前无增量）。
        console.warn(`[session-trace] since baseline invalid (sid=${sessionId}), dropping leaf cache; re-open trace view to rebuild`)
        this.traceLeafCache.delete(sessionId)
      } else {
        console.warn(`[session-trace] getEntries(since) failed (sid=${sessionId}, trigger=${trigger}): ${toErrorMessage(e)}`)
      }
      return
    }
    if (newLeafId) this.traceLeafCache.set(sessionId, newLeafId)
    if (delta.length === 0) return // 触发事件到达但无新 entry（追赶式拉取的正常稳态）
    // 规则 7：session 级消息必带 sessionId（bus.publish 定向推给订阅该 sid 的 ws）
    this.deps.getMessageBus()?.publish(sessionId, {
      type: 'session.traceEntryAppended',
      id: nextTracePushId(),
      payload: { sessionId, entries: delta, leafId: newLeafId },
    })
  }

  /** trace 文件路径解析：活跃 session 内存 sessionFilePath 优先，否则扫描（force 旁路 TTL）。 */
  private resolveTraceFilePath(sessionId: string): string | null {
    const active = this.deps.getSession(sessionId)
    if (active?.sessionFilePath) return active.sessionFilePath
    const target = this.deps.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
    return target?.filePath ?? null
  }

  /**
   * 哨兵感知 get_entries 调用：baseline === ''（空 session 基线——已建立但当时无叶子）时
   * 无参全量拉取（'' 不是合法 entry id，下传 pi 当 since 用会 Entry not found / 空结果，
   * `?? undefined` 只处理 null/undefined 挡不住 ''）；真实 leafId / undefined 原样透传 since。
   */
  private getEntriesSince(client: IPiEngine, baseline: string | undefined): Promise<EntriesSinceResult> {
    // pi 响应是动态 JSON（PiMessage=unknown，ports 层「类型系统认输」既定语义）——收窄
    // 责任收敛到本单点，两处消费点直接拿 EntriesSinceResult（原先各自 as 收窄）。
    const raw: Promise<unknown> = baseline === '' ? client.getEntries() : client.getEntries(baseline)
    return raw as Promise<EntriesSinceResult>
  }

  /**
   * 现取当前 system prompt（session-trace design §3.1 失败路径 / D2）。
   *
   * 通道：pi RPC 无 get_system_prompt 命令、getSystemPrompt() 只在 extension API，且现取
   * 不能依赖可禁的留痕包（system-prompt-trace 是 feature tier）——链路固定为：
   *   client.prompt('/__taiji_get_system_prompt__')（builtin agent-ext 包注册，不可禁，
   *   /__ 内部命令不经 LLM；RPC prompt 在 preflight 后即返回，不等 handler 完成）
   *   → handler 写 taiji:current-system-prompt custom entry
   *   → 本方法轮询 get_entries(since=基线) 拉到该 entry 后提取返回。
   *
   * 副作用：命中后滚动 traceLeafCache 基线 + 广播 session.traceEntryAppended（现取 entry
   * 作为 DATA 行同步出现在 trace 台账，留下取值痕迹；custom 不进 LLM context，零模型影响——
   * pi sessionEntryToContextMessages 对 type=custom 落入末尾 return []，session-manager.ts:383-413）。
   *
   * @throws code=session_not_active（无活跃 pi 进程——非活跃 session 无现取源）/
   *   session_busy（生成/压缩中，命令会排队导致超时，预检拒绝更诚实）/
   *   fetch_current_prompt_timeout（轮询超时，命令未产出 entry）
   */
  async fetchCurrentSystemPrompt(sessionId: string): Promise<ServerMessageMap['session.currentSystemPrompt']> {
    const client = this.deps.pm.getClient(sessionId)
    if (!client) {
      throw Object.assign(new Error(`Session ${sessionId} not active`), { code: 'session_not_active' })
    }
    // busy 预检只看明确的 busy 信号（生成/压缩中命令会排队导致超时）；sessions Map 无条目
    //（恢复窗口/测试简化态）不拒——能否执行由 pi 决定
    const active = this.deps.getSession(sessionId)
    if (active?.isGenerating || active?.isCompacting) {
      throw Object.assign(new Error(`Session ${sessionId} is busy`), { code: 'session_busy' })
    }
    let baseline = await this.ensurePromptBaseline(sessionId, client)
    await client.prompt('/__taiji_get_system_prompt__')
    // 轮询：命令 handler 毫秒级完成，RPC 往返 1-2 轮命中；超时上限覆盖慢盘/慢命令
    const deadline = Date.now() + FETCH_CURRENT_PROMPT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const step = await this.pollOnceForPromptEntry(sessionId, client, baseline)
      if (step === 'retry') {
        baseline = undefined
        continue
      }
      if (!step.hit) continue
      // 增量同步给 trace 台账（DATA 行留取值痕迹；消费端按 entry.id 去重）
      if (step.delta.length > 0) {
        const bus = this.deps.getMessageBus()
        if (bus) {
          bus.publish(sessionId, {
            type: 'session.traceEntryAppended',
            id: nextTracePushId(),
            payload: { sessionId, entries: step.delta, leafId: step.newLeafId },
          })
        }
      }
      return extractCurrentPromptHit(sessionId, step.hit)
    }
    throw Object.assign(new Error(`Timed out fetching current system prompt for session ${sessionId}`), { code: 'fetch_current_prompt_timeout' })
  }

  /**
   * 现取轮询的 since 基线初始化：trace 打开过则用缓存；否则 getEntries() 全量拉一次建立
   *（全量拉是接受的一次性开销——现取是用户显式动作）。
   */
  private async ensurePromptBaseline(sessionId: string, client: IPiEngine): Promise<string | undefined> {
    const cached = this.traceLeafCache.get(sessionId)
    if (cached !== undefined) return cached
    const initial = await client.getEntries() as { data?: { leafId?: string | null } }
    const baseline = initial.data?.leafId ?? undefined
    if (baseline) this.traceLeafCache.set(sessionId, baseline)
    return baseline
  }

  /**
   * 现取轮询单步：sleep → getEntries(since=baseline) → 倒序找 taiji:current-system-prompt
   * custom entry。未命中也滚动 traceLeafCache 基线（增量无遗漏）。
   * 基线跨 pi 进程失效（Entry not found）时清缓存基线并返回 'retry'——调用方置
   * baseline=undefined 全量重建后继续轮询（命令可能已产出 entry）。
   */
  private async pollOnceForPromptEntry(
    sessionId: string,
    client: IPiEngine,
    baseline: string | undefined,
  ): Promise<PromptPollStep> {
    await new Promise((resolve) => setTimeout(resolve, FETCH_CURRENT_PROMPT_POLL_MS))
    let delta: unknown[] = []
    let newLeafId: string | null = null
    try {
      // 哨兵感知（getEntriesSince）：'' 基线无参全量拉，undefined 同样全量（?? 挡不住 ''）
      const result = await this.getEntriesSince(client, baseline)
      delta = result.data?.entries ?? []
      newLeafId = result.data?.leafId ?? null
    } catch (e) {
      if (isEntryNotFoundError(e)) {
        this.traceLeafCache.delete(sessionId)
        return 'retry'
      }
      throw e
    }
    const hit = [...delta].reverse().find(
      (e) => (e as { type?: unknown; customType?: unknown })?.type === 'custom'
        && (e as { customType?: unknown })?.customType === CURRENT_SYSTEM_PROMPT_CUSTOM_TYPE,
    )
    if (newLeafId) this.traceLeafCache.set(sessionId, newLeafId)
    return { hit: hit ?? null, delta, newLeafId }
  }

  /**
   * session 销毁的域清理（Facade removeSessionEntry 第 ⑤ 步直调，S4 各域清理汇聚形态）：
   * 清 trace 增量腿基线与串行链（与 historyCache 同因——基线跨进程存活无意义；链已
   * settled，删 Map 条目只释放槽位）。
   */
  onSessionDisposed(sessionId: string): void {
    this.traceLeafCache.delete(sessionId)
    this.traceSyncChains.delete(sessionId)
  }
}
