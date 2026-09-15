/**
 * Workflow Extension — 静态 lint
 *
 * 在执行前捕获常见的 workflow 脚本 API 误用。纯函数，零副作用，零 IO。
 *
 * 设计：
 * - lint 是编排层关注（非技术资源），归属 Engine 层。
 * - **entry-point 检查**：脚本必须含 agent/parallel/pipeline 之一，否则视为 error。
 * WorkflowScript.validate 直接委托 lintScript，故 entry-point 检查必须在此。
 * - LintFinding/LintResult 类型规范的 canonical 源在本文件。
 *
 * 检查项：
 * 1. 必须含 agent/parallel/pipeline 入口（error）
 * 2. agent 选项中 outputSchema 当 key 用 → 应为 schema（error）
 * 3. result.output / result.parsedOutput / result.content → agent 返回未包装值（error）
 * 4. readFileSync/writeFileSync 传状态 → 脆弱（warning）
 * 5. unlinkSync 清理状态 → 与 subprocess 文件读竞态（warning）
 * 6. 顶层未 await 的异步 IIFE + 内部调 agent/parallel/pipeline → 子进程被提前 kill（error）
 * 7. agent() 缺 description/label → TUI /workflows 显示 '(unnamed)'（warning）
 * 8. meta.phases 非字符串数组（对象数组等）→ 引擎忽略（warning）
 * 9. meta.phases 声明与 phase() 调用不一致 → 运行时分组与声明脱节（warning）
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §7（validate 语义）。
 */

/** m4 W2：meta 描述字段长度上限（§5.1 注入段预算约束）。 */
const DESC_MAX_LENGTH = 200;
/** m4 W4：agent examples 最少条数（正反各一需 ≥2）。 */
const EXAMPLES_MIN_COUNT = 2;
/** m5：examples 上限（注入是每 turn 常驻成本——防数据无界膨胀）。 */
const EXAMPLES_MAX_COUNT = 4;

/** Lint 检查发现项。 */
export interface LintFinding {
 /** error = 会导致运行时崩溃; warning = 可能的错误 */
  severity: "error" | "warning";
  line: number;
  message: string;
  suggestion: string;
}

/** Lint 检查结果。 */
export interface LintResult {
  valid: boolean;
  findings: LintFinding[];
}

/** 必须命中其一——workflow 脚本不调用任何编排函数等于空跑。 */
import type { AgentMeta } from "../shared/resource-meta.ts";
import { parseResourceMeta } from "../shared/meta-parser.ts";

const ENTRY_POINT_PATTERNS = [/\bagent\s*\(/, /\bparallel\s*\(/, /\bpipeline\s*\(/] as const;

/**
 * 检查脚本是否含至少一个编排入口（agent/parallel/pipeline）。
 * 无入口视为 error——空跑脚本无意义。
 */
function checkEntryPoint(source: string): LintFinding[] {
  const hasEntryPoint = ENTRY_POINT_PATTERNS.some((p) => p.test(source));
  if (hasEntryPoint) return [];
  return [
    {
      severity: "error",
      line: 0,
      message: "Workflow script must call agent(), parallel(), or pipeline() at least once.",
      suggestion: "Add at least one agent(), parallel(), or pipeline() invocation.",
    },
  ];
}

/**
 * 检查单行 lint 问题，返回该行的发现项（可能为空）。
 */
function checkLine(lineText: string, lineNum: number): LintFinding[] {
  const results: LintFinding[] = [];

  // 跳过注释行
  const trimmed = lineText.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
    return results;
  }

  // result.output / result.parsedOutput / result.content
  const resultAccessPatterns: Array<{ regex: RegExp; field: string }> = [
    { regex: /\bresult\s*\.\s*output\b/, field: "output" },
    { regex: /\bresult\s*\.\s*parsedOutput\b/, field: "parsedOutput" },
    { regex: /\bresult\s*\.\s*content\b/, field: "content" },
  ];
  for (const p of resultAccessPatterns) {
    if (p.regex.test(lineText)) {
      results.push({
        severity: "error",
        line: lineNum,
        message: `\`result.${p.field}\` does not exist. agent() returns the unwrapped value directly.`,
        suggestion: "Use `const value = await agent(...)` and access `value` directly.",
      });
    }
  }

  // 文件传状态（readFileSync of STATE）
  if (/readFileSync\(.*STATE.*\)|readFileSync\(.*state.*\.json/i.test(lineText)) {
    results.push({
      severity: "warning",
      line: lineNum,
      message: "Reading a state file between agent calls is fragile (subprocess file access).",
      suggestion: "Use agent() with `schema` to get structured output directly, avoiding file I/O for state passing.",
    });
  }

  // unlinkSync 清理状态
  if (/unlinkSync.*state/i.test(lineText)) {
    results.push({
      severity: "warning",
      line: lineNum,
      message: "unlinkSync in finally may race with agent subprocess file reads.",
      suggestion: "Avoid file-based state passing; use agent() `schema` for structured output.",
    });
  }

  return results;
}

/**
 * 剔除字符串字面量与注释内容（MF-4）。逐行处理，不跨行。
 * 用途：`\bagent\s*\(` 不命中字符串里的 "agent(s)"（review-fix-loop L281 误报根因）；
 * checkAgentDescription 的 `description\s*:` 不把 schema 内嵌 description 字符串当已提供。
 */
function stripStringsAndComments(line: string): string {
  return line
    .replace(/"(?:\\.|[^"\\])*"/g, "")
    .replace(/'(?:\\.|[^'\\])*'/g, "")
    .replace(/`(?:\\.|[^`\\])*`/g, "")
    .replace(/\/\/.*$/, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 注释行判定：行注释开头或块注释续行开头（* 与斜杠星号前缀）。 */
function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** 括号平衡增量：圆/花/方括号开符计 +1，闭符计 -1，其余 0。 */
function bracketDepthDelta(text: string): number {
  let delta = 0;
  for (const ch of text) {
    if (ch === "(" || ch === "{" || ch === "[") delta++;
    if (ch === ")" || ch === "}" || ch === "]") delta--;
  }
  return delta;
}

// 检测行内「agent(」字面量对象调用起点；命中返回替换后的调用头圆括号及其后原文
//（计括号用），未命中 / 非字面量实参返回 undefined。
//
// 非字面量实参（agent(callVar) / agent(expr)）返回 undefined：description 等选项在调用点
// 静态不可见，checkAgentDescription 无法验证运行时构造的调用——继续报 warning 即误报
// （review-fix-loop 的 agent(call) 三连误报根因）。
// 形如 agent( 换行 { 的多行字面量调用（argTail 为空）保留原追踪行为。
function matchAgentCallHead(codeLine: string): string | undefined {
  if (!/\bagent\s*\(/.test(codeLine)) return undefined;
  const afterAgent = codeLine.replace(/^.*?\bagent\s*\(/, "(");
  const argTail = afterAgent.trimStart().slice(1).trimStart();
  if (argTail.length > 0 && !argTail.startsWith("{")) return undefined;
  return afterAgent;
}

/**
 * 遍历 source 中所有 agent 调用的行范围，对每个调用执行 callback。
 *
 * agent 调用可能跨多行，通过括号配对定位起止行：
 *   agent({
 *     prompt: ...,
 *   })
 *
 * 单行 agent 调用（如 `agent({ prompt: 'x' })`）的 startLine === endLine。
 * 与 checkAgentCalls / checkAgentDescription 共享同一套范围定义，确保
 * outputSchema 检查与 description 检查覆盖完全相同的调用集合（含 parallel/pipeline
 * 内嵌的 agent() 调用——它们同样被 `\bagent\s*\(` 匹配）。
 *
 * 匹配前逐行剔除字符串/注释内容（MF-4）：字符串字面量里的 "agent(s)" 不再误触发。
 *
 * @param callback (startLine, endLine) 0-based 行号
 */
function forEachAgentCallRange(
  source: string,
  callback: (startLine: number, endLine: number) => void,
): void {
  const lines = source.split("\n");
  let inAgentCall = false;
  let depth = 0;
  let agentStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 跳过注释
    if (isCommentLine(trimmed)) {
      continue;
    }

    // 匹配/计括号都用剔除字符串与注释后的行，避免字面量内容干扰
    const codeLine = stripStringsAndComments(line);

    if (!inAgentCall) {
      // 检测 agent 调用开始（非字面量实参 → undefined，跳过本行）
      const afterAgent = matchAgentCallHead(codeLine);
      if (afterAgent === undefined) continue;
      inAgentCall = true;
      depth = 0;
      agentStartLine = i;
      // 从 agent( 开始计括号
      depth += bracketDepthDelta(afterAgent);
      if (depth <= 0) {
        // 单行 agent 调用
        callback(agentStartLine, i);
        inAgentCall = false;
      }
      continue;
    }

    depth += bracketDepthDelta(codeLine);
    if (depth <= 0) {
      callback(agentStartLine, i);
      inAgentCall = false;
    }
  }
}

/**
 * 找出 source 中所有 agent 调用跨度，检查错误的选项 key（outputSchema）。
 * 范围遍历委托 forEachAgentCallRange。
 */
function checkAgentCalls(source: string): LintFinding[] {
  const lines = source.split("\n");
  const findings: LintFinding[] = [];
  forEachAgentCallRange(source, (startLine, endLine) => {
    checkAgentCallOptions(lines, startLine, endLine, findings);
  });
  return findings;
}

/**
 * 检查 agent 调用内的错误选项 key。
 * 只标记 outputSchema 作为 KEY（属性名）使用的情况，不标记作为 VALUE。
 *
 * Error: { outputSchema } ← 简写属性（outputSchema 是 key）
 * Error: { outputSchema: ... } ← 显式 key
 * OK: { schema: outputSchema } ← outputSchema 是 value，`schema` 是 key
 * OK: const outputSchema = {} ← 变量声明（在 agent 调用外）
 */
function checkAgentCallOptions(
  lines: string[],
  startLine: number,
  endLine: number,
  findings: LintFinding[],
): void {
  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i];

    // 跳过变量声明（const/let/var outputSchema = ...）
    if (/\b(?:const|let|var)\s+outputSchema\b/.test(line)) {
      continue;
    }

    // 匹配：outputSchema 作为对象 key（简写或显式）
    if (/\boutputSchema\s*[,\}]/.test(line) || /\boutputSchema\s*:/.test(line)) {
      // 排除：outputSchema 作为 value（在另一个 key 的冒号后）
      // e.g. "schema: outputSchema," — outputSchema 前是冒号
      const beforeOutput = line.substring(0, line.indexOf("outputSchema"));
      if (/:\s*$/.test(beforeOutput)) {
        continue; // outputSchema 是 value，不是 key
      }

      findings.push({
        severity: "error",
        line: i + 1,
        message: "`outputSchema` is not a valid agent() option.",
        suggestion: "Use `schema` instead of `outputSchema`.",
      });
    }
  }
}

/**
 * 剔除 agent 选项对象里的 schema 块（`schema: {...}` 嵌套对象，括号配对）。
 * 用于 checkAgentDescription：JSON Schema 的 properties 里常见 `description:` 字段
 * （schema 文档字段，不是 agent 选项）——只剔字符串字面量时该 key 仍保留，会把
 * 内嵌 description 误判为「已提供」导致漏报（I-10 修正的剩余部分）。
 * 输入为已剔除字符串/注释的 range（无引号内容干扰，括号配对安全）。
 */
function stripSchemaBlocks(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const m = text.slice(i).match(/\bschema\s*:\s*\{/);
    if (!m || m.index === undefined) {
      out += text.slice(i);
      break;
    }
    const start = i + m.index;
    const braceIdx = start + m[0].lastIndexOf("{");
    out += text.slice(i, start);
    let depth = 0;
    let j = braceIdx;
    for (; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    i = j;
  }
  return out;
}

/**
 * 检查 agent 调用是否提供 description（或其别名 label）。
 *
 * worker-script-builder 取 `firstArg.label || firstArg.description` 作 TUI 显示名，
 * 两者都缺 → node.agent 为空 → /workflows 视图显示 '(unnamed)'。
 *
 * 实现复用 forEachAgentCallRange 的范围定义，在范围内检测 `description:` 或 `label:`
 * 作为对象 key。两层剔除保证只认 agent 选项层的真正 key：① 字符串字面量（
 * stripStringsAndComments，MF-4）；② schema 块（stripSchemaBlocks——schema 内嵌的
 * `description:` 是 JSON Schema 字段说明不是 agent 选项，不剔除会漏报）。
 */
function checkAgentDescription(source: string): LintFinding[] {
  const lines = source.split("\n");
  const findings: LintFinding[] = [];
  forEachAgentCallRange(source, (startLine, endLine) => {
    // range 逐行剔除字符串字面量（MF-4）后再剔除 schema 块：schema 内嵌的
    // `description:` 对象 key（JSON Schema 字段说明）不再被误判为「已提供」——
    // 只有 agent 选项层的真正 description/label key 才算数（修正 I-10 漏报方向）。
    const range = stripSchemaBlocks(lines.slice(startLine, endLine + 1).map(stripStringsAndComments).join("\n"));
    // 对象以展开开头（agent({ ...call, ... })）：description 来自运行时对象、调用点静态
    // 不可见——无法验证即不报（review-fix-loop 的 agent({ ...call, agent: ... }) 即此形态）。
    if (/\{\s*\.\.\./.test(range)) return;
    // 匹配 description 或 label 作为对象 key（后跟冒号）
    if (!/\b(description|label)\s*:/.test(range)) {
      findings.push({
        severity: "warning",
        line: startLine + 1,
        message:
          "agent() call without `description` (or `label`) will show as '(unnamed)' in TUI.",
        suggestion:
          "Add `description: 'kebab-case-name'` to agent() opts for readable /workflows display.",
      });
    }
  });
  return findings;
}

// ── 顶层未 await 的异步 IIFE 检测 ───────────────────────────

/**
 * 匹配未 await 的 async IIFE 起点（粗筛）。
 *
 * 形式：`(async function`、`(async ()`、`(async (args)` 后跟 `=>`
 * 不匹配：`await (async ...`（lookbehind 排除）
 */
const BARE_ASYNC_IIFE_PATTERN = /(^|[;\n\s{}(])(?<!await\s)\(async\s+(?:function\b|\(\)|\([^)]*\)\s*=>)/g;

/**
 * 判断 IIFE 调用表达式是否被某个上下文「接住」（return/赋值/await 链等）。
 *
 * 返回 true 表示 IIFE 的 Promise 被接住（合法或可能合法）；
 * false 表示 IIFE 是孤立语句表达式（fire-and-forget）。
 *
 * 判断方法：扫描 IIFE 起点 `(async` 前的非空白 token：
 *   - 遇到 `=` `return` `await` `(` `[` `,` → 接住
 *   - 遇到 `;` `{` `}` 或行首 → 孤立语句
 *
 * 例：
 *   `const x = (async ...` → '=' 接住
 *   `return (async ...` → 'return' 接住
 *   `(async ...` 行首 → 孤立
 *   `}; (async ...` → 孤立（前一个语句结束后新起一个）
 */
function isIIFEAwaited(source: string, iifeStart: number): boolean {
  let i = iifeStart - 1;
  while (i >= 0) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i--;
      continue;
    }
    // 当前字符是标识符字符 → 向前扫完整标识符
    if (/[A-Za-z0-9_$]/.test(ch)) {
      // return / await / yield / 变量名（如 `foo(async ...`）→ 接住
      return true;
    }
    // 单字符操作符
    if (ch === "=" || ch === "(" || ch === "[" || ch === "," || ch === "?" || ch === ":") {
      return true;
    }
    if (ch === ";" || ch === "{" || ch === "}" || ch === ")") {
      return false;
    }
    // 其他字符（如 `.` `+`），保守视为接住（避免误报）
    return true;
  }
  return false;
}

/**
 * 检测未 await 的 async IIFE，且其内部调用了 agent/parallel/pipeline。
 *
 * 严重度分级：
 * - **error**：IIFE 是孤立语句表达式（fire-and-forget）+ 内部调 agent。
 *   这是 daily-news-impact 的 bug 模式——worker 外层 IIFE 不等内层就 post return，
 *   主线程 transition done → releaseRuntime → controller.abort() → SIGKILL 子进程。
 * - **warning**：IIFE 被 `=`/`return`/`(` 等接住（可能后续 await），但内部调 agent。
 *   提醒作者确认 Promise 真的被 await，不阻断运行。
 *
 * 误报规避（不报）：
 * - await 前缀的 IIFE（lookbehind 排除）
 * - IIFE 内不含 agent/parallel/pipeline（stock-screening 这类纯 execSync 合法）
 *
 * 局限：纯正则 + 括号配对，无法做数据流分析。「赋值后稍后 await」「return 给外层 await」
 * 都识别为「接住」（warning 而非 error），避免阻断合法写法。
 */
function checkBareAsyncIIFE(source: string): LintFinding[] {
  if (!ENTRY_POINT_PATTERNS.some((p) => p.test(source))) return [];

  // 用 matchAll 检查所有 IIFE（脚本可能有多个，每个都需独立判断）
  const findings: LintFinding[] = [];
  for (const match of source.matchAll(BARE_ASYNC_IIFE_PATTERN)) {
    const iifeStart = match.index ?? 0;
    const finding = analyzeIIFE(source, iifeStart);
    if (finding) findings.push(finding);
  }
  return findings;
}

/**
 * 分析单个 IIFE 起点是否触发 finding。
 *
 * 返回 LintFinding（error 或 warning）或 undefined（IIFE 内无 agent/无闭合）。
 * 详见 checkBareAsyncIIFE 的 [HISTORICAL] 教训记录。
 */
function analyzeIIFE(source: string, iifeStart: number): LintFinding | undefined {
  const iifeLine = source.slice(0, iifeStart).split("\n").length;

  const firstBrace = source.indexOf("{", iifeStart);
  if (firstBrace === -1) return undefined;

  let depth = 0;
  let iifeEnd = -1;
  for (let i = firstBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        iifeEnd = i;
        break;
      }
    }
  }
  if (iifeEnd === -1) return undefined;

  const iifeBody = source.slice(firstBrace, iifeEnd);
  const hasAgentInside = ENTRY_POINT_PATTERNS.some((p) => p.test(iifeBody));
  if (!hasAgentInside) return undefined;

  const awaited = isIIFEAwaited(source, iifeStart);
  if (awaited) {
    return {
      severity: "warning",
      line: iifeLine,
      message:
        "Async IIFE wrapping agent() is assigned/returned but must be awaited. If the surrounding context does not await this Promise, the worker will post `return` early and kill in-flight agent() subprocesses.",
      suggestion:
        "Verify the surrounding code awaits this IIFE's Promise. When unsure, prefer top-level await directly (the worker already wraps your script in an async IIFE).",
    };
  }

  return {
    severity: "error",
    line: iifeLine,
    message:
      "Top-level async IIFE is a fire-and-forget statement. The worker's outer IIFE will post `return` before agent() resolves, killing the subprocess via runtime abort.",
    suggestion:
      "Remove the IIFE wrapper and use top-level await directly (the worker already wraps your script in an async IIFE). Or `await` the IIFE: `await (async function main() { ... })();`.",
  };
}

// ── 显示性检查（description / phase）───────────────────────────

/**
 * 检查 meta.phases 是否字符串数组。
 *
 * 引擎 buildPhaseGroups 只按运行时 node.phase 分组，不读 meta.phases 声明。但 meta.phases
 * 仍用于文档/一致性检查（见 checkPhaseConsistency），且 SSOT 约定为字符串数组。对象数组
 * （如 [{title,detail}]）是常见误写，提醒作者改为字符串数组。
 */
function checkMetaPhases(source: string): LintFinding[] {
  const findings: LintFinding[] = [];
  // 跨行匹配（\s* 含换行）：`phases: [` 与 `{` 换行分离的多行对象数组同样命中。
  // 原逐行匹配只命中「`[` 与 `{` 同行」，最常见的格式化写法（phases: [ 换行 { ... }）零检出（MF-5）。
  // 行号从 match index 反推。字符串数组（phases: [\n "a"）不匹配 \s*\{，不会误报。
  for (const m of source.matchAll(/phases\s*:\s*\[\s*\{/g)) {
    if (m.index === undefined) continue;
    const lineNum = source.slice(0, m.index).split("\n").length;
    findings.push({
      severity: "warning",
      line: lineNum,
      message:
        "`meta.phases` should be a string array like ['phase1','phase2']. Object arrays are ignored by the engine.",
      suggestion:
        "Use `phases: ['analyze','fix']`. Engine groups nodes by runtime `phase()` calls, not by `meta.phases` declarations.",
    });
  }
  return findings;
}

/**
 * 检查 meta.phases 声明与 phase() 调用的一致性。
 *
 * - 声明了但从未 phase() 调用 → warning（运行时分组用不上，声明形同虚设）
 * - phase() 调用了但未声明 → warning（声明遗漏，meta.phases 失去文档价值）
 *
 * 两者都为空时跳过（脚本不使用 phase 机制，不报）。
 */
function checkPhaseConsistency(source: string): LintFinding[] {
  const findings: LintFinding[] = [];

  // 提取 meta.phases 声明的字符串 + 声明所在行号
  const declared = new Map<string, number>();
  const phasesArrayMatch = source.match(/phases\s*:\s*\[[^\]]*\]/);
  if (phasesArrayMatch && phasesArrayMatch.index !== undefined) {
    const inner = phasesArrayMatch[0];
    // 对象数组（如 [{title,detail}]）由 checkMetaPhases 单独报，这里跳过提取，
    // 避免从对象字段里误抽出字符串作 declared。
    if (!/\[\s*\{/.test(inner)) {
      const phasesLine = source.slice(0, phasesArrayMatch.index).split("\n").length;
      for (const m of inner.matchAll(/['"]([^'"]+)['"]/g)) {
        if (!declared.has(m[1])) declared.set(m[1], phasesLine);
      }
    }
  }

  // 提取所有 phase() 调用实参 + 首次出现的行号
  const called = new Map<string, number>();
  for (const m of source.matchAll(/\bphase\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (m.index === undefined) continue;
    const lineNum = source.slice(0, m.index).split("\n").length;
    if (!called.has(m[1])) called.set(m[1], lineNum);
  }

  // 两者都为空 → 跳过（脚本不使用 phase 机制）
  if (declared.size === 0 && called.size === 0) return [];

  // 声明了但从未 phase() 调用
  for (const [name, line] of declared) {
    if (!called.has(name)) {
      findings.push({
        severity: "warning",
        line,
        message: `declared phase '${name}' never set via phase().`,
        suggestion: `Add phase('${name}') before the agent() calls belonging to this phase, or remove it from meta.phases.`,
      });
    }
  }

  // 调用了但未声明
  for (const [name, line] of called) {
    if (!declared.has(name)) {
      findings.push({
        severity: "warning",
        line,
        message: `phase('${name}') called but not in meta.phases.`,
        suggestion: `Add '${name}' to meta.phases array, e.g. phases: [..., '${name}'].`,
      });
    }
  }

  return findings;
}

/**
 * 静态检查 workflow 脚本合法性。
 *
 * @param source 脚本源码（原始文件内容）
 * @returns LintResult（valid = 无 error 级 finding）
 */
/**
 * W2/W3 共享 helper：meta 描述字段长度上限 + 单句判定（workflow lintScript 与
 * agent lintAgentMeta 共用同一规则——S-5 对称，避免 agent 长 description 常驻膨胀）。
 *
 * W2：>200 字符 → error。
 * W3：括号内容剥离（（…）/（…）与 (...)）后含换行/。；/'. ' 分句 → error。
 * 输出格式与 severity 约定与 checkMetaQuality 一致（error / line 1 / meta.<field> 前缀）。
 */
function checkMetaFieldQuality(field: string, value: string): LintFinding[] {
  const findings: LintFinding[] = [];
  // W2
  if (value.length > DESC_MAX_LENGTH) {
    findings.push({
      severity: "error",
      line: 1,
      message: `meta.${field} 长度 ${value.length} 超过 ${DESC_MAX_LENGTH} 字符（§5.1 注入段预算约束）`,
      suggestion: "精简为单句路由描述，细节移入 usage",
    });
  }
  // W3：括号剥离后分句判定
  const stripped = value
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\b(?:e\.g|i\.e)\.\s/g, ""); // 缩写剔除（exec-review F8：括号外 e.g. 不误报）
  if (/[\n。；]|\.\s/.test(stripped)) {
    findings.push({
      severity: "error",
      line: 1,
      message: `meta.${field} 非单句（含换行/分句标点）——§5.1 注入段要求一句话路由描述`,
      suggestion: "精简为单句，细节移入 when/notFor/usage",
    });
  }
  return findings;
}

/** 对象的 keys 全部收集进集合（非对象安全退化：不加任何 key）。 */
function collectObjectKeys(src: unknown, out: Set<string>): void {
  if (src === null || typeof src !== "object") return;
  for (const k of Object.keys(src as Record<string, unknown>)) out.add(k);
}

/** patternProperties 的 `^word\\d+$` 形态提取 word 前缀作参数名（其余形态不加）。 */
function collectPatternPropertyNames(pp: unknown, out: Set<string>): void {
  if (pp === null || typeof pp !== "object") return;
  for (const p of Object.keys(pp as Record<string, unknown>)) {
    const m = p.match(/^\^([a-zA-Z]+)\\d\+\$$/);
    if (m) out.add(m[1] as string);
  }
}

/** W1 参数名集合 = parameters.properties keys + patternProperties 的 word 前缀。 */
function collectDeclaredParamNames(parameters: unknown): Set<string> {
  const paramNames = new Set<string>();
  if (parameters === null || typeof parameters !== "object") return paramNames;
  const params = parameters as Record<string, unknown>;
  collectObjectKeys(params.properties, paramNames);
  collectPatternPropertyNames(params.patternProperties, paramNames);
  return paramNames;
}

/** W1：单字段内已声明参数名的 ':'/'=' 形态检查（文案见 finding）。 */
function findParamNameFindings(
  field: string,
  value: string,
  paramNames: ReadonlySet<string>,
): LintFinding[] {
  const findings: LintFinding[] = [];
  // W1：已声明参数名的 ':'/'=' 形态（参数名转义防 RegExp 注入崩溃——exec-review F2；
  // ':' 形态加 \\b 前缀防子串误报（subtask: 不命中 task——exec-review F6））
  for (const name of paramNames) {
    const nameEsc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${nameEsc}:\\s`).test(value) || new RegExp(`\\b${nameEsc}=\\S`).test(value)) {
      findings.push({
        severity: "error",
        line: 1,
        message: `meta.${field} 包含已声明参数名 '${name}'（'${name}:' / '${name}=' 形态）——参数契约请 read 脚本文件的 @pi-meta parameters 查询，description/when/notFor 只放路由信息`,
        suggestion: `从 meta.${field} 移除 '${name}: ...' / '${name}=...'，改在 parameters/usage 中声明`,
      });
    }
  }
  return findings;
}

/**
 * W1-W3：SSOT lint（m4）——保 §5.1 注入段 description 短单句、不含已声明参数名。
 * 仅对 parseResourceMeta 解析成功的 meta 执行（旧 const meta 格式不检查）。
 *
 * W1 参数名匹配（非形态匹配）：'note:'/'Example:'/'a=b' 等 prose 不误报（design-review
 * 探针实测形态匹配误报面）；参数名集合 = meta.parameters.properties keys + patternProperties
 * 的 word 前缀（^word\\d+$ 转义形态）。检查面 = description + when + notFor 三字段
 * （同进 §5.1 注入段）。W2/W3 抽到 checkMetaFieldQuality（lintAgentMeta 共用）。
 */
function checkMetaQuality(meta: { description?: string; when?: string; notFor?: string; parameters?: Record<string, unknown> }): LintFinding[] {
  const findings: LintFinding[] = [];
  const paramNames = collectDeclaredParamNames(meta.parameters);

  const fields: Array<[string, string]> = [
    ["description", meta.description ?? ""],
    ["when", meta.when ?? ""],
    ["notFor", meta.notFor ?? ""],
  ];
  for (const [field, value] of fields) {
    if (value.length === 0) continue;
    findings.push(...findParamNameFindings(field, value, paramNames));
    findings.push(...checkMetaFieldQuality(field, value));
  }
  return findings;
}

/**
 * W2/W3 + W4（m4/m5 挂 agent 加载路径）：description/when/notFor 长度与单句检查
 * （与 workflow 同规则，S-5 对称）+ examples 正反各一。
 * RoutingExample.positive 判别（action 是 string 非 null）；examples 缺失 → 无 finding
 * （未迁移 agent 不报错——m5 挂载安全根基）。
 */
export function lintAgentMeta(meta: AgentMeta): LintFinding[] {
  // W2/W3（S-5 对称）：agent 的 description/when/notFor 与 workflow 同规则
  // （长度上限 + 单句判定）——formatAgentList 原样注入 systemPrompt，长描述是每 turn 常驻成本。
  const findings: LintFinding[] = [];
  const fields: Array<[string, string]> = [
    ["description", meta.description],
    ["when", meta.when ?? ""],
    ["notFor", meta.notFor ?? ""],
  ];
  for (const [field, value] of fields) {
    if (value.length === 0) continue;
    findings.push(...checkMetaFieldQuality(field, value));
  }

  const examples = meta.examples;
  if (examples === undefined) return findings; // 未迁移 agent（无 examples 字段）不报错
  if (examples.length === 0) {
    findings.push({
      severity: "error",
      line: 1,
      message: `agent '${meta.name}' 声明了 examples 但为空——需 ≥2 条且正反各一`,
      suggestion: "补正向样本（何时调用）+ 反向样本（何时不调用）",
    });
    return findings;
  }
  const hasPositive = examples.some((e) => e.positive === true);
  const hasNegative = examples.some((e) => e.positive === false);
  if (examples.length < EXAMPLES_MIN_COUNT || !hasPositive || !hasNegative) {
    findings.push({
      severity: "error",
      line: 1,
      message: `agent '${meta.name}' 的 examples 需 ≥2 条且正反各一（positive:true 触发路由 + positive:false 反例）`,
      suggestion: "补正向样本（何时调用）+ 反向样本（何时不调用）",
    });
    return findings;
  }
  if (examples.length > EXAMPLES_MAX_COUNT) {
    findings.push({
      severity: "error",
      line: 1,
      message: `agent '${meta.name}' 的 examples ${examples.length} 条超过上限 ${EXAMPLES_MAX_COUNT}（注入段是每 turn 常驻成本）`,
      suggestion: "精简到 2-4 条：正反各一 + 最多 2 条冗余",
    });
  }
  return findings;
}

export function lintScript(source: string): LintResult {
  const lines = source.split("\n");
  const findings: LintFinding[] = [];

  // 入口检查（必须有 agent/parallel/pipeline 之一）
  findings.push(...checkEntryPoint(source));

  // 逐行检查（result.output、文件传状态等）
  for (let i = 0; i < lines.length; i++) {
    findings.push(...checkLine(lines[i], i + 1));
  }

  // agent 调用上下文检查（outputSchema 作为 key）
  findings.push(...checkAgentCalls(source));

  // [HISTORICAL] 顶层未 await 的异步 IIFE + 内部调 agent——子进程被提前 kill。
  // 教训来源：daily-news-impact.js 用 (async function main(){...})();() 包裹整个脚本，
  // worker 外层 IIFE 不等内层 IIFE 就 postMessage("return")，主线程 transition done
  // → release runtime → controller.abort() → spawn 后 2ms SIGKILL 子进程。
  // 诊断耗时 4 轮：先后误判为 model 故障 / 工具缺失 / turn-signal abort / 并发门闩 gate 异常，
  // 最终靠 worker-host → handleReturn → release → abort 的调用栈定位。
  findings.push(...checkBareAsyncIIFE(source));

  // m4 W1-W3：meta 质量（description/when/notFor 短单句 + 不含已声明参数名）。
  // 仅对 IF1 解析成功的 @pi-meta 执行——旧 const meta 格式（D1 无 adapter）不检查。
  const meta = parseResourceMeta(source, "workflow");
  if (meta && meta.kind === "workflow") {
    findings.push(...checkMetaQuality(meta));
  }

  // 显示性检查（warning）：agent 缺 description / meta.phases 形式 / phase 一致性。
  // 目的：让 TUI /workflows 视图避免 unnamed agent 与 (unnamed) phase 分组。
  findings.push(...checkAgentDescription(source));
  findings.push(...checkMetaPhases(source));
  findings.push(...checkPhaseConsistency(source));

  // 按行号排序，稳定输出
  findings.sort((a, b) => a.line - b.line);

  return {
    valid: !findings.some((f) => f.severity === "error"),
    findings,
  };
}
