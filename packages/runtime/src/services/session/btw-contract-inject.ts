/**
 * D9⑤ 行为契约注入面（btw-question 设计 D9⑤ / V6 载体 ① `--append-system-prompt`）。
 *
 * 内聚段抽自 btw-service.ts（max-lines 同目录内聚拆分，2026-09-22，纯移动零行为变更）：
 * 契约文本 + trace 记录类型 + 「模式 append 段 ⊕ 契约」组合器——三者同属契约注入的
 * 数据与纯逻辑面；施加点（buildEstablishOptions / 每轮 trace 调用）留在 BtwService。
 * btw-service 保持原样 re-export（导出面零变更）；对账单测
 *（__tests__/btw-contract-inject.test.ts）消费路径零改动。
 * oracle / 失败三支 / 子通道归属（V6）语义见契约文本 doc 与设计 D9⑤，本模块不复述。
 */

/**
 * D9⑤ 行为契约（model-only 单条注入，UI 不可见，借鉴 zcode system_reminder 一句话版）：
 * 每线会话建立时注入一次（含分支②回落线与重附着轮）。
 * 载体子通道（①pi 侧 system-prompt 通道 / ②请求携带通道）随 V6 核实钉固；
 * 当前实现落 ① 的 spawn `--append-system-prompt` 组合（prompt 期注入、每建立一轮一次、
 * 不产生落盘 entry、不进对话流渲染），oracle = traceContractInjection 挂点记录。
 * 失败三支（设计 D9⑤）：能力缺失 → 放弃 + 登记；实现缺陷 → 修复；oracle 错位 → 修订复测。
 */
export const BTW_BEHAVIOR_CONTRACT =
  '父任务快照仅供背景；只回答本线新问题、不自动续主任务；仅本线明确要求时才改工作区'

/** 行为契约注入 trace 记录（D9⑤ oracle 挂点；V6 钉固载体后与 system-prompt-trace 对账）。 */
export interface BtwContractInjectionTrace {
  vid: string
  /** 第几轮会话建立（create=1，每次 reattach +1）。 */
  round: number
  carrier: 'append-system-prompt'
  contract: string
}

/**
 * 行为契约 ⊕ spawn append 段组合（D9⑤ 载体 ①：`--append-system-prompt`）。
 * 每次会话建立调用一次——base（模式 append 段）与契约同线拼接，互不覆盖。
 */
export function composeContractAppendPrompt(base: string | undefined): string {
  const trimmed = base?.trim() ? base : undefined
  return trimmed ? `${trimmed}\n${BTW_BEHAVIOR_CONTRACT}` : BTW_BEHAVIOR_CONTRACT
}
