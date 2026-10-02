/**
 * workflow-viz overlay 壳的渲染层契约类型（workflow-visualization U4）。
 * 渲染层 props 契约——不进 shared 协议。
 */

/**
 * DAG 不可得的归一错误形态：code = shared 错误码四枚举（RPC 成功返回的结构化
 * 错误臂，protocol.ts WorkflowDagReply——parse_failed/no_script_source/
 * record_not_found/path_rejected）或 'channel'（RPC 通道错误——server 中央 catch
 * 的 error envelope，无领域原因码）。两通道在 renderer 侧归一为「DAG 不可得 +
 * 原因码」的同一形态（设计 §3.1-5），归一动作归数据接线层（U5/U6），本壳只消费。
 */
export interface WorkflowVizDagLoadError { // oe-exempt:20261002:framework:workflow-viz 分段视图模型/派生契约类型——类型契约先行、单实现常态
  code: 'parse_failed' | 'no_script_source' | 'record_not_found' | 'path_rejected' | 'channel'
  message: string
}
