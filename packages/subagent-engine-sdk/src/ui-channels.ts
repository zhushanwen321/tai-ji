// src/ui-channels.ts
//
// UI channel 提取（marker 解析）+ channel 注册表（引擎侧原语，自 core
// execution/ui-channels.ts 移入 @zhushanwen/subagent-engine-sdk，实现体逐字等价；
// round1-reuse R1：core execution 副本与 pi 引擎 CLI 副本自本模块 re-export 收编，
// 消逐字等价双副本——core → SDK、pi → SDK 均正向合法）。
//
// channel 是扩展协议自定义的业务路由标识，由 NUL 前缀 marker 标记。
// 已知 marker（来自 @taiji/extension-protocol）：
//   - ASK_USER_MARKER   = "\0TAIJI_ASK_USER"     走 select method，出现在 title
//     （options[0] = JSON payload {questions, allowCancel}）
//   - GUI_WIDGET_MARKER = "\0TAIJI_GUI_WIDGET:"  走 setWidget method，出现在 widgetLines[0]
//     （同行 marker 后紧跟 JSON payload {component}）
//
// channel 提取位置随 method 变（.fix-plans/00-master-summary.md §一冲突 2）：
//   - select   → 从 title 解析 NUL 前缀（payload 从 options[0] 取）
//   - setWidget → 从 widgetLines[0] 解析 NUL 前缀（payload 从同行 marker 后取）
//   - 其他 method → 无 channel（返回 {}）
//
// channel 名规范化：去 "TAIJI_" 命名空间前缀，去尾部 ":"，小写化。
//   TAIJI_ASK_USER   → ask_user
//   TAIJI_GUI_WIDGET → gui_widget
//
// 本模块是协议层工具（method/marker 都是协议概念），不感知业务。

/** NUL 前缀字符。Pi extension-protocol 用 NUL（\0）标记控制行，
 *  避免与用户可见文本冲突。 */
const NUL = "\0";

/** channel 提取结果。channel 无 NUL 前缀、字段缺失、JSON parse 失败时
 *  channel 与 channelPayload 均为 undefined（返回 {}）。 */
export interface ParsedChannel {
  /** 规范化后的 channel 名（如 "ask_user"、"gui_widget"）。
   *  无 marker 或解析失败时为 undefined。 */
  channel?: string;
  /** marker 标记的结构化 payload（已 JSON.parse）。
   *  ask_user: {questions, allowCancel}；gui_widget: {component}。
   *  payload 来源缺失或 JSON parse 失败时为 undefined（channel 仍可解析）。 */
  channelPayload?: unknown;
}

/** parseChannel 入参的最小形状。
 *  method 是判别字段；按 method 不同，对应字段（select 的 title/options、
 *  setWidget 的 widgetLines）可选出现。其他 method 的字段统称 [key:string]。 */
export interface ExtensionUiRequestLike {
  method: string;
  /** select method：title 字段（可能含 ASK_USER_MARKER NUL 前缀）。 */
  title?: string;
  /** select method：options 数组（options[0] 可能是 channel payload 的 JSON）。 */
  options?: string[];
  /** setWidget method：widgetKey 字段。 */
  widgetKey?: string;
  /** setWidget method：widgetLines 数组（widgetLines[0] 可能含 GUI_WIDGET_MARKER）。 */
  widgetLines?: string[] | undefined;
  /** 其他 method 的任意字段（容错：允许测试和未来扩展传入额外字段）。 */
  [key: string]: unknown;
}

/** channel handler 签名：接收 UiRequest，返回 UiResponse。
 *  具体类型定义在 session-runner.ts（W2 工作），此处用最小形状避免循环依赖。
 *  handler 实现方按 channel 注册，由 session-runner 按 req.channel 分派。 */
export type ChannelHandler = (req: unknown) => Promise<unknown>;

/** channel 注册表接口。职责单一：只管业务路由，不管排队、不管透传判定。
 *  - register(channel, handler)：注册 channel 对应的 handler（同名覆盖）
 *  - resolve(channel)：取 channel 对应的 handler，未注册返回 undefined
 *  - list()：列举所有已注册 channel 名 */
export interface UiChannelRegistry {
  register(channel: string, handler: ChannelHandler): void;
  resolve(channel: string): ChannelHandler | undefined;
  list(): string[];
}

/** 规范化 channel 名。
 *  输入是 NUL 前缀后的字面量（如 "TAIJI_ASK_USER"、"TAIJI_GUI_WIDGET:"）。
 *  规则：
 *    1. 去 "TAIJI_" 命名空间前缀（协议命名空间标识，非业务语义）
 *    2. 去尾部 ":"（GUI_WIDGET 等"行内 payload"型 marker 的分隔符）
 *    3. 小写化（TAIJI_ASK_USER → ask_user）
 *
 *  例：
 *    "TAIJI_ASK_USER"    → "ask_user"
 *    "TAIJI_GUI_WIDGET:" → "gui_widget"
 *    "FOO_BAR"         → "foo_bar"（无 TAIJI_ 前缀也容忍，去前缀仅当字面量以 TAIJI_ 开头） */
function normalizeChannelName(markerLiteral: string): string {
  let name = markerLiteral;
  // 去 "TAIJI_" 命名空间前缀（仅当以此开头）
  if (name.startsWith("TAIJI_")) {
    name = name.slice("TAIJI_".length);
  }
  // 去尾部 ":"（行内 payload 型 marker 的分隔符）
  if (name.endsWith(":")) {
    name = name.slice(0, -1);
  }
  return name.toLowerCase();
}

/** 从 marker 字面量字符串解析 channel 名。
 *  输入 str 形如 "\0TAIJI_ASK_USER"（marker 占满整个字段，payload 在别处）。
 *  无 NUL 前缀返回 undefined。 */
function parseMarkerFromField(str: string): string | undefined {
  if (!str.startsWith(NUL)) return undefined;
  // 去掉 NUL 前缀，取剩余字面量作为 marker literal
  const literal = str.slice(NUL.length);
  if (literal === "") return undefined;
  return normalizeChannelName(literal);
}

/** 从 marker + 行内 payload 字符串解析 channel 名 + payload。
 *  输入 str 形如 "\0TAIJI_GUI_WIDGET:{...json...}"（marker 与 payload 在同一行）。
 *  无 NUL 前缀返回 undefined。
 *  payload 解析失败时不抛（返回 channel 名，payload 由调用方处理）。 */
function parseInlineMarkerFromField(str: string): { channel: string } | undefined {
  if (!str.startsWith(NUL)) return undefined;
  const rest = str.slice(NUL.length);
  // marker literal 与 payload 的分界：第一个 ":" 或行尾
  // GUI_WIDGET_MARKER 格式为 "\0TAIJI_GUI_WIDGET:" + json，分界是 ":"
  const colonIdx = rest.indexOf(":");
  let literal: string;
  if (colonIdx >= 0) {
    literal = rest.slice(0, colonIdx + 1); // 含 ":"，normalizeChannelName 会去尾部 ":"
  } else {
    literal = rest;
  }
  if (literal === "") return undefined;
  return { channel: normalizeChannelName(literal) };
}

/** 从 select.title 解析 channel（payload 从 options[0] 取）。
 *  - title 无 NUL 前缀 → undefined
 *  - title 含 marker → channel 名；payload 从 options[0] JSON.parse（失败/缺失 → undefined） */
function parseFromMarkerString(
  title: string | undefined,
  options: string[] | undefined,
): ParsedChannel {
  if (title === undefined) return {};
  const channel = parseMarkerFromField(title);
  if (channel === undefined) return {};
  // payload 从 options[0] 取（ask_user 协议：title 是 marker，options[0] 是 JSON payload）
  let payload: unknown;
  if (options !== undefined && options.length > 0) {
    try {
      payload = JSON.parse(options[0]);
    } catch {
      payload = undefined; // JSON parse 失败：不抛，channel 仍解析
    }
  }
  return { channel, channelPayload: payload };
}

/** 从 setWidget.widgetLines[0] 解析 channel（payload 从同行 marker 后取）。
 *  - widgetLines 缺失/空数组/首行无 NUL 前缀 → undefined
 *  - 首行含 marker → channel 名；payload 从 marker 后的 JSON 取（失败 → undefined） */
function parseFromMarkerArray(
  widgetLines: string[] | undefined,
): ParsedChannel {
  if (widgetLines === undefined || widgetLines.length === 0) return {};
  const firstLine = widgetLines[0];
  if (typeof firstLine !== "string") return {};
  const parsed = parseInlineMarkerFromField(firstLine);
  if (parsed === undefined) return {};
  // payload 从 marker 后的 JSON 取（GUI_WIDGET 协议：marker 与 payload 同行）
  let payload: unknown;
  const rest = firstLine.slice(NUL.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx >= 0) {
    const jsonStr = rest.slice(colonIdx + 1);
    if (jsonStr !== "") {
      try {
        payload = JSON.parse(jsonStr);
      } catch {
        payload = undefined; // JSON parse 失败：不抛，channel 仍解析
      }
    }
  }
  return { channel: parsed.channel, channelPayload: payload };
}

/** 按 method 分派解析 channel。
 *
 *  - select → 从 title 解析 NUL 前缀（payload 从 options[0]）
 *  - setWidget → 从 widgetLines[0] 解析 NUL 前缀（payload 从同行 marker 后）
 *  - 其他 method → {}（无 channel 提取位置）
 *
 *  边界（均不抛错）：
 *    - title/widgetLines 字段缺失 → {}
 *    - 无 NUL 前缀 → {}
 *    - JSON parse 失败 → channel 仍解析，channelPayload 为 undefined
 *
 *  @param req ExtensionUiRequestLike（method + 对应字段）
 *  @returns ParsedChannel（channel/channelPayload 可选） */
export function parseChannel(req: ExtensionUiRequestLike): ParsedChannel {
  switch (req.method) {
    case "select":
      return parseFromMarkerString(req.title, req.options);
    case "setWidget":
      return parseFromMarkerArray(req.widgetLines);
    default:
      return {};
  }
}

/** 创建 channel 注册表实例。
 *  进程级单例（通常由 SubagentService 持有一个实例，跨所有子进程共享）。
 *  register 同名 channel 会覆盖旧 handler。 */
export function createUiChannelRegistry(): UiChannelRegistry {
  const handlers = new Map<string, ChannelHandler>();
  return {
    register(channel: string, handler: ChannelHandler): void {
      handlers.set(channel, handler);
    },
    resolve(channel: string): ChannelHandler | undefined {
      return handlers.get(channel);
    },
    list(): string[] {
      return Array.from(handlers.keys());
    },
  };
}
