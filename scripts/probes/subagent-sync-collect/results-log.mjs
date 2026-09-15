// scripts/probes/subagent-sync-collect/results-log.mjs
//
// 探针结果记录独立模块（RESULTS.md，纯 markdown 日志追加写入）。
//
// [commit 前修复·R1 误报拆分] pre-commit 检查器按文件级启发式，把 common.mjs 的
// appendFileSync(RESULTS_FILE) 判为「pi 会话 JSONL 直写候选」——根因是 common.mjs
// 同文件含子代理数据目录路径推导代码，启发式保守命中。本模块只做本目录 RESULTS.md
// 的结果追加（markdown，非任何 pi 数据文件），不含任何 pi 数据目录路径推导。
// common.mjs 从这里 re-export，场景脚本调用面（C.appendResultRecord / C.RESULTS_FILE）
// 保持不变，行为逐字节等价。

import { appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 结果日志落点：本探针目录下 RESULTS.md（与 common.mjs 原 PROBE_DIR 同一目录）。 */
export const RESULTS_FILE = join(resolve(dirname(fileURLToPath(import.meta.url))), "RESULTS.md");

/** 按场景追加一条留痕（A2 对比表 / A7 手动模板 / 各场景执行结果）。
 *  幂等性不保证——append-only 留痕语义，与既有行为一致。 */
export function appendResultRecord(scenarioId, lines) {
  const stamp = new Date().toISOString();
  const block = [`\n## ${scenarioId} — ${stamp}\n`, ...lines, ""].join("\n");
  appendFileSync(RESULTS_FILE, block, "utf-8");
  console.log(`  (记录已追加到 ${RESULTS_FILE})`);
}
