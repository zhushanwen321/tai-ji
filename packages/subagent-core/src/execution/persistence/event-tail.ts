// src/execution/persistence/event-tail.ts
//
// [W1 D6 → event-push-channel W-P3] journal tail 读取原语（域无关层，run / record
// 两域共用）。
//
// 定位（event-push-channel 退役后）：journal 实时性的载体 = 写入方（subagent-core）
// 落盘提交点经 select marker 通道推送（消费方按 seq 水位判缺口）；本模块只保留
// 「补读与恢复读」的两个读原语——
// 1. offset 续读（readEventTail）：per-file 字节偏移，只推进到完整行边界——
//    runtime 派生视图的缺口补读与冷读入口（events-projection readFromOffset）；
// 2. 幂等全量重读：文件变短（截断/重建）→ 偏移归零重读——重复行的去重归域
//    fold（record 域 seq 单调守卫构造性保证；run 域 seq 由 W1 补齐）。
//
// [event-push-channel W-P3 退役登记] watch 族三原语（目录级 fs.watch / 30s 周期复查
// 兜底 / 5s 失败重挂 + 200ms 合并）已整体删除——ADR-0112「活状态走订阅推送，存储只
// 做恢复源；禁止用监视存储模拟实时」的清拆对象。头注原声明的「extension 与 runtime
// 各自 tail 同一批 journal 文件」拓扑前提自 W1 起即已漂移（extension 侧全部是按需
// 全量读，无任何 tail/watch），随退役一并清理。
//
// tail 契约的部分行与坏行语义（D6）：
// - offset 只落在完整行边界——无尾随换行的末段是不完整行，留在文件侧等下次
//   续读拼齐（splitCompleteLines 的 remainder 形态）；
// - 坏行 = 跳过该行并计数（skippedLines），不炸读取、不卡游标——增量读不能
//   沿用全量 scan 的「保守停在最近一致态」（停会永久卡住增量游标）。
//
// 层归属：本模块零领域依赖（不 import run-events / record-events）——行解析器
// 经 parseLine 注入（record 域 = parseRecordEventFileLine；run 域 =
// parseWorkflowRunEventFileLine，runtime 侧单源）。日志策略同构注入
// （调用方按 skippedLines 自持），判定与策略分离。

import { readFileSync, statSync } from "node:fs";

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
 * - offset ≥ 文件大小 → 空结果、偏移不动（重复补读的零成本快路径）；
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
    // 缺省语义：空结果 + 偏移归零（下次补读从 0 重新收敛）
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
