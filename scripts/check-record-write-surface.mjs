#!/usr/bin/env node
// scripts/check-record-write-surface.mjs
//
// [H4 / S4 / D7] record 持久化写面唯一入口守卫（grep 门——文本级兜底；模块边界
// 的一级拦截 = eslint no-restricted-imports，见 eslint.config.mjs subagent-core 块）。
//
// 设计基线：
//   - docs/architecture/subagent-record-persistence-consolidation.md §3.3 D7
//     （record 持久化收敛，写面从 9 处收口为 RecordStore 唯一写入口）
//   - docs/adr/decisions.md ADR-0078（W1 介质归位：journal 唯一事实源 + 主 session
//     每实体注册/终态两条 v2 小条目 + 物化投影；v1 全量快照写点停写，唯一残余 =
//     v1 实体孤儿纠偏兼容层）
//
// 检查项（W1 后口径，R1-R7）：
//   R1 七名真实导出函数直调：writeFinalizedState / writeCancelledState /
//      writeSettledState / writeManifest / saveIndex / writeAliveMarker /
//      removeAliveMarker——不得在 store（record-store.ts）之外出现代码级调用/引用。
//      （D7 谱系 #2：v1 模式 writeStateMarker 是模块私有函数，恒零命中假绿——
//       模式必须用真实导出名；轮 5 补 .alive 写/删两名，堵对 alive 面恒零检查的
//       盲区；U2 补 writeSettledState（轮收口 .state 写面，消费入口 =
//       RecordStore.markSettled），堵对 idle 收条面恒零检查的同型盲区。
//       writeRecordBinding/updateRecordBinding（UF-1 绑定 sidecar）不在 record
//       终态写面收敛范围，不拦——边界登记见 eslint.config.mjs subagent-core 块注释，
//       run-orchestration 的 binding 回填是登记内合法调用面）
//   R2 subagent-record custom entry 直写：append 条目调用（appendEntry /
//      appendSettledEntry 等以 Entry 结尾的写通道名）与 customType 引用
//      （SUBAGENT_RECORD_CUSTOM_TYPE 常量或 "subagent-record" 字面量）在调用窗口
//      内同现，只许 store 家族（record-store.ts 本体 + record-store-rounds.ts 的
//      RecordJournalWriteFace 容器——W1 v2 两条款写面宿主）与常量定义面
//      （record-entry.ts）。appendEntry 是 pi 全局通路，全域禁不可行，按
//      customType 限定到「写」形态（读面失效回调/类型声明不拦）。
//   R3 workflow-record entry 写面白名单（W1 新增；D15/D7 裁决点 7 扩）：append 条目
//      调用 × customType 引用（WORKFLOW_RECORD_CUSTOM_TYPE 常量或 "workflow-record"
//      字面量）只许四写点宿主——lifecycle.ts（收编终态条目补写 hook 面）、壳
//      jsonl-run-store.ts（loadAll 终态条目幂等补写）、terminal-actions.ts（D15
//      终局编排单一入口的注册/终态条目写点）、resume-run.ts（D7/裁决点 7 resume 链
//      注册条目写点）。其余文件（含 extension 域）一律违规。
//   R4 v1 快照投影构造器白名单（W1 新增，subagent-record 族）：toSubagentRecordEntry
//      调用只许 record-entry.ts（定义）与 record-store.ts（v1 实体孤儿纠偏兼容层
//      reportSubagentRecord——ADR-0078 失效清单登记面，W4 sunset 统一退役）。
//      其余文件引用即违规：v1 全量快照（含 eventLog/displayItems 死字节）写点
//      已停写，新写点一律走 v2 条目构造器。
//   R5 workflow-record v1 快照载荷形态拒绝（W1 新增，全域无豁免）：workflow-record
//      写点窗口内出现 v1 快照形态标记（`v: 1` 载荷字面量 / toWorkflowRecordEntryData
//      构造器 / snapshot 直传）即违规——含 R3 白名单宿主自身（四宿主的写点必须
//      全部是 v2 形态，回潮 v1 快照即守卫红）。
//   R6 entry 载荷死字节拒绝（W1 新增，全域无豁免）：append 条目调用窗口内出现
//      `eventLog:` / `displayItems:` 字段写形态即违规（ADR-0078：运行态死字节
//      不进主 session 条目；v1 兼容层的整对象投影不经字段字面量，不误伤）。
//   R7 事件文件直写拒绝（W1 新增）：appendFileSync/appendFile 调用行起 4 行
//      窗口内含 `.events` 路径字面量只许 record-events.ts（record 事件文件唯一
//      写者）与 run-events.ts（run journal 唯一写者）——事件文件的追加必须经
//      两模块的原语入口，禁止在别处构造 .events 路径直接 append（窗口判定与
//      R2-R6 同构，覆盖 prettier 拆行形态）。
//
// 白名单逐域（D7 ③ + ADR-0078 写面清单）：
//   - store 家族：record-store.ts（R1+R2+R4 豁免，唯一写入口本体）+
//     record-store-rounds.ts（R2 豁免——RecordJournalWriteFace 容器，v2 两条款
//     写面 + 事件追加注入位的共享写面基础设施）
//   - 写面载体定义文件：state-marker.ts / alive-store.ts / sessions-index.ts /
//     manifest-store.ts（R1 定义行豁免：函数/类方法定义处，非调用方）
//   - 常量定义：record-entry.ts（R2/R4 豁免）、workflow-record-entry.ts（R3 天然
//     不命中——定义行无 append 调用）
//   - run 族四写点宿主：lifecycle.ts / 壳 jsonl-run-store.ts /
//     terminal-actions.ts（D15）/ resume-run.ts（D7/裁决点 7）
//     （R3 豁免；R5/R6 在宿主内照常拦截）
//   - 事件文件双写者：record-events.ts / run-events.ts（R7 豁免）
//   - notify-ledger 投递账 entry（NOTIFY_LEDGER_CUSTOM_TYPE）、reconcile-sweep
//     注销 entry（发射点⑤）、pending:register/unregister 通道：customType 均非
//     两族字面量，天然不命中 R2/R3——显式列举在此表达逐域保留口径。
//   - extension 自有域：extensions/**/src 纳入扫描（当前零命中）；未来确需直写
//     的自有域须在本脚本 EXTENSION_DOMAIN_ALLOWLIST 登记并注明依据。
//
// 扫描根：packages/*/src + extensions/**/src；tests 豁免（__tests__/ 与 *.test.ts
// 与 .d.ts——测试 mock/替身形态不属于生产写面）。
//
// 退出码：0 通过 / 1 违规（打印 文件:行 + 命中 + 恢复动作）。
// 接线：pre-commit 按路径触发（packages/subagent-core/src、extensions/**/src
// 全域、本脚本 staged 时——阶段 4 修复组 C 扩全，原仅 subagent-workflow 单包）；
// CI invariants 面全量兜底（ci.yml，跨 worktree 等价拦截）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** R1 八名模式：真实导出名（D7 v2，含 .alive 写/删两名——轮 5 补；含 U2 轮收口写面；
 *  manifest-store 的 bound 物化写面 materializeBoundRecordManifest——2026-09-29 补，
 *  此前它不在名单内，record-store-rounds.ts 直接 import 调用可整条绕过本检查）。 */
export const WRITE_FN_RE = /\b(writeFinalizedState|writeCancelledState|writeSettledState|writeManifest|materializeBoundRecordManifest|saveIndex|writeAliveMarker|removeAliveMarker)\s*\(/;

/** R2 subagent-record custom entry 写形态（单行双序，字面量形态——窗口判定的
 *  快路径导出，行为回归锚定见 scripts/__tests__/check-record-write-surface.test.mjs）。
 *  appendEntry 是 pi 全局通路，全域禁不可行——按 customType 限定到「写」形态；
 *  读面（失效回调 / 事件类型联合 / 常量定义）不拦，如 runtime event-interpreter
 *  的 onRecordEntriesInvalidated 判别参数与 core barrel 的 SUBAGENT_RECORD_CUSTOM_TYPE。 */
export const RECORD_ENTRY_WRITE_RE = /\bappendEntry\b[^\n]*["'`]subagent-record["'`]|["'`]subagent-record["'`][^\n]*\bappendEntry\b/;

/** append 条目调用锚（R2/R3/R5/R6 共用）：以 Entry 结尾的 append 写通道名——
 *  覆盖 appendEntry / appendSettledEntry（lifecycle 收编 hook 面）等，结构性排除
 *  appendFileSync/appendFile 文件系族（R7 另行判定）。中间段（[A-Z]\w*）可选：
 *  appendEntry 本身无中间段（可选段缺席直配字面 Entry），appendSettledEntry
 *  经中间段 "Settled" 接字面 "Entry"。 */
export const APPEND_ENTRY_CALL_RE = /\bappend(?:[A-Z]\w*)?Entry\b/;

/** subagent-record customType 引用（常量或字面量双形态，W1 加宽——store 内写点
 *  用常量名，纯字面量正则会漏）。 */
export const SUBAGENT_RECORD_TYPE_RE = /\bSUBAGENT_RECORD_CUSTOM_TYPE\b|["'`]subagent-record["'`]/;

/** workflow-record customType 引用（常量或字面量双形态）。 */
export const WORKFLOW_RECORD_TYPE_RE = /\bWORKFLOW_RECORD_CUSTOM_TYPE\b|["'`]workflow-record["'`]/;

/** R4 v1 快照投影构造器（subagent-record 族）——调用形态（带括号），barrel 的
 *  re-export 行（无括号）天然不命中。 */
export const V1_SNAPSHOT_PROJECTOR_RE = /\btoSubagentRecordEntry\s*\(/;

/** R5 workflow-record v1 快照载荷形态标记：v1 版本字面量 / v1 构造器名（W1 已删，
 *  回潮即红）/ snapshot 直传。 */
export const WF_V1_PAYLOAD_RE = /\bv:\s*1\b|\btoWorkflowRecordEntryData\s*\(|\bsnapshot\b/;

/** R6 entry 载荷死字节字段写形态（eventLog/displayItems——ADR-0078 停写面）。 */
export const ENTRY_DEAD_BYTES_RE = /\beventLog\s*:|\bdisplayItems\s*:/;

/** R7 事件文件直写形态（两段窗口判定）：调用行锚 = appendFile(Sync) 调用；
 *  路径形态 = 窗口内 `.events` 路径字面量（引号起始到 .events 的串）。两段
 *  拆开单行组合正则，覆盖 prettier 拆行形态（appendFileSync( / join(dir,
 *  id + ".events") / …）——与 R2-R6 的 APPEND_WINDOW_LINES 窗口同构。 */
export const APPEND_FILE_CALL_RE = /\bappendFile(?:Sync)?\s*\(/;
export const EVENTS_PATH_LITERAL_RE = /["'`][^"'`\n]*\.events/;

/** append 条目调用窗口（行数）：调用行 + 后 3 行——覆盖 prettier 拆行形态
 *  （appendEntry( / customType / payload / ) 四行）。 */
const APPEND_WINDOW_LINES = 4;

/** 调用行起的判定窗口构造：APPEND_WINDOW_LINES 行内剔除注释行（起点 idx 0 =
 *  调用行，主循环已过滤非注释；后续注释行剔除——R5/R6/R7 触发词在注释行
 *  提及不构成违规，违规行号仍报调用行）。R2-R6 与 R7 共用。 */
function callWindow(lines, i) {
  return lines
    .slice(i, i + APPEND_WINDOW_LINES)
    .filter((l, idx) => idx === 0 || !isCommentLine(l))
    .join("\n");
}

/** store 本体（R1+R2+R4 豁免）——唯一写入口本体，含全部合法调用与注释提及。 */
const STORE_FILE = "packages/subagent-core/src/execution/persistence/record-store.ts";

/** store 家族补充：RecordJournalWriteFace 容器（R2 豁免——v2 两条款写面宿主，
 *  W1 写面接线层，见 record-store-rounds.ts 头注释）。 */
const JOURNAL_FACE_FILE = "packages/subagent-core/src/execution/persistence/record-store-rounds.ts";

/** R4 白名单：v1 快照投影构造器定义 + v1 兼容层纠偏写点（reportSubagentRecord，
 *  ADR-0078 失效清单登记面）。 */
const V1_PROJECTOR_ALLOWED_FILES = new Set([
  "packages/subagent-core/src/execution/persistence/record-entry.ts",
  STORE_FILE,
]);

/** 写面载体定义文件（R1 白名单：定义处非调用方）。 */
const WRITER_DEFINITION_FILES = new Set([
  "packages/subagent-core/src/execution/persistence/state-marker.ts",
  "packages/subagent-core/src/execution/persistence/alive-store.ts",
  "packages/subagent-core/src/execution/persistence/sessions-index.ts",
  "packages/subagent-core/src/execution/persistence/manifest-store.ts",
]);

/** R2 白名单：subagent-record 常量定义（非写点）。 */
const ENTRY_DEFINITION_FILES = new Set([
  "packages/subagent-core/src/execution/persistence/record-entry.ts",
]);

/** R3 白名单：workflow-record 四写点宿主（D15 注册/终态 + 收编补写 + 壳 fallback + D7/裁决点 7 resume）。 */
const WF_ENTRY_HOST_FILES = new Set([
  "packages/subagent-core/src/orchestration/lifecycle.ts",
  "extensions/universal/subagent-workflow/src/jsonl-run-store.ts",
  "packages/subagent-core/src/orchestration/terminal-actions.ts",
  "packages/subagent-core/src/orchestration/resume-run.ts",
]);

/** R7 白名单：事件文件追加入口（record 事件文件 + run journal 的唯一写面，经
 *  shared/jsonl-event-journal.ts 基座落地——§3.1.3 后 append/scan 单源，两域只提供策略）。 */
const EVENTS_WRITER_FILES = new Set([
  "packages/subagent-core/src/execution/persistence/record-events.ts",
  "packages/subagent-core/src/orchestration/run-events.ts",
  "packages/subagent-core/src/shared/jsonl-event-journal.ts",
]);

/** extension 自有域白名单（R1+R2；相对仓根路径）。当前零命中，新增须注明依据。 */
const EXTENSION_DOMAIN_ALLOWLIST = new Set([]);

/** 收集 .ts 文件（递归，排除 __tests__/ *.test.ts *.d.ts node_modules dist）。 */
export function collectTsFiles(dir, out = []) {
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
export function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

// ── 扫描根收集 ───────────────────────────────────────────────────────────────

/** 扫描根收集（CLI 默认 roots = packages 各包 src + extensions 两级分组 src，
 *  与改造前逐行同构；roots 收集细节见 collectScanRoots）。 */
function collectScanRoots() {
  const roots = [];
  const packagesDir = join(PROJECT_ROOT, "packages");
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const src = join(packagesDir, entry.name, "src");
    if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) roots.push(src);
  }
  const extensionsDir = join(PROJECT_ROOT, "extensions");
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    // extensions 两级分组（taiji/universal/<pkg>/src）+ 分组直挂 src，逐级探测
    const pkgSrc = join(extensionsDir, entry.name, "src");
    if (statSync(pkgSrc, { throwIfNoEntry: false })?.isDirectory()) roots.push(pkgSrc);
    for (const group of readdirSync(join(extensionsDir, entry.name), { withFileTypes: true })) {
      if (!group.isDirectory() || group.name === "src" || group.name === "node_modules") continue;
      const nested = join(extensionsDir, entry.name, group.name, "src");
      if (statSync(nested, { throwIfNoEntry: false })?.isDirectory()) roots.push(nested);
    }
  }
  return roots;
}

/**
 * 扫描判定核心（MF-7 测试加载面）：对给定扫描根逐文件跑 R1-R7 规则，
 * 返回违规文本数组（空 = 通过）。roots 注入后可对 tmpdir fixture 判定，
 * 不依赖真实仓库状态。
 *
 * 窗口规则（R2/R3/R5/R6/R7）：调用行起取 4 行窗口并剔除窗口内注释行
 * （触发词在注释行提及不构成违规），customType 引用、载荷形态标记与
 * `.events` 路径字面量在窗口内组合判定——覆盖单行与 prettier 拆行两种
 * 调用形态。
 */
export function scanRecordWriteSurface(roots) {
  const files = roots.flatMap((root) => collectTsFiles(root));
  const violations = [];

  for (const file of files) {
    const rel = relative(PROJECT_ROOT, file);
    const flags = {
      isStore: rel === STORE_FILE,
      isJournalFace: rel === JOURNAL_FACE_FILE,
      isExtAllowed: EXTENSION_DOMAIN_ALLOWLIST.has(rel),
    };
    const lines = readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      scanWriteLineRules(rel, i, line, lines, flags, violations);
    }
  }
  return violations;
}

/**
 * [scanRecordWriteSurface 拆分] 单行规则扫描（R1/R7/R4 单行判定 + 窗口类规则转
 * scanWindowRules；规则原文见 scanRecordWriteSurface 头注释）。flags = 文件级豁免面。
 */
function scanWriteLineRules(rel, i, line, lines, flags, violations) {
  // R1：写函数调用。载体定义文件的「定义行」豁免（export function X( / async X(），
  // 其余文件一律红。
  const fnHit = WRITE_FN_RE.exec(line);
  if (fnHit) {
    const name = fnHit[1];
    const isDefinition =
      WRITER_DEFINITION_FILES.has(rel) &&
      new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?${name}\\s*\\(`).test(line);
    if (!flags.isStore && !flags.isExtAllowed && !isDefinition) {
      violations.push(
        `${rel}:${i + 1} [R1] record 写面函数直调 \`${name}(...)\` 出现在 store 外——` +
          `record 持久化写面的唯一入口是 RecordStore 意图原语（markFinalized/markCancelled/` +
          `markSettled/markBatchFinalized/markIdleArchived/acquireWriteLease 等）。` +
          `Recovery: 改调 store 意图原语（写面知识归 store 内部，D7/G1）。`,
      );
    }
    return;
  }
  // R7：事件文件直写（appendFile 族 × `.events` 路径字面量，双写者外违规）。
  // 调用行起 4 行窗口内找 `.events` 字面量——覆盖 prettier 拆行形态
  // （appendFileSync( / join(dir, id + ".events") / …），与 R2-R6 窗口同构。
  if (APPEND_FILE_CALL_RE.test(line) && !EVENTS_WRITER_FILES.has(rel)) {
    if (EVENTS_PATH_LITERAL_RE.test(callWindow(lines, i))) {
      violations.push(
        `${rel}:${i + 1} [R7] 事件文件直写（appendFile×\`.events\`）出现在唯一写者外——` +
          `追加原语单源在 shared/jsonl-event-journal.ts（seq 分配权与头行契约单点），` +
          `两域策略分别在 run-events.ts / record-events.ts（createRunEventJournal / ` +
          `createRecordEventJournal，ADR-0078）。Recovery: 改经两个创建入口。`,
      );
      return;
    }
  }
  // R4：v1 快照投影构造器调用（白名单外违规——W1 停写面，兼容层除外）。
  if (V1_SNAPSHOT_PROJECTOR_RE.test(line) && !V1_PROJECTOR_ALLOWED_FILES.has(rel)) {
    violations.push(
      `${rel}:${i + 1} [R4] v1 全量快照投影构造器 toSubagentRecordEntry 出现在登记面外——` +
        `v1 快照 entry 已停写（ADR-0078），白名单仅 record-entry.ts（定义）与` +
        `record-store.ts（v1 实体孤儿纠偏兼容层，W4 sunset 退役）。` +
        `Recovery: 新写点改走 v2 条目构造器（toRegisteredEntryData / toSettledEntryData /` +
        `buildAdoptedSettledEntry）；读侧兼容投影经 record-entry.ts 单源扩展。`,
    );
    return;
  }
  // 窗口类规则（R2/R3/R5/R6）：append 条目调用行起 4 行窗口（注释行剔除）。
  if (!APPEND_ENTRY_CALL_RE.test(line)) return;
  scanWindowRules(rel, i, callWindow(lines, i), flags, violations);
}

/**
 * [scanRecordWriteSurface 拆分] 窗口类规则（R2/R3/R5/R6）：调用行起 4 行窗口内
 * customType 引用与载荷形态组合判定（窗口构造见 callWindow）。
 */
function scanWindowRules(rel, i, window, flags, violations) {
  const hasSubagentType = SUBAGENT_RECORD_TYPE_RE.test(window);
  const hasWorkflowType = WORKFLOW_RECORD_TYPE_RE.test(window);
  if (!hasSubagentType && !hasWorkflowType) return;
  // R2：subagent-record entry 直写（store 家族 + 常量定义面外违规）。
  if (
    hasSubagentType &&
    !flags.isStore &&
    !flags.isJournalFace &&
    !flags.isExtAllowed &&
    !ENTRY_DEFINITION_FILES.has(rel)
  ) {
    violations.push(
      `${rel}:${i + 1} [R2] customType "subagent-record" 的 entry 直写出现在 store 家族外——` +
        `record 主记录 entry 的写面归 RecordStore（register/archive/收编内置）与` +
        `RecordJournalWriteFace 容器（v2 两条款写面）。Recovery: 改调 store 公开原语或` +
        `reportSubagentRecord（appendEntry 是 pi 全局通路，record 域 customType 限定唯一，D7 ②）。`,
    );
  }
  // R3：workflow-record entry 写面白名单（四写点宿主外违规）。
  if (hasWorkflowType && !WF_ENTRY_HOST_FILES.has(rel)) {
    violations.push(
      `${rel}:${i + 1} [R3] customType "workflow-record" 的 entry 写出现在四写点宿主外——` +
        `run 族条目写面只许 lifecycle.ts（收编终态条目补写）、壳 jsonl-run-store.ts` +
        `（loadAll 幂等补写）、terminal-actions.ts（D15 终局编排注册/终态条目）与` +
        `resume-run.ts（D7/裁决点 7 resume 链注册条目）。` +
        `Recovery: 经 core run 写链（terminal-actions 终局编排 / 收编入口）落条目，勿在消费侧直写（ADR-0078）。`,
    );
  }
  // R5：workflow-record v1 快照载荷形态（全域拒绝，含四宿主自身）。
  if (hasWorkflowType && WF_V1_PAYLOAD_RE.test(window)) {
    violations.push(
      `${rel}:${i + 1} [R5] workflow-record 写点携带 v1 快照载荷形态（v:1 / snapshot 直传）——` +
        `v1 全量快照 entry 已停写（ADR-0078）：主 session 每实体只写注册 + 终态两条 v2` +
        `小条目（buildWorkflowRecordRegisteredEntryData / buildWorkflowRecordSettledEntryData）。` +
        `Recovery: 运行态数据落 run journal（run-events.ts），条目面改 v2 构造器。`,
    );
  }
  // R6：entry 载荷死字节（全域拒绝）。
  if (ENTRY_DEAD_BYTES_RE.test(window)) {
    violations.push(
      `${rel}:${i + 1} [R6] entry 载荷携带 eventLog/displayItems 字段写形态——` +
        `两字段是端到端死字节（读侧全部置空或不进 runtime 契约），W1 起禁入主 session` +
        `条目（ADR-0078）。Recovery: 详情数据留在子 session 文件与事件流，条目面只写` +
        `身份/终局/摘要字段。`,
    );
  }
}

function main() {
  const roots = collectScanRoots(); // 单次遍历复用（文件计数与违规扫描同一 roots，I-1）
  const files = roots.flatMap((root) => collectTsFiles(root));
  const violations = scanRecordWriteSurface(roots);
  if (violations.length > 0) {
    console.error(`[record-write-surface] FAIL：${violations.length} 处写面违规命中`);
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error("");
    console.error("  权威源：docs/architecture/subagent-record-persistence-consolidation.md §3.3 D7");
    console.error("          docs/adr/decisions.md ADR-0078（W1 介质归位写面清单）");
    console.error("  一级拦截（模块边界）：eslint no-restricted-imports（subagent-core 块）");
    return 1;
  }
  console.log(
    `[record-write-surface] OK：${files.length} 个源文件（packages/*/src + extensions/**/src，tests 豁免）` +
      ` 写面守卫零命中（R1 八名函数 + R2 subagent-record + R3 workflow-record 白名单 +` +
      ` R4 v1 投影器 + R5 v1 快照载荷 + R6 死字节 + R7 .events 直写，ADR-0078）`,
  );
  return 0;
}

// main()：CLI 直跑才执行（vitest import 纯函数导出时不触发扫描/exit，check-publish-surface 先例）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exit(main());
