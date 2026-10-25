#!/usr/bin/env node
// build-review-fix-loop.mjs — review-fix-loop 双平台产物构建器（单源拼接路线）
//
// 适配自 zsw-skills scripts/build-workflows.mjs（同族管线；差异：单 workflow、
// shared 无字面 agent( 调用点不视为错误——平台 agent 形态差异经 ctx 注入，
// 字面调用在各壳模板内，zcode GUI 泳道静态分析不受影响）。
//
// 源（workflows/src/）：
//   review-fix-loop.shared.ts     单源机制段（TS 写法；纯逻辑无平台 API——平台差异经
//                                 ContentRepairCtx 等注入面由壳装配）
//   review-fix-loop.zcode.tpl.ts  zcode 壳（frontmatter + 主体 + @@STITCH@@）
//   review-fix-loop.pi.tpl.js     pi 壳（@pi-meta + utils require + 主体 + @@STITCH@@）
// 产物（入 git；zcode saved 副本随构建同步）：
//   workflows/review-fix-loop.js       pi 产物（npm 分发路径不变）
//   workflows/review-fix-loop.dwf.ts   zcode 产物（仓内权威副本）
//   ~/.zcode/workflows/review-fix-loop.dwf.ts   zcode saved（CreateWorkflow 发现目录）
//
// pi 管线（zcode 产物 = 壳 + shared 原文，零转换）：
//   ① 词法安全改写：代码区的 agent( → wfAgent(（字符串/模板/注释/正则内不动）
//   ② .ask<T>( → .ask("T", ：泛型参数转 typeKey 字符串
//   ③ typescript.transpileModule 剥 TS（标注/as/非空!/类型谓词）
//
// 用法：node scripts/build-review-fix-loop.mjs [--check]
//   默认构建产物并同步 saved；--check 校验产物与重生成结果一致（防改源忘构建/忘同步）

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF = join(PKG_ROOT, "workflows");
const SRC = join(WF, "src");
const SAVED_DIR = join(homedir(), ".zcode", "workflows");
const NAME = "review-fix-loop";

const ts = createRequire(import.meta.url)("typescript");

const STITCH = /^\s*@@STITCH@@\s*$/;

// ── 拼接：标记行替换为 shared 全文（保持标记行缩进）──
function stitch(template, shared) {
  const out = [];
  let replaced = 0;
  for (const line of template.split("\n")) {
    if (STITCH.test(line)) {
      replaced++;
      const indent = line.match(/^\s*/)[0];
      out.push(shared.split("\n").map((l) => (l === "" ? "" : indent + l)).join("\n"));
    } else {
      out.push(line);
    }
  }
  if (replaced !== 1) throw new Error(`模板应有恰好 1 个 @@STITCH@@ 标记行，实际 ${replaced}`);
  return out.join("\n");
}

// ── 词法规则表（lexSegments 的分派依据）──────────────────────────────────────
// 每条规则两件套：matches(src, i, prevSig) 判起点；scan(src, i) 返回
// { end, prevSig }——end = 消费到的下一位置，prevSig = 该字面量结束后回溯给
// 主循环的「上一个有效字符」。按表中顺序首次命中即生效（与原 if/else-if 链同序，
// 注释优先于正则判定）。新增字面量形态只加一行规则，主循环分支数不随形态数量增长。
const REGEX_PRECEDING = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "<", ">", "~", "^", "\n"]);
const REGEX_KEYWORDS = new Set(["return", "case", "do", "else", "in", "of", "typeof", "void", "delete", "yield", "await"]);

const LEX_RULES = [
  {
    name: "line-comment",
    matches: (src, i) => src[i] === "/" && src[i + 1] === "/",
    scan: (src, i) => ({ end: indexOrEnd(src, "\n", i), prevSig: "\n" }),
  },
  {
    name: "block-comment",
    matches: (src, i) => src[i] === "/" && src[i + 1] === "*",
    scan: (src, i) => {
      const j = src.indexOf("*/", i + 2);
      return { end: j < 0 ? src.length : j + 2, prevSig: "\n" };
    },
  },
  {
    name: "regex-literal",
    matches: (src, i, prevSig) => src[i] === "/" && regexAllowedAt(src, i, prevSig),
    scan: (src, i) => ({ end: scanRegexEnd(src, i), prevSig: "/" }),
  },
  {
    name: "quoted-string",
    matches: (src, i) => src[i] === '"' || src[i] === "'",
    scan: (src, i) => ({ end: scanQuotedEnd(src, i, src[i]), prevSig: src[i] }),
  },
  {
    name: "template-string",
    matches: (src, i) => src[i] === "`",
    scan: (src, i) => ({ end: scanTemplateEnd(src, i), prevSig: "`" }),
  },
];

/** 段尾复用：末段已是目标 kind 则续写，否则开新段（原 codeStart/rawStart 的公共体）。 */
function pushSegment(segments, code) {
  const last = segments[segments.length - 1];
  if (last && last.code === code) return last;
  const seg = { code, text: "" };
  segments.push(seg);
  return seg;
}

/** indexOf 的「找不到 → 串尾」包装（行注释吃到行尾或文件尾）。 */
function indexOrEnd(src, needle, from) {
  const j = src.indexOf(needle, from);
  return j < 0 ? src.length : j;
}

/** 正则字面量起点判定：前一有效字符落在 REGEX_PRECEDING，或紧邻关键字之后。 */
function regexAllowedAt(src, i, prevSig) {
  if (REGEX_PRECEDING.has(prevSig)) return true;
  return /[A-Za-z_$]/.test(prevSig) && REGEX_KEYWORDS.has(prevWordBefore(src, i));
}

/** 位置 i 之前紧邻的标识符（正则/除法判定的关键词依据）。 */
function prevWordBefore(src, i) {
  let j = i;
  while (j > 0 && /[A-Za-z_$]/.test(src[j - 1])) j--;
  return src.slice(j, i);
}

/** 正则字面量结束位置：不吃跨行；字符类内的 / 不终止；反斜杠吞下一字符。 */
function scanRegexEnd(src, i) {
  const n = src.length;
  let j = i + 1;
  let inClass = false;
  while (j < n && src[j] !== "\n") {
    if (src[j] === "\\") { j += 2; continue; }
    if (src[j] === "[") inClass = true;
    else if (src[j] === "]") inClass = false;
    else if (src[j] === "/" && !inClass) break;
    j++;
  }
  return j;
}

/** 引号字符串结束位置（quote 由 src[i] 给出）：反斜杠吞下一字符；未闭合吃到串尾。 */
function scanQuotedEnd(src, i, quote) {
  const n = src.length;
  let j = i + 1;
  while (j < n && src[j] !== quote) { if (src[j] === "\\") j += 2; else j++; }
  return Math.min(j + 1, n);
}

/** 模板串结束位置：${} 嵌套计入深度，嵌内的反引号不终止；未闭合吃到串尾。 */
function scanTemplateEnd(src, i) {
  const n = src.length;
  let j = i + 1;
  let depth = 0;
  while (j < n && (src[j] !== "`" || depth > 0)) {
    if (src[j] === "\\") { j += 2; continue; }
    if (src[j] === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
    if (src[j] === "}" && depth > 0) { depth--; j++; continue; }
    j++;
  }
  return Math.min(j + 1, n);
}

// ── 词法扫描（与 zsw-skills check-workflow-parity.mjs 同一套状态机设计）──
// 输出段列表：{ code, text }——code=true 的段是可改写区，其余原样透传
function lexSegments(src) {
  const segments = [];
  const n = src.length;
  let i = 0;
  let prevSig = "\n";
  while (i < n) {
    const rule = LEX_RULES.find((r) => r.matches(src, i, prevSig));
    if (!rule) {
      const c = src[i];
      pushSegment(segments, true).text += c;
      if (!" \t\r".includes(c)) prevSig = c;
      i += 1;
      continue;
    }
    const { end, prevSig: nextSig } = rule.scan(src, i);
    pushSegment(segments, false).text += src.slice(i, end);
    i = end;
    prevSig = nextSig;
  }
  return segments;
}

// ── export 剥离：shared 源文件带 export（供 vitest 直接 import 单测），但两侧产物都是
//    拼接进单文件脚本体（zcode 编译进函数体 / pi worker 顶层 return），禁 module 语法——
//    拼接前剥掉行首 export 关键字（shared 内无行首 "export " 字符串字面量，替换安全）──
function stripExports(src) {
  return src.replace(/^export (?=(?:async )?(?:function|interface|const|type)\b)/gm, "");
}

// ── pi 管线 ①：代码区 agent( → wfAgent(（词法安全；shared 纯逻辑时零命中，原样透传）──
function rewriteAgentCalls(src) {
  const segments = lexSegments(src);
  let count = 0;
  for (const seg of segments) {
    if (!seg.code) continue;
    seg.text = seg.text.replace(/(?<![\w.$])agent\(/g, () => { count++; return "wfAgent("; });
  }
  return { text: segments.map((s) => s.text).join(""), count };
}

// ── pi 管线 ②③：ask 泛型转 typeKey + transpile 剥 TS ──
function stripTs(sharedTs) {
  const pre = sharedTs.replace(/\.\s*ask<([A-Za-z_$][\w$]*)>\(/g, '.ask("$1", ');
  const { outputText } = ts.transpileModule(pre, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return outputText;
}

/** 构建或校验（可导入：vitest 产物一致性门禁直接调用，免子进程 spawn）。
 *  返回 { dirty }——check 模式下 dirty > 0 = 产物过期或 saved 滞后。 */
export function runBuildOrCheck({ check }) {
  let dirty = 0;

  const sharedPath = join(SRC, `${NAME}.shared.ts`);
  const shared = readFileSync(sharedPath, "utf8");
  const zcTpl = readFileSync(join(SRC, `${NAME}.zcode.tpl.ts`), "utf8");
  const piTpl = readFileSync(join(SRC, `${NAME}.pi.tpl.js`), "utf8");

  const rewritten = rewriteAgentCalls(stripExports(shared));
  const piShared = stripTs(rewritten.text);
  const zcOut = stitch(zcTpl, stripExports(shared));
  const piOut = stitch(piTpl, piShared);

  const targets = [
    [join(WF, `${NAME}.dwf.ts`), zcOut],
    [join(WF, `${NAME}.js`), piOut],
    // zcode saved 副本与仓内产物同内容（CreateWorkflow 的 saved 发现目录；滞后时实际
    // 执行的是旧版，故 build 一并同步、--check 一并拦截——zsw-skills 同款教训）
    [join(SAVED_DIR, `${NAME}.dwf.ts`), zcOut],
  ];
  for (const [path, content] of targets) {
    const rel = path.startsWith(PKG_ROOT) ? path.slice(PKG_ROOT.length + 1) : path.replace(homedir(), "~");
    const existing = (() => { try { return readFileSync(path, "utf8"); } catch { return null; } })();
    if (existing === content) {
      console.log(`✓ ${rel}（一致）`);
    } else if (check) {
      console.error(`✗ ${rel} 与重生成结果不一致（产物过期或 saved 副本滞后）——重跑 node scripts/build-review-fix-loop.mjs`);
      dirty++;
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      console.log(`已生成 ${rel}`);
    }
  }

  if (check && dirty > 0) {
    console.error(`\n${dirty} 个产物过期。恢复动作：node scripts/build-review-fix-loop.mjs`);
  }
  return { dirty };
}

// CLI 直跑（被 import 时不触发——vitest 产物一致性门禁直接调 runBuildOrCheck）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { dirty } = runBuildOrCheck({ check: process.argv.includes("--check") });
  if (dirty > 0) process.exit(1);
}
