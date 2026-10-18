// src/raw-mirror.ts
//
// [M3 relay-spawn-transport §3.4.4 D6] 引擎侧 fd3 raw stdout 镜像写入器。
//
// runtime 在 spawn 引擎进程时多开一根 pipe（stdio[3]）并以 env
// `TAIJI_ENGINE_RAW_MIRROR=1` 宣告（runtime 侧注入点 =
// infra/subagent-control/engine-launch-env.ts；deny 矩阵只剥 task pi，引擎自身合法
// 读取）。本模块把本次 run 的 pi 子进程 stdout **原始字节**按行转成
// `{v:1, recordId, seq, b64}` NDJSON 帧写入 fd3——runtime 侧镜像读取器
// （infra/subagent-control/mirror.ts）据此重建实时 subagent 流（tee）与磁盘镜像。
//
// 关键契约（设计 D6 / §3.4.4）：
//   - 写入点必须与既有 stdout 解析同一数据源：tap 在 `child.stdout.on('data')` 的
//     **原始 Buffer** 处（spawn-run-pump 在挂 `pumpNdjsonLines` 的 setEncoding 之前
//     接线），顺序与主解析链一致（tap 先注册，先收同一 chunk）；
//   - 行切分在字节层完成（跨 chunk 的 UTF-8 多字节字符留在缓冲里等到完整行再
//     b64——`chunk.toString('utf8')` 逐 chunk 解码会把多字节字符劈坏）；
//   - `seq` **per recordId** 单调递增（跨 run 不重置），**丢弃也递增**（丢弃由 runtime
//     侧 seq 空洞检测 + degraded 显式标注）。引擎进程可服务多个 run；workflow 成员复用
//     会让同一 recordId 在后续 run 再次派发——计数归进程级 per-record 注册表持有，
//     writer（per run）只取初始值并递增，因此「同一 record 的 seq 只增不回落」在跨 run
//     面同样成立（读取侧 RecordMirror 生命周期 = 通道/引擎进程，两侧口径一致）；
//   - 写策略 = 非阻塞 best-effort：fd3 不存在/写失败/队列 >1MB → 丢弃并计数，warn
//     一次；不阻塞 pi stdout 消费、不影响 run（live 流是派生视图，权威数据仍是 pi
//     session 文件 + journal）。

import * as fs from "node:fs";
import type { Writable } from "node:stream";

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

const logger = getLogger("raw-mirror");

/**
 * fd3 镜像宣告 env 键：runtime 在 `buildEngineLaunchEnv` 以 L0 显式注入 `'1'`。
 * 与 runtime 侧 engine-launch-env.ts 的同名字面量是跨进程契约（改名须两处同批）；
 * 本包不 import runtime，故在引擎侧保留本常量（引擎是唯一合法读取方）。
 */
export const RAW_MIRROR_ENV_VAR = "TAIJI_ENGINE_RAW_MIRROR";

/** fd3 镜像通道的文件描述符号（stdio[3]，设计 D6）。 */
export const RAW_MIRROR_FD = 3;

/** 字节/KiB 换算常量（no-magic-numbers 口径：单字面量 const 声明不入表达式）。 */
const BYTES_PER_KIB = 1024;

/** 换行字节（行切分判据）。 */
const NEWLINE_BYTE = 0x0a;

/** 写队列上限（设计 §3.4.4：队列 >1MB 丢弃并计数）。 */
export const RAW_MIRROR_MAX_QUEUE_BYTES = BYTES_PER_KIB * BYTES_PER_KIB;

/** 单帧 wire 形状（设计 §3.4.4；与 runtime 侧 RawMirrorWireFrame 对偶）。 */
export type RawMirrorFrame = {
  v: 1;
  recordId: string;
  seq: number;
  /** 一个完整 stdout 行的原始字节（不含行尾 \n；runtime 侧按行重建时补回）。 */
  b64: string;
};

/**
 * per-record seq 计数器（引擎进程级共享；writer 取初始值后原地递增）。
 * 不作 run 结束重置：同 recordId 的第二轮 run 必须接续上一轮的序号，否则读取侧
 * 会把 seq 回落判为空洞并永久停发 live 流。
 */
export type RawMirrorSeqCounter = { value: number };

/** per-recordId 计数器注册表（进程级共享；同一 recordId 恒返回同一计数器实例）。 */
export type RawMirrorSeqRegistry = {
  counterFor(recordId: string): RawMirrorSeqCounter;
};

/**
 * 创建 per-record 计数器注册表。条目随引擎进程生命周期保留（每个被镜像过的
 * recordId 一条，值是小整数）——不按 run 清理，正是跨 run 单调契约的载体。
 */
export function createRawMirrorSeqRegistry(): RawMirrorSeqRegistry {
  const counters = new Map<string, RawMirrorSeqCounter>();
  return {
    counterFor(recordId: string): RawMirrorSeqCounter {
      let counter = counters.get(recordId);
      if (counter === undefined) {
        counter = { value: 0 };
        counters.set(recordId, counter);
      }
      return counter;
    },
  };
}

/** 写入统计（dispose 后只读快照）。 */
export type RawMirrorStats = {
  /** 已写入 sink 的帧数（seq 不在此计数——丢弃帧不落 sink 但同样消耗 seq）。 */
  written: number;
  /** 丢弃帧数（fd 不可用/写失败/队列超限）。 */
  dropped: number;
};

/**
 * 写入通道端口（生产 = fd3 WriteStream；测试注入可控背压/失败桩）。
 * `write` 返回 false = 背压（帧已进写缓冲，计入队列直到 drain）。
 */
export type RawMirrorSink = {
  write(frame: string): boolean;
  /** 背压排空回调注册（缺省不注册 = 队列只增不减，达上限即丢弃）。 */
  onDrain?: (handler: () => void) => void;
  /** onDrain 反注册（writer.dispose 必达——共享 sink 的 per-run 回调不得跨 run 滞留）。 */
  offDrain?: (handler: () => void) => void;
  /** 写错误回调注册（一次性；失败后全部帧走丢弃计数）。 */
  onError?: (handler: (err: unknown) => void) => void;
  /** onError 反注册（writer.dispose 必达，理由同 {@link offDrain}）。 */
  offError?: (handler: (err: unknown) => void) => void;
};

/** fd3 raw mirror 写入器（per run；seq 归属 recordId，跨 run 接续）。 */
export type RawMirrorWriter = {
  /** 喂入 stdout 原始字节 chunk（与主解析链同一数据源；内部行切分）。 */
  tap(chunk: Buffer): void;
  /** run 结束释放（幂等；不 close fd——fd3 属引擎进程，跨 run 复用）。 */
  dispose(): void;
  /** 统计快照。 */
  readonly stats: RawMirrorStats;
};

export function isRawMirrorActive(env: NodeJS.ProcessEnv): boolean {
  return env[RAW_MIRROR_ENV_VAR] === "1";
}

function defaultWarn(message: string): void {
  logger.warn(message);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type RawMirrorWriterOptions = {
  recordId: string;
  sink: RawMirrorSink;
  /** 队列字节上限（测试注入小值；缺省 {@link RAW_MIRROR_MAX_QUEUE_BYTES}）。 */
  maxQueueBytes?: number;
  /** 告警出口（缺省 SDK logger.warn；测试注入捕获）。 */
  warn?: (message: string) => void;
  /**
   * per-record seq 计数器（引擎进程级共享；缺省新建从 0 起的独立计数器——单测/一次性
   * 写入器形态）。生产工厂按 recordId 从 {@link RawMirrorSeqRegistry} 取同一实例。
   */
  seqCounter?: RawMirrorSeqCounter;
};

/**
 * 创建 per-run 写入器（`seq` 来自 per-record 计数器，不随 run 重置）。行切分缓冲用
 * Buffer 列表（防超长行跨 chunk 累积的 O(n²) 拷贝）；仅完整行（\n 界）才产出帧——
 * 残留尾部随 run 结束丢弃（NDJSON 语义，与 pumpNdjsonLines 一致）。
 */
export function createRawMirrorWriter(opts: RawMirrorWriterOptions): RawMirrorWriter {
  const maxQueueBytes = opts.maxQueueBytes ?? RAW_MIRROR_MAX_QUEUE_BYTES;
  const warn = opts.warn ?? defaultWarn;
  const pending: Buffer[] = [];
  // seq 归属 recordId 而非 run：共享计数器跨 run 接续（见 {@link RawMirrorSeqCounter}）。
  const seqCounter = opts.seqCounter ?? { value: 0 };
  let queuedBytes = 0;
  let failed = false;
  let disposed = false;
  let warnedFailure = false;
  let warnedQueue = false;
  const stats: RawMirrorStats = { written: 0, dropped: 0 };

  const fail = (reason: string, detail?: unknown): void => {
    failed = true;
    if (warnedFailure) return;
    warnedFailure = true;
    warn(
      `[raw-mirror] mirror disabled (${reason}) recordId=${opts.recordId}; ` +
        `the live subagent stream will be marked degraded, reload is unaffected` +
        (detail !== undefined ? `: ${describeError(detail)}` : ""),
    );
  };

  // [C-U4] 回调句柄持名，dispose 时按名反注册：共享 sink 是进程级单例，per-run 回调
  // 若只注册不注销，长驻引擎的 drain 监听器与 errorHandlers 会随 run 数无界增长
  // （第 11 个 run 起触发 Node MaxListenersExceededWarning）。
  const onDrain = (): void => {
    queuedBytes = 0;
  };
  const onError = (err: unknown): void => {
    fail("fd3 write error", err);
  };
  opts.sink.onDrain?.(onDrain);
  opts.sink.onError?.(onError);

  // 待拼缓冲中找到第一个 \n 的绝对偏移（-1 = 尚无完整行）。
  const findNewline = (): number => {
    let offset = 0;
    for (const chunk of pending) {
      const nl = chunk.indexOf(NEWLINE_BYTE);
      if (nl !== -1) return offset + nl;
      offset += chunk.length;
    }
    return -1;
  };

  // 从待拼缓冲头部取出 count 字节（调用方保证 count <= 待拼长度）。
  const take = (count: number): Buffer => {
    const head = pending[0];
    if (head === undefined) return Buffer.alloc(0);
    if (head.length >= count) {
      const line = head.subarray(0, count);
      if (head.length === count) pending.shift();
      else pending[0] = head.subarray(count);
      return line;
    }
    const out = Buffer.allocUnsafe(count);
    let filled = 0;
    while (filled < count) {
      const next = pending[0];
      if (next === undefined) break;
      const takeLen = Math.min(next.length, count - filled);
      next.copy(out, filled, 0, takeLen);
      if (takeLen === next.length) pending.shift();
      else pending[0] = next.subarray(takeLen);
      filled += takeLen;
    }
    return out;
  };

  const emitLine = (line: Buffer): void => {
    // seq 先递增——丢弃也递增（设计 D6；runtime 侧靠 seq 空洞检测丢弃）。
    // 计数器 per recordId 进程级共享：跨 run 接续，不在此处重置。
    const frame: RawMirrorFrame = {
      v: 1,
      recordId: opts.recordId,
      seq: seqCounter.value++,
      b64: line.toString("base64"),
    };
    const wire = `${JSON.stringify(frame)}\n`;
    if (disposed || failed) {
      stats.dropped += 1;
      return;
    }
    const frameBytes = Buffer.byteLength(wire, "utf8");
    if (queuedBytes + frameBytes > maxQueueBytes) {
      stats.dropped += 1;
      if (!warnedQueue) {
        warnedQueue = true;
        warn(
          `[raw-mirror] write queue exceeded ${maxQueueBytes} bytes, dropping frames recordId=${opts.recordId}; ` +
            `the runtime will mark this record's live stream degraded`,
        );
      }
      return;
    }
    try {
      const ok = opts.sink.write(wire);
      stats.written += 1;
      if (!ok) queuedBytes += frameBytes;
    } catch (err) {
      stats.dropped += 1;
      fail("fd3 write threw", err);
    }
  };

  return {
    tap(chunk: Buffer): void {
      if (disposed || chunk.length === 0) return;
      pending.push(chunk);
      for (;;) {
        const nl = findNewline();
        if (nl === -1) break;
        const line = take(nl);
        take(1); // 丢弃行界 \n（take(nl) 只取行内容，不推进分隔符）
        emitLine(line);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      pending.length = 0;
      // 本 run 的计数归零 + 从共享 sink 摘除回调（幂等；fd3 属引擎进程不 close）。
      queuedBytes = 0;
      opts.sink.offDrain?.(onDrain);
      opts.sink.offError?.(onError);
    },
    get stats(): RawMirrorStats {
      return { ...stats };
    },
  };
}

/**
 * 共享 sink 的测试可观测面：per-run 回调注册表大小（dispose 后必须归零）。
 * 流级监听器恒为 2（drain/error 各一，进程级单例），不随 run 数增长。
 */
export type SharedFd3Sink = RawMirrorSink & {
  readonly handlerCounts: { drain: number; error: number };
};

/**
 * 构造进程级共享 fd3 sink（单 WriteStream = 跨 run 写序串行化；导出供测试注入
 * Writable 桩——生产路径的 fd3 句柄不可在测试进程里真实创建）。
 *
 * 一个引擎进程可并发服务多个 run（server 的 activeRuns 为 Map），各 run 各自 tap
 * 自己的 pi 子进程 stdout。若每个 per-run 写入器各持一个 fd3 WriteStream，大帧
 * （>PIPE_BUF）在管道上的 `write(2)` 会跨流字节交错、劈坏帧界；共享单流后所有帧经
 * 同一 Writable 队列按序整体写入，交错只发生在帧边界（帧自带 recordId/seq，读取侧按
 * record 归属）。fd3 属引擎进程、跨 run 复用——autoClose:false、从不由本流 close，
 * 进程退出统一回收。
 *
 * [C-U4] per-run 回调收进注册表，流上只挂**一个** drain 与一个 error 监听器：
 * 长驻引擎服务任意数量 run（含并发）都不会触发 MaxListeners 警告；writer.dispose
 * 经 offDrain/offError 摘除自身条目，注册表大小 = 活跃 run 数。
 */
export function createSharedFd3Sink(
  stream: Writable,
  opts: { onPersistentError?: (err: unknown) => void } = {},
): SharedFd3Sink {
  const drainHandlers = new Set<() => void>();
  const errorHandlers = new Set<(err: unknown) => void>();
  stream.on("drain", () => {
    // 快照迭代：handler 内部不会改注册表（只清自己的队列），防未来实现边迭代边删。
    for (const handler of [...drainHandlers]) handler();
  });
  stream.on("error", (err: unknown) => {
    // persistent 错误（EBADF 等）：后续 run 直接跳过镜像（单次告警由各 writer 的
    // fail 防重逻辑承担）。
    opts.onPersistentError?.(err);
    for (const handler of [...errorHandlers]) handler(err);
  });
  return {
    write: (frame) => stream.write(frame),
    onDrain: (handler) => {
      drainHandlers.add(handler);
    },
    offDrain: (handler) => {
      drainHandlers.delete(handler);
    },
    onError: (handler) => {
      errorHandlers.add(handler);
    },
    offError: (handler) => {
      errorHandlers.delete(handler);
    },
    get handlerCounts() {
      return { drain: drainHandlers.size, error: errorHandlers.size };
    },
  };
}

/** 进程级 per-record seq 注册表（长驻引擎跨 run 服务同一 record 时序号连续）。 */
const fd3SeqRegistry = createRawMirrorSeqRegistry();

let sharedFd3Sink: SharedFd3Sink | null = null;
/** persistent error 后新 run 不再重建 sink（fd3 已坏，避免每个 run 重复尝试与告警）。 */
let fd3Unavailable = false;
/** fd3 不可用的进程级一次性告警（首 run 响亮 warn，后续 run 仅 debug 留痕）。 */
let fd3UnavailableWarned = false;

/** 不可用告警一次化：后续 run 只 debug（设计 §3.4.4「warn 一次」）。 */
function warnFd3UnavailableOnce(warn: (message: string) => void, message: string): void {
  if (fd3UnavailableWarned) {
    logger.debug(message);
    return;
  }
  fd3UnavailableWarned = true;
  warn(message);
}

function getSharedFd3Sink(warn: (message: string) => void): RawMirrorSink | null {
  if (sharedFd3Sink !== null) return sharedFd3Sink;
  let stream: fs.WriteStream;
  try {
    // path 被忽略（fd 已给）。
    stream = fs.createWriteStream("", { fd: RAW_MIRROR_FD, autoClose: false });
  } catch (err) {
    fd3Unavailable = true;
    warnFd3UnavailableOnce(
      warn,
      `[raw-mirror] fd${RAW_MIRROR_FD} unavailable, mirror channel disabled: ${describeError(err)}`,
    );
    return null;
  }
  sharedFd3Sink = createSharedFd3Sink(stream, {
    onPersistentError: () => {
      fd3Unavailable = true;
    },
  });
  return sharedFd3Sink;
}

/**
 * 生产工厂：env 宣告时创建 fd3 写入器，否则返回 undefined（不引入任何 fd3 触点）。
 * fd 3 不存在（EBADF）/写失败都是异步错误事件，经 sink.onError 转入「丢弃 + warn
 * 一次」；创建期同步抛错（防御）同判。
 */
export function createFd3RawMirrorWriter(opts: {
  recordId: string;
  env: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}): RawMirrorWriter | undefined {
  if (!isRawMirrorActive(opts.env)) return undefined;
  const warn = opts.warn ?? defaultWarn;
  if (fd3Unavailable) {
    // [C-U4] 每 run 重复响亮告警与设计「warn 一次」相悖：只首个 run warn，其余 debug。
    warnFd3UnavailableOnce(
      warn,
      `[raw-mirror] fd${RAW_MIRROR_FD} is unavailable, mirror channel disabled for recordId=${opts.recordId}`,
    );
    return undefined;
  }
  const sink = getSharedFd3Sink(warn);
  if (sink === null) return undefined;
  return createRawMirrorWriter({
    recordId: opts.recordId,
    warn,
    sink,
    seqCounter: fd3SeqRegistry.counterFor(opts.recordId),
  });
}
