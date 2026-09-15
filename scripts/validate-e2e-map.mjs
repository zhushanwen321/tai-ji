#!/usr/bin/env node
/**
 * validate-e2e-map.mjs — docs/testing/e2e-map.json（SSOT）结构校验
 *
 * e2e-map.json 登记全部 e2e 资产与触发面（消费方 scripts/select-affected-e2e.mjs），
 * 本脚本是登记自身的护栏：结构非法 / 死链 / 幽灵 asset 拦在提交前。
 * pre-commit 在 e2e-map.json / 两脚本 / 其单测变更时触发（install-hooks.sh 段）。
 *
 * 用法：node scripts/validate-e2e-map.mjs
 *
 * 校验项：
 *   - _meta：fields / consumers 非空（schema 自描述完整性）
 *   - id 唯一且格式 E2E-<域>-<两位序号>（域 = 大写字母数字）
 *   - layer / trigger 枚举合法；serial 必须显式 boolean
 *   - scope 非空，每条 glob 可编译（受限文法 <prefix>/** 或精确路径——与
 *     scripts/select-constraints.mjs 同款零依赖匹配语义，minimatch 等价子集）
 *   - assets 非空，kind 枚举合法，ref 磁盘真实存在（强校验，防幽灵资产）
 *   - authority 非空且文件存在（剥离 #锚点后按仓库根解析）
 *
 * 退出码：0 成功 / 2 校验失败（含 JSON 解析失败）
 *
 * 校验函数全部导出（errors 数组参数化——无模块级共享可变状态），
 * main 经 isMain guard 只在直接执行时运行，被测试 import 时不触发 process.exit。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const JSON_PATH = join(REPO_ROOT, "docs/testing/e2e-map.json");

const LAYERS = ["L1", "L2", "L2.5", "L3"];
const TRIGGERS = ["on-diff", "always", "on-release", "on-pi-bump"];
const ASSET_KINDS = ["spec", "script", "probe", "harness"];
// 与 validate-constraints.mjs 的 scope 文法一致：<prefix>/** 前缀通配或精确路径
const SCOPE_GLOB_RE = /^[\w./-]+(\/\*\*)?$/;
const ID_RE = /^E2E-[A-Z0-9]+-\d{2}$/;

// ---------- 结构校验 ----------

export function validateMeta(data, errors) {
  const meta = data?._meta;
  if (!meta || typeof meta !== "object") {
    errors.push("_meta 缺失（fields 语义说明 + consumers 列表是登记表自描述的最低要求）");
    return;
  }
  if (!meta.fields || typeof meta.fields !== "object" || Object.keys(meta.fields).length === 0) {
    errors.push("_meta.fields 为空（每个 rule 字段的语义必须登记）");
  }
  if (!Array.isArray(meta.consumers) || meta.consumers.length === 0) {
    errors.push("_meta.consumers 为空（消费方清单必须登记）");
  }
}

export function validateId(rule, seenIds, at, errors) {
  if (!rule.id || !ID_RE.test(rule.id)) errors.push(`id 格式非法（期望 E2E-<域>-<两位序号>）: ${at}`);
  if (seenIds.has(rule.id)) errors.push(`id 重复: ${rule.id}`);
  seenIds.add(rule.id);
}

export function validateLayer(rule, at, errors) {
  if (!LAYERS.includes(rule.layer)) errors.push(`${at}: layer 非法 "${rule.layer}"（合法值 ${LAYERS.join(" | ")}）`);
}

export function validateTrigger(rule, at, errors) {
  if (!TRIGGERS.includes(rule.trigger)) errors.push(`${at}: trigger 非法 "${rule.trigger}"（合法值 ${TRIGGERS.join(" | ")}）`);
}

export function validateSerial(rule, at, errors) {
  if (typeof rule.serial !== "boolean") errors.push(`${at}: serial 必须显式 boolean`);
}

export function validateScope(rule, at, errors) {
  if (!Array.isArray(rule.scope) || rule.scope.length === 0) {
    errors.push(`${at}: scope 为空`);
    return;
  }
  for (const s of rule.scope) {
    if (typeof s !== "string" || !SCOPE_GLOB_RE.test(s)) {
      errors.push(`${at}: scope 非法 glob "${s}"（只支持 <prefix>/** 或精确路径，字符集 [\\w./-]）`);
    }
  }
}

export function validateAssets(rule, at, errors) {
  if (!Array.isArray(rule.assets) || rule.assets.length === 0) {
    errors.push(`${at}: assets 为空`);
    return;
  }
  for (const a of rule.assets) {
    if (!a || !ASSET_KINDS.includes(a.kind)) {
      errors.push(`${at}: asset kind 非法 "${a?.kind}"（合法值 ${ASSET_KINDS.join(" | ")}）`);
      continue;
    }
    if (!a.ref || typeof a.ref !== "string") {
      errors.push(`${at}: asset ref 缺失（kind=${a.kind}）`);
      continue;
    }
    if (a.ref.includes("#") || a.ref.startsWith("/")) {
      errors.push(`${at}: asset ref 必须是仓库相对路径: ${a.ref}`);
      continue;
    }
    if (!existsSync(join(REPO_ROOT, a.ref))) {
      errors.push(`${at}: asset 磁盘不存在: ${a.ref}`);
    }
  }
}

export function validateAuthority(rule, at, errors) {
  if (!rule.authority || typeof rule.authority !== "string") {
    errors.push(`${at}: authority 缺失（权威文档锚点必填）`);
    return;
  }
  const path = rule.authority.split("#")[0];
  if (!path || !existsSync(join(REPO_ROOT, path))) {
    errors.push(`${at}: authority 文件不存在: ${rule.authority}`);
  }
}

/** 校验整张登记表，返回错误清单（空数组 = 通过）。 */
export function validate(data) {
  const errors = [];
  validateMeta(data, errors);

  const rules = data?.rules;
  if (!Array.isArray(rules) || rules.length === 0) errors.push("rules 为空数组");

  const seenIds = new Set();
  for (const rule of rules ?? []) {
    const at = rule.id || "(missing id)";
    validateId(rule, seenIds, at, errors);
    if (!rule.summary) errors.push(`${at}: summary 缺失`);
    if (!rule.run) errors.push(`${at}: run（可运行命令）缺失`);
    if (!rule.owner) errors.push(`${at}: owner 缺失`);
    validateLayer(rule, at, errors);
    validateTrigger(rule, at, errors);
    validateSerial(rule, at, errors);
    validateScope(rule, at, errors);
    validateAssets(rule, at, errors);
    validateAuthority(rule, at, errors);
    if (rule.note !== undefined && typeof rule.note !== "string") errors.push(`${at}: note 须为字符串`);
  }
  return errors;
}

// ---------- main ----------

function main() {
  let data;
  try {
    data = JSON.parse(readFileSync(JSON_PATH, "utf-8"));
  } catch (err) {
    console.error(`[validate-e2e-map] e2e-map.json 解析失败：${JSON_PATH}`);
    console.error(`  原因：${err instanceof Error ? err.message : String(err)}`);
    console.error("  恢复动作：修复 docs/testing/e2e-map.json 的 JSON 语法后重跑 node scripts/validate-e2e-map.mjs");
    process.exit(2);
  }
  const errors = validate(data);

  if (errors.length > 0) {
    console.error(`[validate-e2e-map] 结构校验失败（${errors.length} 处）：`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error("  恢复动作：按上方明细修正 docs/testing/e2e-map.json 后重跑 node scripts/validate-e2e-map.mjs");
    process.exit(2);
  }
  console.log(`[validate-e2e-map] OK：${data.rules.length} 条 rule，结构校验通过（asset 引用磁盘存在）`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(join(process.argv[1])).href;
if (isMain) main();
