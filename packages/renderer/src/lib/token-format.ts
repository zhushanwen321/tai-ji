/**
 * token 数 K 格式化单点（renderer 侧）。
 *
 * 原 WorkflowTab.vue / TrayNativePanel.vue 同名 formatTokens + TOKEN_K_THRESHOLD 双实现
 * 收敛于此（质量审查结构收敛批）；两消费点 unit 来源不同（字面量 / i18n），以参数注入。
 * ui 包的 SystemNotice 自持 K 格式（含 `.0` 去尾），包间不互依、各自收敛，不强求跨包统一。
 */

/** token 数超过此阈值显示 k 单位（沿用自退役的侧栏工作流详情视图同值） */
const TOKEN_K_THRESHOLD = 1000

/** token 数 → K 格式：1500 → `1.5k tokens`，800 → `800 tokens`（unit 由调用方注入） */
export function formatTokens(tokens: number, unit: string): string {
  if (tokens >= TOKEN_K_THRESHOLD) return `${(tokens / TOKEN_K_THRESHOLD).toFixed(1)}k ${unit}`
  return `${tokens} ${unit}`
}
