/**
 * subagent-workflow tool 结果的公共类型（`workflow` 与 `subagents` 两个 tool 共用）。
 *
 * 此前两文件各自 `export interface ToolResult`（同目录同名异形，`details` 必填/可空
 * 也不同），且各自声明了一份「一次 run 启动回执」的近似形状。本模块把公共底座单点化：
 * - `RunStartDetails`：启动回执的公共字段（runId / status / slug / stateFile）
 * - `ToolTextContent` / `WorkflowToolResult<Details>`：tool execute 返回骨架
 * 各 tool 在各自文件里以本底座扩展（补工具特有字段与判别式）。字段名与运行期形态零变化
 * （`scriptName → name` 的对齐属行为变更，不在本次范围）。
 *
 * 层归属：Interface（纯类型层，无运行时依赖）。
 */

/** tool 结果的文本 content 块（对齐 pi AgentToolResult 的 content 元素形状）。 */
export interface ToolTextContent {
  type: "text";
  text: string;
}

/**
 * 一次 run 启动回执的公共字段（两侧 details 各自扩展工具特有字段与判别式）。
 *
 * `status` 取并集：`subagents` 只有一个动作、启动即返回，收窄为 `"running"`；
 * `workflow` 的 actionRun 另有 `not_found` / `invalid_args` 两态。
 */
export interface RunStartDetails {
  runId: string;
  status: "running" | "not_found" | "invalid_args";
  /** Run 级 slug（可选，旧 run 缺失为 undefined）。 */
  slug?: string;
  /** run 状态快照文件绝对路径（<sessionDir>/workflow-state/<runId>.jsonl）。 */
  stateFile?: string;
}

/** tool execute 返回骨架：details 由各 tool 的 details 类型实例化。 */
export interface WorkflowToolResult<Details> {
  content: Array<ToolTextContent>;
  details: Details;
  isError?: boolean;
}
