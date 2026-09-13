#!/usr/bin/env node
// check-engine-sdk-boundary.mjs
//
// 引擎 SDK 边界守卫（W1 交付，impl-plan §2.1「守卫基线」：新增 SDK 代码前先建守卫）。
// 设计权威源：docs/architecture/subagent-engine-protocolization.md §3.5.1 不变量 +
// docs/design/subagent-engine-protocolization.impl-plan.md §2.1 末「守卫基线」（impl-plan 已删除，git 可追溯）。
//
// 不变量（设计 §3.10 实施不变量 1）：**SDK 不得 import core**——否则 core → SDK → core
// 成环。本守卫扫描 @zhushanwen/subagent-engine-sdk 的源码与 dist：
//   1. 不得出现 core 包名 `@zhushanwen/subagent-core`（import/require/dynamic import
//      的模块说明符形态）；
//   2. 不得出现指向 `packages/subagent-core/**` 的越界相对路径（相对说明符解析后
//      逃出 SDK 包根即违规——不依赖包名拼写，路径穿越形态同样拦下）。
//
// 扫描范围与口径：
//   - 源码：packages/subagent-engine-sdk/src/**/*.ts（含测试；测试 import core 会把
//     边界依赖带进类型闭包，同样违规）；
//   - dist：packages/subagent-engine-sdk/dist/**/*.{js,cjs,mjs}（存在才扫；构建后
//     守卫必须重跑——bundle 产物把依赖内联，源码干净不代表产物干净）；
//   - 只检查模块说明符（import/require/export from/dynamic import），不扫注释文本——
//     源文件头部的「源 = packages/subagent-core/src/...」参照注释是合法的迁移留痕。
//
// 运行：node scripts/check-engine-sdk-boundary.mjs（.githooks 下脚本由仓根相对路径
// 定位包目录；违规时 exit 1 并逐条列出文件:行号:违规说明符 + 恢复指引）。

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_DIR = join(REPO_ROOT, "packages", "subagent-engine-sdk");
const CORE_PACKAGE_NAME = "@zhushanwen/subagent-core";

const SRC_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const DIST_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

// 模块说明符提取：覆盖静态 import / export from / require() / 动态 import()。
// 说明符必须是引号包裹的字面量（变量形态 require(x) 无法静态判定，逐行扫不到属
// 已知边界——SDK 侧出现动态说明符本身就是待审查信号，由 review 兜底）。
const SPECIFIER_PATTERNS = [
  /\bimport\s+[^'";]*from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bexport\s+[^'";]*from\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function listFiles(rootDir, extensions) {
  const out = [];
  if (!existsSync(rootDir)) return out;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (extensions.has(extname(entry))) {
        out.push(full);
      }
    }
  };
  walk(rootDir);
  return out;
}

/** 提取一个文件内全部模块说明符及其行号。 */
function extractSpecifiers(filePath, source) {
  const found = [];
  const lines = source.split("\n");
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(source)) !== null) {
      const before = source.slice(0, m.index);
      const lineNo = before.split("\n").length;
      const lineText = lines[lineNo - 1] ?? "";
      found.push({ specifier: m[1], lineNo, lineText: lineText.trim() });
    }
  }
  return found;
}

function checkFile(filePath, opts) {
  const violations = [];
  const source = readFileSync(filePath, "utf8");
  for (const { specifier, lineNo, lineText } of extractSpecifiers(filePath, source)) {
    // 规则 1：core 包名（含子路径/深引用形态）
    if (specifier === CORE_PACKAGE_NAME || specifier.startsWith(`${CORE_PACKAGE_NAME}/`)) {
      violations.push({
        file: filePath,
        lineNo,
        lineText,
        specifier,
        reason: `SDK imports core package "${CORE_PACKAGE_NAME}" (invariant: SDK must not import core)`,
      });
      continue;
    }
    // 规则 2：相对说明符解析后逃出 SDK 包根（含指向 packages/subagent-core 的穿越形态）
    if (specifier.startsWith(".")) {
      const resolvedAbs = resolve(dirname(filePath), specifier);
      const relToSdk = relative(SDK_DIR, resolvedAbs);
      if (relToSdk.startsWith("..")) {
        violations.push({
          file: filePath,
          lineNo,
          lineText,
          specifier,
          reason: `relative specifier escapes the SDK package root (resolves to ${resolvedAbs})`,
        });
      }
    }
    void opts;
  }
  return violations;
}

function main() {
  if (!existsSync(SDK_DIR)) {
    console.error(
      `[check-engine-sdk-boundary] SDK package not found: ${SDK_DIR}\n` +
        `  Recovery: this guard expects packages/subagent-engine-sdk to exist (W1 deliverable). ` +
        `If the package was intentionally removed, remove this guard from the hook chain too.`,
    );
    process.exit(1);
  }

  const violations = [];
  for (const f of listFiles(join(SDK_DIR, "src"), SRC_EXTENSIONS)) {
    violations.push(...checkFile(f));
  }
  for (const f of listFiles(join(SDK_DIR, "dist"), DIST_EXTENSIONS)) {
    violations.push(...checkFile(f));
  }

  if (violations.length > 0) {
    console.error(
      `[check-engine-sdk-boundary] ${violations.length} violation(s): SDK must not import core ` +
        `(invariant 1, docs/architecture/subagent-engine-protocolization.md §3.10)`,
    );
    for (const v of violations) {
      console.error(`  ${relative(REPO_ROOT, v.file)}:${v.lineNo}: ${v.specifier}`);
      console.error(`    ${v.lineText}`);
      console.error(`    reason: ${v.reason}`);
    }
    console.error(
      `  Recovery: engine-side primitives and contract types live inside the SDK ` +
        `(packages/subagent-engine-sdk/src) as structurally-equivalent copies; ` +
        `core-side references belong to core (see impl-plan §2.1 type-closure table). ` +
        `If a shared implementation is needed, move it INTO the SDK and have core re-export it ` +
        `(core → SDK is the legal direction).`,
    );
    process.exit(1);
  }

  const scanned = listFiles(join(SDK_DIR, "src"), SRC_EXTENSIONS).length +
    listFiles(join(SDK_DIR, "dist"), DIST_EXTENSIONS).length;
  console.log(`[check-engine-sdk-boundary] OK (${scanned} files scanned, 0 violations)`);
}

main();
