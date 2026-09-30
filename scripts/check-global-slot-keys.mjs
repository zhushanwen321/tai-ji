#!/usr/bin/env node
/**
 * check-global-slot-keys.mjs —— 进程级全局槽键归属守卫（§2.6，约束 C-state-20）。
 *
 * 背景：进程级单例经 `globalThis[Symbol.for(键)]` 共享（workspace 源码 / npm dist /
 * pi jiti 三实例化通道下模块级变量会分裂）。键字面量散落多前缀时，撞名无编译期报错，
 * 只会静默抢槽（两端拿到的不是同一对象 → 「设置了不生效」），且名字与实际归属不符。
 *
 * 判据：
 *   1. `Symbol.for("<字面量>")` 只允许出现在两处声明文件：
 *      packages/subagent-core/src/shared/global-slots.ts（core + 壳侧托管槽）与
 *      packages/subagent-engine-sdk/src/global-slots.ts（SDK 自有槽，SDK 不得 import
 *      core 故保留自有前缀）。其余源码里必须写 `Symbol.for(<常量>)`。
 *   2. 两文件内的键前缀分别只能是 `@zhushanwen/subagent-core.` 与
 *      `@zhushanwen/subagent-engine-sdk.`。
 *   3. 键字符串全仓唯一（跨两文件也不得重复）。
 *
 * 用法：node scripts/check-global-slot-keys.mjs [--root <dir>]（--root 供 fixture 单测）
 * 退出码：0 = 合规；1 = 违规（逐条打印文件:行与修复动作）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

const ARGS = process.argv.slice(2);
const ROOT_FLAG = ARGS.indexOf("--root");
const BASE = resolve(process.cwd(), ROOT_FLAG >= 0 ? ARGS[ROOT_FLAG + 1] : ".");

/**
 * 扫描面 = subagent 体系三包（§2.6 的范围：core + engine SDK + 壳）。
 * 其他 extension（如 goal/plan 共享的 `@zhushanwen/pi-goal.goalInit`）的槽键前缀与
 * 归属包一致，不属本约束范围。
 */
const SCAN_ROOTS = [
  "packages/subagent-core/src",
  "packages/subagent-engine-sdk/src",
  "extensions/universal/subagent-workflow/src",
].map((p) => join(BASE, p));

const ALLOWED = new Map([
  ["packages/subagent-core/src/shared/global-slots.ts", "@zhushanwen/subagent-core."],
  ["packages/subagent-engine-sdk/src/global-slots.ts", "@zhushanwen/subagent-engine-sdk."],
]);

const LITERAL_RE = /Symbol\.for\(\s*"([^"]*)"\s*,?\s*\)/g;

function collect(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    // __tests__ 不跳过：测试也声明/读取槽键，漏扫曾致改名后测试写旧键、生产读新键
    //（2026-09-30 实证：12 例扩展测试假红）。
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collect(full, out);
      continue;
    }
    if (/\.(ts|mts|cts)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const violations = [];
const seen = new Map();

for (const root of SCAN_ROOTS) {
  for (const file of collect(root)) {
    const rel = relative(BASE, file);
    const allowedPrefix = ALLOWED.get(rel);
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, index) => {
      // 注释行不参与（声明文件头部用 Symbol.for("…") 举例说明机制）
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      for (const m of line.matchAll(LITERAL_RE)) {
        const literal = m[1];
        if (allowedPrefix === undefined) {
          violations.push(
            `${rel}:${index + 1} 槽键字面量散落在声明文件之外（"${literal}"）——` +
            `改用 Symbol.for(GLOBAL_SLOT_KEYS.<槽名>) / Symbol.for(ENGINE_SDK_SLOT_KEYS.<槽名>)`,
          );
        }
      }
    });
  }
}

// ── 声明文件内的键串：前缀 + 跨文件唯一 ──
for (const [rel, allowedPrefix] of ALLOWED) {
  let src;
  try {
    src = readFileSync(join(BASE, rel), "utf8");
  } catch {
    violations.push(`${rel} 不存在——槽键声明文件缺失`);
    continue;
  }
  src.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    for (const m of line.matchAll(/"(@zhushanwen\/[^"]+)"/g)) {
      const key = m[1];
      if (!key.startsWith(allowedPrefix)) {
        violations.push(`${rel}:${index + 1} 槽键前缀越界（"${key}"）——本文件只允许 ${allowedPrefix}*`);
      }
      const prev = seen.get(key);
      if (prev !== undefined && prev !== rel) {
        violations.push(`${rel}:${index + 1} 槽键重复声明（"${key}" 已在 ${prev} 声明）`);
      }
      seen.set(key, rel);
    }
  });
}

if (violations.length > 0) {
  console.error("[global-slot-keys] 检出违规：");
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "[global-slot-keys] 单一声明处 = packages/subagent-core/src/shared/global-slots.ts" +
    "（core + 壳侧托管槽）与 packages/subagent-engine-sdk/src/global-slots.ts（SDK 自有槽）",
  );
  process.exit(1);
}
console.log(`[global-slot-keys] OK：${seen.size} 个槽键全部集中在两处声明文件，前缀与唯一性合规`);
process.exit(0);
