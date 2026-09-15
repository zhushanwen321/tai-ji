// scripts/probes/subagent-sync-collect/faux-script.mjs
//
// faux 通道响应脚本写入独立模块（L2.5）。
//
// [R1 误报拆分·先例同 results-log.mjs] pre-commit 的 pi session JSONL 直写检查按
// 文件级启发式：common.mjs 含子代理 sessions 路径推导痕迹，其内的 writeFileSync
// 会被保守判为「pi 会话 JSONL 直写候选」。本模块只写探针工作区（mkdtemp root）下
// 的 faux-script.json——faux provider 的 model-keyed 响应脚本（声明式测试载荷，
// 由 pi 子进程内的测试 extension 读取，非任何 pi 数据文件），不含任何 pi 数据目录
// 路径推导。common.mjs 的 makeWorkspace.writeFauxScript 经本模块落盘。
//
// 脚本形态 SSOT：faux 队列字段 = packages/runtime/src/__tests__/equivalence/pi-fixture.ts
// ScriptedStep（数组形态）；model-keyed 对象形态（{ "provider/id": steps[] }）见
// packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts loadScript（主/子进程共享
// 脚本按 --model 选队）。

import { writeFileSync } from "node:fs";

/** 把 model-keyed 响应脚本写到 path（JSON 对象 { "provider/id": steps[] }）。 */
export function writeFauxScriptFile(path, map) {
  writeFileSync(path, JSON.stringify(map));
  return path;
}
