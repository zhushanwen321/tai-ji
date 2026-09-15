// src/execution/assembly/session-pending.ts
//
// agent_end 后代判定：读子进程的 session 文件，用 pending-notifications 的
// register − unregister 差集计数（经通知域窄端口 NotifyDomainPorts 注入的
// countActiveFromEntries——core 依赖闭包不含 pi-pending-notifications，见
// core/notify-ports.ts；端口缺席时按零活跃处理 = pending 门全开）判断该 subagent
// 是否还有活跃后代（background subagent / workflow）。
//
// 背景（v4 递归编排）：层主 planning-agent 派子 subagent 后结束 turn 等待被唤醒。
// 若 runSpawn 在 agent_end 无条件 kill，进程被回收、steer 唤醒送不到，递归树断。
// 判定依据：子进程的 session 文件里 pending:register entry（其进程内 appendEntry
// 同步写盘，见 pi SessionManager._persist）减去 pending:unregister 的差集。
// fork 继承的父级 register 残留（翻 process 档后 U4 补注销不再中性化，永久留存于
// 子 session 文件）由读侧过滤收口 [W4 读侧过滤② / F1]：本文件读侧以「被读文件
// 所属 session id」（pi session 文件首行 SessionHeader.id）为基准，经通知域端口
// countActiveFromEntries 的第二参传入，端口实现按「entry sessionId ≠ 基准 → 跳过」
// 过滤——差集不受污染；落盘收口归 core 注册对账 sweep（reconcile-sweep.ts）。
//
// 纯函数 + fs，独立于执行链路，可单测。
//
// [D5 消亡登记（chat-domain-v1x-liveness-governance W3）] listActivePendingFromSessionFile
// （后代补杀清单口径）随 inproc session-runner（已删） 删除消亡——其消费方全在该待删
// 文件；「层主死后孤儿后代止损」语义由 W4 轮次活性监督器逐 record 三态（该放弃）承接，
// 禁止按旧「不过滤跨 session」语义把补杀迁入新路径（翻档后 fork 残留会进补杀清单，
// 误杀父 session 活跃后代）。readActivePendingFromSessionFile（count 口径）保留：
// 判定语义仍由其单测锁守，生产消费方随删件清零（存活面 = 机制本体，勿误认清理仍在工作）。

import * as fs from "node:fs";

import { getLogger } from "../../core/logger.ts";
import { getNotifyDomainPorts } from "../../core/notify-ports.ts";

const logger = getLogger("subagents");

/** 后代刚完成（unregister）后，notify 唤醒父 agent 可能仍在路上（triggerTurn 的
 *  steer/followUp 经 sendMessage → agent 队列排空（agent-session.js:1081-1087），
 *  不经 EventBus——EventBus 只用于扩展间 pi.events；与主进程处理 agent_end 行存在
 *  毫秒级竞态——explorer 3 秒完成时实测 unregister 先于 agent_end 判定写入，导致
 *  差集 0 误判完成）。此窗口内的 agent_end 不 kill，等父被唤醒后的下一次 agent_end 再判。 */
const RECENT_UNREGISTER_WINDOW_MS = 60_000;

/** 判定结果：count > 0 = 有活跃后代（应保持进程等唤醒）。 */
export interface ActivePendingResult {
  count: number;
  /** 最近窗口内（60s）有 pending:unregister——后代刚完成，唤醒通知可能在路上。 */
  recentUnregister: boolean;
  /** 读取/解析失败的原因（undefined = 成功）。调用方对 error 采取保守策略（不 kill）。 */
  error?: string;
}

/**
 * [perf] per-file 增量游标：session 文件 append-only，同文件重复判定（层主被多个
 * 后代唤醒 N 次 → N 次 agent_end）只需读上次 offset 之后的新增行。fork 继承的大
 * session（数十 MB）从「每次整读」降为「首读全量 + 后续增量」。
 * truncate/重建防御：size < offset → 重置全读。EOF 半行（写入竞态）不入账，
 * offset 只推进到完整行边界，下次补读。
 *
 * [LC-6/T6②] entries 只留 register−unregister 差集的**活跃**条目（activeRegisters
 * Map，id → 原始 register entry），不累积全量历史 pending 行——长寿命 orchestrator
 * 的内存从「随 pending 行总数无界涨」收敛为「随活跃后代数有界」（差集化同时把每次
 * 判定的端口/list 重扫从 O(历史行数) 降为 O(活跃数)）。unregister 抵消已内联完成，
 * 下游 countActiveFromEntries 端口（TTL/跨 session 过滤作用于 register entry 本体）
 * 与 list 差集口径的语义与全量读完全一致；latestUnregisterMs（60s 唤醒窗口判据）
 * 独立在 cursor 字段上，不受差集化影响。缺 data.id 的畸形行丢弃（对齐坏行跳过层级，
 * 契约上 register/unregister 必带 data.id）。
 *
 * 剪枝：文件 stat/read 失败（含删除）即删 cursor（下次成功读时全量重建，增量只是
 * 优化不是事实源）；进程 close 后由调用方调 prunePendingCursor 显式回收。
 * 测试隔离用 clearPendingCursors()。
 */
interface PendingReadCursor {
  offset: number;
  activeRegisters: Map<string, unknown>;
  latestUnregisterMs: number;
  /** [F1] 被读文件所属 session id（pi session 文件首行 SessionHeader.id，首读全量
   *  时提取一次随 cursor 缓存——增量读不重读首行）。undefined = 首行非 session
   *  header（旧 fixture/手工构造形态）→ 端口调用不传基准（不过滤，向后兼容）。 */
  headerSessionId?: string;
}

const cursors = new Map<string, PendingReadCursor>();

/** 清空增量游标缓存（测试隔离用）。 */
export function clearPendingCursors(): void {
  cursors.clear();
}

/**
 * [LC-6/T6②] 剪枝单个 sessionFile 的增量游标（子进程 close / session 终态化时调）。
 *
 * 进程死后其 sessionFile 不再有 agent_end 判定，cursor 条目（offset + 活跃后代 Map）
 * 只会滞留不再更新——进程退出路径调用本函数回收。文件删除侧的自动剪枝在
 * accumulatePendingEntries（stat/read 失败即删）。不存在时 no-op。
 */
export function prunePendingCursor(sessionFile: string): void {
  cursors.delete(sessionFile);
}

/** [taste/no-unsafe-cast] pending 行的最小结构守卫：非 null object 即可（字段访问
 *  侧均做了 undefined 检查，全可选类型断言无校验意义，改守卫带运行时检查）。 */
function isPendingLineLike(v: unknown): v is { customType?: string; timestamp?: string } {
  return typeof v === "object" && v !== null;
}

/**
 * [内部共享] 读 session 文件并把 pending register/unregister 行累积进 per-file 增量
 * 游标的**活跃差集**（见 PendingReadCursor）。readActivePendingFromSessionFile（count
 * 口径，唯一存活口径——清单口径已随 D5 消亡登记，见文件头）消费同一 cursor。
 *
 * 快速路径：行内含 pending 值（`"pending:register"` / `"pending:unregister"`）才解析，
 * 大量 message 行只付 includes 扫描跳过 JSON.parse。
 * [S-4] 按值匹配而非 `"customType":"pending:` 序列化格式——后者耦合 pi 的 JSON 序列化
 * 空格习惯（冒号后无空格），pi 改 pretty-print 会导致全过滤 → count=0 → keep-alive
 * 静默失效 → recursive tree 被杀、steer 丢失。值字符串本身不受序列化空格影响。
 *
 * 文件不存在（sessionFile 未回填/首次 assistant 前）→ error（调用方保守不 kill）。
 * [LC-6] stat/read 失败（含文件被删）剪枝 cursor——下次成功读时全量重建（增量只是
 * 优化不是事实源），防「已删文件 cursor 永久滞留」。坏行跳过（append 中途崩溃的截断行）。
 */
function accumulatePendingEntries(
  sessionFile: string | undefined,
): { activeRegisters: Map<string, unknown>; latestUnregisterMs: number; headerSessionId?: string; error?: string } {
  const emptyAcc = { activeRegisters: new Map<string, unknown>(), latestUnregisterMs: 0 };
  if (!sessionFile) {
    return { ...emptyAcc, error: "no sessionFile (handshake not settled)" };
  }

  const size = statPendingFileSize(sessionFile);
  if (typeof size !== "number") {
    return { ...emptyAcc, error: size.error };
  }

  let cursor = cursors.get(sessionFile);
  if (cursor === undefined || size < cursor.offset) {
    // 首次（全量）或文件被 truncate/重建（offset 越界）→ 重置从头读
    cursor = { offset: 0, activeRegisters: new Map<string, unknown>(), latestUnregisterMs: 0 };
  }

  const chunk = readPendingChunk(sessionFile, cursor, size);
  if (typeof chunk !== "string") {
    return { ...emptyAcc, error: chunk.error };
  }

  // [F1] 首读全量时提取被读文件所属 session id（首行 SessionHeader.id），随 cursor
  // 缓存——增量读不重读首行。须在 offset 推进前判（offset===0 = 本次为全量读）。
  if (cursor.offset === 0 && cursor.headerSessionId === undefined) {
    cursor.headerSessionId = extractHeaderSessionId(chunk);
  }

  // 只消费到最后一个完整行：EOF 半行（append 写入竞态）不入账，offset 不推进，
  // 下次从该行起点重读（补全后正常入账）。
  const lastNl = chunk.lastIndexOf("\n");
  const complete = lastNl === -1 ? "" : chunk.slice(0, lastNl);
  cursor.offset += Buffer.byteLength(complete, "utf-8");
  cursors.set(sessionFile, cursor);
  consumePendingLines(complete, cursor, sessionFile);

  return {
    activeRegisters: cursor.activeRegisters,
    latestUnregisterMs: cursor.latestUnregisterMs,
    headerSessionId: cursor.headerSessionId,
  };
}

/**
 * [F1 读侧过滤②基准] pi session 文件首行 SessionHeader 的 id 提取（pi 实装锚定：
 * session-manager.js newSession 置 fileEntries=[header]，首次 flush 整体落盘——
 * 首行 = `{type:"session", id, ...}`）。首行非 session header（旧 fixture / 手工
 * 构造 / 坏行）返回 undefined = 端口调用不传基准（不过滤，向后兼容——漏计的危害
 * 方向是幻 defer，宁放行不误杀活跃计数，对齐 pending-notifications 的容错语义）。
 */
function extractHeaderSessionId(chunk: string): string | undefined {
  const nl = chunk.indexOf("\n");
  const firstLine = nl === -1 ? chunk : chunk.slice(0, nl);
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (
      typeof parsed === "object" && parsed !== null &&
      (parsed as { type?: unknown }).type === "session" &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      return (parsed as { id: string }).id;
    }
  } catch (err) {
    // 首行坏行：无基准（不过滤）。预期内可忽略（旧 fixture / 手工构造 / append
    // 中途崩溃的截断行），debug 留痕对齐 applyPendingLine 的坏行处理。
    logger.debug("skipped malformed session header line", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return undefined;
}

/** stat + 失败剪枝的统一文案（stat/read 两路 [LC-6] 剪枝共用）。 */
function pendingFileUnreadableMessage(err: unknown): string {
  return `session file unreadable: ${err instanceof Error ? err.message : String(err)}`;
}

/** stat 文件大小；失败（含 ENOENT 文件被删）剪枝 cursor 并返回错误（防已删文件 cursor 永久滞留）。 */
function statPendingFileSize(sessionFile: string): number | { error: string } {
  try {
    return fs.statSync(sessionFile).size;
  } catch (err) {
    cursors.delete(sessionFile);
    return { error: pendingFileUnreadableMessage(err) };
  }
}

/** 按 cursor.offset 增量读 chunk（首次全量）；读失败剪枝 cursor（同 stat 失败路径）。 */
function readPendingChunk(
  sessionFile: string,
  cursor: PendingReadCursor,
  size: number,
): string | { error: string } {
  try {
    if (cursor.offset === 0) {
      return fs.readFileSync(sessionFile, "utf-8");
    }
    return readPendingChunkFrom(sessionFile, cursor.offset, size - cursor.offset);
  } catch (err) {
    cursors.delete(sessionFile);
    return { error: pendingFileUnreadableMessage(err) };
  }
}

/** offset 起的定长读（短读循环补齐到 EOF）；异常由 readPendingChunk 的 catch 统一接。 */
function readPendingChunkFrom(sessionFile: string, offset: number, len: number): string {
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(sessionFile, "r");
  try {
    let total = 0;
    while (total < len) {
      const n = fs.readSync(fd, buf, total, len - total, offset + total);
      if (n <= 0) break;
      total += n;
    }
    return buf.toString("utf-8", 0, total);
  } finally {
    fs.closeSync(fd);
  }
}

/** 完整行逐条入账差集（值匹配快速路径 + 坏行跳过，见 accumulatePendingEntries 的 [S-4] 注）。 */
function consumePendingLines(complete: string, cursor: PendingReadCursor, sessionFile: string): void {
  for (const line of complete.split("\n")) {
    // [S-4] 按值匹配：countActiveFromEntries 只消费 register/unregister 两种 customType，
    // 故只需检测这两个值字符串；冒号前后空格变化不影响（值始终是连续子串）。
    if (!line.includes('"pending:register"') && !line.includes('"pending:unregister"')) continue;
    applyPendingLine(line, cursor, sessionFile);
  }
}

/** 单行 register/unregister 入账（差集内联 + latestUnregister 窗口判据；坏行 catch 跳过）。 */
function applyPendingLine(line: string, cursor: PendingReadCursor, sessionFile: string): void {
  try {
    const entry: unknown = JSON.parse(line);
    if (!isPendingLineLike(entry)) return;
    // [LC-6] 差集内联：register 入活跃 Map（同 id 重 register 覆盖 = 差集语义），
    // unregister 抵消移除。缺 data.id 的畸形行丢弃（契约必带 id，对齐坏行跳过层级）。
    const customType = entry.customType;
    const id = extractPendingEntryId((entry as { data?: unknown }).data);
    if (customType === "pending:register" && id !== undefined) {
      cursor.activeRegisters.set(id, entry);
    } else if (customType === "pending:unregister" && id !== undefined) {
      cursor.activeRegisters.delete(id);
    }
    if (customType === "pending:unregister" && entry.timestamp) {
      const ts = Date.parse(entry.timestamp);
      if (Number.isFinite(ts) && ts > cursor.latestUnregisterMs) cursor.latestUnregisterMs = ts;
    }
  } catch {
    // 截断行/坏行跳过——不影响其余 entry 的差集判定（罕见：append 中途崩溃）
    logger.debug("skipped malformed pending line", { sessionFile });
  }
}

/** entry.data.id 的运行时守卫提取（[taste/no-unsafe-cast] 字段访问前校验）。 */
function extractPendingEntryId(data: unknown): string | undefined {
  return typeof data === "object" && data !== null && typeof (data as { id?: unknown }).id === "string"
    ? (data as { id: string }).id
    : undefined;
}

/**
 * 读 session 文件计算活跃 pending 数（增量读 + 差集，见 PendingReadCursor）。
 */
export function readActivePendingFromSessionFile(
  sessionFile: string | undefined,
): ActivePendingResult {
  const acc = accumulatePendingEntries(sessionFile);
  if (acc.error) {
    return { count: 0, recentUnregister: false, error: acc.error };
  }

  // 计数器经通知域窄端口解析（缺省实现恒 0 = 零活跃，pending 门全开——安全侧缺省
  // 收敛在端口层，见 core/notify-ports.ts DEFAULT_NOTIFY_PORTS；此处 `?? 0` 仅防御
  // 宿主注入部分端口对象的形态）。[LC-6] 入参是差集后的活跃 register 集合（unregister
  // 抵消已内联），端口语义（TTL/跨 session 过滤作用于 register entry 本体）不受影响。
  // [F1 读侧过滤②] 以「被读文件所属 session id」为基准传入端口（提取不到 =
  // undefined = 不过滤，向后兼容）——fork 继承的父级注册残留（entry sessionId =
  // 父 session ≠ 基准）不进后代判定差集，层主不被残留误判「尚有活跃后代」。
  const countActive = getNotifyDomainPorts().countActiveFromEntries;
  const active = countActive
    ? countActive(
      [...acc.activeRegisters.values()],
      acc.headerSessionId !== undefined ? { currentSessionId: acc.headerSessionId } : undefined,
    )
    : 0;
  return {
    count: active,
    recentUnregister:
      acc.latestUnregisterMs > 0 &&
      Date.now() - acc.latestUnregisterMs < RECENT_UNREGISTER_WINDOW_MS,
  };
}
