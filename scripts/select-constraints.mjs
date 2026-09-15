#!/usr/bin/env node
/**
 * select-constraints.mjs — CR 约束动态加载调度器（消费 docs/constraints.json SSOT）
 *
 * 按改动文件范围选择命中的架构约束，产出 review 可消费的清单：
 *   - scope 含 "global" 的条目每次必载（核心不变量）
 *   - 其余按路径前缀命中（<prefix>/** → startsWith("<prefix>/")；精确路径全等）
 *
 * 用法：
 *   node scripts/select-constraints.mjs --base main            # 按 git diff main...HEAD 的变更文件选择
 *   node scripts/select-constraints.mjs --staged               # 按 staged（git diff --cached）文件选择
 *   node scripts/select-constraints.mjs --files a.ts,b.ts      # 显式文件列表
 *   node scripts/select-constraints.mjs --base main --dimension data-governance   # 只输出该 review 维度的子集
 *   node scripts/select-constraints.mjs --base main --check    # 死链校验模式：authority 文件必须存在，
 *                                                               # 末行输出 "constraints-check PASS|FAIL"（cw e2e-sh 标记行兼容）
 *
 * 输出：
 *   - 落盘 .review/constraints.md（review agent 按「存在时必须消费」约定读取）
 *   - stdout 同步打印摘要 + 命中清单（供主 agent 直接贴进 subagent task prompt）
 *
 * 退出码：0 成功（--check 模式下死链 = 2）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const JSON_PATH = join(REPO_ROOT, "docs/constraints.json");
const OUT_PATH = join(REPO_ROOT, ".review/constraints.md");

// ---------- 参数 ----------

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const base = argValue("--base");
const staged = args.includes("--staged");
const filesArg = argValue("--files");
const dimension = argValue("--dimension");
const checkMode = args.includes("--check");

if (![base, staged, filesArg].some(Boolean)) {
  // 无输入源时默认 base main（与 pr-cr-fix 主流程一致）
  args.push("--base", "main");
}

// ---------- 变更文件 ----------

function changedFiles() {
  if (filesArg) return filesArg.split(",").map((s) => s.trim()).filter(Boolean);
  if (staged) return execSync("git diff --cached --name-only --diff-filter=ACMR", { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean);
  const ref = base || "main";
  return execSync(`git diff --name-only --diff-filter=ACMR ${ref}...HEAD`, { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean);
}

// ---------- 匹配 ----------

function scopeMatches(scopeList, file) {
  return scopeList.some((s) => {
    if (s === "global") return true;
    if (s.endsWith("/**")) return file.startsWith(s.slice(0, -3) + "/") || file === s.slice(0, -3);
    return s === file;
  });
}

// ---------- main ----------

const data = JSON.parse(readFileSync(JSON_PATH, "utf-8"));
const files = changedFiles();
const uniqueFiles = [...new Set(files)];

const hit = data.constraints.filter((c) => {
  if (dimension && !(c.dimensions || []).includes(dimension)) return false;
  return uniqueFiles.some((f) => scopeMatches(c.scope, f));
});

// --check：命中约束的 authority 死链校验（登记失效 = FAIL）
let checkFailures = [];
if (checkMode) {
  for (const c of hit) {
    for (const a of c.authority) {
      const path = a.split("#")[0];
      if (!path) continue;
      const abs = path.startsWith("../") ? join(REPO_ROOT, path.slice(3)) : join(REPO_ROOT, "docs", path);
      if (!existsSync(abs)) checkFailures.push(`${c.id}: authority 死链 ${a}`);
    }
  }
}

// ---------- 渲染 ----------

const lines = [];
lines.push(`# CR 命中约束清单（select-constraints）`);
lines.push("");
lines.push(`- 变更范围：\`${base ? `git diff ${base}...HEAD` : staged ? "staged" : filesArg ? "显式文件列表" : ""}\`，共 ${uniqueFiles.length} 个文件`);
lines.push(`- 命中约束：${hit.length} / ${data.constraints.length} 条${dimension ? `（dimension=${dimension} 过滤）` : ""}`);
lines.push(`- 消费约定：review 时逐条核对；需要完整表述时 Read「权威源」指向的文档原文（summary 仅导航）。`);
lines.push(`- enforcement 为 review 的条目是本维度重点；machine 的条目已由 pre-commit 拦截（作背景知识，无需人工复核形态）。`);
lines.push("");
lines.push("| ID | 约束（摘要） | 权威源 | 执行 |");
lines.push("|---|---|---|---|");
for (const c of hit) {
  const esc = (s) => s.replaceAll("|", "\\|");
  const auth = c.authority.map((a) => (a.startsWith("../") ? a.slice(3) : `docs/${a.split("#")[0]}`)).join(" · ");
  const enf = c.enforcement.map((e) => (e.type === "machine" ? `hook:${e.hook}` : e.type === "review" ? `review:${e.agent}` : "—")).join(" + ");
  lines.push(`| ${c.id} | ${esc(c.summary)} | ${esc(auth)} | ${esc(enf)} |`);
}

const content = lines.join("\n") + "\n";
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, content);

console.log(content);
console.log(`[select-constraints] 已写入 ${OUT_PATH}（命中 ${hit.length}/${data.constraints.length} 条，变更文件 ${uniqueFiles.length} 个）`);

if (checkMode) {
  if (checkFailures.length > 0) {
    console.error("[select-constraints] authority 死链：");
    for (const f of checkFailures) console.error(`  - ${f}`);
    console.log("constraints-check FAIL");
    process.exit(2);
  }
  console.log("constraints-check PASS");
}
