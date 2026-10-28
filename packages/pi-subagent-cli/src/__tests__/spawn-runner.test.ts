// spawn-runner.test.ts —— pi-subagent-cli C04 簇合并产物（round5-G）。
// 共同被测业务模块：`src/spawn-runner.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/raw-mirror.test.ts（20 用例，skip 0）
//   - src/__tests__/spawn-run-pump-prompt-activity.test.ts（3 用例，skip 0）
//   - src/__tests__/spawn-run-pump-session-file-fallback.test.ts（8 用例，skip 0）
//   - src/__tests__/spawn-runner-prompt-ack.test.ts（11 用例，skip 0）

import { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFd3RawMirrorWriter, createRawMirrorSeqRegistry, createRawMirrorWriter, createSharedFd3Sink, isRawMirrorActive, RAW_MIRROR_ENV_VAR, RAW_MIRROR_MAX_QUEUE_BYTES, type RawMirrorFrame, type RawMirrorSink, type RawMirrorWriter } from '../raw-mirror.ts'
import { createSessionIdentityTracker, wireChildStdoutPump, type RunEndState, type StdoutPumpDeps, createPromptRunCounters, type PromptRunCounters, type SessionIdentityTracker } from '../spawn-run-pump.ts'
import { type SpawnRunCallbacks, killAllActiveChildren, getActiveChild, runSpawnOnce, type SpawnRunParams, type SpawnRunResult } from '../spawn-runner.ts'
import { createPromptAckTracker, type PromptAckResult, PROMPT_ACK_TIMEOUT_ENV } from '../prompt-ack.ts'
import { configureLoggerSink, resetLoggerSinkForTests, type LogLevel, PI_SUBAGENT_TASK_MAX_CHARS, type AgentEvent } from '@zhushanwen/subagent-engine-sdk'
import { applyIdentityEnvToChildEnv, truncateTaskForEnv } from '../child-env.ts'

// ======== 来源：raw-mirror.test.ts ========
describe("raw-mirror", () => {
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

    it("丢弃后 dispose → 一条有界 warn（recordId/written/dropped/lastSeq），幂等不重复", () => {
      const warnings: string[] = [];
      const recordId = "rec-dispose-drop";
      const sink: RawMirrorSink = { write: () => false }; // 永不 drain：第三帧被队列上限丢弃
      const oneFrameBytes = Buffer.byteLength(
        `${JSON.stringify({ v: 1, recordId, seq: 0, b64: Buffer.from("1111111111").toString("base64") })}\n`,
        "utf8",
      );
      const writer = createRawMirrorWriter({
        recordId,
        sink,
        maxQueueBytes: oneFrameBytes * 2 + 1,
        warn: (m) => warnings.push(m),
      });
      writer.tap(Buffer.from("1111111111\n2222222222\n3333333333\n", "utf8"));
      expect(writer.stats).toEqual({ written: 2, dropped: 1 });
      expect(warnings).toHaveLength(1); // 队列超限 warn（既有）

      writer.dispose();
      expect(warnings).toHaveLength(2); // [m-pi-3] dispose 丢弃摘要（stats 唯一生产观测面）
      const summary = warnings[1]!;
      expect(summary).toContain("recordId=rec-dispose-drop");
      expect(summary).toContain("written=2");
      expect(summary).toContain("dropped=1");
      expect(summary).toContain("lastSeq=2"); // 丢弃帧也消耗 seq（0/1 写成功，2 被丢）
      expect(summary).toContain("only marks degraded when a later frame"); // 尾丢盲区的条件式措辞

      writer.dispose(); // 幂等：不重复告警
      expect(warnings).toHaveLength(2);
    });

    it("无丢弃 → dispose 不产生丢弃摘要 warn", () => {
      const warnings: string[] = [];
      const { sink } = collectingSink();
      const writer = createRawMirrorWriter({ recordId: "rec-dispose-clean", sink, warn: (m) => warnings.push(m) });
      writer.tap(Buffer.from("ok\n", "utf8"));
      writer.dispose();
      expect(warnings).toEqual([]);
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
});

// ======== 来源：spawn-run-pump-prompt-activity.test.ts ========
describe("spawn-run-pump-prompt-activity", () => {
  /** 零输出窗口（fake timers，取值不影响语义）。 */
  const ACK_WINDOW_MS = 1_000;

  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "pump-prompt-activity-"));
    // 只接管计时器：PassThrough 的 data 交付（nextTick）与 setImmediate flush 保持真实。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 等待 stdout 的 data 事件链（nextTick）跑完。 */
  async function flushStdout(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  function makeFakeChild(): {
    child: ChildProcess;
    stdout: PassThrough;
  } {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const child = {
      stdout,
      stdin,
      stderr: null,
      killed: false,
      pid: 6161,
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
    } as unknown as ChildProcess;
    return { child, stdout };
  }

  type Harness = {
    tracker: ReturnType<typeof createPromptAckTracker>;
    failures: PromptAckResult[];
    counters: PromptRunCounters;
    stdout: PassThrough;
  };

  function makeHarness(): Harness {
    const { child, stdout } = makeFakeChild();
    const counters = createPromptRunCounters();
    // prompt 已写入（onChannelActivity 的「写入后」语义门）。
    counters.promptWritten = true;
    const failures: PromptAckResult[] = [];
    const tracker = createPromptAckTracker({
      recordId: "rec-prompt-activity",
      timeoutMs: ACK_WINDOW_MS,
      diagnostics: () => ({
        pid: 6161,
        bytesWritten: 1,
        stdoutBytes: counters.stdoutBytes,
        stdoutBytesAfterPrompt: counters.stdoutBytesAfterPrompt,
        stdoutSeen: tracker.stdoutSeen,
        getStateAnswered: counters.getStateAnswered,
      }),
      onFailure: (result) => failures.push(result),
    });
    tracker.register("prompt-1");
    const callbacks: SpawnRunCallbacks = { onEvent: () => {} };
    const runEnd: RunEndState = { endedCleanly: false };
    wireChildStdoutPump({
      child,
      recordId: "rec-prompt-activity",
      callbacks,
      identity: createSessionIdentityTracker(dir, callbacks),
      handleSdkEvent: () => {},
      enqueueUi: () => {},
      stderrTee: undefined,
      runEnd,
      promptAck: tracker,
      runCounters: counters,
    });
    return { tracker, failures, counters, stdout };
  }

  describe("[C-U1] post-prompt invalid 行的活性语义", () => {
    it("仅 invalid 行（非法 JSON + JSON 缺 type）→ 计时器取消、run 不 settle", async () => {
      const h = makeHarness();
      // 两种 invalid 来源（parseSpawnLine）：JSON 解析失败；JSON 缺 string type。
      h.stdout.write(Buffer.from('{oops: not json\n', "utf8"));
      h.stdout.write(Buffer.from('{"foo":"bar"}\n', "utf8"));
      await flushStdout();

      // 字节计数口径（含 invalid）与活性快照同时成立
      expect(h.counters.stdoutBytesAfterPrompt).toBeGreaterThan(0);
      expect(h.tracker.stdoutSeen).toBe(true);

      vi.advanceTimersByTime(ACK_WINDOW_MS);
      expect(h.failures).toEqual([]); // 未 settle：无 timeout 失败

      // 不 settle 的直接证据：迟到的 prompt response 仍按 acked 正常结算（不产生失败面）
      h.tracker.dispatch("prompt-1", "prompt", true, { disposition: "started" });
      expect(h.failures).toEqual([]);
      h.tracker.dispose();
    });

    it("对照：post-prompt 完全零输出 → 窗口到期 settle timeout（证明上例依赖活性取消）", () => {
      const h = makeHarness();
      vi.advanceTimersByTime(ACK_WINDOW_MS);
      expect(h.failures).toHaveLength(1);
      expect(h.failures[0]?.kind).toBe("timeout");
      h.tracker.dispose();
    });

    it("未成行的半个大行（无 \\n）→ chunk 活性取消计时器、不 settle、字节计数 > 0", async () => {
      const h = makeHarness();
      // 极端大行慢写形态：一个 8KB chunk 但没有行界 \\n——解析链只在内部缓冲，
      // 不产出任何行。活跃性必须由 chunk 层取消计时器（行级口径会在此漏判）。
      h.stdout.write(Buffer.from("x".repeat(8 * 1024), "utf8"));
      await flushStdout();

      expect(h.counters.stdoutBytesAfterPrompt).toBeGreaterThan(0);
      expect(h.counters.stdoutBytes).toBeGreaterThan(0);
      expect(h.tracker.stdoutSeen).toBe(true);

      vi.advanceTimersByTime(ACK_WINDOW_MS);
      expect(h.failures).toEqual([]); // 计时器已取消：partial chunk 不 settle

      // 后续 prompt response 到达仍按 acked 结算（活性不是第二回执）
      h.tracker.dispatch("prompt-1", "prompt", true, { disposition: "started" });
      expect(h.failures).toEqual([]);
      h.tracker.dispose();
    });
  });
});

// ======== 来源：spawn-run-pump-session-file-fallback.test.ts ========
describe("spawn-run-pump-session-file-fallback", () => {
  /** LC-4 后缀反查目标 sessionId（fixture 文件名 `<ts>_<sessionId>.jsonl` 后缀段）。 */
  const SESSION_ID = "pump-sess";

  let dir: string;

  let logs: Array<{ level: LogLevel; component: string; message: string }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "pump-close-"));
    logs = [];
    configureLoggerSink({
      log: (level, component, message) => {
        logs.push({ level, component, message });
      },
    });
  });

  afterEach(() => {
    resetLoggerSinkForTests();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 本 run 的日志里含 [sessionfile] 的 warn 文案。 */
  function sessionFileWarnings(): string[] {
    return logs
      .filter((l) => l.level === "warn" && l.message.includes("[sessionfile]"))
      .map((l) => l.message);
  }

  /** LC-4 后缀反查目标 fixture（文件在 sessionDir、名以 _<sessionId>.jsonl 结尾即可命中）。 */
  function writeLc4Fixture(): string {
    const filePath = join(dir, `20260910T010101_${SESSION_ID}.jsonl`);
    fs.writeFileSync(filePath, `${JSON.stringify({ type: "message", id: "e1" })}\n`);
    return filePath;
  }

  /** fake child（PassThrough stdout/stdin + 手动 close/error；precedent: ui-request-queue.test.ts）。 */
  function makeFakeChild(): {
    child: ChildProcess;
    fireClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
    fireError: (err: Error) => void;
  } {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const child = {
      stdout,
      stdin,
      stderr: null,
      killed: false,
      pid: 4242,
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
      fireError: (err) => {
        emitter.emit("error", err);
      },
    };
  }

  interface PumpHarness { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    identity: SessionIdentityTracker;
    exitPromise: Promise<number>;
    fireClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
    fireError: (err: Error) => void;
    readyCalls: Array<{ sessionRef: Record<string, string> }>;
    runEnd: import("../spawn-run-pump.ts").RunEndState;
  }

  /** 装配 close 收尾链（endedCleanly 缺省 true = agent_end 主动终结）。 */
  function wirePump(
    overrides: Partial<SpawnRunCallbacks> = {},
    endedCleanly = true,
  ): PumpHarness {
    const { child, fireClose, fireError } = makeFakeChild();
    const readyCalls: PumpHarness["readyCalls"] = [];
    const callbacks: SpawnRunCallbacks = {
      onEvent: () => {},
      onHandleReady: (partial) => {
        readyCalls.push(partial);
      },
      ...overrides,
    };
    const identity = createSessionIdentityTracker(dir, callbacks);
    const runEnd: import("../spawn-run-pump.ts").RunEndState = { endedCleanly };
    const deps: StdoutPumpDeps = {
      child,
      recordId: "rec-pump-test",
      callbacks,
      identity,
      handleSdkEvent: () => {},
      enqueueUi: () => {},
      stderrTee: undefined,
      runEnd,
    };
    return { identity, exitPromise: wireChildStdoutPump(deps), fireClose, fireError, readyCalls, runEnd };
  }

  describe("close finalizer sessionFile 兜底接线（LC-4 + 仍缺响亮 warn）", () => {
    it("close 时 sessionFile 仍缺：响亮 warn（recordId + unobtainable + 全路 miss 归因 + 排查指引），run 正常终态", async () => {
      const h = wirePump();

      h.fireClose(0);
      const exitCode = await h.exitPromise;

      expect(exitCode).toBe(0); // resolveExit 必达 + 正常折算
      expect(h.identity.sessionFile).toBeUndefined();
      const warns = sessionFileWarnings();
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("unobtainable for rec-pump-test");
      expect(warns[0]).toContain("all acquisition paths missed: spawn handshake, late response, LC-4 suffix lookup");
      expect(warns[0]).toContain("record finalized without transcript anchor");
      expect(warns[0]).toContain("Recovery:");
    });

    it("sessionFile 已回填（握手/header 命中）：不产生 [sessionfile] warn", async () => {
      writeLc4Fixture();
      const h = wirePump();
      const known = join(dir, "known-session.jsonl");
      h.identity.applyGetStateFields({ sessionFile: known });

      h.fireClose(0);
      const exitCode = await h.exitPromise;

      expect(exitCode).toBe(0);
      expect(h.identity.sessionFile).toBe(known);
      expect(sessionFileWarnings()).toHaveLength(0);
    });

    it("[U-A5] 宿主回调 onChildStateChanged 抛错：不逃出 close 监听器，resolveExit 必达且 LC-4 兜底链不被跳过", async () => {
      const lc4File = writeLc4Fixture();
      const h = wirePump({
        onChildStateChanged: () => {
          throw new Error("宿主镜像回调抛错（模拟 server 组帧链失败）");
        },
      });
      // sessionId 已知（握手只回 sessionId 的形态）、sessionFile 缺 → close 期 LC-4 反查
      h.identity.applyGetStateFields({ sessionId: SESSION_ID });

      // 原实现：异常从 close 监听器逃出（本行即抛）且 LC-4/resolveExit 双双被跳过 → run 永挂
      h.fireClose(0);
      const exitCode = await h.exitPromise;

      expect(exitCode).toBe(0); // resolveExit 必达 + 正常折算（endedCleanly=true）
      expect(h.identity.sessionFile).toBe(lc4File); // LC-4 反查仍执行（必达区）
      expect(sessionFileWarnings()).toHaveLength(0); // LC-4 命中 → 无 unobtainable warn
      // 降级留痕（非 [sessionfile] 前缀，不经过 sessionFileWarnings）
      const allWarnText = logs.filter((l) => l.level === "warn").map((l) => l.message);
      expect(allWarnText.some((w) => w.includes("close finalizer step 'reportChildExited' failed for rec-pump-test"))).toBe(true);
    });

    it("LC-4 回填链 onHandleReady 抛错：resolveExit 仍必达，sessionFile 已落位（先赋值后回调）", async () => {
      const lc4File = writeLc4Fixture();
      const h = wirePump({
        onHandleReady: () => {
          throw new Error("server 组帧失败（模拟）");
        },
      });
      h.identity.applyGetStateFields({ sessionId: SESSION_ID });

      h.fireClose(0);
      const exitCode = await h.exitPromise;

      expect(exitCode).toBe(0);
      // LC-4 命中后 applyGetStateFields 先落 sessionFile 再调 onHandleReady——回调抛错
      // 被 bestEffort 吞掉，落位不回滚
      expect(h.identity.sessionFile).toBe(lc4File);
      const allWarnText = logs.filter((l) => l.level === "warn").map((l) => l.message);
      expect(allWarnText.some((w) => w.includes("close finalizer step 'LC-4 suffix lookup' failed for rec-pump-test"))).toBe(true);
      expect(sessionFileWarnings()).toHaveLength(0); // sessionFile 已落位 → 无 unobtainable warn
    });

    it("agent_end 未置位（信号退出）：退出码按 POSIX 128+signo 折算（SIGTERM=143），warn 步骤不改变退出码口径", async () => {
      const h = wirePump({}, false);

      h.fireClose(null, "SIGTERM");
      const exitCode = await h.exitPromise;

      // SIGTERM=15 → 128+15=143（batch A：bare 128 误导 crash triage）
      expect(exitCode).toBe(143);
      expect(h.identity.sessionFile).toBeUndefined();
      expect(sessionFileWarnings()).toHaveLength(1); // 仍缺 → warn 照发（口径与 128+signo 并存）
    });
  });

  describe("child error 事件收尾（spawn 失败形态，F4）", () => {
    /** ENOENT 形态的 fake error（Node spawn 失败的 error 事件等价物）。 */
    const enoentError = (): Error =>
      Object.assign(new Error("spawn /nonexistent/pi ENOENT"), { code: "ENOENT" });

    it("spawn 'error'（典型 ENOENT）：失败码 127 收尾 + 错误快照落 runEnd，绝不伪成功", async () => {
      const h = wirePump({}, false);

      h.fireError(enoentError());
      const exitCode = await h.exitPromise;

      // 子进程从未运行 → 失败终态（127）；(null,null) 的 0 折算（伪成功）已根除
      expect(exitCode).toBe(127);
      expect(h.runEnd.childErrorMessage).toContain("ENOENT");
      // 清理链照走（U-A5）：无身份可回填 → sessionFile 全 miss warn 照发
      expect(h.identity.sessionFile).toBeUndefined();
      expect(sessionFileWarnings().length).toBeGreaterThanOrEqual(1);
    });

    it("error 先达 + 真实 close(-2, null) 迟到再达（Node ENOENT 实测时序）：终态仍 127", async () => {
      const h = wirePump({}, false);

      h.fireError(enoentError());
      // 真实 close 携 negated errno（code=-2）；promise 已按失败口径 settle，
      // close 参数不得经 0 折算改写终态（close finalizer 各步骤幂等重跑无害）
      h.fireClose(-2, null);
      const exitCode = await h.exitPromise;

      expect(exitCode).toBe(127);
    });

    it("endedCleanly 已置位且无 error：口径不变（回归锚，agent_end 主动 kill 仍 0）", async () => {
      const h = wirePump({}, true);

      h.fireClose(null, "SIGTERM"); // agent_end 后 killChain 的 SIGTERM close
      const exitCode = await h.exitPromise;

      expect(exitCode).toBe(0);
      expect(h.runEnd.childErrorMessage).toBeUndefined();
    });
  });
});

// ======== 来源：spawn-runner-prompt-ack.test.ts ========
describe("spawn-runner-prompt-ack", () => {
  /**
   * 注入窗（真机 30s 不可等）。S7 用真实时钟验证窗口必须到期；S7b/S8b 的窗口由测试
   * 时钟冻结到 pi 就绪后（见文件头 [确定性]）——窗口值不变，变的是起算点。
   * 窗值是被测参数而非语义常量：50ms 已足够区分「窗口到期」与「立即失败」两类
   * 时序形态（S7 断言 elapsed < 窗×10、错误文案引用注入值），round6 慢用例治理
   * 自 300ms 收紧；S8b 的 fake pi 延迟（100ms）保持 > 窗 的相对关系。
   */
  const ACK_WINDOW_MS = 50;

  /**
 * [m-pi-2 / S9] 立即失败用例的注入窗（拉大只为区分「立即失败」与「等窗口超时」：
 * 失败路径在 prompt 写入同 tick 结算，实测远小于窗；若接线退化为等窗口，elapsed
 * 会 ≥ 窗值或错误文案变成 timeout）。
 */
  const S9_WINDOW_MS = 5_000;

  /** fake pi 脚本：stdin JSONL 命令 → stdout JSONL（M2 故障注入形态）。 */
  const FAKE_PI_SCRIPT = `
import readline from "node:readline";

const mode = process.env.FAKE_PI_MODE ?? "success";

const send = (obj) => { process.stdout.write(JSON.stringify(obj) + "\\n"); };

const SESSION_ID = "fake-ack-sess";

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg;

  try { msg = JSON.parse(line); } catch { return; }

  if (msg.type === "get_state") {
    if (mode === "silent") return; // S7：对一切命令完全零输出
    send({ type: "response", command: "get_state", success: true, id: msg.id,
      data: { sessionFile: "/tmp/fake-ack/20260910T010101_" + SESSION_ID + ".jsonl", sessionId: SESSION_ID } });

    return;

  }

  if (msg.type !== "prompt") return;

  if (mode === "silent") return;

  if (mode === "get-state-only") {
    // S8b：get_state 已应答、prompt response 延迟（100ms > 注入窗 50ms）
    setTimeout(() => {
      send({ type: "response", command: "prompt", success: true, id: msg.id, data: { disposition: "started" } });

      send({ type: "message_end", message: { stopReason: "stop" } });

      send({ type: "agent_end", willRetry: false, reason: "end_turn" });

      send({ type: "agent_settled" });

    }, 100);

    return;

  }

  if (mode === "reject-prompt") {
    send({ type: "response", command: "prompt", success: false, id: msg.id, error: "provider quota exceeded (fake)" });

    return;

  }

  if (mode === "echo-task-env") {
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: process.env.PI_SUBAGENT_TASK ?? "<env-absent>" } });

    send({ type: "message_end", message: { stopReason: "stop" } });

    send({ type: "agent_end", willRetry: false, reason: "end_turn" });

    send({ type: "agent_settled" });

    return;

  }

});

if (mode === "silent") { setInterval(() => {}, 1000); } // 零输出形态：不退出，等引擎杀链
`;

  type Harness = {
    rootDir: string;
    sessionDir: string;
    events: AgentEvent[];
    deltas: string[];
    stateChanges: Array<{ pid: number; state: string; killed: boolean; exitCode?: number; signal?: string }>;
    argv1Saved: string;
    /** pi 就绪信号：首个 get_state 应答经 pump 回填身份（onHandleReady）时 resolve。 */
    ready: Promise<void>;
    notifyReady: () => void;
  }

  function makeHarness(mode: string): Harness {
    const rootDir = fs.mkdtempSync(join(tmpdir(), "pi-cli-ack-test-"));
    const sessionDir = join(rootDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(join(rootDir, "cli.js"), FAKE_PI_SCRIPT); // pi 入口白名单词形（分支 1 资格）
    process.env.FAKE_PI_MODE = mode;
    const argv1Saved = process.argv[1] ?? "";
    process.argv[1] = join(rootDir, "cli.js"); // getPiInvocation 分支 1：node <pi 入口>
    let notifyReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      notifyReady = resolve;
    });
    return { rootDir, sessionDir, events: [], deltas: [], stateChanges: [], argv1Saved, ready, notifyReady };
  }

  function restoreHarness(h: Harness): void {
    process.argv[1] = h.argv1Saved;
    delete process.env.FAKE_PI_MODE;
    fs.rmSync(h.rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  function callbacksOf(h: Harness, overrides: Partial<SpawnRunCallbacks> = {}): SpawnRunCallbacks {
    return {
      onEvent: (e) => h.events.push(e),
      onDelta: (d) => h.deltas.push(d),
      onChildStateChanged: (p) => h.stateChanges.push(p),
      // pi 就绪 = get_state 应答回填 sessionFile（ready 只在正向用例被 await）。
      onHandleReady: () => h.notifyReady(),
      ...overrides,
    };
  }

  const baseParams = (h: Harness, overrides: Partial<SpawnRunParams> = {}): SpawnRunParams => ({
    recordId: "rec-ack-1",
    task: "integrate me",
    agentName: "ack-agent",
    model: "prov/model-1",
    sessionDir: h.sessionDir,
    cwd: h.rootDir,
    ...overrides,
  });

  /** 注入短 ack 窗（用后恢复；返回 restore 函数）。 */
  function injectAckWindow(windowMs: number = ACK_WINDOW_MS): () => void {
    const saved = process.env[PROMPT_ACK_TIMEOUT_ENV];
    process.env[PROMPT_ACK_TIMEOUT_ENV] = String(windowMs);
    return () => {
      if (saved === undefined) delete process.env[PROMPT_ACK_TIMEOUT_ENV];
      else process.env[PROMPT_ACK_TIMEOUT_ENV] = saved;
    };
  }

  /** 让出一轮 libuv 事件循环（真实 setImmediate——不受 vi 测试时钟接管）。 */
  function nextImmediate(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  /** 等待谓词成立（kill 链/收尾异步面）。 */
  async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  afterEach(() => {
    // 防御：正向用例的测试时钟异常退出时不得泄漏到后续用例（S7 用真实时钟验证窗口到期）。
    vi.useRealTimers();
    killAllActiveChildren();
  });

  describe("S7 假 pi 完全不产出 → 注入窗内 engine_prompt_not_delivered + killChild", () => {
    it("零 stdout 300ms → 失败终态：错误码前缀 + 诊断五元组 detail + SIGKILL 收割 + error 事件", async () => {
      const h = makeHarness("silent");
      const restoreWindow = injectAckWindow();
      try {
        const startedAt = Date.now();
        const result: SpawnRunResult = await runSpawnOnce(baseParams(h), callbacksOf(h));
        const elapsed = Date.now() - startedAt;

        // 注入窗内显式失败（30s 默认窗不可等——env 覆盖生效的构造性证明）
        expect(elapsed).toBeLessThan(ACK_WINDOW_MS * 10);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/^engine_prompt_not_delivered:/);
        expect(result.error).toContain(`within ${ACK_WINDOW_MS}ms`);
        // 诊断五元组逐字段进失败 detail（验收 4）
        expect(result.error).toContain("pid=");
        expect(result.error).toContain("bytesWritten=");
        expect(result.error).toContain("stdoutBytes=0");
        expect(result.error).toContain("stdoutBytesAfterPrompt=0");
        expect(result.error).toContain("getStateAnswered=false");
        expect(result.error).toContain("lastEventType=-");
        expect(result.error).toContain("Recovery:");
        // 失败分诊：送达码确定性分支 → unknown（可重试），不被误诊 stale
        expect(result.failureKind).toBe("unknown");

        // 子进程被杀（SIGKILL 直杀收割）+ error 事件上协议（journal 留痕）
        await waitFor(() => h.stateChanges.some((s) => s.state === "exited"));
        expect(h.stateChanges[0]).toMatchObject({ state: "running", killed: false });
        const exited = h.stateChanges.find((s) => s.state === "exited");
        expect(exited).toMatchObject({ killed: true, signal: "SIGKILL" });
        const errorEvents = h.events.filter((e) => e.type === "error");
        expect(errorEvents).toHaveLength(1);
        expect((errorEvents[0] as { message: string }).message).toMatch(/^engine_prompt_not_delivered:/);
      } finally {
        restoreWindow();
        restoreHarness(h);
      }
    });
  });

  describe("S7b pi 拒绝 prompt → 立即 engine_prompt_rejected（不等窗口、不误报 not_delivered）", () => {
    it("success:false response → 立即失败，错误含 pi error 文本，分型独立", async () => {
      const h = makeHarness("reject-prompt");
      const restoreWindow = injectAckWindow();
      // 零输出窗口走测试时钟：子进程启动耗时移出窗口（见文件头 [确定性]）。
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const run = runSpawnOnce(baseParams(h), callbacksOf(h));
        await h.ready; // pi 已就绪（get_state 应答落位）——窗口自此起算
        await nextImmediate(); // 该应答行的 onChannelActivity（取消计时器）已同步完成
        // 窗口逻辑时间耗尽：活性已取消零输出计时器 → 不误判 not_delivered。
        // 若取消接线缺失，此处推进即触发 timeout → 下方 rejected 断言失败（负向对照）。
        vi.advanceTimersByTime(ACK_WINDOW_MS * 2);
        const result: SpawnRunResult = await run;

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/^engine_prompt_rejected:/);
        expect(result.error).toContain("provider quota exceeded (fake)"); // pi error 文本在 detail
        expect(result.error).not.toContain("engine_prompt_not_delivered"); // 分型防误诊
        expect(result.failureKind).toBe("unknown");
        const errorEvents = h.events.filter((e) => e.type === "error");
        expect(errorEvents).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        restoreWindow();
        restoreHarness(h);
      }
    });
  });

  describe("S8b get_state 有应答但 prompt response 延迟 → 不杀不判失败", () => {
    it("活性取消零输出计时器：run 继续，延迟 response 到达后正常完成（零误杀）", async () => {
      const h = makeHarness("get-state-only");
      const restoreWindow = injectAckWindow();
      const logs: Array<{ level: LogLevel; message: string }> = [];
      configureLoggerSink({ log: (level, _component, message) => logs.push({ level, message }) });
      // 零输出窗口走测试时钟：子进程启动耗时移出窗口（见文件头 [确定性]）。
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const run = runSpawnOnce(baseParams(h), callbacksOf(h));
        await h.ready; // pi 已就绪（get_state 应答落位）——窗口自此起算
        await nextImmediate(); // 该应答行的 onChannelActivity（取消计时器）已同步完成
        // 窗口逻辑时间耗尽：若活性未取消计时器，此处即误杀（负向对照）。
        vi.advanceTimersByTime(ACK_WINDOW_MS * 2);
        const result: SpawnRunResult = await run;

        // run 正常完成（response 延迟 100ms > 窗 50ms——若误杀此处即失败）
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.sessionId).toBe("fake-ack-sess");
        // 零输出计时器被 get_state response 活性取消：prompt ack delayed warn（含诊断摘要）
        const delayed = logs.filter((l) => l.level === "warn" && l.message.includes("prompt ack delayed"));
        expect(delayed).toHaveLength(1);
        expect(delayed[0]!.message).toContain("getStateAnswered=true");
        // 无误报：无 not_delivered 失败日志
        expect(logs.some((l) => l.message.includes("prompt not delivered"))).toBe(false);
      } finally {
        vi.useRealTimers();
        resetLoggerSinkForTests();
        restoreWindow();
        restoreHarness(h);
      }
    });
  });

  // ============================================================
  // [m-pi-2 / S9] stdin 不可用 / EPIPE → 立即失败（run 级装配接线）
  // ============================================================
  // 组件半面（stdin-writer 的 delivered:false/throw、prompt-ack 的 failNow）已有覆盖，
  // 但 `if (!sent.delivered) failNow` 与 catch-EPIPE 两条装配分支此前无 run 级用例
  // 执行——删掉/改错分支不会红。驱动方式：onChildSpawned（prompt 写入前同步触发）
  // 拿到活跃子进程 stdin 注入故障；fake pi 用 silent 形态（读 stdin 但零输出、
  // setInterval 保活），确保失败由 failNow + SIGKILL 收割而非自然退出。

  describe("S9 stdin 不可用 → delivered:false → 立即 engine_prompt_not_delivered（不等窗口）", () => {
    it("spawn 后销毁 stdin → failNow(stdin-unavailable)：错误前缀 + SIGKILL + error 事件 1 条", async () => {
      const h = makeHarness("silent");
      const restoreWindow = injectAckWindow(S9_WINDOW_MS);
      try {
        const startedAt = Date.now();
        const result: SpawnRunResult = await runSpawnOnce(
          baseParams(h),
          callbacksOf(h, {
            onChildSpawned: (_pid, recordId) => {
              // prompt 写入前拿到活跃子进程（registerActiveChild 先于本回调）
              const stdin = getActiveChild(recordId)?.stdin;
              if (stdin === null || stdin === undefined) {
                throw new Error("S9 harness: active child stdin missing");
              }
              stdin.destroy();
            },
          }),
        );
        const elapsed = Date.now() - startedAt;

        // 立即失败：远小于注入窗（若退化为等窗口，错误文案会变成 timeout）
        expect(elapsed).toBeLessThan(S9_WINDOW_MS);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/^engine_prompt_not_delivered:/);
        expect(result.error).toContain("stdin-unavailable");
        expect(result.error).not.toContain("zero stdout after prompt write"); // 非 timeout 形态
        expect(result.failureKind).toBe("unknown");

        await waitFor(() => h.stateChanges.some((s) => s.state === "exited"));
        const exited = h.stateChanges.find((s) => s.state === "exited");
        expect(exited).toMatchObject({ killed: true, signal: "SIGKILL" });
        const errorEvents = h.events.filter((e) => e.type === "error");
        expect(errorEvents).toHaveLength(1);
        expect((errorEvents[0] as { message: string }).message).toMatch(/^engine_prompt_not_delivered:/);
      } finally {
        restoreWindow();
        restoreHarness(h);
      }
    });
  });

  describe("S9 prompt 写入 EPIPE → catch → failNow(epipe)（不等窗口、不误报 timeout）", () => {
    it("stdin.write 抛 EPIPE（仅 prompt 帧）→ engine_prompt_not_delivered 含 epipe + SIGKILL", async () => {
      const h = makeHarness("silent");
      const restoreWindow = injectAckWindow(S9_WINDOW_MS);
      try {
        const startedAt = Date.now();
        const result: SpawnRunResult = await runSpawnOnce(
          baseParams(h),
          callbacksOf(h, {
            onChildSpawned: (_pid, recordId) => {
              const stdin = getActiveChild(recordId)?.stdin;
              if (stdin === null || stdin === undefined) {
                throw new Error("S9 harness: active child stdin missing");
              }
              const originalWrite = stdin.write.bind(stdin);
              stdin.write = ((chunk: string) => {
                // get_state 握手照常写入；只让 prompt 帧抛 EPIPE（模拟管道已断）
                if (chunk.includes('"type":"prompt"')) {
                  throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
                }
                return originalWrite(chunk);
              }) as typeof stdin.write;
            },
          }),
        );
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(S9_WINDOW_MS);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/^engine_prompt_not_delivered:/);
        expect(result.error).toContain("epipe");
        expect(result.error).toContain("EPIPE on stdin write"); // writeStdinLine 的 throw 文案
        expect(result.error).not.toContain("zero stdout after prompt write"); // 非 timeout 形态
        expect(result.failureKind).toBe("unknown");

        await waitFor(() => h.stateChanges.some((s) => s.state === "exited"));
        const exited = h.stateChanges.find((s) => s.state === "exited");
        expect(exited).toMatchObject({ killed: true, signal: "SIGKILL" });
        const errorEvents = h.events.filter((e) => e.type === "error");
        expect(errorEvents).toHaveLength(1);
        expect((errorEvents[0] as { message: string }).message).toMatch(/^engine_prompt_not_delivered:/);
      } finally {
        restoreWindow();
        restoreHarness(h);
      }
    });
  });

  // ============================================================
  // [M1 D2] PI_SUBAGENT_TASK 写入点截断
  // ============================================================

  describe("truncateTaskForEnv（写入点截断纯函数面）", () => {
    it("短任务 / 恰好 2000 字符 → 原样（无标记）", () => {
      expect(truncateTaskForEnv("short task")).toBe("short task");
      expect(truncateTaskForEnv("y".repeat(PI_SUBAGENT_TASK_MAX_CHARS))).toBe("y".repeat(PI_SUBAGENT_TASK_MAX_CHARS));
    });

    it("超限 ASCII → 前 2000 字符 + 标记文案（N = 被截字符数）", () => {
      const task = `${"a".repeat(2001)}tail`;
      expect(truncateTaskForEnv(task)).toBe(`${"a".repeat(2000)}…[truncated ${task.length - 2000} chars]`);
    });

    it("CJK 多字节整字符截断（UTF-16 码元边界 = BMP 整字符，不产残字）", () => {
      const task = "あ".repeat(2500);
      const out = truncateTaskForEnv(task);
      expect(out).toBe(`${"あ".repeat(2000)}…[truncated 500 chars]`);
      expect(out).not.toMatch(/[\uD800-\uDFFF]/); // 无代理对残片
    });

    it("边界劈在 astral 字符（emoji 代理对）→ 回退一个码元，env 值无孤立代理（不劈半）", () => {
      const task = `${"x".repeat(1999)}😀tail`;
      const out = truncateTaskForEnv(task);
      // 边界本应劈在 😀 的高低代理之间（keep=2000）→ 回退到 1999，emoji 整体被截
      expect(out).toBe(`${"x".repeat(1999)}…[truncated ${task.length - 1999} chars]`);
      expect(out).not.toMatch(/[\uD800-\uDFFF]/); // 无孤立高低代理（execve UTF-8 编码安全）
    });
  });

  describe("applyIdentityEnvToChildEnv × 截断（装配面）", () => {
    it("identity env 的 task 键写截断值（env 读取点消费方零改动的前提 = 值自含标记）", () => {
      const childEnv: Record<string, string> = {};
      applyIdentityEnvToChildEnv(
        childEnv,
        { recordId: "rec-1", agentName: "agent-a", task: "z".repeat(3000), cwd: "/w" },
        {},
      );
      expect(childEnv.PI_SUBAGENT_TASK).toBe(`${"z".repeat(2000)}…[truncated 1000 chars]`);
      expect(childEnv.PI_SUBAGENT_AGENT).toBe("agent-a");
    });
  });

  describe("M1 D2 截断 × 真实 spawn env 接线（echo-task-env）", () => {
    it("子 pi 实际收到的 PI_SUBAGENT_TASK env = 截断值 + 标记（经 text_delta 回显断言）", async () => {
      const h = makeHarness("echo-task-env");
      try {
        const task = `${"x".repeat(1999)}😀tail`; // 边界 astral 形态（同单测用例）
        const result: SpawnRunResult = await runSpawnOnce(baseParams(h, { task }), callbacksOf(h));

        expect(result.success).toBe(true);
        const expected = `${"x".repeat(1999)}…[truncated ${task.length - 1999} chars]`;
        expect(result.content).toBe(expected); // 子进程 env 实测值 = 截断投影
        expect(result.content).not.toMatch(/[\uD800-\uDFFF]/);
      } finally {
        restoreHarness(h);
      }
    });
  });
});
