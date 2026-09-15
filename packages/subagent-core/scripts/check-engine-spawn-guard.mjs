#!/usr/bin/env node
// check-engine-spawn-guard.mjs —— W10 静态断言：引擎包「任务子进程 spawn 必经
// SDK spawnEngineChild」（grep 可执行、CI 可挂）。
//
// 规则：两个引擎包源码（src/**/*.ts，排除 __tests__/ 与 .mjs fixture）中，
// node:child_process 的**值导入**（非 `import type`）即视为潜在 spawn/exec 入口，
// 必须命中 allowlist（带理由注释）；同时正向断言每个引擎包存在 spawnEngineChild
// 消费点（防「守卫绿但引擎根本没走 SDK 入口」的空转）。
//
// 与 C-proc-09 守卫（.githooks/check_spawn_env_boundary.py）的分工——互不代偿：
//   - C-proc-09：spawn 点的 **env 出站卫生**（buildOutboundChildEnv 剥 deny 键），
//     盖全仓进程创建点；
//   - 本守卫：引擎包内 spawn 的**单一入口**（spawnEngineChild 硬编码 detached/
//     stdio 形态 + stdin fd 不外泄 R9-4②），只盖引擎包 src。
//   - allowlist 的 ps/taskkill/kill 探测收割调用「不是任务子进程」（§7.2 R9-4③），
//     两守卫都不因其红；收割语义守卫 = kill-chain 单测 + A3 真机门。
//
// 用法：node scripts/check-engine-spawn-guard.mjs [--roots <pkg-src>,<pkg-src>]
// （--roots 覆盖 = 负样本自测入口；缺省 = 两引擎包 src）

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, dirname } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");

const argIdx = process.argv.indexOf("--roots");
const roots = argIdx >= 0
  ? process.argv[argIdx + 1].split(",").map((p) => (isAbsolute(p) ? p : join(repoRoot, p)))
  : [
      join(repoRoot, "packages/pi-subagent-cli/src"),
      join(repoRoot, "packages/zcode-subagent-cli/src"),
    ];

/**
 * allowlist：file（相对 repo root）→ 值导入符号 + 理由。
 * 仅容纳引擎自身的探测/收割类子进程调用（非任务子进程，§7.2 R9-4③）。
 */
const ALLOWLIST = {
  "packages/pi-subagent-cli/src/pi-engine.ts": {
    symbols: ["execFile"],
    reason: "probe 版本探测（pi --version 探测收割判据）——非任务子进程；env 经 buildOutboundChildEnv（C-proc-09）",
  },
  "packages/pi-subagent-cli/src/spawn-args.ts": {
    symbols: ["execFile"],
    reason: "git branch 探测（prompt 环境块）——非任务子进程；env 经 buildOutboundChildEnv（C-proc-09）",
  },
};

const VALUE_IMPORT_RE = /^import\s+(?!type\b)([^;]*)from\s+["'](node:)?child_process["']/gm;

function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "__golden__" || entry === "__fixtures__" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function namedImports(clause) {
  // `import { execFile } from ...` / `import { execFile as x }` → 提取具名符号（排除 type 前缀项）
  const braces = clause.match(/\{([^}]*)\}/);
  if (!braces) return [];
  return braces[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("type "))
    .map((s) => s.split(/\s+as\s+/)[0].trim());
}

const violations = [];
let spawnEngineChildConsumers = 0;

for (const root of roots) {
  let files;
  try {
    files = listTsFiles(root);
  } catch (err) {
    console.error(`[engine-spawn-guard] cannot read root ${root}: ${err.message}`);
    process.exit(2);
  }
  for (const file of files) {
    const rel = file.slice(repoRoot.length + 1);
    const src = readFileSync(file, "utf8");
    if (/\bspawnEngineChild\s*\(/.test(src)) spawnEngineChildConsumers += 1;
    VALUE_IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = VALUE_IMPORT_RE.exec(src)) !== null) {
      const symbols = namedImports(m[1]);
      if (symbols.length === 0) continue;
      const allow = ALLOWLIST[rel];
      const unallowed = allow === undefined ? symbols : symbols.filter((s) => !allow.symbols.includes(s));
      if (unallowed.length > 0) {
        violations.push(
          `${rel}: value-imports { ${unallowed.join(", ")} } from child_process — `
          + (allow === undefined
            ? "不在 allowlist（任务子进程必须经 SDK spawnEngineChild；探测/收割类调用须登记 allowlist 带理由）"
            : `超出 allowlist 符号面（已登记：${allow.symbols.join(", ")}；理由：${allow.reason}）`),
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("[engine-spawn-guard] FAIL:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
if (spawnEngineChildConsumers === 0) {
  console.error("[engine-spawn-guard] FAIL: no spawnEngineChild call site found — guard is green but vacuous");
  process.exit(1);
}
console.log(`[engine-spawn-guard] PASS: ${roots.length} roots clean, ${spawnEngineChildConsumers} files consume spawnEngineChild`);
