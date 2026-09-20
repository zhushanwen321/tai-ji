#!/usr/bin/env node
/**
 * check-rfl-parity.mjs — review-fix-loop 双实现机器锁步守卫
 *
 * 背景（为什么要这个守卫）：review+fix 循环有两份实现，靠注释里的「双版本镜像维护，
 * 改任一侧须同步另一侧」文字约定维系同步。2026-09-20 的比对证实该约定不可靠：
 *  - 调度去重（claimed 单遍归类）曾在 pi 侧修复而 zcode 侧遗留 → 同一 reviewer 双跑；
 *  - 早退点台账守门只在 pi 侧有 → zcode 可达「converged + remaining 非空」矛盾终态。
 * 两处都不是能力差异，而是「同一不变量只在一侧成立」。本脚本把文字承诺换成机器判定。
 *
 * 校验什么：
 *  1. 结构守卫：两侧必须都导出/定义镜像函数的骨架标记（函数名、池常量、阈值常量）。
 *  2. 行为对账：用同一组输入跑两侧 `planReviewerOrder`，比较 **归一化后的调度结果**
 *     （顺序 + 两批划分 + 成员不重复）。比较按维度名归一（pi 侧 `review-<dim>`、
 *     zcode 侧 `<dim>` → 统一 `<dim>`），因此不夹带命名差异；note 文案差异不参与比较
 *     （降级文案两侧刻意不同，不属语义）。
 *  3. 不变量断言：order 恒为输入的排列（无重复、无遗漏）——去重修复的核心不变量，
 *     两侧独立断言，任一侧退化都会红。
 *
 * 退出码：0 = 一致（或 zcode 侧文件不存在 → SKIP）；1 = 结构缺失或行为分歧。
 * 输出 [FIX] 指引：两侧文件路径 + 需要同步的内容。
 *
 * 用法：
 *   node scripts/check-rfl-parity.mjs                # 默认读 $HOME/.zcode/workflows/
 *   ZCODE_RFL=<path> node scripts/check-rfl-parity.mjs   # 指定 zcode 副本（CI/栈测）
 *   PI_RFL=<path>    node scripts/check-rfl-parity.mjs   # 指定 pi 副本（单测夹具用）
 *   RFL_REQUIRE_ZCODE=1 node scripts/check-rfl-parity.mjs # 文件缺失时改为失败（本地强制）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PI_RFL = process.env.PI_RFL
  || path.join(REPO_ROOT, "packages", "subagent-core", "workflows", "review-fix-loop-utils.cjs");
const ZCODE_RFL = process.env.ZCODE_RFL
  || path.join(os.homedir(), ".zcode", "workflows", "review-fix-loop.dwf.ts");
const REQUIRE_ZCODE = process.env.RFL_REQUIRE_ZCODE === "1";

const failures = [];
const fail = (msg) => failures.push(msg);

function skip(reason) {
  console.log("[rfl-parity] SKIP: " + reason);
  process.exit(0);
}

if (!fs.existsSync(PI_RFL)) {
  fail("pi 侧镜像文件缺失：" + PI_RFL);
}
// pi 侧去重不变量：在 zcode 缺席判定**之前**检查——CI 等无 zcode 环境（守卫会 SKIP 双
// 实现对账）仍需守住 pi 侧这一条，否则本步骤在 CI 退化为空跑（2026-09-20 接线时修正）。
// 不变量：planReviewerOrder 的 order 恒为本次输入的排列（无重复、无遗漏）。
// 语料就地定义（不引用下方的模块级常量）——此处位于 createRequire 之前，不能依赖
// piApi 声明，否则撞 TDZ；用局部 createRequire + 直接 require 就够。
if (failures.length === 0) {
  const { createRequire: mkReq } = await import("node:module");
  const invApi = mkReq(import.meta.url)(PI_RFL);
  const invCorpus = [
    { label: "全 8 维", keys: ["extension-api", "arch-boundary", "data-governance", "business-logic", "monorepo-impact", "electron-build", "type-safety", "test-coverage"] },
    // 去重不变量靶子：单个 name 同时命中多个池关键词（曾致同一 reviewer 双跑）
    { label: "多池关键词同串", keys: ["extension-api-arch-boundary"] },
    { label: "单维", keys: ["extension-api"] },
    { label: "空输入", keys: [] },
  ];
  for (const c of invCorpus) {
    const items = c.keys.map((k) => ({ name: "review-" + k }));
    let res;
    try {
      res = invApi.planReviewerOrder(items, null);
    } catch (e) {
      fail(`pi 侧 planReviewerOrder 抛错（不变量语料「${c.label}」）：${e.message}`);
      continue;
    }
    const got = res.order.map((d) => d.name.replace(/^review-/, "").replace(/\.md$/, ""));
    const expected = [...c.keys];
    if ([...got].sort().join("|") !== [...expected].sort().join("|")) {
      const dup = got.length !== new Set(got).size;
      fail(`pi 侧 order 不是输入的排列（不变量语料「${c.label}」）${dup ? "——存在重复项（去重不变量退化）" : ""}\n`
        + `      期望 ${expected.length} 项：${[...expected].sort().join("|")}\n`
        + `      实际 ${got.length} 项：${[...got].sort().join("|")}`);
    }
  }
}
if (!fs.existsSync(ZCODE_RFL)) {
  if (REQUIRE_ZCODE) fail("zcode 侧镜像文件缺失（RFL_REQUIRE_ZCODE=1）：" + ZCODE_RFL);
  // fail-closed：SKIP 只对「双实现对账」豁免。此前已累积的失败（pi 侧去重不变量 /
  // 结构标记 / pi 侧模块加载）必须先报告——否则无 zcode 的环境（CI）里这些检查全部
  // 被 skip 的 exit 0 吞掉，守卫退化为永远绿（2026-09-20 实测发现并修复）。
  else if (failures.length === 0) {
    skip("zcode 原生版不在本机（" + ZCODE_RFL + "）——pi 侧去重不变量已验证，双实现对账跳过");
  }
}
if (failures.length > 0) report();

/* ── 结构守卫：两侧必须存在的镜像标记 ── */
const MARKERS = [
  "const REVIEWER_BATCH",
  "const SLOW_POOL",
  "const FAST_POOL",
  "const DRIFTER_POOL",
  "const SLOW_PKG_THRESHOLD",
  "const SLOW_CHURN_THRESHOLD",
  "function planReviewerOrder",
];
const piSrc = fs.readFileSync(PI_RFL, "utf8");
const zcodeSrc = fs.readFileSync(ZCODE_RFL, "utf8");
for (const m of MARKERS) {
  // pi 侧常量/函数可能以 `const REVIEWER_BATCH = 4;` 或 `function planReviewerOrder(` 形态出现
  const piHas = piSrc.includes(m.replace("const ", "const ")) || piSrc.includes(m);
  const zHas = zcodeSrc.includes(m);
  if (!piHas) fail(`结构缺失：pi 侧无标记 \`${m}\`（${PI_RFL}）`);
  if (!zHas) fail(`结构缺失：zcode 侧无标记 \`${m}\`（${ZCODE_RFL}）`);
}

/* ── 抽取 zcode 侧的纯函数片段（.dwf.ts 不能被 Node 直接 import：宿主全局 + 顶层 await）── */
/**
 * 从 open 处的 `{` 起做花括号配平扫描，跳过字符串 / 模板串 / 行注释 / 块注释内的花括号。
 * 返回配对 `}` 的下标；不配平返回 -1。
 */
function scanBalancedBraces(src, open) {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const endc = src.indexOf("*/", i + 2);
      i = endc < 0 ? src.length : endc + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        // 模板串插值 ${...}：递归按花括号配平跳过（不解析其内部字符串，够用）
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
          let d = 1;
          let j = i + 2;
          while (j < src.length && d > 0) {
            if (src[j] === "{") d++;
            else if (src[j] === "}") d--;
            j++;
          }
          i = j;
          continue;
        }
        i++;
      }
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function extractZcodeScheduler() {
  // 抽取边界刻意与**格式/取值无关**：结束标记用函数签名（不含字段常数），否则阈值本身
  // 漂移（3000→5000）会先把抽取搞崩，守卫就只能报「抽取失败」而报不出「常量不一致」/
  // 「行为分歧」——那会让漂移的诊断信息丢失，也让阈值类漂移的守卫自测失效。
  // 因此：常量区从 REVIEWER_BATCH 抓到 planReviewerOrder 签名；函数体用花括号配平截取。
  // 常量区下界 = `const SLOW_POOL`（池常量 + 阈值 + DiffStats 类型都在其之后）；
  // 上界 = planReviewerOrder 签名。刻意从 SLOW_POOL 起而不是从 REVIEWER_BATCH 起：
  // REVIEWER_BATCH 与池常量之间夹着宿主相关顶层代码（reviewers 窄化 / dims 派生），
  // 卷进来会在无 args 的求值沙箱里抛 not defined（实测踩过）。
  const startMarker = "const SLOW_POOL";
  const fnMarker = "function planReviewerOrder";
  const constStart = zcodeSrc.indexOf(startMarker);
  if (constStart < 0) throw new Error("抽取失败：找不到 " + JSON.stringify(startMarker));
  const fnStart = zcodeSrc.indexOf(fnMarker, constStart);
  if (fnStart < 0) throw new Error("抽取失败：找不到 " + JSON.stringify(fnMarker));
  const constBlock = zcodeSrc.slice(constStart, fnStart);
  // 函数体配平：先参数括号配平（泛型里的 `{ name: string }` 与解构参数都含花括号——
  // 直接从签名后的第一个 `{` 起算会被泛型对象类型提前配对，这是实测踩过的坑），
  // 再从参数列表闭合括号之后找函数体的 `{`，与 review-fix-loop-script.test.ts 的
  // extractFn 同法。
  const paramOpen = zcodeSrc.indexOf("(", fnStart);
  if (paramOpen < 0) throw new Error("抽取失败：planReviewerOrder 无参数列表");
  let parenDepth = 0;
  let paramClose = -1;
  for (let i = paramOpen; i < zcodeSrc.length; i++) {
    const ch = zcodeSrc[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        paramClose = i;
        break;
      }
    }
  }
  if (paramClose < 0) throw new Error("抽取失败：planReviewerOrder 参数括号不配平");
  // 函数体扫描起点：参数闭合后，先扫过签名自带的成对花括号（返回类型标注
  // `): { order: T[]; ... } {` 的内联对象类型自成一对），再进函数体。等价做法是把
  // 函数体左花括号定位为「参数闭合后、首个 depth 归零的 `{`之后」的那一个。
  let sigDepth = 0;
  let open = -1;
  let insideSigBrace = false;
  for (let i = paramClose; i < zcodeSrc.length; i++) {
    const ch = zcodeSrc[i];
    if (ch === "{") {
      if (sigDepth === 0) {
        insideSigBrace = true;
        sigDepth = 1;
        // 记录「第一个 depth=1 的左括号」，待其归零后，下一个左括号即函数体
        continue;
      }
      sigDepth++;
    } else if (ch === "}") {
      if (sigDepth > 0) {
        sigDepth--;
        if (sigDepth === 0 && insideSigBrace) {
          // 签名内联对象类型已闭合：函数体的 `{` 是参数闭合后第一个「depth=0 的 `{`」
          const bodyOpen = zcodeSrc.indexOf("{", i + 1);
          if (bodyOpen >= 0) {
            open = bodyOpen;
            break;
          }
        }
      }
    }
  }
  if (open < 0) throw new Error("抽取失败：planReviewerOrder 函数体未定位");
  const close = scanBalancedBraces(zcodeSrc, open);
  if (close < 0) throw new Error("抽取失败：planReviewerOrder 花括号不配平");
  // 只取函数体（参数与返回类型标注全丢弃），再包成无名函数——抽取层对签名格式/类型标注
  // 的形态变化免疫（这与 pi 侧 utils 是纯 JS、无类型标注的形态对齐）。
  const fnBlock = "function planReviewerOrder(items, diffStats) " + zcodeSrc.slice(open, close + 1);
  // REVIEWER_BATCH 在抽取区之外（宿主相关代码之前），单独按正则读出——它是并发语义
  // 常量，必须参与对账（批大小漂移会直接改变调度切分）。
  const batchMatch = zcodeSrc.match(/const REVIEWER_BATCH\s*=\s*(\d+)\s*;/);
  if (!batchMatch) throw new Error("抽取失败：找不到 REVIEWER_BATCH 数值");
  const js = [constBlock, fnBlock]
    .map((p) => stripTypeScriptTypes(p, { mode: "strip" }))
    .join("\n")
    + "\nconst REVIEWER_BATCH = " + batchMatch[1] + ";"
    + "\nexport const __api = { REVIEWER_BATCH, SLOW_POOL, FAST_POOL, DRIFTER_POOL, SLOW_PKG_THRESHOLD, SLOW_CHURN_THRESHOLD, planReviewerOrder, drifterSlowScore };\n";
  return js;
}

const require_ = createRequire(import.meta.url);
let piApi;
try {
  piApi = require_(PI_RFL);
} catch (e) {
  fail("pi 侧模块加载失败：" + e.message);
}

let zApi = null;
try {
  const js = extractZcodeScheduler();
  const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  zApi = mod.__api;
} catch (e) {
  fail("zcode 侧调度片段抽取/加载失败：" + e.message + "（签名或函数体形态变化时需同步本守卫的抽取标记）");
}

if (!piApi || !zApi) report();

/* ── 行为对账语料：覆盖池归类、去重、边界阈值、降级路径 ── */
const DIM_KEYS = [
  "arch-boundary", "business-logic", "data-governance", "electron-build",
  "extension-api", "monorepo-impact", "test-coverage", "type-safety",
];
const piItems = (keys) => keys.map((k) => ({ name: "review-" + k }));
const zItems = (keys) => keys.map((k) => ({ name: k }));
const dimOf = (name) => name.replace(/^review-/, "").replace(/\.md$/, "");

const CORPUS = [
  { label: "全 8 维 + 跨包大 diff（monorepo 进慢批）", keys: DIM_KEYS, diffStats: { files: [], churnLines: 5000, pkgCount: 9 } },
  { label: "全 8 维 + 大 churn（business 进慢批）", keys: DIM_KEYS, diffStats: { files: [], churnLines: 5000, pkgCount: 1 } },
  { label: "全 8 维 + 小 diff（漂移者按默认池序）", keys: DIM_KEYS, diffStats: { files: [], churnLines: 10, pkgCount: 1 } },
  { label: "全 8 维 + diffStats 缺失（降级默认序）", keys: DIM_KEYS, diffStats: null },
  { label: "阈值边界：pkg=5 / churn=3000（恰好达慢档）", keys: DIM_KEYS, diffStats: { files: [], churnLines: 3000, pkgCount: 5 } },
  { label: "多池关键词命名（去重不变量：extension-api + arch-boundary 同串）", keys: ["extension-api-arch-boundary", ...DIM_KEYS], diffStats: { files: [], churnLines: 100, pkgCount: 2 } },
  { label: "多池关键词 + 未知维度（尾部追加）", keys: [...DIM_KEYS, "custom-lint-dim", "custom-doc-dim"], diffStats: { files: [], churnLines: 4000, pkgCount: 8 } },
  { label: "仅 2 维（池未满，动态位补空缺）", keys: ["extension-api", "business-logic"], diffStats: { files: [], churnLines: 9000, pkgCount: 20 } },
  { label: "空输入", keys: [], diffStats: { files: [], churnLines: 1, pkgCount: 1 } },
];

const normalize = (res) => ({
  order: res.order.map((d) => dimOf(d.name)),
  slow: res.slowBatch.map((d) => dimOf(d.name)),
  fast: res.fastBatch.map((d) => dimOf(d.name)),
});

for (const c of CORPUS) {
  const expectedKeys = c.keys.map((k) => k.replace(/\.md$/, ""));
  let piRes;
  let zRes;
  try {
    piRes = normalize(piApi.planReviewerOrder(piItems(c.keys), c.diffStats));
  } catch (e) {
    fail(`pi 侧 planReviewerOrder 抛错（语料「${c.label}」）：${e.message}`);
    continue;
  }
  try {
    zRes = normalize(zApi.planReviewerOrder(zItems(c.keys), c.diffStats));
  } catch (e) {
    fail(`zcode 侧 planReviewerOrder 抛错（语料「${c.label}」）：${e.message}`);
    continue;
  }

  // 不变量：order 恒为输入的排列（无重复、无遗漏）——zcode 侧独立断言；
  // pi 侧同一条已在 zcode 缺席判定之前先跑（无 zcode 环境也必须守），此处不重复。
  {
    const sorted = [...zRes.order].sort().join("|");
    const expect = [...expectedKeys].sort().join("|");
    if (sorted !== expect) {
      const dup = zRes.order.length !== new Set(zRes.order).size;
      fail(`zcode 侧 order 不是输入的排列（语料「${c.label}」）${dup ? "——存在重复项（去重不变量退化）" : ""}\n`
        + `      期望 ${expectedKeys.length} 项：${expect}\n      实际 ${zRes.order.length} 项：${sorted}`);
    }
  }

  for (const field of ["order", "slow", "fast"]) {
    const a = piRes[field].join(",");
    const b = zRes[field].join(",");
    if (a !== b) {
      fail(`调度结果不一致（语料「${c.label}」，字段 ${field}）\n`
        + `      pi    : ${a || "(空)"}\n      zcode : ${b || "(空)"}`);
    }
  }
}

/* ── 常量对账：池与阈值必须一致 ── */
const constantPairs = [
  ["REVIEWER_BATCH", piApi.REVIEWER_BATCH, zApi.REVIEWER_BATCH],
  ["SLOW_PKG_THRESHOLD", piApi.SLOW_PKG_THRESHOLD, zApi.SLOW_PKG_THRESHOLD],
  ["SLOW_CHURN_THRESHOLD", piApi.SLOW_CHURN_THRESHOLD, zApi.SLOW_CHURN_THRESHOLD],
  ["SLOW_POOL", (piApi.SLOW_POOL || []).join(","), (zApi.SLOW_POOL || []).join(",")],
  ["FAST_POOL", (piApi.FAST_POOL || []).join(","), (zApi.FAST_POOL || []).join(",")],
  ["DRIFTER_POOL", (piApi.DRIFTER_POOL || []).join(","), (zApi.DRIFTER_POOL || []).join(",")],
];
for (const [name, a, b] of constantPairs) {
  if (String(a) !== String(b)) {
    fail(`常量不一致：${name}\n      pi    : ${a}\n      zcode : ${b}`);
  }
}

report();

function report() {
  if (failures.length === 0) {
    console.log("[rfl-parity] OK — 双实现调度与常量一致（pi: " + path.relative(REPO_ROOT, PI_RFL) + "）");
    process.exit(0);
  }
  console.error("[rfl-parity] FAIL — review-fix-loop 双实现已漂移（" + failures.length + " 项）\n");
  for (const f of failures) console.error("  • " + f);
  console.error("\n[FIX] 两侧需保持同一语义（改一侧必须同步另一侧）：");
  console.error("  pi    侧：packages/subagent-core/workflows/review-fix-loop-utils.cjs（planReviewerOrder / 池常量 / 阈值）");
  console.error("  zcode 侧：" + ZCODE_RFL);
  console.error("  同步后重跑：node scripts/check-rfl-parity.mjs");
  process.exit(1);
}
