#!/usr/bin/env node
// scripts/check-subagent-service-boundary.mjs
//
// [H3/R5] SubagentService 六聚合（execution/service/）× 壳（execution/subagent-service.ts）
// 三方向依赖边界守卫（设计 docs/design/subagent-service-decomposition.md §3.4 D4/G2，
// impl-plan §2 R5 行；约束「S3 依赖单向由守卫机械检查接管」）。
//
// 检查项：
//   1. 聚合→聚合 import 台账门：聚合间 import（值或 type）默认红，仅放行 ALLOWED_EDGES
//      登记的合法单向边（按「源文件:符号 → 目标文件」符号级精确登记）。有向环 = 红。
//   2. 聚合→壳 import 门：execution/service/ 下聚合文件 import ../subagent-service.ts
//      即红——deps 晚绑定闭包形态下聚合读壳（assertReady 等）是注入函数非 import
//      （D4），该方向应天然零命中。
//   3. 壳→聚合：允许（装配点），不检查。
//   4. 跨聚合私有访问门（grep 级文本对照）：聚合 deps 接口中返回兄弟聚合实例的
//      getter（`readonly getFoo: () => XxxAggregate` 形态）被映射后，正文
//      `this.deps.getFoo().method(...)` 的 method 不在目标聚合 class 导出面
//      （非 private 成员）即红。防「聚合经 deps 拿兄弟实例调其内部」的未来回退；
//      现状协作全部是窄函数接口注入（resolveIdentity / finalizeRecord 等），
//      该通道应天然零命中。
//      [阶段3 P3-4 覆盖面登记] 本检查可机械覆盖子集 = 「deps getter 直调」单一
//      文本形态；三条通道不覆盖、显式划归 code review 职责：① getter 返回类型
//      接口化（结构兼容接口名 ≠ 聚合 class 名 → 不入 getter 映射）；② 实例缓存
//      局部变量后调用；③ 聚合实例经方法/构造参数流入（import 门只封文件内静态
//      符号获得，不封运行时实例流动）。不建议扩正则追局部变量（文本守卫性价比拐点）。
//   5. [H3/R6] 支撑文件方向门（service-bootstrap.ts / service-constants.ts）：
//      - 支撑→聚合：允许（提供 type/常量/工厂；入环检测图）
//      - 聚合→支撑：service-constants.ts 允许（import 常量）；service-bootstrap.ts
//        仅 type-only 允许（聚合不消费装配工厂）
//      - 支撑→壳：默认红（防反向依赖，D4 同理），仅 SUPPORT_SHELL_EDGES 登记的
//        SubagentService 值边放行（createSubagentService 构造依赖，设计 v4）
//      - 壳→支撑：允许（装配），不检查
//
// [HISTORICAL] 2026-09-12 建立时现状三条合法边（D-R3-2 / D-R4-8 登记）；R6 已兑现
// 预告——①号边（ENV_SELF_RECORD_ID）随常量归位 service-constants.ts 从台账删除：
//   ② run-orchestration.ts → record-access.ts  : ResolvedIdentity（type-only 单向）
//   ③ workflow-dispatch.ts → record-access.ts  : ResolvedIdentity（type-only 单向）
//
// [阶段3 P3-3 已知盲区登记] 静态 `import/export … from` 之外的模块引用通道不检测：
//   动态 `import()` / `require()` / `createRequire` / 指向包 barrel（../../index.ts）
//   的相对 import（经 barrel 中转取兄弟聚合值可绕方向门）/ tsconfig paths。存量
//   实测（2026-09-12 阶段3 审查）：service/ 目录内上述形态零命中，无现实违规；
//   新增使用前须先扩本守卫或在此登记豁免理由。tsconfig paths/vitest alias 无现实
//   通道（subagent-core tsconfig 无 paths、vitest.config 无 alias）。
//
// 退出码：0 通过 / 2 违规。文本级守卫（正则解析，无 AST 依赖），对存量结构零误报。

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTION_DIR = join(PROJECT_ROOT, "packages", "subagent-core", "src", "execution");
const SERVICE_DIR = join(EXECUTION_DIR, "service");

/** 聚合间合法单向边台账（符号级）。key = `${srcFile}|${symbol}`，value = 目标文件名。
 *  新增边须在此登记并注明依据（设计决策/偏差编号），未登记即红。 */
const ALLOWED_EDGES = new Map([
  // ② D-R4-8：ResolvedIdentity type-only 单向
  ["run-orchestration.ts|ResolvedIdentity", "record-access.ts"],
  // ③ D-R4-8：ResolvedIdentity type-only 单向
  ["workflow-dispatch.ts|ResolvedIdentity", "record-access.ts"],
]);

/** [H3/R6] SERVICE_DIR 下的支撑文件（非聚合）：类型声明 / 常量叶子 / 装配工厂的
 *  宿主。与聚合适用不同方向规则（检查 5）；聚合间台账门不覆盖支撑文件。 */
const SUPPORT_FILES = new Set(["service-bootstrap.ts", "service-constants.ts"]);

/** 支撑文件→壳的合法值边台账（符号级）：唯一登记 = service-bootstrap 的
 *  createSubagentService 构造依赖（设计 v4 明文「bootstrap 必须 new SubagentService」；
 *  壳对 bootstrap 零 re-export，防壳↔bootstrap 值环）。 */
const SUPPORT_SHELL_EDGES = new Map([
  ["service-bootstrap.ts|SubagentService", "subagent-service.ts"],
]);

/** 允许出现聚合实例 getter 的 deps 返回类型对照所需：聚合 class 名集合由
 *  壳文件 import 块动态提取（壳装配点 import { X } from "./service/x.ts"）。 */

// ── 解析工具 ───────────────────────────────────────────────────────────────

/** 解析单个 import / re-export 语句 → { symbols: [{ name, typeOnly }], target }；
 *  非该类行返回 null。覆盖形态：`import { A, type B } from "..."` /
 *  `import type { A } from "..."` / `import { default as X } from "..."` /
 *  `import * as ns from "..."` / `export { A } from "..."`（[阶段3 P3-3] re-export
 *  通道与 import 同构——聚合互相转发值符号时按值符号入各方向门）。 */
function parseImport(line) {
  const m = line.match(/^\s*(?:import|export)\s+(type\s+)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+|\*(?!\s+as)|[\w$]+)\s*from\s*['"]([^'"]+)['"]/);
  if (!m) return null;
  const blockTypeOnly = Boolean(m[1]);
  const named = m[2];
  const symbols = [];
  if (named !== undefined) {
    for (const piece of named.split(",")) {
      const token = piece.trim();
      if (!token) continue;
      const typeOnly = blockTypeOnly || token.startsWith("type ");
      const ident = token.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (ident) symbols.push({ name: ident, typeOnly });
    }
  } else {
    // `import X from` / `import * as ns from`：整块视为一个值符号
    symbols.push({ name: "*", typeOnly: blockTypeOnly });
  }
  return { symbols, target: m[3] };
}

/** [R6] 把源码按物理行产出，但将跨行 named import 块合并为单逻辑行——
 *  parseImport 是逐行正则，多行形态 `import {\n  A,\n  B,\n} from "..."` 若不合并
 *  会整块漏检（方向门盲区；R6 常量归一的多行 import 首次暴露，R5 存量壳装配
 *  import 同为多行）。[阶段3 R2-1] 合并条件同时覆盖 import/export 开头（多行
 *  `export {\n A \n} from` 块同漏检面）。仅合并「以 import/export 开头且本行无
 *  from」到「含 from 的行」。 */
function* logicalImportLines(src) {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:import|export)\b/.test(line) && !/from\s*['"]/.test(line)) {
      let merged = line;
      let j = i;
      while (j + 1 < lines.length && !/from\s*['"]/.test(merged) && j - i < 50) {
        j++;
        merged += " " + lines[j].trim();
      }
      if (/from\s*['"]/.test(merged)) {
        yield merged;
        i = j;
        continue;
      }
    }
    yield line;
  }
}

/** import 目标解析为 execution/service/ 内的兄弟文件名；否则返回 null。 */
function resolveServiceTarget(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const abs = resolve(dirname(fromFile), spec);
  const relInService = abs.startsWith(SERVICE_DIR) ? abs.slice(SERVICE_DIR.length + 1) : null;
  if (relInService && relInService.endsWith(".ts")) return relInService;
  return null;
}

/** import 目标解析是否指向壳文件。 */
function isShellTarget(fromFile, spec) {
  if (!spec.startsWith(".")) return false;
  return resolve(dirname(fromFile), spec) === join(EXECUTION_DIR, "subagent-service.ts");
}

/** 从壳文件提取聚合 class 名集合（`import { X, ... } from "./service/xxx.ts"`）。 */
function extractAggregateClassNames() {
  const shellPath = join(EXECUTION_DIR, "subagent-service.ts");
  const names = new Set();
  for (const line of logicalImportLines(readFileSync(shellPath, "utf-8"))) {
    const parsed = parseImport(line);
    if (!parsed || !parsed.target.startsWith("./service/")) continue;
    for (const sym of parsed.symbols) {
      if (sym.name !== "*" && !sym.typeOnly) names.add(sym.name);
    }
  }
  return names;
}

/** 提取聚合 class 的导出面（非 private 成员名集合：方法/getter/字段）。
 *  范围限定 export class 大括号体内（brace 平衡截断），避免 interface 成员与
 *  模块级对象字面量属性混入导出面造成漏报。 */
function extractPublicSurface(source) {
  const classStart = source.search(/export\s+class\s+(\w+)/);
  if (classStart === -1) return null;
  const className = source.slice(classStart).match(/export\s+class\s+(\w+)/)[1];
  const openBrace = source.indexOf("{", classStart);
  if (openBrace === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = end === -1 ? source.slice(openBrace) : source.slice(openBrace, end);
  const surface = new Set();
  const memberRe = /^  (?!private\s)(?:public\s+|readonly\s+|static\s+|override\s+|async\s+|get\s+|set\s+|[*#\s]*)([\w$]+)\s*[(:=<]/gm;
  let m;
  while ((m = memberRe.exec(body)) !== null) {
    if (m[1] !== "constructor") surface.add(m[1]);
  }
  return { className, surface };
}

/** 提取文件内 deps 接口中返回聚合实例的 getter 映射：getterName → 聚合 class 名。
 *  形态：`readonly getFoo: () => XxxAggregate;` / `() => Promise<XxxAggregate>`。 */
function extractAggregateGetters(source, aggregateClassNames) {
  const getters = new Map();
  const re = /readonly\s+(get\w+)\s*:\s*\(\s*\)\s*=>\s*(?:Promise<)?(\w+)>?\s*;/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (aggregateClassNames.has(m[2])) getters.set(m[1], m[2]);
  }
  return getters;
}

// ── 主检查 ─────────────────────────────────────────────────────────────────

function main() {
  const allServiceFiles = readdirSync(SERVICE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();
  // [H3/R6] 支撑文件与聚合分治：支撑文件走检查 5 方向规则，不进聚合间台账门。
  const aggregateFiles = allServiceFiles.filter((f) => !SUPPORT_FILES.has(f));
  const supportFiles = allServiceFiles.filter((f) => SUPPORT_FILES.has(f));
  const aggregateClassNames = extractAggregateClassNames();
  const allSources = new Map(allServiceFiles.map((f) => [f, readFileSync(join(SERVICE_DIR, f), "utf-8")]));
  const sources = new Map(aggregateFiles.map((f) => [f, allSources.get(f)]));

  const violations = [];
  const edges = new Map(); // 聚合/支撑文件间有向边（含白名单），供环检测

  // ── 检查 1 + 2：聚合 import 方向门 ──
  for (const file of aggregateFiles) {
    const src = sources.get(file);
    for (const line of logicalImportLines(src)) {
      if (line.trim().startsWith("//")) continue;
      const parsed = parseImport(line);
      if (!parsed) continue;

      // 检查 2：聚合 → 壳（一律禁，type 也不许——壳符号面只许壳自己 re-export）
      if (isShellTarget(join(SERVICE_DIR, file), parsed.target)) {
        const syms = parsed.symbols.map((s) => (s.name === "*" ? "(default/namespace)" : s.name)).join(", ");
        violations.push(
          `[聚合→壳] ${file} import subagent-service.ts（${syms}）——聚合读壳能力必须经 deps 注入（D4），禁止 import`,
        );
        continue;
      }

      // 检查 1：聚合 → 聚合（台账门）/ 聚合 → 支撑（检查 5 前半）
      const sibling = resolveServiceTarget(join(SERVICE_DIR, file), parsed.target);
      if (!sibling) continue;
      if (!edges.has(file)) edges.set(file, new Set());
      edges.get(file).add(sibling);
      if (SUPPORT_FILES.has(sibling)) {
        // 聚合→支撑：常量叶子允许值 import；bootstrap（类型+装配工厂）仅 type-only
        if (sibling === "service-bootstrap.ts") {
          for (const sym of parsed.symbols) {
            if (sym.typeOnly) continue;
            violations.push(
              `[聚合→支撑·值] ${file} 值 import service-bootstrap.ts 的 ${sym.name === "*" ? "(default/namespace)" : sym.name}——` +
                `聚合只许消费其 type 声明（SubagentQueries 等），装配工厂（单例访问器族）归壳/barrel 消费面`,
            );
          }
        }
        continue; // service-constants.ts（常量叶子）：允许，不入聚合间台账门
      }
      for (const sym of parsed.symbols) {
        const symName = sym.name === "*" ? "(default/namespace)" : sym.name;
        const key = `${file}|${sym.name}`;
        const allowed = ALLOWED_EDGES.get(key);
        if (allowed === sibling) continue; // 台账内合法边
        const kind = sym.typeOnly ? "type-only" : "值";
        violations.push(
          `[聚合→聚合·未登记] ${file} import ${sibling} 的 ${symName}（${kind} import）——` +
            `聚合间协作须走壳 deps 注入或显式接口；确需新边先在 ${"scripts/check-subagent-service-boundary.mjs"} 的 ALLOWED_EDGES 登记并注明依据`,
        );
      }
    }
  }

  // ── 检查 5：支撑文件方向门（支撑→壳台账门 + 支撑→聚合允许入图）──
  for (const file of supportFiles) {
    const src = allSources.get(file);
    for (const line of logicalImportLines(src)) {
      if (line.trim().startsWith("//")) continue;
      const parsed = parseImport(line);
      if (!parsed) continue;

      // 支撑 → 壳：默认红（防反向依赖，D4 同理），仅 SUPPORT_SHELL_EDGES 放行
      if (isShellTarget(join(SERVICE_DIR, file), parsed.target)) {
        for (const sym of parsed.symbols) {
          const symName = sym.name === "*" ? "(default/namespace)" : sym.name;
          const key = `${file}|${sym.name}`;
          if (SUPPORT_SHELL_EDGES.get(key) === "subagent-service.ts") continue;
          violations.push(
            `[支撑→壳·未登记] ${file} import subagent-service.ts 的 ${symName}——` +
              `支撑文件→壳仅 SUPPORT_SHELL_EDGES 登记边放行（现状唯一 = service-bootstrap 的 SubagentService 构造依赖）；` +
              `其余能力经 deps 注入（D4）`,
          );
        }
        continue;
      }

      // 支撑 → 聚合/支撑：允许（提供 type/常量/工厂），入环检测图
      const sibling = resolveServiceTarget(join(SERVICE_DIR, file), parsed.target);
      if (sibling) {
        if (!edges.has(file)) edges.set(file, new Set());
        edges.get(file).add(sibling);
      }
    }
  }

  // ── 环检测（三色 DFS；白名单边与支撑↔聚合边均入图——反向出现即成环被捕获）──
  {
    const color = new Map([...edges.keys()].map((k) => [k, 0]));
    const cycles = [];
    const dfs = (n, path) => {
      color.set(n, 1);
      for (const nb of edges.get(n) ?? []) {
        if ((color.get(nb) ?? 0) === 1) cycles.push([...path, n, nb].join(" -> "));
        else if ((color.get(nb) ?? 0) === 0) dfs(nb, [...path, n]);
      }
      color.set(n, 2);
    };
    for (const n of edges.keys()) if (color.get(n) === 0) dfs(n, []);
    for (const c of cycles) violations.push(`[聚合/支撑间环] ${c}`);
  }

  // ── 检查 4：跨聚合私有访问门（deps getter → 兄弟聚合实例 → 非 public 成员调用）──
  {
    const surfaces = new Map(); // 聚合 class 名 → public 面
    for (const file of aggregateFiles) {
      const extracted = extractPublicSurface(sources.get(file));
      if (extracted) surfaces.set(extracted.className, extracted.surface);
    }
    for (const file of aggregateFiles) {
      const src = sources.get(file);
      const getters = extractAggregateGetters(src, aggregateClassNames);
      if (getters.size === 0) continue;
      // 正文调用形态：this.deps.getFoo().method( （跨行/链式前缀容忍）
      const callRe = /this\.deps\.(get\w+)\(\)\s*\.\s*([\w$]+)\s*\(/g;
      let m;
      while ((m = callRe.exec(src)) !== null) {
        const targetClass = getters.get(m[1]);
        if (!targetClass) continue;
        const method = m[2];
        const surface = surfaces.get(targetClass);
        if (surface && !surface.has(method)) {
          violations.push(
            `[跨聚合私有访问] ${file}: this.deps.${m[1]}().${method}(…) —— ${method} 不在 ${targetClass} 的导出面（public 成员）上` +
              `；聚合间协作走显式接口（窄函数注入），禁止穿透实例调内部`,
          );
        }
      }
    }
  }

  // ── 汇报 ──
  if (violations.length > 0) {
    console.error("[ERROR] subagent-service 聚合边界检查未通过（H3/R5 三方向守卫）：");
    for (const v of violations) console.error("  - " + v);
    console.error("\n[INFO] 合法边台账与规则见 scripts/check-subagent-service-boundary.mjs 头部注释；");
    console.error("      聚合读壳能力（assertReady 等）经 deps 注入函数，不是 import（设计 D4）。");
    console.error("\x1b[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\x1b[0m");
    return 2;
  }
  const edgeCount = [...edges.values()].reduce((acc, s) => acc + s.size, 0);
  console.log(
    `[OK] subagent-service 聚合边界检查通过（${aggregateFiles.length} 聚合文件 + ${supportFiles.length} 支撑文件，` +
      `聚合/支撑间 ${edgeCount} 条边单向无环，聚合→壳与支撑→壳（登记边外）import 零命中，跨聚合私有访问零命中）`,
  );
  return 0;
}

process.exit(main());
