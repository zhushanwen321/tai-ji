// src/execution/engine/common/event-journal.ts
//
// 宿主 event journal（P2 公共降级层）。设计权威源：
// docs/architecture/subagent-engine-abstraction.md D6（第②级归属宿主——host 统一落盘
// 则全引擎免费获得、格式唯一）+ §3.3.6 event journal 格式（JSONL 中立 v1）。
//
// 为什么 host 落盘而非各 adapter 缓存：adapter 各自缓存会演变出六种格式；host 消费
// onEvent 统一落盘，read 第②级（journal 重放）与探针 golden 语料共用同一份产物。
//
// 写入纪律（§3.3.6）：onEvent 回调内追加写（有界缓冲 + 批量 flush），run 终态后
// flush 并 fsync 一次。journal 不随池删（D5），生命周期跟随 record。
//
// 失败语义：journal 是降级链第②级（尽力而为的数据源）——写失败不炸主流程：
// warn 一次 + 置 failed，后续 append 丢弃、close 立即返回（不静默：warn 有留痕）。

import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import { getLogger } from "../../../core/logger.ts";

import type { AgentEvent } from "../../assembly/types.ts";

const logger = getLogger("subagents");

// ============================================================
// 中立行格式（§3.3.6 v1）
// ============================================================

/** journal 单行（JSONL）。seq 是 host 侧单调递增序号——重放顺序权威。 */
export interface JournalLine {
  v: 1;
  /** host 落盘时刻（Date.now()，ms）。 */
  ts: number;
  /** = RunContext.taskId = record.id（journal 文件名与池引用计数 key）。 */
  taskId: string;
  engineId: string;
  seq: number;
  /** AgentEvent 原样（onEvent 回调对象的 JSON.stringify 直接产物，无二次变换）。 */
  event: AgentEvent;
}

// ============================================================
// JournalWriter
// ============================================================

/** flush 触发的缓冲阈值：行数与字节数任一到达即批量落盘（有界缓冲）。 */
const FLUSH_THRESHOLD_LINES = 64;
// eslint-disable-next-line no-magic-numbers -- 32KB = 32 * 1024 bytes 缓冲字节换算常数
const FLUSH_THRESHOLD_BYTES = 32 * 1024;

/** FileHandle 的结构子集（close 期 fsync 用；注入 fake 可测）。 */
export interface FileHandleLike {
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** writer 的文件系统依赖面（结构接口：测试注入 fake，免 vi.mock 整个 fs 模块）。 */
export interface JournalFsDeps {
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
  appendFile(path: string, data: string): Promise<void>;
  open(path: string, flags: string): Promise<FileHandleLike>;
}

const defaultFs: JournalFsDeps = {
  mkdir: (p, o) => mkdir(p, o),
  appendFile: (p, d) => appendFile(p, d, "utf8"),
  open: (p, f) => open(p, f),
};

/** JournalWriter 构造参数。 */
export interface JournalWriterOpts {
  /** journal 文件绝对路径（经 paths.ts resolveJournalPath 派生，禁自拼）。 */
  path: string;
  taskId: string;
  engineId: string;
}

/**
 * 追加写 writer：append 同步入队（onEvent 是同步回调，不阻塞事件流），批量异步
 * flush；close = flush 全部 + fsync 一次（§3.3.6 写入纪律）。
 *
 * 文件惰性创建：首个 flush 才 mkdir + appendFile——无事件的任务不产生空 journal。
 */
export class JournalWriter {
  private readonly opts: JournalWriterOpts;
  private readonly fs: JournalFsDeps;
  private readonly warn: (msg: string) => void;

  private buffer: string[] = [];
  private bufferedBytes = 0;
  private seq = 0;
  /** 串行化异步写（promise 链），防交错 append。 */
  private chain: Promise<void> = Promise.resolve();
  private failed = false;
  private closed = false;
  /** 是否成功落过盘——close 的 fsync 只对已存在的文件做（无事件任务不产生空文件）。 */
  private wrote = false;

  constructor(opts: JournalWriterOpts, fs: JournalFsDeps = defaultFs, warn: (msg: string) => void = defaultWarn) {
    this.opts = opts;
    this.fs = fs;
    this.warn = warn;
  }

  /** 追加一个事件（同步入队；缓冲达阈值自动排队 flush）。closed/failed 后丢弃。 */
  append(event: AgentEvent): void {
    if (this.failed || this.closed) return;
    const line: JournalLine = {
      v: 1,
      ts: Date.now(),
      taskId: this.opts.taskId,
      engineId: this.opts.engineId,
      seq: this.seq++,
      event,
    };
    const serialized = JSON.stringify(line);
    this.buffer.push(serialized);
    this.bufferedBytes += serialized.length;
    if (this.buffer.length >= FLUSH_THRESHOLD_LINES || this.bufferedBytes >= FLUSH_THRESHOLD_BYTES) {
      void this.flush();
    }
  }

  /** 把缓冲写入磁盘（串行排队；等待此前所有排队写完成）。 */
  flush(): Promise<void> {
    if (this.failed || this.buffer.length === 0) return this.chain;
    const chunk = `${this.buffer.join("\n")}\n`;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.chain = this.chain.then(() => this.writeChunk(chunk));
    return this.chain;
  }

  /** run 终态后调用：flush 全部 + fsync 一次 + 关闭（幂等）。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    if (this.failed || !this.wrote) return;
    // fsync 一次（§3.3.6）：进程崩溃后已 flush 的行不丢——record 读第②级的一致性依据
    this.chain = this.chain.then(async () => {
      const fh = await this.fs.open(this.opts.path, "r");
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    });
    await this.chain;
  }

  /** 是否已写失败（降级诊断用；failed 后 journal 不可作为②级数据源）。 */
  get isFailed(): boolean {
    return this.failed;
  }

  /**
   * 当前落盘路径（handle.journalPath 回填数据源）。
   * [池抽象降级 2026-09-13] 原 retarget（onPoolResolved 重定向路径）已删除——
   * 路径构造即终值（两引擎 poolKey 恒 'shared'）。
   */
  get path(): string {
    return this.opts.path;
  }

  private async writeChunk(chunk: string): Promise<void> {
    try {
      await this.fs.mkdir(dirname(this.opts.path), { recursive: true });
      await this.fs.appendFile(this.opts.path, chunk);
      this.wrote = true;
    } catch (err) {
      // 尽力而为语义：一次写失败即永久放弃（重试追写会产生乱序行），warn 留痕不静默
      this.failed = true;
      this.buffer = [];
      this.warn(
        `[event-journal] write failed, journal for task ${this.opts.taskId} is unavailable ` +
          `(read falls back to lower tiers): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function defaultWarn(msg: string): void {
  logger.warn(msg);
}

// ============================================================
// 重放
// ============================================================

// replayJournal/parseLine 已收编 SDK journal-io（S4 簇 6：zcode 引擎包不能 import
// core，双包逐字等价副本单源落 SDK；此处 re-export 保 journal-replay.ts /
// session-view-service.ts 消费路径零改动）。行格式权威仍 §3.3.6，行为逐字等价。
export { replayJournal } from "@zhushanwen/subagent-engine-sdk";
