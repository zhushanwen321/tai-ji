#!/usr/bin/env node
/**
 * validate-constraints.mjs — docs/constraints.json（SSOT）结构校验
 *
 * [HISTORICAL] 前身 render-constraints.mjs 还生成 docs/constraints.md 人读视图；
 * 2026-09-13 裁决删除人读视图（json 本身即人读，生成物徒增一份 json/md 同步面），
 * 本脚本收敛为纯结构校验。pre-commit 在 constraints.json 变更时触发。
 *
 * 用法：node scripts/validate-constraints.mjs
 *
 * 校验项（约束登记自身的护栏）：
 *   - id 唯一且格式 C-<topic>-<两位序号>
 *   - scope 非空：["global"] 或路径 glob（<prefix>/** 或精确路径）
 *   - authority 非空且文件存在（剥离 #锚点后按相对 docs/ 解析，../ 前缀相对仓库根）
 *   - enforcement：machine 项 hook 须存在于 .githooks/ / scripts/ / 仓库根（含 "§" 的内联段特例跳过）；
 *     review 项 agent 须存在于 .agents/skills/pr-cr-fix/agents/<agent>.md
 *
 * 退出码：0 成功 / 2 校验失败
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DOCS_DIR = join(REPO_ROOT, "docs");
const JSON_PATH = join(DOCS_DIR, "constraints.json");

const errors = [];
function fail(msg) {
  errors.push(msg);
}

// ---------- 结构校验 ----------

function validateHookExists(hook) {
  if (hook.includes("§")) return true; // install-hooks.sh §2c 类内联段，无独立脚本
  return (
    existsSync(join(REPO_ROOT, ".githooks", hook)) ||
    existsSync(join(REPO_ROOT, "scripts", hook)) ||
    existsSync(join(REPO_ROOT, hook))
  );
}

function validateAuthorityPath(ref) {
  const path = ref.split("#")[0];
  if (!path) return true; // 纯锚点不查
  const abs = path.startsWith("../") ? join(REPO_ROOT, path.slice(3)) : join(DOCS_DIR, path);
  if (!existsSync(abs)) fail(`authority 文件不存在: ${ref}`);
}

function validateId(c, seenIds, at) {
  const idRe = /^C-(pi|data|comm|state|ext|build|proc|sw)-\d{2}$/;
  if (!c.id || !idRe.test(c.id)) fail(`id 格式非法: ${at}`);
  if (seenIds.has(c.id)) fail(`id 重复: ${c.id}`);
  seenIds.add(c.id);
}

function validateScope(c, at) {
  if (!Array.isArray(c.scope) || c.scope.length === 0) {
    fail(`${at}: scope 为空`);
    return;
  }
  for (const s of c.scope) {
    if (s === "global") continue;
    if (!/^[\w./-]+(\/\*\*)?$/.test(s)) fail(`${at}: scope 非法 glob "${s}"（只支持 <prefix>/** 或精确路径）`);
  }
}

function validateAuthority(c, at) {
  if (!Array.isArray(c.authority) || c.authority.length === 0) {
    fail(`${at}: authority 为空`);
    return;
  }
  for (const a of c.authority) validateAuthorityPath(a);
}

function validateEnforcementItem(e, at) {
  if (e.type === "machine") {
    if (!e.hook) fail(`${at}: machine enforcement 缺 hook`);
    else if (!validateHookExists(e.hook)) fail(`${at}: hook 不存在于 .githooks/ / scripts/ / 根: ${e.hook}`);
  } else if (e.type === "review") {
    if (!e.agent) fail(`${at}: review enforcement 缺 agent`);
    else if (!existsSync(join(REPO_ROOT, ".agents/skills/pr-cr-fix/agents", `${e.agent}.md`)))
      fail(`${at}: review agent 不存在: ${e.agent}`);
  } else if (e.type !== "none") {
    fail(`${at}: enforcement.type 非法: ${e.type}`);
  }
}

function validateEnforcement(c, at) {
  if (!Array.isArray(c.enforcement) || c.enforcement.length === 0) {
    fail(`${at}: enforcement 为空`);
    return;
  }
  for (const e of c.enforcement) validateEnforcementItem(e, at);
}

function validate(data) {
  const constraints = data.constraints;
  if (!Array.isArray(constraints) || constraints.length === 0) fail("constraints 为空数组");

  const seenIds = new Set();
  for (const c of constraints) {
    const at = c.id || "(missing id)";
    validateId(c, seenIds, at);
    validateScope(c, at);
    validateAuthority(c, at);
    validateEnforcement(c, at);
    if (c.dimensions !== undefined && !Array.isArray(c.dimensions)) fail(`${at}: dimensions 须为数组`);
  }
}

// ---------- main ----------

const data = JSON.parse(readFileSync(JSON_PATH, "utf-8"));
validate(data);

if (errors.length > 0) {
  console.error(`[validate-constraints] 结构校验失败（${errors.length} 处）：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(2);
}
console.log(`[validate-constraints] OK：${data.constraints.length} 条约束，结构校验通过`);
