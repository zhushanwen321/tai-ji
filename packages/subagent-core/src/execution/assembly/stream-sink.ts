/**
 * subagent text_delta streaming sink。
 *
 * background subagent 执行期间，session-runner 的 agentEvent 出口把每个 text_delta
 * 传到 SubagentStream.onDelta。本模块做 100ms 时间窗合并后，通过 StreamSink.setWidget
 * 转发到 RPC stdout（经 ctx.ui.setWidget → extension_ui_request 通道）。
 *
 * SubagentStream 是一个生命周期对象——内聚 buffer/timer 状态 + onDelta/dispose 方法。
 * 调用方（subagent-service）创建后只需在 text_delta 时调 onDelta、终态时调 dispose，
 * 不需要拆散 push/clear 两个函数跨层透传。
 *
 * 设计要点：
 * - leading edge：第一个 delta 立即 flush（前端尽快看到开始）
 * - trailing edge：后续 delta 追加 buffer，timer 到期后 flush
 * - 每次 flush 把 buffer 的累积文本 split("\n") 截尾 MAX_WIDGET_LINES 行传给 setWidget
 * - dispose 清除 widget + 清 timer
 */

import type { ExtensionMode } from "./host-mode.ts";
import { resolveHostMode } from "./host-mode.ts";
import { isRelayActive } from "@zhushanwen/subagent-engine-sdk";

/** UI streaming sink 的最小接口（ctx.ui.setWidget 的 duck-typed 子集）。
 *
 * 当前只有一个 adapter（index.ts session_start 包装 ctx.ui.setWidget）。
 * 保留接口而非裸函数类型，因为 StreamSink 的语义是「UI sink 契约」——
 * 测试 mock 和未来可能的第二 sink（如写文件）都走此契约。 */
export interface StreamSink {
  setWidget(key: string, lines: string[] | undefined): void;
}

/** delta 合并窗口时间（ms）。 */
const STREAM_FLUSH_MS = 100;

/** widget 发送的最大行数上限。
 *
 * flush 把 buffer 累积全文 split 后经 setWidget RPC 通道整包发送——长输出 subagent
 * （数百 KB）下每 100ms 一次 O(当前总量) 的序列化+传输，累计 O(n²)。widget 是实时
 * 预览（完整输出在 record/eventLog 与 session 文件），只保留尾部行即可；超限时以
 * 一行 truncated 提示替代被裁掉的头部。 */
const MAX_WIDGET_LINES = 200;

/**
 * subagent text_delta streaming 生命周期对象。
 *
 * 创建后：
 * - `onDelta(delta)`：session-runner 每次 text_delta 调
 * - `dispose()`：subagent 终态时调，清除 widget + 清 timer
 *
 * buffer/timer 状态全部内聚在此对象，调用方不需要关心合并逻辑。
 */
export class SubagentStream {
  private readonly widgetKey: string;
  private readonly sink: StreamSink;
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private hasFlushed = false;
  private disposed = false;

  constructor(recordId: string, sink: StreamSink) {
    this.widgetKey = `subagent-stream-${recordId}`;
    this.sink = sink;
  }

  /** 接收一个 text_delta 增量。空串静默丢弃（不消耗 leading edge）。 */
  onDelta(delta: string): void {
    if (this.disposed || delta.length === 0) return;
    this.buffer += delta;
    if (!this.hasFlushed) {
      // leading edge：第一个 delta 立即 flush
      this.hasFlushed = true;
      this.flush();
    } else if (this.timer === undefined) {
      // trailing edge：后续 delta 经 timer 合并
      this.timer = setTimeout(() => this.flush(), STREAM_FLUSH_MS);
    }
  }

  /** 终态清理：清除 widget + 清 timer（幂等）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.sink.setWidget(this.widgetKey, undefined);
  }

  private flush(): void {
    this.timer = undefined;
    if (this.buffer.length === 0 || this.disposed) return;
    const lines = this.buffer.split("\n");
    if (lines.length <= MAX_WIDGET_LINES) {
      this.sink.setWidget(this.widgetKey, lines);
      return;
    }
    const dropped = lines.length - MAX_WIDGET_LINES;
    this.sink.setWidget(this.widgetKey, [
      `(... ${dropped} earlier lines truncated, full output in /subagents detail)`,
      ...lines.slice(dropped),
    ]);
  }
}

/**
 * background stream 创建策略（widget 私货通道退役步骤 2，E 方案 §6.3）。
 *
 * GUI（mode=rpc）+ relay 激活时不创建——drawer 实时改由 runtime tee 供数
 * （session.subagentEntriesAppended 帧），extension 停发 setWidget 私货，主 pi stdout
 * 卸载。TUI（widget 行是 TUI 用户的实时预览）与 relay 未激活环境（独立 pi / 无
 * xyz-agent runtime）原样创建——universal 包自足性不绑架。
 *
 * env/mode 显式入参而非内部读 process.env：调用方语义（本 record 的宿主形态）一次
 * 确定，测试可注入，函数保持纯判定。
 */
export function createBackgroundStream(
  recordId: string,
  sink: StreamSink | null,
  mode: ExtensionMode | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): SubagentStream | undefined {
  if (sink === null) return undefined;
  if (isRelayActive(env) && resolveHostMode(mode) === "gui") return undefined;
  return new SubagentStream(recordId, sink);
}
