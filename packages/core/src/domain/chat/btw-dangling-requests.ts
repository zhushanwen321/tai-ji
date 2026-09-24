import type { Message } from '@taiji/shared'

/**
 * btw 悬空交互请求判定（投影层纯谓词，btw-question D8 失效支三路之三「回放对账路」的
 * 悬空扫描 SSOT——自 renderer btw-pending-bookkeeping 上移〔2026-09-23 review round 1
 * MF-1-5〕，与 message-turns 派生族同居 core：消费 Message[] 投影形态，live 与 reload
 * 同一公式；对照 derivePlanStage（#36）renderer 展示派生先例）。
 *
 * 信号源语义：悬空 toolCall 是执行体被杀时留下的持久痕迹（pi 会话文件层）——整机杀
 * 重启后首轮回放据此判「曾有交互请求未获应答」，不依赖任何内存簿记跨进程存活。
 *
 * 层界注记（双实现非同源，刻意不合流）：runtime `btw-fork-exec.ts` 的
 * `hasDanglingToolCall` 在 **raw entry 层**判定（任意工具的 callId 无对应 toolResult，
 * fork 快照 pill 用）——raw entry 无 output 回填语义，闭合判定只能做 id 差集；本谓词在
 * **投影层**判定（名单内工具 ∧ `output === undefined`），依赖投影不变量：回放投影中
 * 已闭合 toolCall 恒有 `output: string`（fillHostToolCall 无条件回填，空串也算闭合），
 * 悬空者保持 undefined。两层输入形态与判定目的不同，合流需先统一 entry→投影的闭合
 * 语义，无此需求前维持双实现。
 */

/**
 * 交互请求类工具名（悬空判定名单，窄而准——宁漏不误）。口径 = D8 请求范围五类中
 * 「以本名工具 toolCall 持久化、且执行体阻塞等待用户应答」的子集：
 * - `ask_user`：ask-user 富提问表单（extensions/universal/ask-user/src/index.ts registerTool）
 * - `schedule`：scheduler 建单表单（extensions/universal/scheduler/src/index.ts registerTool，
 *   interaction.ts 经 uiFormInteract 阻塞等应答）
 * - `plan`：plan 模式生命周期（extensions/universal/plan/src/tool.ts registerTool，
 *   submit-review 阻塞等用户审批）
 * 刻意排除（按名不可辨识或非用户对话等待）：`schedule_control`（纯服务调用无 UI 阻塞）；
 * session-manager 六工具（SESSION_MANAGER_MARKER 机器 RPC 通道，亚秒级非用户应答）；
 * permission 审批与 confirm/input/editor 简单 dialog（挂在 bash/edit 等普通工具执行体或
 * extension 内部调用上，悬空 toolCall 名不可辨识——误标普通工具即违名单窄而准）；
 * plugin-bridge 动态插件工具（非 taiji 交互请求族）。
 */
export const BTW_INTERACTIVE_REQUEST_TOOLS: ReadonlySet<string> = new Set([
  'ask_user',
  'schedule',
  'plan',
])

/**
 * 消息投影中是否存在悬空交互请求 toolCall（名单内工具 ∧ 无 output 回填）。
 * 纯函数、零副作用——调用方（markBtwStaleInteractiveFromReplay）持有存活挂起守卫与
 * 状态写入，本谓词只回答「有没有」。
 */
export function hasDanglingInteractiveRequest(messages: readonly Message[]): boolean {
  for (const m of messages) {
    const tcs = m.toolCalls
    if (!tcs) continue
    for (const tc of tcs) {
      if (tc.output === undefined && BTW_INTERACTIVE_REQUEST_TOOLS.has(tc.toolName)) return true
    }
  }
  return false
}
