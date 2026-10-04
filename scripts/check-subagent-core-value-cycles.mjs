#!/usr/bin/env node
/**
 * check-subagent-core-value-cycles.mjs —— subagent-core 包内**值依赖环**守卫（§2.3 配套）。
 *
 * 背景：packages/subagent-core 内部按领域分家（execution 记录/执行域 vs orchestration
 * 编排域），依赖方向应为单向向下。历史上两域互指（workflow 服务住在 execution/service、
 * 跨域共享词汇没有中立住所），文件级图上形成环时没有任何检查覆盖——既有三个相关守卫
 * 分别管「闭包不含 pi SDK」「六聚合 vs 壳」「record 写入口单一」，都不看包内方向。
 *
 * 判据（先只查值边）：静态 import/export-from、动态 import()、require() 构成的**值**
 * 依赖图上不得存在环（含自环）。`import type` / 全 `type` 修饰的具名导入 / `export type
 * from` 是编译期擦除边，不参与判定（环里只剩它们时运行期无环，属可接受形态）；这类
 * 类型环单独统计并打印为提示，不红。
 *
 * 用法：node scripts/check-subagent-core-value-cycles.mjs [--json] [--root <dir>]
 * 退出码：0 = 无值环；1 = 存在值环（打印每个 SCC 的成员与内部边）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

const ARGS = process.argv.slice(2);
const ROOT_FLAG = ARGS.indexOf("--root");
const ROOT = resolve(process.cwd(), ROOT_FLAG >= 0 ? ARGS[ROOT_FLAG + 1] : "packages/subagent-core/src");
const EXTS = [".ts", ".mts", ".cts"];
const CANDIDATES = [".ts", ".mts", ".cts", "/index.ts", "/index.mts", "/index.cts"];

/** 递归收集源文件（跳过 __tests__ 与声明文件）。 */
function collect(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "__tests__" || name === "node_modules") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collect(full, out);
      continue;
    }
    if (name.endsWith(".d.ts")) continue;
    if (EXTS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)[ \t]*import[ \t]+(type[ \t]+)?([\s\S]*?)[ \t]*from[ \t]*["']([^"']+)["']/g;
const EXPORT_RE = /(?:^|\n)[ \t]*export[ \t]+(type[ \t]+)?([\s\S]*?)[ \t]*from[ \t]*["']([^"']+)["']/g;
const DYNAMIC_RE = /import[ \t]*\([ \t]*["']([^"']+)["'][ \t]*\)/g;
const REQUIRE_RE = /require[ \t]*\([ \t]*["']([^"']+)["'][ \t]*\)/g;

/**
 * 具名说明符是否全为 type（`{ type A, type B }`）——混合（含任一值说明符）即值边。
 * 默认导入 / 命名空间导入（`* as ns`）恒为值边（编译后仍绑定模块对象）。
 */
function allSpecifiersTypeOnly(body) {
  const inner = body.trim();
  if (!inner.startsWith("{")) return false;
  const specifiers = inner.replace(/^\{|\}$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  if (specifiers.length === 0) return false;
  return specifiers.every((s) => /^type[\s{]/.test(s));
}

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of ["", ...CANDIDATES]) {
    const full = candidate === "" ? base : base.endsWith(candidate) ? base : `${base}${candidate}`;
    try {
      const st = statSync(full);
      if (st.isFile() && EXTS.some((e) => full.endsWith(e))) return full;
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  return undefined;
}

function collectEdges(file) {
  const src = readFileSync(file, "utf8");
  const value = [];
  const typeOnly = [];
  const push = (spec, isType) => {
    const target = resolveSpecifier(file, spec);
    if (target === undefined) return;
    (isType ? typeOnly : value).push(target);
  };
  for (const m of src.matchAll(IMPORT_RE)) push(m[3], Boolean(m[1]) || allSpecifiersTypeOnly(m[2]));
  for (const m of src.matchAll(EXPORT_RE)) push(m[3], Boolean(m[1]) || allSpecifiersTypeOnly(m[2]));
  for (const m of src.matchAll(DYNAMIC_RE)) push(m[1], false);
  for (const m of src.matchAll(REQUIRE_RE)) push(m[1], false);
  return { value, typeOnly };
}

/** Tarjan SCC（迭代实现，避免深图爆栈）。 */
function stronglyConnected(nodes, edges) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    const work = [{ node: start, next: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const neighbours = edges.get(frame.node) ?? [];
      if (frame.next < neighbours.length) {
        const child = neighbours[frame.next];
        frame.next += 1;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, next: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(child)));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const members = [];
        for (;;) {
          const node = stack.pop();
          onStack.delete(node);
          members.push(node);
          if (node === frame.node) break;
        }
        sccs.push(members);
      }
    }
  }
  return sccs;
}

function formatCycle(members, edges) {
  const set = new Set(members);
  const lines = members.map((m) => `    ${relative(process.cwd(), m)}`).join("\n");
  const inner = [];
  for (const m of members) {
    for (const t of new Set(edges.get(m) ?? [])) {
      if (set.has(t)) inner.push(`    ${relative(process.cwd(), m)} → ${relative(process.cwd(), t)}`);
    }
  }
  return `${lines}\n  内部边：\n${inner.join("\n")}`;
}

const files = collect(ROOT);
const valueEdges = new Map();
const typeEdges = new Map();
for (const file of files) {
  const { value, typeOnly } = collectEdges(file);
  valueEdges.set(file, value);
  typeEdges.set(file, [...value, ...typeOnly]);
}

/** 自环单列（Tarjan 会把自环节点单独成一个 SCC）。 */
function hasSelfLoop(file, edges) {
  return (edges.get(file) ?? []).includes(file);
}

const valueSccs = stronglyConnected(files, valueEdges).filter(
  (members) => members.length > 1 || hasSelfLoop(members[0], valueEdges),
);
const typeSccs = stronglyConnected(files, typeEdges).filter(
  (members) => members.length > 1 || hasSelfLoop(members[0], typeEdges),
);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({
    files: files.length,
    valueCycles: valueSccs.map((m) => m.map((f) => relative(process.cwd(), f))),
    typeCycles: typeSccs.map((m) => m.map((f) => relative(process.cwd(), f))),
  }, null, 1));
} else {
  console.log(
    `[core-value-cycles] 扫描 ${files.length} 个源文件 · 值环 ${valueSccs.length} 个 · ` +
    `含类型边的环 ${typeSccs.length} 个`,
  );
  for (const members of typeSccs) {
    console.log(`[core-value-cycles][提示] 含类型边的环（不红，编译期擦除）：\n${formatCycle(members, typeEdges)}`);
  }
}

if (valueSccs.length > 0) {
  console.error("[core-value-cycles] 检出值依赖环——包内依赖方向必须单向向下（execution 记录域 ↛ orchestration 编排域的具体值依赖需经端口/装配注入，或把共享词汇下沉到契约层）：");
  for (const members of valueSccs) console.error(formatCycle(members, valueEdges));
  process.exit(1);
}
console.log("[core-value-cycles] OK：包内无值依赖环");
process.exit(0);
