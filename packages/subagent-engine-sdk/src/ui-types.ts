// src/ui-types.ts
//
// UI 请求/响应契约类型（自 core execution/dialog-queue.ts :94/:113/:150/:159 迁入
// @zhushanwen/subagent-engine-sdk，结构等价）。迁移处置（impl-plan §2.1 类型闭包表
// R3 S-A / R4-S③）：**UiMethod / UiRequest / UiResponse / UiRequestHandler 入 SDK
// 类型闭包**——该模块是三类型的规范来源（dialog-queue.ts:87 注释自证）；`UiMethod`
// 是 `UiRequest.method` 的依赖类型（:94，R4-S③ 补录，包外零消费方）。队列实现本体
// 留 core；core 侧改再导出 SDK 类型（`export type { ... } from
// "@zhushanwen/subagent-engine-sdk"`，§2.7 MF-X2 既定决策，引用切换归 W2/W7）；
// 双向可赋值断言挂 core typecheck 断言族。
//
// 协议消费面：反向通道 host/askUser 的载荷携带 UiRequest（reverse-channels.ts），
// 两阶段结果 = UiResponse（ack 先行、结果异步到达，R9-2）。

/** Pi extension_ui_request 的方法枚举（dialog + fire-and-forget 两类）。
 *  dialog 类：select/confirm/input/editor（占输入焦点，等响应）。
 *  fire-and-forget 类：notify/setStatus/setWidget/setTitle/set_editor_text（纯展示/写入）。
 *  (string & {}) 兜底：Pi 未来新增 method 或未知 method 走字符串字面量类型。 */
export type UiMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle"
  | "set_editor_text"
  | (string & {});

/** UI 请求（引擎侧构造后经 host/askUser 送达宿主 handler）。
 *
 *  method 是判别字段，决定排队策略（dialog 排队）和业务路由（channel 分发）。
 *  method 特定字段按 method 可选出现（与 ExtensionUiRequest 1:1，由引擎侧
 *  ui-request-queue 从 ExtensionUiRequest 平铺构造）。channel/channelPayload 由
 *  parseChannel 填充。
 *
 *  契约来源：.fix-plans/00-master-summary.md §二 2.2。 */
export interface UiRequest {
  /** Pi rpc-types.ts 的 method（select/confirm/input/editor 为 dialog 类）。 */
  method: UiMethod;
  /** 请求 id（从 extension_ui_request envelope 顶层提取，用于 response 关联）。 */
  id: string;
  // method 特定字段（按 method 可选，与 ExtensionUiRequest 1:1）
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  statusKey?: string;
  statusText?: string | undefined;
  widgetKey?: string;
  widgetLines?: string[] | undefined;
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string;
  timeout?: number;
  /** channel 名（从 method 对应字段的 NUL 前缀解析）。
   *  select → 从 title 解析；setWidget → 从 widgetLines[0] 解析；其他 → undefined。
   *  已知值："ask_user"（select）、"gui_widget"（setWidget）。handler 按 channel 分发。 */
  channel?: string;
  /** channel 解析后的结构化 payload（已 JSON.parse）。
   *  ask_user: {questions, allowCancel}；gui_widget: {component}；无 channel: undefined。 */
  channelPayload?: unknown;
  /** 内部元数据字段：发起该 UI 请求的子进程 pid（由引擎侧 ui-request-queue 从
   *  child.pid 填入——session-runner 已随协议化重构删除，填充点现住 pi 引擎包）。
   *  L2 队列据此关联 rejectChildDialogs（子进程退出时批量取消，见
   *  notifyChildProcessExited 的接线链）。
   *  下划线前缀表示内部字段，非 Pi 协议字段，不参与 stdin 回写。 */
  _childPid?: number;
}

/** UI 响应（handler 返回，session-runner 按 shape 回写 stdin）。
 *  - {value}: select/input/editor 的答案
 *  - {confirmed}: confirm 的答案
 *  - {cancelled}: 取消（child close / handler 抛错 / 用户取消）
 *  - {ack}: fire-and-forget（当前不透传到 TUI，留作协议完整） */
export type UiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
  | { ack: true };

/** UI 请求 handler 签名（单函数，按 req.method 内部路由）。
 *  实现方负责：channel 业务路由（ask_user → AskUserComponent）+ 默认转发（ctx.ui.*）。
 *  抛错由调用方（DialogGlobalQueue / session-runner）兜底为 {cancelled:true}。 */
export type UiRequestHandler = (req: UiRequest) => Promise<UiResponse>;
