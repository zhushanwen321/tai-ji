import { join } from 'node:path';

/**
 * 引擎数据目录布局 SSOT（引擎侧原语，自 core execution/engine/paths.ts 移入
 * @zhushanwen/subagent-engine-sdk，实现体逐字等价）。
 * 迁移处置（impl-plan §2.1 paths 行）：纯 `node:path` 模块 → **移入 SDK**（引擎侧需
 * 自算池/journal 路径）；core 侧引用切换已完成（core execution/engine/paths.ts 为
 * re-export shim，子入口 ./engine/paths 解析路径不变）。
 *
 * 设计权威源：constraints.json C-ext-15（原 subagent-engine-abstraction.md D5/D6，已删，git 可追溯）。
 *
 * 为什么独立成模块：extension 写侧（journal 落盘 / preparer 池目录）与
 * runtime 校验侧（subagent-extractor 前缀白名单）必须同源推导——
 * 双方 import 同一份纯函数，禁止各自拼字符串漂移。
 *
 * 布局：`<dataDir>/engines/<engineId>/<pool-key>/journal-<taskId>.jsonl`
 * 隔离池跨任务保留复用；journal 生命周期跟随 record，不随池删除（D5）。
 */

/** 路径段安全编码后的最大字符数（防超长段击穿文件名长度上限；runtime 校验侧同源）。 */
const MAX_SEG_CHARS = 80;

/** 路径段进入文件系统前的安全编码：路径穿越、分隔符、空白、超长全部归一。 */
export function sanitizeSeg(input: string): string {
  const s = input.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 ? s.slice(0, MAX_SEG_CHARS) : 'default';
}

export function resolveEnginesRoot(dataDir: string): string {
  return join(dataDir, 'engines');
}

export function resolveEngineDir(dataDir: string, engineId: string): string {
  return join(resolveEnginesRoot(dataDir), sanitizeSeg(engineId));
}

export function resolvePoolDir(dataDir: string, engineId: string, poolKey: string): string {
  return join(resolveEngineDir(dataDir, sanitizeSeg(engineId)), sanitizeSeg(poolKey));
}

export function resolveJournalPath(
  dataDir: string,
  engineId: string,
  poolKey: string,
  taskId: string,
): string {
  return join(resolvePoolDir(dataDir, engineId, poolKey), `journal-${sanitizeSeg(taskId)}.jsonl`);
}
