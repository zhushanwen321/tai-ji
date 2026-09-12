// src/execution/ui-request-handler-factory.ts
//
// UI 请求 handler 工厂（透传 + 排队总控）。
//
// 按 ctx.mode（ExtensionMode）创建合适的 UiRequestHandler，SubagentService 持有后经
// host-ui-endpoint 登记处注入协议客户端——引擎进程的 extension_ui_request 经
// host/askUser 反向通道到达本 handler（[W3] inproc L1 队列 inproc UI 请求队列（已删） 随
// inproc pi 引擎目录 删除消亡，「run 生命周期内闭包队列」语义由引擎包内等价物 +
// 协议应答路径承接）。本模块是「handler 注入链路」的组装点：把 channel registry
//（业务路由）+ dialog queue（L2 跨子进程串行）+ mode 分流（TUI/GUI/headless）
// 粘合成一个 handler。
//
// 设计依据（.fix-plans/00-master-summary.md）：
//   - §一冲突 2「透传矩阵」：
//       TUI  dialog 透传 + L2 排队；fire-and-forget 不透传（回 ack，不影响 TUI 输入交互）
//       GUI  全透传；dialog 走 L2 排队，fire-and-forget 直接转发
//       headless  不注入（返回 undefined）
//   - §一冲突 3「L2 队列接入点」：dialog 类进 dialogQueue.enqueue 串行
//   - §二 2.7「handler 工厂 + 透传/排队总控」：createUiRequestHandlerForMode 完整实现
//
// SR-3：调用方（index.ts session_start）无论 new 还是 existing SubagentService 都必须调
//   setUiRequestHandler——/resume /fork 复用 existingService 时旧 handler 可能已失效。

import { getLogger } from "../core/logger.ts";

import {
  DialogGlobalQueue,
  isValidDialogTimeout,
  registerActiveDialogQueue,
  type UiRequest,
  type UiRequestHandler,
  type UiResponse,
} from "./dialog-queue.ts";
import { type HostMode, resolveHostMode } from "./host-mode.ts";
import type { UiChannelRegistry } from "./ui-channels.ts";
import { isDialogMethod } from "./ui-interaction-model.ts";

const logger = getLogger("subagents");

// ── core 自持结构化 UI 上下文（subagent-core 包抽离 u1-move 类型中立化）─────────
//
// 检查点 1 裁定本文件进 core（本文件粘合 dialog-queue / host-mode / ui-channels /
// ui-interaction-model 四个 core 件、唯一生产消费方是壳 index.ts——划壳将迫使壳深引
// core 内部件并分裂 UiRequestHandler 契约；r2 修正原「双消费」措辞），pi SDK 的
// ExtensionContext 虽仅 type import 也不得留在 core 闭包（D1 判据）——改为 core 自持
// 的结构化窄面类型：只声明本模块实际消费的字段（mode 分流 + ui 透传方法），ui 方法
// 签名按 SDK ExtensionUIContext 真实形状（read from
// @earendil-works/pi-coding-agent dist/core/extensions/types.d.ts，注释见
// defaultDialogForward）逐字段同构。宿主壳直传各自 ctx：pi 的 ExtensionContext 结构
// 兼容本类型（结构化类型系统按字段子集赋值），zsw 壳按同形状实现，core 不感知宿主类型。

/** 宿主 UI 通道方法面（core 消费的最小集）。 */
export interface HostUIChannel {
  select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type: "info" | "warning" | "error"): void;
  setStatus(key: string, text?: string): void;
  setWidget(key: string, lines?: string[], opts?: { placement?: "aboveEditor" | "belowEditor" }): void;
  setTitle(title: string): void;
  setEditorText(text: string): void;
}

/** core 自持的宿主 UI 上下文（pi ExtensionContext 的结构化子集）。 */
export interface HostUIContext {
  /** 主进程运行模式（host-mode.ts ExtensionMode 同构字面量；undefined 归 headless）。 */
  mode?: "tui" | "rpc" | "json" | "print";
  ui: HostUIChannel;
}

/** 按 ctx.mode 创建 UI 请求 handler（透传 + 排队总控）。
 *
 *  透传矩阵（§一冲突 2）：
 *    - headless（json/print/undefined）：返回 undefined（不注入任何 UI handler）
 *    - TUI：dialog 透传 + L2 排队；fire-and-forget 回 ack 不透传（不影响 TUI 输入交互）
 *    - GUI（rpc）：全透传；dialog 走 L2 排队，fire-and-forget 直接转发
 *
 *  业务路由（§一冲突 2 维度 2）：
 *    - channel 命中 registry（ask_user/gui_widget）→ 走注册的 channel handler
 *    - 无 channel 的 dialog → defaultDialogForward（调主 agent ctx.ui.select/confirm/...）
 *
 *  SR-3：调用方（index.ts session_start）无论 new 还是 existing SubagentService 都必须调
 *  setUiRequestHandler。headless 下本函数返回 undefined，调用方应据此走不注入路径。
 *
 *  @param ctx Pi ExtensionContext（读 ctx.mode 分流）
 *  @param registry channel 注册表（业务路由；W3 当前为空，ask-user 扩展 Stage 4a 注册）
 *  @param dialogQueue L2 跨子进程全局 dialog 串行队列
 *  @returns UiRequestHandler（tui/gui）；headless 返回 undefined */
export function createUiRequestHandlerForMode(
  ctx: HostUIContext,
  registry: UiChannelRegistry,
  dialogQueue: DialogGlobalQueue,
): UiRequestHandler | undefined {
  const hostMode = resolveHostMode(ctx.mode);
  if (hostMode === "headless") return undefined;

  // [SR-4 接线登记] 队列是跨子进程全局单例（宿主壳创建），而子进程退出信号来自 core
  // 引擎镜像层——本工厂是两者交汇点，在返回 handler 的同一路径上登记，壳侧无需改动。
  registerActiveDialogQueue(dialogQueue);

  const realHandler = createRealHandler(ctx, hostMode, registry);

  return async (req: UiRequest): Promise<UiResponse> => {
    // 维度 1：TUI 下 fire-and-forget 不透传（回 ack，不写 stdin——由 session-runner respond 处理）
    if (hostMode === "tui" && !isDialogMethod(req.method)) {
      return { ack: true };
    }
    // L2 全局队列：dialog 类必须串行（争输入焦点）。fire-and-forget（GUI 下）直接转发。
    // [SR-4] 透传 req._childPid（session-runner 从 child.pid 填入）给 enqueue——
    //   L2 据此关联 child close 时的 rejectChildDialogs 批量 reject（防全局死锁）。
    if (isDialogMethod(req.method)) {
      return dialogQueue.enqueue(req, realHandler, {
        child: req._childPid !== undefined ? { pid: req._childPid } : undefined,
      });
    }
    // GUI 下 fire-and-forget 直接转发
    return realHandler(req);
  };
}

/** 创建实际处理请求的 handler（channel 路由 + 默认转发）。
 *  - channel 命中 registry（ask_user）→ channel handler（结果经 coerceUiResponse 形变）
 *  - 无 channel 的 dialog → defaultDialogForward（主 agent ctx.ui.*） */
function createRealHandler(
  ctx: HostUIContext,
  _hostMode: HostMode,
  registry: UiChannelRegistry,
): UiRequestHandler {
  return async (req: UiRequest): Promise<UiResponse> => {
    // 维度 2：channel 业务路由。channel handler 签名是 (unknown)=>Promise<unknown>
    //（ui-channels.ts 定义，避免循环依赖），此处经 coerceUiResponse 形变为 UiResponse。
    const channelHandler = registry.resolve(req.channel ?? "");
    if (channelHandler) {
      const raw = await channelHandler(req);
      return coerceUiResponse(raw, req.id);
    }

    // 无 channel 的 dialog → 默认转发到主 agent ctx.ui.*
    return defaultDialogForward(req, ctx);
  };
}

/** channel handler 返回值（unknown）形变为 UiResponse。
 *  channel handler 由扩展注册（如 ask-user 扩展返回 {value}/{confirmed}/{cancelled}），
 *  但 ChannelHandler 类型签名用 unknown（协议层避免循环依赖）。本函数做运行时收窄：
 *    - 已是合法 UiResponse shape → 原样返回
 *    - 形状不匹配 → 降级 {cancelled:true}（保守，不阻塞队列） */
function coerceUiResponse(raw: unknown, reqId: string): UiResponse {
  if (typeof raw !== "object" || raw === null) {
    logger.warn("[subagents] channel handler returned non-object, coercing to cancelled", { detail: { reqId } });
    return { cancelled: true };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.value === "string") return { value: obj.value };
  if (typeof obj.confirmed === "boolean") return { confirmed: obj.confirmed };
  if (obj.cancelled === true) return { cancelled: true };
  if (obj.ack === true) return { ack: true };
  logger.warn("[subagents] channel handler returned unrecognized shape, coercing to cancelled", { detail: { reqId } });
  return { cancelled: true };
}

/** 无 channel 的 dialog 默认转发：调主 agent 的 ctx.ui.select/confirm/input/editor。
 *  ask_user channel 未注册时（ask-user 扩展未安装）也会落到这里——
 *  select 请求转发为普通 select（title 可能含 marker，主 agent 会忽略或当普通 select 渲染）。
 *
 *  实现依据（SDK ExtensionUIContext 真实签名，read from
 *  @earendil-works/pi-coding-agent dist/core/extensions/types.d.ts）：
 *    select(title: string, options: string[], opts?): Promise<string | undefined>
 *    confirm(title: string, message: string, opts?): Promise<boolean>
 *    input(title: string, placeholder?: string, opts?): Promise<string | undefined>
 *    editor(title: string, prefill?: string): Promise<string | undefined>
 *  注意：SDK 是位置参数（非对象参数）；返回 undefined 表示用户取消。
 *  opts 为 ExtensionUIDialogOptions（signal?/timeout?，timeout 毫秒，SDK auto-dismiss
 *  带倒计时展示）——LC-3/T2⑦ 协同：请求方显式传 timeout 时透传给 SDK，SDK 层超时
 *  （正常路径，用户可见倒计时）先于队列级兜底 settle；队列级上界（dialog-queue，
 *  未传挂 30min 默认）兜住 SDK timeout 未生效的形态（host 实现不完整 / channel handler
 *  路径不经 SDK）。两层取先到，settle 恰一次由 DialogGlobalQueue 的 settled 标志保证。
 *  editor 的 SDK 签名无 opts，不透传（其上界只由队列级兜底承担）。
 *
 *  Stage 4 风险点：TUI 下 ask_user channel 未注册时，select 会以普通列表渲染
 *  （title 可能含 marker）。channel 注册后由 createRealHandler 优先走 channel handler，
 *  不进这里。editor 不可用/抛错时降级 cancelled + warn，不卡队列。 */
/** select/confirm/input 的 SDK 第三参（opts）：请求方传了**合法** timeout（>0 且有限，
 *  判定源 = dialog-queue 的 isValidDialogTimeout，与队列层上界同一权威）才透传——
 *  未传或非法（0/负数/NaN/±Infinity）时不加第三参，参数个数与旧调用完全一致（严格
 *  additive）。非法值透传会让 SDK 收到语义反转的 opts（<=0 可能立即 auto-dismiss），
 *  且与队列层「非法回落默认上界」的判定不一致（A2-3）；不透传时数组为空，SDK 无界
 *  由队列层默认上界（30min）兜底。
 *  返回元组联合以支持 spread 到固定签名（TS2556）。 */
function sdkTimeoutArg(req: UiRequest): [] | [{ timeout: number }] {
  return isValidDialogTimeout(req.timeout) ? [{ timeout: req.timeout }] : [];
}

/** 各 method 的默认转发器（表驱动分发；dialog 类 await SDK，fire-and-forget 类同步调用后回 ack）。
 *  落空（未知 method）语义留在 defaultDialogForward，与原 default 分支逐字节一致。 */
type DialogMethodForwarder = (req: UiRequest, ui: HostUIChannel) => Promise<UiResponse>;

async function forwardSelect(req: UiRequest, ui: HostUIChannel): Promise<UiResponse> {
  const selected = await ui.select(req.title ?? "", req.options ?? [], ...sdkTimeoutArg(req));
  return selected === undefined ? { cancelled: true } : { value: selected };
}

async function forwardConfirm(req: UiRequest, ui: HostUIChannel): Promise<UiResponse> {
  // SDK confirm 必传 message（req.message 缺失时降级空串，不报错阻塞）
  const confirmed = await ui.confirm(req.title ?? "", req.message ?? "", ...sdkTimeoutArg(req));
  return { confirmed };
}

async function forwardInput(req: UiRequest, ui: HostUIChannel): Promise<UiResponse> {
  const text = await ui.input(req.title ?? "", req.placeholder, ...sdkTimeoutArg(req));
  return text === undefined ? { cancelled: true } : { value: text };
}

async function forwardEditor(req: UiRequest, ui: HostUIChannel): Promise<UiResponse> {
  // SDK editor 必填，但部分 host 运行时未实现——try/catch 降级 cancelled + warn（不卡队列）。
  // 不用 typeof 守卫：editor 在类型上必填，typeof 检查会被 TS2367 拒（条件永假）。
  try {
    const text = await ui.editor(req.title ?? "", req.prefill);
    return text === undefined ? { cancelled: true } : { value: text };
  } catch (err) {
    logger.warn(
      "[subagents] ctx.ui.editor unavailable/threw, returning cancelled",
      { detail: { id: req.id, error: err instanceof Error ? err.message : String(err) } },
    );
    return { cancelled: true };
  }
}

// ── fire-and-forget 类（§3.2 映射表：GUI 模式下由 createUiRequestHandlerForMode 直接转发）
// 子进程 rpc-mode 发出的 fire-and-forget method，channel miss 后落到此处。
// 全部回 {ack:true}（fire-and-forget 语义：子进程不等响应）。

async function forwardNotify(req: UiRequest, ui: HostUIChannel): Promise<UiResponse> {
  // notifyType 运行时收窄：UiRequest.notifyType 是宽 string，ctx.ui.notify 要字面量联合。
  // 非法值 fallback "info"（pi 侧也会静默降级 info，此处显式 fallback 避免类型不安全）。
  const rawType = req.notifyType;
  const notifyType = rawType === "info" || rawType === "warning" || rawType === "error"
    ? rawType
    : "info";
  ui.notify(req.message ?? "", notifyType);
  return { ack: true };
}

async function forwardSetStatus(req: UiRequest, ui: HostUIChannel): Promise<UiResponse> {
  ui.setStatus(req.statusKey ?? "", req.statusText);
  return { ack: true };
}

async function forwardSetWidget(req: UiRequest, ui: HostUIChannel): Promise<UiResponse> {
  // setWidget channel-miss 语义（§3.2 D1）：
  //   req.channel === "gui_widget"（带 marker 但 channel 未注册）→ 不转发（marker 行无渲染意义）
  //   req.channel === undefined（普通 widget）→ 转发文本行到主 agent
  // channel 命中 registry 时由 createRealHandler 优先走 channel handler，不进这里。
  if (req.channel === "gui_widget") {
    return { ack: true };
  }
  ui.setWidget(req.widgetKey ?? "", req.widgetLines, { placement: req.widgetPlacement });
  return { ack: true };
}

async function forwardSetTitle(req: UiRequest, ui: HostUIChannel): Promise<UiResponse> {
  ui.setTitle(req.title ?? "");
  return { ack: true };
}

async function forwardSetEditorText(req: UiRequest, ui: HostUIChannel): Promise<UiResponse> {
  ui.setEditorText(req.text ?? "");
  return { ack: true };
}

/** method → 转发器路由表（key 与原 switch case 标签一一对应；值可选表达落空语义）。 */
const DIALOG_METHOD_FORWARDERS: Readonly<
  Record<string, DialogMethodForwarder | undefined>
> = {
  select: forwardSelect,
  confirm: forwardConfirm,
  input: forwardInput,
  editor: forwardEditor,
  notify: forwardNotify,
  setStatus: forwardSetStatus,
  setWidget: forwardSetWidget,
  setTitle: forwardSetTitle,
  set_editor_text: forwardSetEditorText,
};

async function defaultDialogForward(
  req: UiRequest,
  ctx: HostUIContext,
): Promise<UiResponse> {
  const forwarder = DIALOG_METHOD_FORWARDERS[req.method];
  if (!forwarder) {
    // 未知 method（非 dialog 非 fire-and-forget）——保留 warn（协议演进信号，P3 限流兜底），
    // 回 ack（落到 default 的一定不是 dialog，fire-and-forget 正确应答是 ack，与 TUI 分支先例一致）。
    logger.warn(
      "[subagents] defaultDialogForward: unknown method",
      { detail: { method: req.method, id: req.id } },
    );
    return { ack: true };
  }
  return forwarder(req, ctx.ui);
}
