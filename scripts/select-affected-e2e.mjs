#!/usr/bin/env node
/**
 * select-affected-e2e.mjs — e2e 感知调度器（消费 docs/testing/e2e-map.json SSOT）
 *
 * 「改了哪个域 → 跑哪些 e2e」的机器对账入口：
 *   - scope 含于 diff 的 on-diff rule + 全部 always rule = 受影响面
 *   - --release 输出 on-release / on-pi-bump 面（发布与 pi 升级必跑清单）
 *   - --check 门禁：diff 文件落在 watched root 下却不被任何 rule 覆盖 → exit 1（防漏登记）
 *
 * glob 匹配与 scripts/select-constraints.mjs 同款零依赖语义（<prefix>/** → startsWith，
 * 精确路径 → 全等），不引 minimatch——两调度器保持一套匹配语义。
 *
 * 用法：
 *   node scripts/select-affected-e2e.mjs                  # diff = origin/main...HEAD（默认）
 *   node scripts/select-affected-e2e.mjs --base main      # 显式 base ref（diff = <ref>...HEAD）
 *   node scripts/select-affected-e2e.mjs --release        # trigger ∈ {on-release, on-pi-bump}
 *   node scripts/select-affected-e2e.mjs --layer L3       # 叠加层过滤（可与 --base/--release 同用）
 *   node scripts/select-affected-e2e.mjs --check          # 门禁模式：未登记的 watched 文件 → exit 1
 *
 * 退出码：0 成功 / 1 --check 检出未登记文件 / 2 环境错误（map 缺失、git ref 无效）
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const JSON_PATH = join(REPO_ROOT, "docs/testing/e2e-map.json");

const RELEASE_TRIGGERS = ["on-release", "on-pi-bump"];
const LAYERS = ["L1", "L2", "L2.5", "L3"];

// ---------- 纯函数（scripts/__tests__/select-affected-e2e.test.mjs 消费） ----------

/** scope glob 匹配：prefix/** → startsWith(prefix/) 或全等 prefix；精确路径 → 全等。 */
export function scopeCovers(scopeList, file) {
  return scopeList.some((s) => {
    if (s.endsWith("/**")) return file.startsWith(s.slice(0, -3) + "/") || file === s.slice(0, -3);
    return s === file;
  });
}

/** coverage：scope 匹配 ∪ asset ref 精等（asset 是自身触发面的一部分）。 */
export function ruleCovers(rule, file) {
  return scopeCovers(rule.scope, file) || rule.assets.some((a) => a.ref === file);
}

/**
 * watched roots：scope 的 <prefix>/ 目录 ∪ 资产族目录。
 * 「本表声称看护的目录」——这些目录下的新文件必须被某 rule 覆盖，否则 --check 红。
 * 资产侧只在同一目录聚合 ≥2 个 asset 时才产生目录级看护根（资产族之家：新同目录
 * 文件必须登记）；孤资产常落在共享目录（scripts/、src/infra/pi/__tests__/ 等通用
 * 位置），不把整目录泛化成看护根——否则所有无关脚本都被逼进 e2e-map 登记。
 */
export function watchedRoots(map) {
  const roots = new Set();
  const assetDirCount = new Map();
  for (const rule of map.rules) {
    for (const s of rule.scope) {
      if (s.endsWith("/**")) roots.add(s.slice(0, -3) + "/");
    }
    for (const a of rule.assets) {
      const slash = a.ref.lastIndexOf("/");
      if (slash === -1) continue;
      const dir = a.ref.slice(0, slash + 1);
      assetDirCount.set(dir, (assetDirCount.get(dir) ?? 0) + 1);
    }
  }
  for (const [dir, count] of assetDirCount) {
    if (count >= 2) roots.add(dir);
  }
  return [...roots].sort();
}

/** --check 核心：watched root 下且无任何 rule coverage 的文件。 */
export function unregisteredWatchedFiles(map, files) {
  const roots = watchedRoots(map);
  return files.filter((f) => roots.some((r) => f.startsWith(r)) && !map.rules.some((rule) => ruleCovers(rule, f)));
}

/** diff 选择：scope 命中的 on-diff rule + 全部 always rule；on-release/on-pi-bump 不参与（--release 通道）；--layer 叠加过滤。 */
export function selectRules(map, files, { layer } = {}) {
  const byLayer = (rule) => !layer || rule.layer === layer;
  const hit = map.rules.filter(
    (rule) => rule.trigger === "on-diff" && byLayer(rule) && files.some((f) => scopeCovers(rule.scope, f)),
  );
  const always = map.rules.filter((rule) => rule.trigger === "always" && byLayer(rule));
  return [...always, ...hit];
}

/** --release 选择：trigger ∈ {on-release, on-pi-bump}；--layer 叠加过滤。 */
export function releaseRules(map, { layer } = {}) {
  return map.rules.filter((rule) => RELEASE_TRIGGERS.includes(rule.trigger) && (!layer || rule.layer === layer));
}

// ---------- main ----------

function loadMap() {
  try {
    return JSON.parse(readFileSync(JSON_PATH, "utf-8"));
  } catch (err) {
    console.error(`[select-affected-e2e] e2e-map.json 读取/解析失败：${JSON_PATH}`);
    console.error(`  原因：${err instanceof Error ? err.message : String(err)}`);
    console.error("  恢复动作：确认 docs/testing/e2e-map.json 存在且 JSON 合法（node scripts/validate-e2e-map.mjs 可诊断）");
    process.exit(2);
  }
}

function changedFiles(base) {
  try {
    return execSync(`git diff --name-only ${base}...HEAD`, { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    console.error(`[select-affected-e2e] git diff ${base}...HEAD 失败：base ref 不存在或仓库状态异常`);
    console.error(`  恢复动作：git fetch origin main 后重试，或显式指定存在的 ref：node scripts/select-affected-e2e.mjs --base <ref>`);
    process.exit(2);
  }
}

function renderRules(rules, map) {
  const lines = [];
  lines.push(`| ID | 层 | 触发 | 串行 | 摘要 |`);
  lines.push(`|---|---|---|---|---|`);
  for (const r of rules) {
    const esc = (s) => String(s).replaceAll("|", "\\|");
    lines.push(`| ${r.id} | ${r.layer} | ${r.trigger} | ${r.serial ? "是" : "否"} | ${esc(r.summary)} |`);
  }
  lines.push("");
  for (const r of rules) {
    lines.push(`## ${r.id}（${r.layer} / ${r.trigger}${r.serial ? " / 空载串行" : ""}）`);
    lines.push(`- 运行：\`${r.run}\``);
    lines.push(`- assets：${r.assets.map((a) => a.ref).join(", ")}`);
    lines.push(`- 权威：${r.authority}`);
  }
  lines.push("");
  lines.push(`共 ${rules.length} / ${map.rules.length} 条 rule。`);
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  function argValue(name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  }
  const base = argValue("--base") ?? "origin/main";
  const release = args.includes("--release");
  const check = args.includes("--check");
  const layer = argValue("--layer");
  if (layer && !LAYERS.includes(layer)) {
    console.error(`[select-affected-e2e] --layer 非法 "${layer}"（合法值 ${LAYERS.join(" | ")}）`);
    process.exit(2);
  }

  const map = loadMap();
  const files = release ? [] : changedFiles(base);

  if (release) {
    const rules = releaseRules(map, { layer });
    console.log(`# e2e release / pi-bump 面（--release${layer ? ` --layer ${layer}` : ""}）\n`);
    console.log(renderRules(rules, map));
    return;
  }

  const rules = selectRules(map, files, { layer });
  console.log(`# 受影响 e2e 清单（select-affected-e2e）\n`);
  console.log(`- 变更范围：\`git diff ${base}...HEAD\`，共 ${files.length} 个文件${layer ? `（--layer ${layer} 过滤）` : ""}`);
  console.log("");
  console.log(renderRules(rules, map));

  if (check) {
    const unregistered = unregisteredWatchedFiles(map, files);
    if (unregistered.length > 0) {
      console.error("[select-affected-e2e] --check FAIL：以下变更文件落在 e2e-map 看护目录内但无任何 rule 覆盖（防漏登记）：");
      for (const f of unregistered) console.error(`  - ${f}`);
      console.error("  恢复动作：在 docs/testing/e2e-map.json 为该文件新增 rule（E2E-<域>-<序号>），或扩展既有 rule 的 scope/assets 后重跑。");
      console.error("  若该目录不应被看护：先修订造成 watched root 的 scope/asset 登记，再重跑。");
      process.exit(1);
    }
    console.log("e2e-map-check PASS");
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(join(process.argv[1])).href;
if (isMain) main();
