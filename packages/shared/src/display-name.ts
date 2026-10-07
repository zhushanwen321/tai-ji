/**
 * agent/workflow 引用显示名（basename 短名）——GUI 侧单点实现（D-收敛：tray 行、
 * workflow 块标题行共用，替代各自内联的 split/replace 私有拷贝，消除 tray 侧
 * 只切 `/` 不切 `\` 的分叉）。
 *
 * 与 core 侧等价锚定：`@zhushanwen/subagent-core` 的 shared/agent-ref.ts 导出
 * 同名 displayAgentName / displayWorkflowName，两侧行为逐字节等价（双分隔符
 * basename + 扩展名剥离，大小写敏感 endsWith）。core 不依赖 shared（shared 不发
 * npm，core 运行时 import 需改 bundle/发布面，代价不成比例），故双实现并存；
 * 等价性由两侧测试同款向量（`C:\\a\\worker.md` → `worker` 等）共同锁定，任一侧
 * 改语义须同步另一侧。
 *
 * 数据层不动：record.agent / input.name 等完整引用原文保持，仅显示层取短名。
 */

/** agentRef 扩展名（.md 绝对路径；与 core shared/agent-ref.ts AGENT_REF_EXT 同值）。 */
const AGENT_NAME_EXT = ".md";
/** workflowRef 扩展名（.js 绝对路径；与 core shared/agent-ref.ts WORKFLOW_REF_EXT 同值）。 */
const WORKFLOW_NAME_EXT = ".js";

/**
 * agent 引用的显示名：双分隔符 basename + 去 .md（`/a/b/worker.md`、`C:\a\worker.md`
 * → `worker`）。非路径值（如默认 agent 名）与无 .md 后缀的值原样返回。手动 split
 * 而非 path.basename：跨平台统一（macOS 的 path.basename 不切 Windows `\` 分隔符，
 * 反之类推）。
 */
export function displayAgentName(ref: string): string {
  const base = ref.split(/[\\/]/).pop() ?? ref;
  return base.endsWith(AGENT_NAME_EXT) ? base.slice(0, -AGENT_NAME_EXT.length) : base;
}

/**
 * workflow 引用的显示名：双分隔符 basename + 去 .js（`/a/b/batch.js` → `batch`）。
 * 与 displayAgentName 对称（input.name 绝对路径 → 标题行短名，drawer 选中仍用全路径）。
 */
export function displayWorkflowName(ref: string): string {
  const base = ref.split(/[\\/]/).pop() ?? ref;
  return base.endsWith(WORKFLOW_NAME_EXT) ? base.slice(0, -WORKFLOW_NAME_EXT.length) : base;
}
