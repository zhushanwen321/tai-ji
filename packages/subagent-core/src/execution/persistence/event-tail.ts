// src/execution/persistence/event-tail.ts
//
// W1 [D6]：journal tail 读取原语（域无关层，run / record 两域共用）。
//
// 为什么需要它：全仓此前所有 journal 读都是 readFileSync 全文重读（探查 B-4
// 核实零先例）——写侧每事件一次「全量 scan 重 fold」是 O(N²) 读放大（问题点 6），
// 读侧（runtime）每请求全文解析同理。tail = 从上次读到的字节偏移继续读新增行。
//
// 三原语（设计 D6 词面）：
// 1. offset 续读（readEventTail）：per-file 字节偏移，只推进到完整行边界；
// 2. 幂等全量重读：文件变短（截断/重建）→ 偏移归零重读——重复行的去重归域
//    fold（record 域 seq 单调守卫构造性保证；run 域 seq 由 U1 补齐）；
// 3. watch 目录（createEventDirectoryTailer）：目录级 fs.watch（不 per-file，
//    D6 裁决）+ 周期复查兜底 fs.watch 静默丢事件（macOS 前科，git-head-watcher
//    头注明载并以 60s 无条件兜底处理——本层同构，间隔可注入）。
//
// tail 契约的部分行与坏行语义（D6）：
// - offset 只落在完整行边界——无尾随换行的末段是不完整行，留在文件侧等下次
//   续读拼齐（splitCompleteLines 的 remainder 形态）；
// - 坏行 = 跳过该行并计数（skippedLines），不炸读取、不卡游标——增量读不能
//   沿用全量 scan 的「保守停在最近一致态」（停会永久卡住增量游标）。
//
// 层归属：本模块零领域依赖（不 import run-events / record-events）——行解析器
// 经 parseLine 注入（record 域 = parseRecordEventFileLine；run 域 = U1 接入时
// 注入）。日志策略同构注入（onSkippedLines），判定与策略分离。
//
// 进程拓扑前提（设计前提 8）：extension 与 runtime 各自 tail 同一批 journal
// 文件（幂等读无害）——本层不做进程内转发。

import { readdirSync, readFileSync, statSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";

import { bestEffort } from "../assembly/best-effort.ts";

/** 换行字节（行边界判定用；UTF-8 多字节序列内部不出现 0x0A，字节级切割安全）。 */
const NEWLINE_BYTE = 0x0a;

// ── 纯函数：完整行边界切分 ────────────────────────────────────

/**
 * 按换行符切分完整行（纯函数，tail 契约「offset 只落在完整行边界」的形态层）。
 *
 * 末段无换行符 = 不完整行，留在 remainder（调用方等下一段数据拼齐）——续读
 * 缓存不完整尾行的构造载体。空串输入 → 0 行 + 空 remainder。
 */
export function splitCompleteLines(buffer: string): { lines: string[]; remainder: string } {
  if (buffer.length === 0) return { lines: [], remainder: "" };
  const parts = buffer.split("\n");
  const remainder = parts.pop() ?? "";
  return { lines: parts, remainder };
}

// ── offset 续读（无状态单文件原语）────────────────────────────

/** 域注入的行解析器：合法事件返回 T；空行/头行/坏行返回 undefined（跳过 + 计数）。 */
export type EventLineParser<T> = (line: string) => T | undefined;

/** 单次续读结果。 */
export interface EventTailChunk<T> { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** 本次新读出的完整事件行（写入序）。 */
  events: T[];
  /** 下次续读起点（字节偏移；只落在完整行边界——不完整尾行不计入）。 */
  nextOffset: number;
  /**
   * 跳过行计数 = 解析器拒绝的行（头行 + 坏行——头行是合法存在，计入是为
   * 「跳过并记日志计数」的单通道；每文件每生命周期至多 1 次头行，量级可忽略）。
   */
  skippedLines: number;
  /** 文件比 offset 短（截断/重建）→ 已从文件头全量重读（幂等全量重读原语）。 */
  truncated: boolean;
}

/**
 * 从字节偏移续读到文件末尾的最后一个完整行边界（无状态，IO 原语）。
 *
 * - ENOENT → 空结果 + offset 归零（文件未创建 / 已清理——pi 延迟写入同族的
 *   缺省语义，消费方按空流处理）；
 * - offset ≥ 文件大小 → 空结果、偏移不动（周期复查的零成本快路径）；
 * - offset > 文件大小 → truncated：从 0 全量重读（文件重建/轮转；重复行去重
 *   归域 fold）；
 * - 换行边界按字节判定（0x0A 不出现在 UTF-8 多字节序列内部，字节级切割安全）。
 */
export function readEventTail<T>(
  filePath: string,
  offset: number,
  parseLine: EventLineParser<T>,
): EventTailChunk<T> {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], nextOffset: 0, skippedLines: 0, truncated: false };
    }
    throw error;
  }
  if (size === offset) {
    return { events: [], nextOffset: offset, skippedLines: 0, truncated: false };
  }
  const truncated = offset > size;
  const start = truncated ? 0 : offset;
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch (error) {
    // stat 与 read 之间被清理（retention prune / rescan 竞态）——与首段 ENOENT 同族
    // 缺省语义：空结果 + 偏移归零（目录 tailer 的下一轮 rescan 回收偏移条目）
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], nextOffset: 0, skippedLines: 0, truncated: false };
    }
    throw error;
  }
  // 完整区 = [0, lastNewline+1)——其后是不完整尾行，等下次拼齐
  const lastNewline = buf.lastIndexOf(NEWLINE_BYTE);
  if (lastNewline + 1 <= start) {
    // 起点之后没有新的完整行（例如上次停在同一行内、其后只有半行追加）。
    // truncated 时起点已归零——无可推进的完整行边界，偏移同样归零（防陈旧偏移
    // 在空文件/无换行文件上每轮重复判 truncated 重读）。
    return { events: [], nextOffset: truncated ? 0 : offset, skippedLines: 0, truncated };
  }
  const completeText = buf.subarray(start, lastNewline + 1).toString("utf8");
  const { lines } = splitCompleteLines(completeText);
  const events: T[] = [];
  let skippedLines = 0;
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed === undefined) {
      skippedLines += 1;
    } else {
      events.push(parsed);
    }
  }
  return { events, nextOffset: lastNewline + 1, skippedLines, truncated };
}

// ── watch 目录 + 周期复查（有状态目录 tailer）─────────────────

/** 默认周期复查间隔：watch 静默丢事件的兜底上界（U3 按检查点②实测校准）。 */
const DEFAULT_RECHECK_INTERVAL_MS = 30_000;
/** 默认 watch 事件 debounce：高频 append 合并为一次续读。 */
const DEFAULT_DEBOUNCE_MS = 200;
/** 默认 watch 失败重挂间隔（git-head-watcher L1 同构）。 */
const DEFAULT_RETRY_DELAY_MS = 5_000;

export interface EventDirectoryTailerOptions<T> { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** 监视目录（目录级 watch，不 per-file——D6 裁决；run 域 = workflow-state，record 域 = records）。 */
  dir: string;
  /**
   * 文件名过滤（必填——records 目录同时存在 manifest .json，无过滤会误读）。
   * 如 record 域 = (name) => name.endsWith(".events")。
   */
  filter: (filename: string) => boolean;
  /** 域注入的行解析器（record 域 = parseRecordEventFileLine）。 */
  parseLine: EventLineParser<T>;
  /** 续读产出的事件（按文件回调；events 恒非空数组才回调）。 */
  onEvents: (filename: string, events: T[]) => void;
  /** 跳过行出声（宽容跳过 + 计日志——调用方注入日志策略）。 */
  onSkippedLines?: (filename: string, count: number) => void;
  /** 截断/重建全量重读信号（消费方据此可重建 fold state；seq 守卫下不重建也幂等）。 */
  onReset?: (filename: string) => void;
  /** 周期复查间隔（默认 30s；测试注入短值）。 */
  recheckIntervalMs?: number;
  /** watch 事件 debounce（默认 200ms）。 */
  debounceMs?: number;
  /** watch 失败重挂间隔（默认 5s）。 */
  retryDelayMs?: number;
}

export interface EventDirectoryTailer { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** 手动触发一次全目录复查（冷启动全量读 / 测试驱动入口；幂等）。 */
  rescan(): void;
  /** 某文件当前续读偏移（字节；未读过 = undefined——诊断/测试面）。 */
  offsetOf(filename: string): number | undefined;
  /** 停止 watcher 与定时器（shutdown / 测试 teardown）。幂等。 */
  dispose(): void;
}

class DirectoryEventTailer<T> implements EventDirectoryTailer {
  /** filename → 字节偏移（只落在完整行边界）。 */
  private readonly offsets = new Map<string, number>();
  private watcher: FSWatcher | undefined;
  private disposed = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private rescanPending = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly recheckTimer: NodeJS.Timeout;

  constructor(private readonly opts: EventDirectoryTailerOptions<T>) {
    this.mountWatch();
    const timer = setInterval(() => {
      // 周期复查：无条件运行（不依赖 watch 存活）——静默丢事件兜底 + 死 watcher
      // 补挂 + 已消失文件偏移回收，三职责一轮完成
      if (this.disposed) return;
      if (this.watcher === undefined) this.mountWatch();
      this.rescan();
    }, opts.recheckIntervalMs ?? DEFAULT_RECHECK_INTERVAL_MS);
    // 纯兜底周期：unref 不持有事件循环；shutdown 由 dispose 显式清理
    timer.unref();
    this.recheckTimer = timer;
  }

  rescan(): void {
    if (this.disposed) return;
    let entries: string[];
    try {
      entries = readdirSync(this.opts.dir);
    } catch {
      // 目录消失（session 目录被清理）——静默等下一周期；读侧零状态损失
      //（offset 保留，目录重建后同名文件从偏移续读或按 truncated 全量重读）
      return;
    }
    const wanted = new Set(entries.filter((name) => this.opts.filter(name)));
    for (const name of wanted) this.readOne(name);
    // 已消失文件的偏移回收：同名新文件（清理后重建）从 0 全量读，不带着旧偏移误判 truncated
    for (const name of this.offsets.keys()) {
      if (!wanted.has(name)) this.offsets.delete(name);
    }
  }

  offsetOf(filename: string): number | undefined {
    return this.offsets.get(filename);
  }

  dispose(): void {
    this.disposed = true;
    if (this.watcher !== undefined) {
      this.closeQuietly(this.watcher);
      this.watcher = undefined;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    clearInterval(this.recheckTimer);
  }

  // ── watch 挂载与事件 ────────────────────────────────────────

  private mountWatch(): void {
    if (this.disposed || this.watcher !== undefined) return;
    try {
      this.watcher = watch(this.opts.dir, { persistent: false }, (_event, filename) => {
        // filename null = 平台未提供名字，保守全扫（git-head-watcher 同构）
        if (filename !== null && !this.opts.filter(filename)) return;
        this.scheduleRescan();
      });
    } catch {
      this.handleWatchError();
      return;
    }
    this.watcher.on("error", () => this.handleWatchError());
  }

  /** watch 事件 → debounce 收敛为一次 rescan（窗口内只合并不重置）。 */
  private scheduleRescan(): void {
    if (this.disposed || this.rescanPending) return;
    this.rescanPending = true;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.rescanPending = false;
      this.rescan();
    }, this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  /** error 处置：拆 watcher → 延迟重挂（L1 同构）；数据新鲜度由周期复查维持，不冻结。 */
  private handleWatchError(): void {
    if (this.watcher !== undefined) {
      this.closeQuietly(this.watcher);
      this.watcher = undefined;
    }
    if (this.retryTimer !== null || this.disposed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.mountWatch();
    }, this.opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.retryTimer.unref();
  }

  private readOne(filename: string): void {
    const offset = this.offsets.get(filename) ?? 0;
    const chunk = readEventTail(join(this.opts.dir, filename), offset, this.opts.parseLine);
    if (chunk.truncated) this.opts.onReset?.(filename);
    if (chunk.events.length > 0) this.opts.onEvents(filename, chunk.events);
    if (chunk.skippedLines > 0) this.opts.onSkippedLines?.(filename, chunk.skippedLines);
    this.offsets.set(filename, chunk.nextOffset);
  }

  private closeQuietly(watcher: FSWatcher): void {
    try {
      watcher.close();
    } catch (err) {
      // close 竞态失败（watcher 已死/目录已删）无害且不可恢复——git-head-watcher 同语义；
      // bestEffort 兼容 taste/no-silent-catch 并留 debug 痕迹
      bestEffort(err, "journal tailer watcher close");
    }
  }
}

/**
 * 创建目录级 journal tailer（watch + offset 续读 + 周期复查三原语的有状态组合）。
 *
 * 冷启动：构造后调用一次 rescan()（或等首个周期复查）从文件头全量读——tail 与
 * 全量读是同一文件同一解析器，只差起点偏移（直播/冷启动同构，D6 语义）。
 */
export function createEventDirectoryTailer<T>(
  options: EventDirectoryTailerOptions<T>,
): EventDirectoryTailer {
  return new DirectoryEventTailer<T>(options);
}
