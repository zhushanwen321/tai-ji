// src/execution/engine/engine-discovery-roots.ts
//
// [W4] 三级发现的搜索路径域（L1 env 根解析 / L2 node 解析域推导 / 发现根扫描）。
// 自 engine-discovery-scan.ts 拆出（max-lines 纪律）——路径收集与目录遍历是发现
// 主链的无状态前置面。设计权威源：§3.4 搜索路径表 + impl-plan §2.4。

import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "../../core/logger.ts";

const logger = getLogger("subagents");

/** L1 引擎发现根 env（设计 §3.4；值形态 = path.delimiter 分隔的绝对路径列表）。 */
export const ENGINE_ROOTS_ENV = "TAIJI_AGENT_ENGINE_ROOTS";

/** L1 env 根解析：path.delimiter 分隔；空段跳过；非绝对路径丢弃 + warn；去重（大小写敏感）。 */
export function parseEngineRootsEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env[ENGINE_ROOTS_ENV];
  if (raw === undefined || raw.trim() === "") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(path.delimiter)) {
    const dir = part.trim();
    if (dir === "") continue;
    if (!path.isAbsolute(dir)) {
      logger.warn(
        `[engine-discovery] ${ENGINE_ROOTS_ENV} entry '${dir}' is not an absolute path — dropping entry`,
      );
      continue;
    }
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

/**
 * L2 根推导：宿主进程入口（process.argv[1]）所在目录逐级上溯的 node_modules——与
 * createRequire(<宿主入口>) 的 require.resolve 候选目录链同构（「宿主 node_modules
 * require.resolve」的扫描化：零枚举发现要求扫目录而非 resolve 具体包名）。打包态
 * （staged 扩展 / Bun standalone 无 node_modules 结构）与 zsw vendor 态自然为空——
 * 规格明确两态 L2 无效。argv[1] 不可得（嵌入式 / worker）→ L2 缺席。
 */
export function deriveNodeModuleRoots(argvEntry: string | undefined = process.argv[1]): string[] {
  if (!argvEntry || argvEntry.trim() === "") return [];
  const roots: string[] = [];
  let dir = path.dirname(path.resolve(argvEntry));
  while (true) {
    const nm = path.join(dir, "node_modules");
    if (isDirectory(nm)) roots.push(nm);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/**
 * 扫描单个发现根：一级子目录直接含 package.json 即候选包；无 package.json 的目录
 * 再下钻一层（org 分组布局：npm @scope/name、pi npm 安装位的 <org>/<pkg>）。二层封顶。
 * 根不存在/不可读 → 静默（L2 上溯链多数层级无 node_modules，warn 会刷屏）。
 */
export function scanEngineRoot(root: string, visit: (pkgDir: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of entries) {
    if (!item.isDirectory()) continue;
    const dir = path.join(root, item.name);
    if (isFile(path.join(dir, "package.json"))) {
      visit(dir);
      continue;
    }
    let sub: fs.Dirent[];
    try {
      sub = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of sub) {
      if (!child.isDirectory()) continue;
      const subDir = path.join(dir, child.name);
      if (isFile(path.join(subDir, "package.json"))) visit(subDir);
    }
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false; // ENOENT 等 → 非目录
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false; // ENOENT 等 → 非文件
  }
}
