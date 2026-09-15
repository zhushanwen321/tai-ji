#!/usr/bin/env node
// check-engine-package-boundary.mjs
//
// 引擎包边界守卫（W9 交付，impl-plan §2.9 新守卫 / 设计 §3.7「SSOT 与守卫」）。
// 与 .githooks/check-engine-sdk-boundary.mjs（W1，SDK 不得 import core）同精神、
// 扫描面扩展到引擎 CLI 包，另加 DoD#2 的 exports/barrel 断言。
//
// 规则（扫描对象 = packages/subagent-engine-* + packages/pi-subagent-cli +
// packages/zcode-subagent-cli；引擎包是 CLI/npm 库，落位 packages/，不进
// extensions/ 的扩展守卫体系——check-extension-dependencies 的 EXT_DIR 只扫
// extensions/，覆盖不到这里）：
//   1. 依赖边界：package.json 的 dependencies/peerDependencies/optionalDependencies
//      不得含 @zhushanwen/subagent-core（引擎经 engine-protocol v1 + SDK 与 core
//      解耦，链接依赖 = 边界破坏）；
//   2. 导入边界：src/bin 源码不得 import/require core 包名（含子路径），相对说明符
//      解析后不得逃出包根（路径穿越形态同样拦下）；
//   3. DoD#2：exports 不得有 ./engines/ 子入口；barrel（index/main 入口）不得从
//      core engines/ 路径重导出。
//
// 挂载：.githooks/install-hooks.sh pre-commit 链 + .github/workflows/ci.yml
// invariants job + build.yml build job（W9 登记落点，见 impl-plan §2.9）。
//
// 运行：node scripts/check-engine-package-boundary.mjs（违规 exit 1 + 逐条
// 文件:行号 + 恢复指引）。

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const CORE_PACKAGE_NAME = "@zhushanwen/subagent-core";

const SRC_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".cjs", ".mjs"]);

/** 扫描目标：显式两个引擎 CLI 包名 + subagent-engine-* 前缀（W1-W7 全部引擎侧包）。 */
const EXPLICIT_ENGINE_PACKAGES = new Set(["pi-subagent-cli", "zcode-subagent-cli"]);

function listEnginePackageDirs() {
  const out = [];
  if (!existsSync(PACKAGES_DIR)) return out;
  for (const entry of readdirSync(PACKAGES_DIR)) {
    if (!statSync(join(PACKAGES_DIR, entry)).isDirectory()) continue;
    if (entry.startsWith("subagent-engine-") || EXPLICIT_ENGINE_PACKAGES.has(entry)) {
      if (existsSync(join(PACKAGES_DIR, entry, "package.json"))) out.push(entry);
    }
  }
  return out;
}

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
      if (st.isDirectory()) walk(full);
      else if (extensions.has(extname(entry))) out.push(full);
    }
  };
  walk(rootDir);
  return out;
}

function extractSpecifiers(source) {
  const found = [];
  const lines = source.split("\n");
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(source)) !== null) {
      const lineNo = source.slice(0, m.index).split("\n").length;
      found.push({ specifier: m[1], lineNo, lineText: (lines[lineNo - 1] ?? "").trim() });
    }
  }
  return found;
}

function rel(p) {
  return relative(REPO_ROOT, p);
}

/** 规则 1：依赖声明（dependencies/peerDependencies/optionalDependencies）不得含 core。 */
function checkPackageDependencies(pkg, pkgPath, violations) {
  for (const depType of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[depType] ?? {};
    if (typeof deps[CORE_PACKAGE_NAME] === "string") {
      violations.push({
        where: `${rel(pkgPath)} (${depType})`,
        detail: CORE_PACKAGE_NAME,
        reason: `engine package declares a dependency on core — engines decouple via engine-protocol v1 + @zhushanwen/subagent-engine-sdk`,
      });
    }
  }
}

/** 规则 3a（DoD#2）：exports 不得有 ./engines/ 子入口。 */
function checkPackageExports(pkg, pkgPath, violations) {
  const exportsKeys = pkg.exports !== undefined && typeof pkg.exports === "object"
    ? Object.keys(pkg.exports)
    : [];
  for (const key of exportsKeys) {
    if (key === "./engines" || key.startsWith("./engines/")) {
      violations.push({
        where: `${rel(pkgPath)} (exports)`,
        detail: key,
        reason: `DoD#2: engine packages must not expose ./engines/ subpath exports`,
      });
    }
  }
}

/** 单源文件导入检查：规则 2（core import / 相对说明符逃出包根）+ 规则 3b（DoD#2 barrel 无 core engines/ 重导出）。 */
function checkSourceFile(filePath, pkgDir, violations) {
  const source = readFileSync(filePath, "utf8");
  for (const { specifier, lineNo } of extractSpecifiers(source)) {
    if (specifier === CORE_PACKAGE_NAME || specifier.startsWith(`${CORE_PACKAGE_NAME}/`)) {
      violations.push({
        where: `${rel(filePath)}:${lineNo}`,
        detail: specifier,
        reason: `engine package imports core (invariant: engines speak engine-protocol, core internals are not linkable)`,
      });
      continue;
    }
    if (specifier.startsWith(".")) {
      const resolvedAbs = resolve(dirname(filePath), specifier);
      if (relative(pkgDir, resolvedAbs).startsWith("..")) {
        violations.push({
          where: `${rel(filePath)}:${lineNo}`,
          detail: specifier,
          reason: `relative specifier escapes the engine package root (resolves to ${resolvedAbs})`,
        });
      }
    }
    if (/engines\/(pi|zcode)\//.test(specifier)) {
      violations.push({
        where: `${rel(filePath)}:${lineNo}`,
        detail: specifier,
        reason: `DoD#2: engine package barrel must not re-export core engine implementations`,
      });
    }
  }
}

/** 规则 2 + 3b 的 src/bin 源码扫描面。 */
function checkPackageSources(pkgDir, violations) {
  for (const sub of ["src", "bin"]) {
    for (const f of listFiles(join(pkgDir, sub), SRC_EXTENSIONS)) {
      checkSourceFile(f, pkgDir, violations);
    }
  }
}

/** 单引擎包全规则检查（violations 按规则 1 → 3a → 2/3b 顺序追加，保持逐条输出顺序稳定）。 */
function checkPackage(dirName, violations) {
  const pkgDir = join(PACKAGES_DIR, dirName);
  const pkgPath = join(pkgDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  checkPackageDependencies(pkg, pkgPath, violations);
  checkPackageExports(pkg, pkgPath, violations);
  checkPackageSources(pkgDir, violations);
}

/** 违规报告（逐条 文件:行号 + 原因 + 恢复指引）。 */
function reportViolations(violations, pkgDirs) {
  console.error(
    `[check-engine-package-boundary] ${violations.length} violation(s) in ${pkgDirs.length} engine package(s):`,
  );
  for (const v of violations) {
    console.error(`  ${v.where}: ${v.detail}`);
    console.error(`    reason: ${v.reason}`);
  }
  console.error(
    `  Recovery: engine packages depend only on @zhushanwen/subagent-engine-sdk; ` +
      `shared logic belongs in the SDK (core -> SDK is the legal direction, never the reverse). ` +
      `See docs/architecture/subagent-engine-protocolization.md §3.7 / impl-plan §2.9.`,
  );
}

function main() {
  const pkgDirs = listEnginePackageDirs();
  if (pkgDirs.length === 0) {
    console.error(
      `[check-engine-package-boundary] no engine packages found under packages/ ` +
        `(expected subagent-engine-* + pi/zcode-subagent-cli — W1/W5/W7 deliverables)`,
    );
    process.exit(1);
  }

  const violations = [];
  for (const dirName of pkgDirs) {
    checkPackage(dirName, violations);
  }

  if (violations.length > 0) {
    reportViolations(violations, pkgDirs);
    process.exit(1);
  }

  console.log(
    `[check-engine-package-boundary] OK (${pkgDirs.length} engine packages scanned: ${pkgDirs.join(", ")})`,
  );
}

main();
