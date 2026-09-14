/**
 * `@xyz-agent/extension-protocol/background-task` 子出口聚合——仅 re-export 三个含
 * node 内建依赖的后台任务行为原语模块，无其它逻辑。
 *
 * 为什么是独立子出口：三个原语模块均含 `node:child_process` / `node:fs` 顶层
 * import，而本包 index 桶出口的消费面含浏览器环境（renderer / core）。原语走
 * 独立子出口后浏览器消费面结构性不触达 node 内建（不依赖 tree-shake 行为），
 * bte 与 runtime 从本子出口 import。三个原语模块**不进 index 桶出口**。
 */

export * from './background-task-process'
export * from './background-task-registry-file'
export * from './output-tail'
