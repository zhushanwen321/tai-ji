#!/usr/bin/env node
// scripts/check-record-write-surface.mjs
//
// [H4 / S4 / D7] record 持久化写面唯一入口守卫（grep 门——文本级兜底；模块边界
// 的一级拦截 = eslint no-restricted-imports，见 eslint.config.mjs subagent-core 块）。
//
// 设计基线：docs/design/subagent-record-persistence-consolidation.md §3.3 D7
//（record 持久化收敛，写面从 9 处收口为 RecordStore 唯一写入口）。
//
// 检查项（对齐 D7 v2 口径）：
//   R1 六名真实导出函数直调：writeFinalizedState / writeCancelledState /
//      writeManifest / saveIndex / writeAliveMarker / removeAliveMarker——
//      不得在 store（record-store.ts）之外出现代码级调用/引用。
//      （D7 谱系 #2：v1 模式 writeStateMarker 是模块私有函数，恒零命中假绿——
//       模式必须用真实导出名；轮 5 补 .alive 写/删两名，堵对 alive 面恒零检查的盲区）
//   R2 subagent-record custom entry 直写：appendEntry 调用携带 customType
//      `"subagent-record"` 只许 store 内部（record-store.ts）；常量定义面
//      （record-entry.ts）豁免。appendEntry 是 pi 全局通路，全域禁不可行，按
//      customType 限定到「写」形态（读面失效回调/类型声明不拦）。
//
// 白名单逐域（D7 ③）：
//   - store 内部：packages/subagent-core/src/execution/record-store.ts（唯一写入口本体）
//   - 写面载体定义文件：state-marker.ts / alive-store.ts / sessions-index.ts /
//     manifest-store.ts（函数/类方法定义处，非调用方）
//   - 常量定义：record-entry.ts（SUBAGENT_RECORD_CUSTOM_TYPE）
//   - notify-ledger 投递账 entry（NOTIFY_LEDGER_CUSTOM_TYPE）、reconcile-sweep
//     注销 entry（发射点⑤）、pending:register/unregister 通道：customType 均非
//     "subagent-record" 字面量，天然不命中 R2——显式列举在此表达 D7 逐域保留口径。
//   - extension 自有域：extensions/**/src 纳入扫描（当前零命中）；未来确需直写
//     的自有域须在本脚本 EXTENSION_DOMAIN_ALLOWLIST 登记并注明依据。
//
// 扫描根：packages/*/src + extensions/**/src；tests 豁免（__tests__/ 与 *.test.ts
// 与 .d.ts——测试 mock/替身形态不属于生产写面）。
//
// 退出码：0 通过 / 1 违规（打印 文件:行 + 厽中 + 恢复动作）。
// 接线：pre-commit 按路径触发（packages/subagent-core/src、extensions/**/src
// 全域、本脚本 staged 时——阶段 4 修复组 C 扩全，原仅 subagent-workflow 单包）；
// CI invariants 面全量兜底（ci.yml，跨 worktree 等价拦截）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** R1 六名模式：真实导出名（D7 v2，含 .alive 写/删两名——轮 5 补）。 */
const WRITE_FN_RE = /\b(writeFinalizedState|writeCancelledState|writeManifest|saveIndex|writeAliveMarker|removeAliveMarker)\s*\(/;

/** R2 subagent-record custom entry 写形态：同一行 appendEntry + customType 字面量
 *  （appendEntry 是 pi 全局通路，全域禁不可行——按 customType 限定到「写」形态；
 *  读面（失效回调 / 事件类型联合 / 常量定义）不拦，如 runtime event-interpreter
 *  的 onRecordEntriesInvalidated 判别参数与 shared SUBAGENT_RECORD_CUSTOM_TYPE）。 */
const RECORD_ENTRY_WRITE_RE = /\bappendEntry\b[^\n]*["'`]subagent-record["'`]|["'`]subagent-record["'`][^\n]*\bappendEntry\b/;

/** store 内部（R1+R2 白名单）——唯一写入口本体，含全部合法调用与注释提及。 */
const STORE_FILE = "packages/subagent-core/src/execution/record-store.ts";

/** 写面载体定义文件（R1 白名单：定义处非调用方）。 */
const WRITER_DEFINITION_FILES = new Set([
  "packages/subagent-core/src/execution/state-marker.ts",
  "packages/subagent-core/src/execution/alive-store.ts",
  "packages/subagent-core/src/execution/sessions-index.ts",
  "packages/subagent-core/src/execution/manifest-store.ts",
]);

/** R2 白名单：subagent-record 常量定义（非写点）。 */
const ENTRY_DEFINITION_FILES = new Set([
  "packages/subagent-core/src/execution/record-entry.ts",
]);

/** extension 自有域白名单（R1+R2；相对仓根路径）。当前零命中，新增须注明依据。 */
const EXTENSION_DOMAIN_ALLOWLIST = new Set([]);

/** 收集 .ts 文件（递归，排除 __tests__/ *.test.ts *.d.ts node_modules dist）。 */
function collectTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "__tests__" || entry === "test" || entry === "node_modules" || entry === "dist") continue;
      collectTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 非注释行判定（strip 后以 // 、* 、/* 开头视为注释——同 check-unsafe-stream-writes 先例）。 */
function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

// ── 扫描根收集 ───────────────────────────────────────────────────────────────

const scanRoots = [];
const packagesDir = join(PROJECT_ROOT, "packages");
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "node_modules") continue;
  const src = join(packagesDir, entry.name, "src");
  if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) scanRoots.push(src);
}
const extensionsDir = join(PROJECT_ROOT, "extensions");
for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "node_modules") continue;
  // extensions 两级分组（taiji/universal/<pkg>/src）+ 分组直挂 src，逐级探测
  const pkgSrc = join(extensionsDir, entry.name, "src");
  if (statSync(pkgSrc, { throwIfNoEntry: false })?.isDirectory()) scanRoots.push(pkgSrc);
  for (const group of readdirSync(join(extensionsDir, entry.name), { withFileTypes: true })) {
    if (!group.isDirectory() || group.name === "src" || group.name === "node_modules") continue;
    const nested = join(extensionsDir, entry.name, group.name, "src");
    if (statSync(nested, { throwIfNoEntry: false })?.isDirectory()) scanRoots.push(nested);
  }
}

const files = scanRoots.flatMap((root) => collectTsFiles(root));
const violations = [];

for (const file of files) {
  const rel = relative(PROJECT_ROOT, file);
  const isStore = rel === STORE_FILE;
  const isWriterDef = WRITER_DEFINITION_FILES.has(rel);
  const isEntryDef = ENTRY_DEFINITION_FILES.has(rel);
  const isExtAllowed = EXTENSION_DOMAIN_ALLOWLIST.has(rel);
  if (isStore || isExtAllowed) continue; // store 内部 / extension 登记域：全豁免
  const lines = readFileSync(file, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    // R1：写函数调用。载体定义文件的「定义行」豁免（export function X( / async X(），
    // 其余文件一律红。
    const fnHit = WRITE_FN_RE.exec(line);
    if (fnHit) {
      const name = fnHit[1];
      const isDefinition = isWriterDef && new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?${name}\\s*\\(`).test(line);
      if (!isDefinition) {
        violations.push(
          `${rel}:${i + 1} [R1] record 写面函数直调 \`${name}(...)\` 出现在 store 外——` +
            `record 持久化写面的唯一入口是 RecordStore 意图原语（markFinalized/markCancelled/` +
            `markBatchFinalized/markIdleArchived/acquireWriteLease 等）。` +
            `Recovery: 改调 store 意图原语（写面知识归 store 内部，D7/G1）。`,
        );
      }
      continue;
    }
    // R2：subagent-record custom entry 直写（appendEntry + customType 同行写形态）。
    if (RECORD_ENTRY_WRITE_RE.test(line) && !isEntryDef) {
      violations.push(
        `${rel}:${i + 1} [R2] customType "subagent-record" 的 entry 直写出现在 store 外——` +
          `record 主记录 entry 的写面归 RecordStore（register/archive/reportRecordTransition 内置）。` +
          `Recovery: 改调 store 公开原语或 reportSubagentRecord（appendEntry 是 pi 全局通路，` +
          `record 域 customType 限定唯一，D7 ②）。`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(`[record-write-surface] FAIL：${violations.length} 处 store 外 record 写面命中`);
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error("");
  console.error("  权威源：docs/design/subagent-record-persistence-consolidation.md §3.3 D7");
  console.error("  一级拦截（模块边界）：eslint no-restricted-imports（subagent-core 块）");
  process.exit(1);
}

console.log(
  `[record-write-surface] OK：${files.length} 个源文件（packages/*/src + extensions/**/src，tests 豁免）` +
    ` store 外 record 写面零命中（R1 六名函数 + R2 subagent-record entry，S4）`,
);
