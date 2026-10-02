/**
 * run-name.ts —— workflow 脚本名归一纯函数（run 名定位判据单源）。
 *
 * 「按 run 名定位 record」的两个入口共用本归一：overlay 反查（workflow-viz-overlay.ts
 * findRun——chips lookup / opener 注入）与 drawer 兼收解析（WorkflowTab.vue 的
 * selectedWorkflowName 匹配——SubagentTab 返回按钮 / 反查未命中回落注入）。主 agent 调
 * workflow 工具常传脚本路径（/abs/path/x.js）而 record.scriptName 存 basename（x）——
 * 严格等值恒 miss（L4 真机发现）；两侧 basename 化 + 去脚本扩展名后比较，路径 / 带扩展名 /
 * bare 三形态互通。runId 精确匹配在前、名字归一匹配在后的次序属入口职责，不在本函数内。
 */
export function normalizeWorkflowScriptName(name: string): string {
  const base = name.replace(/\\/gu, '/').split('/').pop() ?? name
  return base.replace(/\.(js|mjs|cjs|ts)$/u, '')
}
