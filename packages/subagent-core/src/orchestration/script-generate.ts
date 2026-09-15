/**
 * Workflow 脚本创作管线（generate）——pi-sw tool-workflow-script.ts actionGenerate
 * 的校验管线下沉（convergence D-6 / W4）。
 *
 * 五道闸 + round-trip + tmp 写盘，闸序与 pi 现版一致：
 * 1. ESM import 拒绝（Worker 跑 CJS）；'export const meta' 例外
 * 2. 非 meta 的 export 拒绝
 * 3. meta 声明必需（@pi-meta YAML 块注释或 legacy const meta，过渡期 m0）
 * 4. agent() 调用必需
 * 5. 语法检查（包 async IIFE，与 runtime 包裹形态一致）
 * 6. round-trip：@pi-meta 存在时 parseResourceMetaDetailed 校验 YAML（报行列）
 * 7. 通过全部校验 → tmp 目录写盘
 *
 * 与 pi 版的差异（均为宿主职责，不属纯函数边界）：
 * - 不含 signal aborted 检查（AbortSignal 是 pi tool 契约层关注，宿主改接时自留）；
 * - 返回结构化结果而非 throw——pi 只对 execute throw 置 isError:true 的契约
 *   转换由宿主（C5 改接）负责，core 保持纯函数。
 *
 * 报错文案逐字平移自 pi 现版（含 round-trip 的 line/col 信息）——pi 侧行为
 * 不变是 CA2 验收前提，任何文案改动必须同步两处。
 *
 * tmp 目录经 options.tmpDir 宿主注入（缺省 pi 布局，与 workflow-files.ts
 * 同源常量——save/delete/generate 三入口共享同一目录参数化口径）。
 *
 * 层归属：orchestration（创作闭环，与 lintScript / workflow-files 同域）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseResourceMetaDetailed } from "../shared/meta-parser.ts";
import { DEFAULT_WORKFLOW_TMP_DIR } from "./workflow-files.ts";

/** generate 目录注入参数：tmp 落盘目录宿主注入（缺省 DEFAULT_WORKFLOW_TMP_DIR）。 */
export interface GenerateWorkflowScriptOptions {
  tmpDir?: string;
}

/**
 * 管线结果：成功 = 落盘绝对路径；失败 = 报错文案（逐字对齐 pi 现版，
 * 含 round-trip 的行列信息——供宿主转 throw 后 LLM 自纠正）。
 */
export type GenerateWorkflowScriptResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

// ── 校验闸（每闸返回 error 文案；undefined = 通过。文案逐字对齐 pi 现版） ──

/** 闸 0：参数完备（缺 name/script 即拒）。 */
function checkRequiredParams(name: string, script: string): string | undefined {
  if (!name || !script) {
    return "generate requires 'name' and 'script' parameters";
  }
  return undefined;
}

/** 闸 1：ESM 语法拒绝（Worker 跑 CJS）；'export const meta' 例外。stripped = 注释剥离后源码。 */
function checkEsamSyntax(stripped: string): string | undefined {
  if (/\bimport\s+(?:type\s+)?[\w{*]/.test(stripped)) {
    return "Script uses ESM 'import' syntax. Workflow scripts run in a CJS Worker — use require() instead.";
  }
  const hasExportMeta = /\bexport\s+const\s+meta\s*=/.test(stripped);
  const otherExports = stripped.match(/\bexport\s+(?:const|let|var|function|default|\{)/g);
  if (otherExports && !hasExportMeta) {
    return "Script uses ESM 'export' (non-meta). Use 'const meta = {...}' at top level instead.";
  }
  return undefined;
}

// 闸 2：meta 声明必需（/* @pi-meta */ YAML 块注释或 legacy const meta，过渡期 m0）
function checkMetaDeclaration(script: string, hasPiMeta: boolean): string | undefined {
  const hasLegacyMeta = script.includes("const meta") || script.includes("export const meta");
  if (!hasPiMeta && !hasLegacyMeta) {
    return "Script must contain a meta declaration: a /* @pi-meta */ YAML block comment (preferred) or legacy const meta = { ... }. The block has the form: a block comment starting with /* @pi-meta followed by YAML (name/description/phases/parameters?/usage?), closed by */ on its own line.";
  }
  return undefined;
}

/** 闸 3：agent() 调用必需。 */
function checkAgentUsage(stripped: string): string | undefined {
  if (!/\bagent\s*\(/.test(stripped)) {
    return "Script does not contain any agent() calls. A workflow must call agent() at least once.";
  }
  return undefined;
}

/** 闸 4：语法检查（包 async IIFE，与 runtime 包裹形态一致）。 */
function checkSyntax(script: string): string | undefined {
  const cjsScript = script.replace(/\bexport\s+const\s+meta\b/, "const meta");
  try {
    new Function(`(async () => { ${cjsScript} })();`);
    return undefined;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Syntax error in script: ${msg}`;
  }
}

/** 闸 4b：round-trip——@pi-meta 存在时 parseResourceMetaDetailed 校验 YAML（报行列）。 */
function checkMetaRoundTrip(script: string, hasPiMeta: boolean): string | undefined {
  if (!hasPiMeta) return undefined;
  const detailed = parseResourceMetaDetailed(script, "workflow");
  if (detailed.ok) return undefined;
  const loc = "linePos" in detailed && detailed.linePos
    ? ` (line ${detailed.linePos.line}, col ${detailed.linePos.col})`
    : "";
  return `Generated /* @pi-meta */ YAML cannot be parsed${loc}: ${detailed.error}. Common causes: YAML indent errors, patternProperties regex must use double backslash (\\d not \d), or a stray star-slash inside the YAML body. Fix the meta block and retry.`;
}

/**
 * 校验并落盘一个 AI 生成的 workflow 临时脚本。
 *
 * @param name 脚本名（落盘 <tmpDir>/{name}.js）
 * @param script 完整脚本源码
 * @param options 目录注入（tmpDir 缺省 pi 布局，相对 cwd resolve）
 */
export function generateWorkflowScript(
  name: string,
  script: string,
  options?: GenerateWorkflowScriptOptions,
): GenerateWorkflowScriptResult {
  const paramError = checkRequiredParams(name, script);
  if (paramError) return { ok: false, error: paramError };

  // 1. Reject ESM syntax (Worker runs CJS); 'export const meta' 例外
  const stripped = script.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const esamError = checkEsamSyntax(stripped);
  if (esamError) return { ok: false, error: esamError };

  // 2. Validate meta declaration (/* @pi-meta */ new format preferred; legacy const meta accepted during transition — m0)
  const hasPiMeta = /\/\*\s*@pi-meta\s*\n/.test(script);
  const metaError = checkMetaDeclaration(script, hasPiMeta);
  if (metaError) return { ok: false, error: metaError };

  // 3. Check agent usage
  const agentError = checkAgentUsage(stripped);
  if (agentError) return { ok: false, error: agentError };

  // 4. Syntax check (wrap in async IIFE like runtime)
  const syntaxError = checkSyntax(script);
  if (syntaxError) return { ok: false, error: syntaxError };

  // 4b. Round-trip: validate /* @pi-meta */ YAML before writing (v5 §4.7 / ERR4 — report linePos, don't write bad files)
  const roundTripError = checkMetaRoundTrip(script, hasPiMeta);
  if (roundTripError) return { ok: false, error: roundTripError };

  // 5. Write to tmp directory
  const tmpDir = resolve(options?.tmpDir ?? DEFAULT_WORKFLOW_TMP_DIR);
  mkdirSync(tmpDir, { recursive: true });
  const filePath = resolve(tmpDir, `${name}.js`);
  writeFileSync(filePath, script, "utf-8");

  return { ok: true, path: filePath };
}
