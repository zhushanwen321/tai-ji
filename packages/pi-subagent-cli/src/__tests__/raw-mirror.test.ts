// src/__tests__/raw-mirror.test.ts
//
// [M3 relay-spawn-transport u-m3-mirror 验收①] fd3 raw mirror 写入侧单测：
//   - 帧形态 `{v:1, recordId, seq, b64}` + seq 单调（丢弃也递增）；
//   - 行切分在字节层（跨 chunk 的 UTF-8 多字节字符不被劈坏；b64 解码 ≡ 原始行字节）；
//   - env 未宣告 → 工厂不创建（零 fd3 触点）；
//   - 写失败/队列超限 → 丢弃计数 + warn 一次，不抛出不阻塞；
//   - 进程级共享 sink：per-run 回调随 dispose 摘除（连续 15 个 run 监听器数不增长）；
//   - 写入点与主 stdout 解析同一数据源（wireChildStdoutPump 的原始 Buffer tap：
//     mirror 行序列 ≡ 行解析链事件序列，同一读取顺序）。
//
// 注意：fd3 在测试进程里可能是 vitest worker 的内部管道，**禁止**在测试中创建真实
// fd3 写入器（createFd3RawMirrorWriter 仅验证 env 关闭分支）；背压/失败用注入 sink 驱动。

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFd3RawMirrorWriter,
  createRawMirrorSeqRegistry,
  createRawMirrorWriter,
  createSharedFd3Sink,
  isRawMirrorActive,
  RAW_MIRROR_ENV_VAR,
  RAW_MIRROR_MAX_QUEUE_BYTES,
  type RawMirrorFrame,
  type RawMirrorSink,
  type RawMirrorWriter,
} from "../raw-mirror.ts";
import {
  createSessionIdentityTracker,
  wireChildStdoutPump,
  type RunEndState,
  type StdoutPumpDeps,
} from "../spawn-run-pump.ts";
import type { SpawnRunCallbacks } from "../spawn-runner.ts";

/** 帧收集 sink（无背压；丢帧不混入）。 */
function collectingSink(): { sink: RawMirrorSink; frames: RawMirrorFrame[] } {
  const frames: RawMirrorFrame[] = [];
  return {
    frames,
    sink: {
      write: (frame) => {
        frames.push(JSON.parse(frame) as RawMirrorFrame);
        return true;
      },
    },
  };
}

function decodeFrames(frames: RawMirrorFrame[]): string[] {
  return frames.map((f) => Buffer.from(f.b64, "base64").toString("utf8"));
}

describe("raw mirror 写入器（行切分 / 帧形态 / seq）", () => {
  it("单 chunk 多行 → 逐行一帧：v=1/recordId/seq 从 0 单调 + b64 解码 ≡ 原始行字节", () => {
    const { sink, frames } = collectingSink();
    const writer = createRawMirrorWriter({ recordId: "rec-1", sink });
    writer.tap(Buffer.from("aaa\nbbb\nccc\n", "utf8"));

    expect(frames).toHaveLength(3);
    expect(frames.map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(frames.every((f) => f.v === 1 && f.recordId === "rec-1")).toBe(true);
    expect(decodeFrames(frames)).toEqual(["aaa", "bbb", "ccc"]);
    expect(writer.stats).toEqual({ written: 3, dropped: 0 });
  });

  it("同 recordId 连续两 run（writer 重建）→ seq 由进程级计数器接续，不从 0 重开", () => {
    // 回归 R2-B-U-1：workflow 成员复用 = 同 recordId 在后续 run 再次派发；写侧 seq 若
    // per-run 重置，读取侧 RecordMirror（生命周期 = 通道/引擎进程）会把 seq 回落判为
    // 空洞并永久停发 live 流。计数器载体 = 注册表（引擎进程级），writer 只取初始值递增。
    const { sink, frames } = collectingSink();
    const registry = createRawMirrorSeqRegistry();

    const run1 = createRawMirrorWriter({
      recordId: "rec-reuse",
      sink,
      seqCounter: registry.counterFor("rec-reuse"),
    });
    run1.tap(Buffer.from("a\nb\n", "utf8"));
    run1.dispose();

    // 其它 record 不受影响：各自的计数器从 0 起
    const other = createRawMirrorWriter({
      recordId: "rec-other",
      sink,
      seqCounter: registry.counterFor("rec-other"),
    });
    other.tap(Buffer.from("x\n", "utf8"));
    other.dispose();

    // 第二轮 run：writer 新建，但同一 recordId 的计数器已推进到 2
    const run2 = createRawMirrorWriter({
      recordId: "rec-reuse",
      sink,
      seqCounter: registry.counterFor("rec-reuse"),
    });
    run2.tap(Buffer.from("c\nd\n", "utf8"));
    run2.dispose();

    expect(frames.filter((f) => f.recordId === "rec-reuse").map((f) => f.seq)).toEqual([0, 1, 2, 3]);
    expect(frames.filter((f) => f.recordId === "rec-other").map((f) => f.seq)).toEqual([0]);
  });

  it("跨 chunk 行重组 + 多字节字符劈在 chunk 边界：完整行才产出，b64 保真（含 CJK/astral）", () => {
    const { sink, frames } = collectingSink();
    const writer = createRawMirrorWriter({ recordId: "rec-mb", sink });

    // "你好\u{1F680}" 的 UTF-8 字节流被人为劈在码点中间（模拟 OS read 边界）。
    const lineBytes = Buffer.from('{"text":"你好\u{1F680}"}\n', "utf8");
    const split1 = 12; // 落在 "你" 的三字节中间
    writer.tap(lineBytes.subarray(0, split1));
    expect(frames).toHaveLength(0); // 无完整行 → 零帧
    writer.tap(lineBytes.subarray(split1, lineBytes.length - 1)); // 仍缺 \n
    expect(frames).toHaveLength(0);
    writer.tap(lineBytes.subarray(lineBytes.length - 1)); // 补上行尾

    expect(frames).toHaveLength(1);
    expect(Buffer.from(frames[0].b64, "base64")).toEqual(lineBytes.subarray(0, lineBytes.length - 1));
    expect(decodeFrames(frames)).toEqual(['{"text":"你好\u{1F680}"}']);
  });

  it("残留无换行尾 byte 不产出帧（NDJSON 语义）；dispose 后 tap 为 no-op", () => {
    const { sink, frames } = collectingSink();
    const writer = createRawMirrorWriter({ recordId: "rec-tail", sink });
    writer.tap(Buffer.from("complete\npartial", "utf8"));
    expect(frames).toHaveLength(1);
    writer.dispose();
    writer.tap(Buffer.from("more\n", "utf8"));
    expect(frames).toHaveLength(1);
    expect(decodeFrames(frames)).toEqual(["complete"]);
  });

  it("\\r\\n 行尾原样保留在 b64（reader 侧补 \\n 后逐字节还原）", () => {
    const { sink, frames } = collectingSink();
    const writer = createRawMirrorWriter({ recordId: "rec-crlf", sink });
    writer.tap(Buffer.from("a\r\nb\n", "utf8"));
    expect(decodeFrames(frames)).toEqual(["a\r", "b"]);
  });
});

describe("raw mirror 丢弃面（best-effort：不阻塞 stdout、不影响 run）", () => {
  it("队列超限 → 丢弃计数 + warn 一次，seq 仍递增（丢弃也递增）", () => {
    const warnings: string[] = [];
    const writtenLines: string[] = [];
    // 永不 drain 的背压 sink：write 恒返回 false。
    const sink: RawMirrorSink = {
      write: (frame) => {
        writtenLines.push(frame);
        return false;
      },
    };
    const oneFrameBytes = Buffer.byteLength(
      `${JSON.stringify({ v: 1, recordId: "rec-overflow", seq: 0, b64: Buffer.from("1111111111").toString("base64") })}\n`,
      "utf8",
    );
    const writer = createRawMirrorWriter({
      recordId: "rec-overflow",
      sink,
      // 小窗注入：前两帧入队（2×frame），第三帧超上限丢弃。
      maxQueueBytes: oneFrameBytes * 2 + 1,
      warn: (m) => warnings.push(m),
    });
    writer.tap(Buffer.from(["1111111111", "2222222222", "3333333333"].join("\n") + "\n", "utf8"));

    expect(writer.stats.written).toBe(2);
    expect(writer.stats.dropped).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[raw-mirror] write queue exceeded");
    // 已产出的帧保持 seq 单调（0/1）；丢帧不落 sink。
    expect(writtenLines.map((l) => (JSON.parse(l) as RawMirrorFrame).seq)).toEqual([0, 1]);
  });

  it("sink.write 抛错 → 丢弃计数 + 单次 warn，tap 不抛出（后续帧继续走丢弃）", () => {
    const warnings: string[] = [];
    let calls = 0;
    const sink: RawMirrorSink = {
      write: () => {
        calls += 1;
        throw new Error("EPIPE");
      },
    };
    const writer = createRawMirrorWriter({ recordId: "rec-throw", sink, warn: (m) => warnings.push(m) });
    expect(() => writer.tap(Buffer.from("x\ny\nz\n", "utf8"))).not.toThrow();
    expect(calls).toBe(1); // 失败后不再触 sink
    expect(writer.stats).toEqual({ written: 0, dropped: 3 });
    expect(warnings.filter((w) => w.includes("fd3 write threw"))).toHaveLength(1);
  });

  it("sink error 事件 → 一次性 warn，后续帧丢弃", () => {
    const warnings: string[] = [];
    let onError: ((err: unknown) => void) | undefined;
    const sink: RawMirrorSink = {
      write: () => true,
      onError: (handler) => {
        onError = handler;
      },
    };
    const writer = createRawMirrorWriter({ recordId: "rec-err", sink, warn: (m) => warnings.push(m) });
    writer.tap(Buffer.from("first\n", "utf8"));
    expect(writer.stats.written).toBe(1);
    onError?.(new Error("EBADF"));
    writer.tap(Buffer.from("second\n", "utf8"));
    expect(writer.stats).toEqual({ written: 1, dropped: 1 });
    expect(warnings.filter((w) => w.includes("fd3 write error"))).toHaveLength(1);
  });

  it("drain 恢复：背压后队列可复用（maxQueueBytes 内不被误弃）", () => {
    let drain: (() => void) | undefined;
    const sink: RawMirrorSink = {
      write: () => false,
      onDrain: (handler) => {
        drain = handler;
      },
    };
    const oneFrameBytes = Buffer.byteLength(
      `${JSON.stringify({ v: 1, recordId: "rec-drain", seq: 0, b64: Buffer.from("aaaaaaaa").toString("base64") })}\n`,
      "utf8",
    );
    const writer = createRawMirrorWriter({ recordId: "rec-drain", sink, maxQueueBytes: oneFrameBytes * 2 + 10 });
    writer.tap(Buffer.from(["aaaaaaaa", "bbbbbbbb"].join("\n") + "\n", "utf8"));
    const first = writer.stats.written;
    expect(first).toBe(2);
    drain?.(); // 排空后队列归零
    writer.tap(Buffer.from("cccccccc\n", "utf8"));
    expect(writer.stats.dropped).toBe(0);
    expect(writer.stats.written).toBe(first + 1);
  });
});

describe("raw mirror env 宣告闸（无宣告零 fd3 触点）", () => {
  it("isRawMirrorActive：仅 '1' 为真（缺失/空串/其他值均关闭）", () => {
    expect(isRawMirrorActive({ [RAW_MIRROR_ENV_VAR]: "1" })).toBe(true);
    expect(isRawMirrorActive({})).toBe(false);
    expect(isRawMirrorActive({ [RAW_MIRROR_ENV_VAR]: "" })).toBe(false);
    expect(isRawMirrorActive({ [RAW_MIRROR_ENV_VAR]: "true" })).toBe(false);
  });

  it("env 未宣告 → 工厂返回 undefined（不创建任何写入器）", () => {
    expect(createFd3RawMirrorWriter({ recordId: "rec-off", env: {} })).toBeUndefined();
  });

  it("缺省队列上限为设计值 1MB（常量守卫）", () => {
    expect(RAW_MIRROR_MAX_QUEUE_BYTES).toBe(1024 * 1024);
  });
});

// ── 进程级共享 sink：per-run 回调不跨 run 滞留（C-U4） ──────────────────────

describe("进程级共享 sink（C-U4：长驻引擎不累积监听器）", () => {
  it("连续 15 个 run（create → dispose 循环）：listenerCount 恒为 1/1，注册表每轮归零", () => {
    const stream = new PassThrough();
    const sink = createSharedFd3Sink(stream);
    for (let i = 0; i < 15; i += 1) {
      const writer = createRawMirrorWriter({ recordId: `rec-seq-${i}`, sink });
      expect(sink.handlerCounts).toEqual({ drain: 1, error: 1 });
      expect(stream.listenerCount("drain")).toBe(1);
      expect(stream.listenerCount("error")).toBe(1);
      writer.dispose();
      expect(sink.handlerCounts).toEqual({ drain: 0, error: 0 });
    }
    // 修复前每 run 直接 stream.on('drain'/'error') 且不反注册 → 第 11 个 run 触发
    // MaxListenersExceededWarning；现在进程级监听器恒为 1（不随 run 数增长）。
    expect(stream.listenerCount("drain")).toBe(1);
    expect(stream.listenerCount("error")).toBe(1);
  });

  it("15 个 run 同时在册：流级 drain/error 监听器仍为 1/1，回调注册表 = 活跃 run 数", () => {
    const stream = new PassThrough();
    const sink = createSharedFd3Sink(stream);
    const writers: RawMirrorWriter[] = [];
    for (let i = 0; i < 15; i += 1) {
      writers.push(createRawMirrorWriter({ recordId: `rec-shared-${i}`, sink }));
    }
    // 15 个活跃 run 只挂 2 个流监听器（修复前每 run 一个 drain 监听器 → 第 11 个触发
    // MaxListenersExceededWarning）；per-run 回调收进注册表。
    expect(stream.listenerCount("drain")).toBe(1);
    expect(stream.listenerCount("error")).toBe(1);
    expect(sink.handlerCounts).toEqual({ drain: 15, error: 15 });

    for (const writer of writers) writer.dispose();
    expect(sink.handlerCounts).toEqual({ drain: 0, error: 0 });
    // 监听器数不随 run 数/生命周期增长（进程级单例恒为 1）
    expect(stream.listenerCount("drain")).toBe(1);
    expect(stream.listenerCount("error")).toBe(1);
  });

  it("dispose 幂等：重复调用不重复摘除（注册表仍归零）", () => {
    const stream = new PassThrough();
    const sink = createSharedFd3Sink(stream);
    const writer = createRawMirrorWriter({ recordId: "rec-idem", sink });
    expect(sink.handlerCounts).toEqual({ drain: 1, error: 1 });
    writer.dispose();
    writer.dispose();
    expect(sink.handlerCounts).toEqual({ drain: 0, error: 0 });
  });

  it("共享 drain 事件仍逐 run 排空写队列（单监听器分发给注册表）", () => {
    // 背压桩：highWaterMark=1 使每次 write 返回 false（帧计入队列），drain 由测试手动触发。
    const stream = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const sink = createSharedFd3Sink(stream);
    const oneFrameBytes = Buffer.byteLength(
      `${JSON.stringify({ v: 1, recordId: "rec-shared-drain", seq: 0, b64: Buffer.from("aaaaaaaa").toString("base64") })}\n`,
      "utf8",
    );
    const a = createRawMirrorWriter({ recordId: "rec-a", sink, maxQueueBytes: oneFrameBytes * 2 + 10 });
    const b = createRawMirrorWriter({ recordId: "rec-b", sink, maxQueueBytes: oneFrameBytes * 2 + 10 });
    // 两 run 各写两帧 → 队列各占满（第三帧将被丢）
    a.tap(Buffer.from("aaaaaaaa\nbbbbbbbb\n", "utf8"));
    b.tap(Buffer.from("cccccccc\ndddddddd\n", "utf8"));
    expect(a.stats.written).toBe(2);
    expect(b.stats.written).toBe(2);
    expect(sink.handlerCounts).toEqual({ drain: 2, error: 2 });
    // 单次 drain 事件触发注册表全部 handler → 两 run 队列同时归零
    stream.emit("drain");
    a.tap(Buffer.from("eeeeeeee\n", "utf8"));
    b.tap(Buffer.from("ffffffff\n", "utf8"));
    expect(a.stats.dropped).toBe(0);
    expect(b.stats.dropped).toBe(0);
    a.dispose();
    b.dispose();
  });
});

// ── wireChildStdoutPump 接线：tap 与主解析链同一数据源、顺序一致 ──────────────

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "raw-mirror-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

type FakeChild = {
  child: ChildProcess;
  fireClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const child = {
    stdout,
    stdin,
    stderr: null,
    killed: false,
    pid: 5252,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  } as unknown as ChildProcess;
  return {
    child,
    fireClose: (code, signal = null) => {
      emitter.emit("close", code, signal);
      stdout.end();
      stdin.end();
    },
  };
}

function wirePumpWithMirror(rawMirror?: RawMirrorWriter): {
  fireClose: FakeChild["fireClose"];
  exitPromise: Promise<number>;
  events: string[];
  stdout: PassThrough;
} {
  const { child, fireClose } = makeFakeChild();
  const events: string[] = [];
  const callbacks: SpawnRunCallbacks = { onEvent: () => {} };
  const identity = createSessionIdentityTracker(dir, callbacks);
  const runEnd: RunEndState = { endedCleanly: true };
  const deps: StdoutPumpDeps = {
    child,
    recordId: "rec-wire",
    callbacks,
    identity,
    handleSdkEvent: (event) => {
      events.push(String((event as { type?: unknown }).type));
    },
    enqueueUi: () => {},
    stderrTee: undefined,
    runEnd,
    ...(rawMirror !== undefined ? { rawMirror } : {}),
  };
  return { fireClose, exitPromise: wireChildStdoutPump(deps), events, stdout: child.stdout as PassThrough };
}

describe("raw mirror 与 stdout 解析同源接线（wireChildStdoutPump）", () => {
  it("镜像开通：mirror 行序列 ≡ 行解析链事件序列（跨 chunk 多行同序），b64 解码 ≡ 原始行", async () => {
    const { sink, frames } = collectingSink();
    const mirror = createRawMirrorWriter({ recordId: "rec-wire", sink });
    const h = wirePumpWithMirror(mirror);

    const lines = [
      JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好\u{1F680}" } }),
      JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] }),
    ];
    const payload = lines.map((l) => l + "\n").join("");
    // 任意切分（含劈在行/多字节中间）也保持同源同序。
    const buf = Buffer.from(payload, "utf8");
    h.stdout.write(buf.subarray(0, 7));
    h.stdout.write(buf.subarray(7, 33));
    h.stdout.write(buf.subarray(33, 61));
    for (let i = 61; i < buf.length; i += 17) {
      h.stdout.write(buf.subarray(i, Math.min(i + 17, buf.length)));
    }
    h.fireClose(0);
    await h.exitPromise;

    expect(decodeFrames(frames)).toEqual(lines);
    expect(frames.map((f) => f.seq)).toEqual([0, 1, 2, 3]);
    // 同一读取顺序：解析链收到的事件序列 ≡ mirror 行里 type 的序列
    const mirrorTypes = decodeFrames(frames).map((l) => (JSON.parse(l) as { type: string }).type);
    expect(h.events).toEqual(mirrorTypes);
  });

  it("镜像未开通：stdout 解析路径行为不变（无 PassThrough 桥），close 正常收尾", async () => {
    const h = wirePumpWithMirror(undefined);
    h.stdout.write(Buffer.from(`${JSON.stringify({ type: "turn_start" })}\n`, "utf8"));
    h.fireClose(0);
    await expect(h.exitPromise).resolves.toBe(0);
    expect(h.events).toEqual(["turn_start"]);
  });
});
