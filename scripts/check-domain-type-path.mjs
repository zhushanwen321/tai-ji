#!/usr/bin/env node
// [D2] 领域类型路径单源检查：`execution/domain/` 是 record 域类型与词汇的**唯一权威路径**。
//
// 拦两类回退（都不需要语义判断，纯路径/名字面）：
//   ① `execution/assembly/types.ts` 重新导出领域名（re-export shim 复活 → 路径双源）；
//   ② 其它文件从 assembly 取领域名（绕开单源，回到「领域概念住在应用层目录」的旧形态）。
//
// 口径：领域名清单 = `execution/domain/record-types.ts` + `record-model.ts` 的导出名
// （动态读取，避免清单漂移）；assembly 允许**内部 import** 这些名字（它自己的剩余类型
// 引用它们），只禁止 **export**。
//
// 用法：node scripts/check-domain-type-path.mjs [--root <dir>]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const ROOT = resolve(rootFlag >= 0 ? args[rootFlag + 1] : process.cwd());
const CORE = join(ROOT, "packages/subagent-core/src");
const DOMAIN_FILES = [join(CORE, "execution/domain/record-types.ts"), join(CORE, "execution/domain/record-model.ts")];
const SHIM = join(CORE, "execution/assembly/types.ts");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** 领域名清单（动态：从 domain 模块的 export 语句收集）。 */
const domainNames = new Set();
for (const f of DOMAIN_FILES) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const n of m[1].split(",")) {
      const name = n.trim().split(/\s+as\s+/)[0].trim();
      if (name) domainNames.add(name);
    }
  }
  for (const m of text.matchAll(/^export\s+(?:interface|type|const|class|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    domainNames.add(m[1]);
  }
}

const violations = [];
const shimText = readFileSync(SHIM, "utf8");
for (const m of shimText.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
  for (const n of m[1].split(",")) {
    const name = n.trim().split(/\s+as\s+/)[0].trim();
    if (domainNames.has(name)) violations.push(`${relative(ROOT, SHIM)}: 重新导出领域名 ${name}（路径双源）`);
  }
}

for (const file of walk(CORE)) {
  if (file === SHIM || DOMAIN_FILES.includes(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]*assembly\/types[^"]*)"/gs)) {
    for (const n of m[1].split(",")) {
      const name = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (domainNames.has(name)) {
        violations.push(`${relative(ROOT, file)}: 从 assembly 取领域名 ${name}（应走 execution/domain/）`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("[domain-type-path] 失败：领域类型路径出现双源");
  for (const v of violations.slice(0, 20)) console.error(`  ✗ ${v}`);
  if (violations.length > 20) console.error(`  … 共 ${violations.length} 条`);
  process.exit(1);
}
console.log(`[domain-type-path] OK：${domainNames.size} 个领域名只在 execution/domain/ 声明，assembly 无 re-export、无绕道引用`);
