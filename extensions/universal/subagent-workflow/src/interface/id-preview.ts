// src/interface/id-preview.ts
//
// run/subagent 标识符的截断展示口径（单点常量）。
//
// runId（wf-<ts>-<rand>）与 subagentId（UUID）分属两族标识符，但所有展示面
// （workflow tool 渲染 / /workflows 命令行 / GUI label / subagent GUI header）
// 统一取前 8 字符做预览——同一口径保证各界面引用同一 run/subagent 时展示一致
// （helpers 的 GUI label 与 buildWorkflowGui 对齐先例 I#3）。此前 4 处本地常量
// 3 种命名（RUNID_SHORT ×2 / RUN_ID_DISPLAY_LENGTH / SUBAGENT_ID_PREVIEW）收敛到此。

/** 标识符截断展示长度（前 N 字符）。 */
export const ID_PREVIEW_LENGTH = 8;
