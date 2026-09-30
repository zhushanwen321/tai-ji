// src/shared/jsonl-event-stream.ts
//
// [§3.1.3 双份基座收敛] 泛型 JSONL 事件 journal 基座——append（seq 单调分配）/ scan
// （宽容解析 + 坏行计数）的唯一实现。
//
// 为什么需要：record 事件文件（`<sa-id>.events`）与 run journal（`<runId>.record.jsonl`）
// 此前各持一份约 90 行的 append+scan 实现，正文高度同构，差异只在四类契约点——两处
// 分别演化时，seq 分配纪律 / 坏行宽容度 / ENOENT 语义会各自漂移。
//
// 差异经策略注入（本文件零域知识）：
//   - pathFor：文件路径构造（含各自的 id 白名单校验——非法 id 在此抛错）；
//   - headerFor / isHeader：可选首行头行（record 域有，run 域无）；
//   - parseLine：行校验器（各自的词表与信封判据——record 要求 seq 必填、run 容忍
//     存量无 seq 行）；
//   - scanWarn：坏行 warn 文案（各自的日志标签与计数字段名）。
//
// 本文件是 shared 零依赖原语（只 import node:fs）——日志经 warn 回调注入，不 import
// core/logger（保持 shared 层无内部依赖）。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

/** 泛型 journal 的域策略（各域唯一实装点提供）。 */
export interface JsonlEventStreamStrategy<TInput, TEvent extends { seq?: number }> { // oe-exempt:20260930:framework:shared 泛型基座的策略注入契约——record / run 两域各提供一份策略对象（两个真实变体），基座只此一个泛型实现属参数化 seam 常态，非单实现投机抽象
  /** id → 文件绝对路径（须一并做该域的 id 白名单校验，非法即抛）。 */
  pathFor(id: string): string;
  /** 首行头行载荷（文件不存在时先落一行）；无头行契约的域返回 undefined。 */
  headerFor?(id: string): unknown;
  /** 头行判定（scan 命中即跳过，不参与坏行计数）；无头行契约的域返回 false。 */
  isHeader?(value: unknown): boolean;
  /** 行校验：返回 undefined = 坏行（跳过 + 计数）。 */
  parseLine(value: unknown): TEvent | undefined;
  /** 组装落盘事件（seq 已分配）——各域在此做自己的类型窄化（基座不做 cast）。 */
  withSeq(event: TInput, seq: number): TEvent;
  /** 坏行 warn 文案（缺省由基座生成）。 */
  scanWarn?(filePath: string, malformed: number, id: string): string;
  /** 日志出口（各域注入自己的 logger；shared 层不 import 日志库）。 */
  warn(message: string, detail: Record<string, unknown>): void;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

/**
 * 文件形态的 JSONL 事件 journal（append / scan）。
 *
 * append 契约：id 显式传参（文件定位不依赖事件形态）；seq 分配权在本实装内
 *（末水位 + 1，跨实例正确性靠首 append 探测文件尾，不靠进程内缓存）；文件不存在时
 * 先落头行（仅声明头行契约的域）。返回落盘的完整事件（含 seq）。
 *
 * 为什么同步落盘（域策略无关的共同理由）：事件流是取证证据——「事件流停止前的尾部
 * 事件是什么」是待恢复判读（注册表投影相）的唯一依据，批写缓冲随进程死亡丢掉的恰好
 * 是尾部事件；实测每 run 2-20 条（2026-09-26，29 个真实 run journal），微秒级追加
 * 成本不构成吞吐压力。接口保持 Promise 形态（两域接口契约），实装内同步完成。
 *
 * scan 契约：文件不存在 = 空 journal（ENOENT 静默）；坏行跳过并计数（warn 留证）——
 * 失效模式是保守可诊断，不炸整个投影。
 */
export class JsonlEventStream<TInput extends object, TEvent extends { seq?: number }> {
  private dirEnsured = false;
  /** id → 已知末 seq（append 分配基数）。 */
  private readonly lastSeqById = new Map<string, number>();

  constructor(
    private readonly dir: string,
    private readonly strategy: JsonlEventStreamStrategy<TInput, TEvent>,
  ) {}

  async append(id: string, event: TInput): Promise<TEvent> {
    const filePath = this.strategy.pathFor(id);
    if (!this.dirEnsured) {
      // 惰性一次：目录缺失自建（recursive 幂等），scan 侧不建目录（只读）。
      mkdirSync(this.dir, { recursive: true });
      this.dirEnsured = true;
    }
    // seq 分配：末水位 + 1。水位未缓存时探测文件（存在则取有效事件最大 seq）——
    // 同步 readFileSync 与调用侧同一取舍（取证证据：append 返回即达页缓存）。
    let lastSeq = this.lastSeqById.get(id);
    if (lastSeq === undefined) {
      lastSeq = this.scanFile(filePath).maxSeq;
    }
    const seq = lastSeq + 1;
    const full = this.strategy.withSeq(event, seq);
    // 头行只在文件不存在时落（existsSync 每次探测，跨实例续写不重写头行）。
    if (this.strategy.headerFor !== undefined && !existsSync(filePath)) {
      appendFileSync(filePath, `${JSON.stringify(this.strategy.headerFor(id))}\n`, "utf8");
    }
    appendFileSync(filePath, `${JSON.stringify(full)}\n`, "utf8");
    this.lastSeqById.set(id, seq);
    return full;
  }

  async scan(id: string): Promise<readonly TEvent[]> {
    const filePath = this.strategy.pathFor(id);
    const { events, malformed } = this.scanFile(filePath);
    if (malformed > 0) {
      const message = this.strategy.scanWarn?.(filePath, malformed, id)
        ?? `jsonl event journal scan：跳过 ${malformed} 个坏行（文件=${filePath}）`;
      this.strategy.warn(message, { id, malformed });
    }
    return events;
  }

  /** 读文件并宽容解析：头行跳过、坏行跳过计数 + 有效事件最大 seq 探测（scan 与 append 共用）。 */
  private scanFile(filePath: string): { events: TEvent[]; malformed: number; maxSeq: number } {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return { events: [], malformed: 0, maxSeq: 0 };
      throw error;
    }
    const events: TEvent[] = [];
    let malformed = 0;
    let maxSeq = 0;
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed += 1;
        continue;
      }
      if (this.strategy.isHeader?.(parsed) === true) continue;
      const event = this.strategy.parseLine(parsed);
      if (event === undefined) {
        // 词表外 type（含合法 JSON 但漂移的形态）/信封坏值按坏行跳过——保守可诊断。
        malformed += 1;
        continue;
      }
      events.push(event);
      // 存量行 seq 运行时可能缺失（各域兼容度由 parseLine 决定）——有值才参与水位。
      if (typeof event.seq === "number" && event.seq > maxSeq) maxSeq = event.seq;
    }
    return { events, malformed, maxSeq };
  }
}
