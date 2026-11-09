#!/usr/bin/env node
// check-no-text-assertion.mjs — 断言路径文字匹配防回潮门禁（taiji 侧，同 zsw-skills 仓
// 同名脚本移植——构建门禁配套：dev-merge-gates / pr-lifecycle 两单源的判定路径禁新增
// 字面匹配。由 build-workflows.mjs 在构建与 --check 时调用）
//
// 背景：workflow 引擎的断言已按「结构化断言改造」字段化（判定依据 = agent 产结构化
// 字段或 JSON 文件；自由文本/工具输出上的字面搜索判定全部退役）。本脚本防两类回潮：
//   ① 已退役判定点的字面匹配复活；
//   ② 新增「在 agent 返回文本 / 工具 stdout 上搜证据行并据以判定」的代码。
//
// 形态 = 基线锁定 + 增量门禁：扫描四个业务单源的 `.includes(` / `.test(` / `indexOf(`
// 命中点，与基线快照（scripts/text-assertion-baseline.json）比对——
//   - 命中 ⊆ 基线：通过（基线内的存量命中均已归类为保留区：协议解析 / 格式校验 /
//     路径集合判定 / 枚举合法判定——这些是结构化断言的合法判定原语，见改造分析 §0/§5.3）
//   - 有新增命中：exit 1，要求处置——属保留区的更新基线（node scripts/check-no-text-assertion.mjs --update，
//     并在提交说明写明该命中的归类理由）；属证据扫描的改为结构化判定
//   - 删减不拦（存量自然收敛方向）
//
// 用法：node scripts/check-no-text-assertion.mjs [--update]

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 扫描根解析：优先 cwd（worktree 根——.agents 为全 worktree 共享 symlink，任意 worktree
// 内跑都指向同一实体文件）；cwd 下探测不到 TARGETS 时回退脚本位置上推（.agents/workflows/
// scripts/ → workspace 实体根——测试的临时 HOME/cwd 场景、以及经构建器从任意目录发起时，
// 扫到的都是同一实体 shared.ts，结果一致）。基线与脚本同目录（.agents 实体内）
const scriptDir = dirname(fileURLToPath(import.meta.url));
const TARGETS = [
  ".agents/workflows/src/dev-merge-gates.shared.ts",
  ".agents/workflows/src/pr-lifecycle.shared.ts",
  ".agents/workflows/src/wait-until.shared.ts",
  ".agents/workflows/src/merge.shared.ts",
];
const scanRootCandidates = [
  process.cwd(),
  join(scriptDir, "..", "..", ".."),
];
const scanRoot = scanRootCandidates.find((root) => {
  try {
    readFileSync(join(root, TARGETS[0]), "utf8");
    return true;
  } catch (err) {
    // 探测语义 = 目标文件存在性：只吞 ENOENT / ENOTDIR（目标不存在的预期形态）；
    // 其余异常（权限等真实故障）报错退出，不静默吞成「候选不命中」——裸抛 stack
    // trace 会与门禁基线违规同码（exit 1）且难归因，故打印 ERROR + 恢复动作
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
    console.error(`ERROR: 扫描根探测读文件失败（${join(root, TARGETS[0])}）：${err.message}。恢复：核对该路径权限后重跑本检查`);
    process.exit(1);
  }
}) ?? scanRootCandidates[scanRootCandidates.length - 1];
const BASELINE = join(scriptDir, "text-assertion-baseline.json");
// 覆盖六类字面匹配 API（2026-11-04 审查缺陷 7 修正：只扫三类会漏 .match/.exec/
// startsWith/endsWith 回潮——本次退役的判定点恰有 /词表符号.../.exec 与 startsWith("[process]") 形态）
const API_RE = /\.includes\(|\.test\(|\.indexOf\(|\.match\(|\.exec\(|\.startsWith\(|\.endsWith\(/;

const scanFile = (rel) => {
  const out = [];
  const lines = readFileSync(join(scanRoot, rel), "utf8").split("\n");
  lines.forEach((l, i) => {
    if (API_RE.test(l)) out.push([i + 1, l.trim().slice(0, 160)]);
  });
  return out;
};

const current = {};
for (const rel of TARGETS) current[rel] = scanFile(rel);

// 基线条目第三元 = 归类标签（protocol-parse | format-validation | path-set | enum-check |
// unclassified）：使「该命中为何属保留区」可被 grep 复查——误归类（实为证据扫描却登记为
// 保留区）机器查不出存在性、只能靠标签抽查兜住。--update 沿用旧标签，新命中标 unclassified；
// 校验只按行号+内容匹配，标签不参与，未归类计数随通过信息输出提醒补标
const readOldCategories = () => {
  try {
    const old = JSON.parse(readFileSync(BASELINE, "utf8"));
    const map = new Map();
    for (const rel of TARGETS)
      for (const e of old[rel] ?? []) {
        const cat = e.length >= 3 ? e[2] : "unclassified";
        map.set(`${e[0]}\t${e[1]}`, cat);
      }
    return map;
  } catch {
    return new Map();
  }
};

const update = process.argv.includes("--update");
if (update) {
  const oldCats = readOldCategories();
  const tagged = {};
  let unclassified = 0;
  for (const rel of TARGETS)
    tagged[rel] = current[rel].map(([l, c]) => {
      const cat = oldCats.get(`${l}\t${c}`) ?? "unclassified";
      if (cat === "unclassified") unclassified += 1;
      return [l, c, cat];
    });
  writeFileSync(BASELINE, `${JSON.stringify(tagged, null, 1)}\n`);
  const total = Object.values(tagged).reduce((n, v) => n + v.length, 0);
  console.log(`基线已更新：${total} 处存量命中（新增命中标 unclassified：${unclassified} 处）。归类标签可直接编辑基线第三元修正；新增命中点须在提交说明写明归类理由。`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error(`基线快照不可读（${BASELINE}）——运行 node scripts/check-no-text-assertion.mjs --update 生成后重试`);
  process.exit(1);
}

const keyOf = (line, content) => `${line}\t${content}`;
const additions = [];
const totals = { current: 0, baseline: 0, removed: 0 };
for (const rel of TARGETS) {
  const base = new Map((baseline[rel] ?? []).map(([l, c]) => [keyOf(l, c), false]));
  totals.baseline += base.size;
  for (const [l, c] of current[rel]) {
    totals.current += 1;
    const k = keyOf(l, c);
    if (base.has(k)) base.set(k, true);
    else additions.push(`${rel}:${l}  ${c}`);
  }
  totals.removed += [...base.values()].filter((used) => !used).length;
}

if (additions.length === 0) {
  const unclassified = Object.values(baseline).reduce(
    (n, entries) => n + entries.filter((e) => e.length < 3 || e[2] === "unclassified").length,
    0,
  );
  const tagNote = unclassified > 0 ? `；未归类 ${unclassified} 处（编辑基线第三元补标签，类别：protocol-parse/format-validation/path-set/enum-check）` : "；归类标签齐全";
  console.log(`文字匹配断言防回潮：通过（当前 ${totals.current} 处命中 ⊆ 基线 ${totals.baseline} 处；基线外新增 0；基线已收敛 ${totals.removed} 处${tagNote}）`);
  process.exit(0);
}

console.error(`文字匹配断言防回潮：发现 ${additions.length} 处基线外新增命中——判定路径禁止新增字面匹配（证据扫描形态已全部字段化）。逐条处置：`);
for (const a of additions) console.error(`  - ${a}`);
console.error(`处置：属保留区（协议解析 / 格式校验 / 路径集合判定 / 枚举合法判定）→ node scripts/check-no-text-assertion.mjs --update 更新基线，并在提交说明写明归类理由；属对 agent 返回文本或工具输出的证据搜索 → 改为结构化判定（agent 产枚举/布尔字段，引擎枚举/等值/集合判定），不允许合入。`);
process.exit(1);
