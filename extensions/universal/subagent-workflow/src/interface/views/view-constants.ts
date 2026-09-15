// src/interface/views/view-constants.ts
//
// workflow 全屏视图族专属布局常量（WorkflowsView + detail-content 消费）。
// 自 interface/format.ts 沉回 views/（post-convergence C4：format.ts 只保留
// 跨视图族共享的格式化函数，views 专属常量就近落位消费方目录）。
// ELLIPSIS 留在 format.ts（formatActivityLine/formatPhaseLine 亦消费，非 views 专属）。

/** 左侧 sidebar 宽度（WorkflowsView 布局）。 */
export const SIDEBAR_WIDTH = 24;
/** prompt 区折叠时显示的行数（detail-content L2）。 */
export const PROMPT_FOLD_LINES = 3;
/** result 正文渲染的截断预算（字节，detail-content L2）。 */
export const OUTPUT_TRUNCATE_BYTES = 100_000;
/** box 左右边框字符宽度（│ x 2），用于内容行截断预算。 */
export const BOX_BORDER_CHARS = 2;
/** token 数 → k 单位的除数。 */
export const BUDGET_TOKENS_DIVISOR = 1000;
/** Activity 区最多显示的 tool call 条数。 */
export const MAX_TOOL_CALLS_DISPLAY = 3;
