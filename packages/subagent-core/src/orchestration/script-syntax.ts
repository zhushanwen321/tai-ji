/**
 * Workflow 脚本语法闸（生成期与派发期共用原语）。
 *
 * 为什么独立成模块：同一道闸有两个消费场景——
 *   - 生成期（script-generate.generateWorkflowScript 的语法闸）：AI 生成脚本落盘前
 *     拦下，诊断文案回喂模型自纠正；
 *   - 派发期（lifecycle.runWorkflow / resume-run.resumeRun 入口）：手工编写或从别处
 *     拷进工作流目录的脚本没有生成期检查——脚本顶层重声明宿主名时，Worker 启动后
 *     以**异步**语法错暴露，被 worker 错误矩阵当成崩溃重试 MAX_WORKER_RETRIES 次
 *     才失败，错误分类与行号信息丢失。派发前拦下 = 在入口给同款诊断 + 恢复指引，
 *     且失败先于任何副作用（run 未创建 / resume 未落盘）。
 *
 * 文案契约：本模块返回的诊断文案与 pi 现版逐字一致（生成期 CA2 验收前提），
 * 不得改动；派发期在诊断外围追加恢复指引（见 WorkflowScriptSyntaxError）。
 *
 * 层归属：orchestration（脚本域共享原语）。
 */

/**
 * Worker 执行时在用户脚本作用域（async IIFE 顶层）预先声明的名字全集——
 * 镜像 worker-script-builder.ts 的宿主段（`(async () => {` 起至「User workflow
 * script」注释行止的全部声明）。语法闸（checkWorkflowScriptSyntax）以假声明拼接
 * 复现真实包裹作用域：脚本顶层重声明任一名字 = 真机 SyntaxError，必须在生成期/
 * 派发期拦下（曾因闸只包脚本文本、未拼宿主段，产物 `const args` 撞宿主别名仅在
 * 真机崩、生成期零信号）。
 *
 * 同步义务：worker-script-builder.ts 宿主段增删名字时本清单必须同改；检查 =
 * __tests__/script-generate.test.ts 的宿主声明对账用例（从 builder 源文本提取
 * 声明名与本清单互查）。
 */
export const WORKER_IIFE_HOST_DECLARED_NAMES = [
  "parentPort",
  "workerData",
  "_callIdCounter",
  "_agentCallCount",
  "_pendingCalls",
  "_callCache",
  "_currentPhase",
  "$ARGS",
  "args",
  "$WORKSPACE",
  "_budgetData",
  "$BUDGET",
  "$MODEL",
  "$THINKING_LEVEL",
  "WorkflowAbortedError",
  "phase",
  "log",
  "agent",
  "parallel",
  "pipeline",
] as const;

/** 语法闸：async IIFE + 宿主预声明假拼接——与 worker 真实包裹作用域一致，脚本顶层
 *  重声明宿主名（args / $ARGS / agent / …）在此红，而非真机 SyntaxError。
 *  @returns undefined = 通过；否则返回诊断文案（与 pi 现版逐字一致）。 */
export function checkWorkflowScriptSyntax(script: string): string | undefined {
  const cjsScript = script.replace(/\bexport\s+const\s+meta\b/, "const meta");
  const hostDecls = WORKER_IIFE_HOST_DECLARED_NAMES.map((n) => `const ${n} = null;`).join("\n");
  try {
    new Function(`(async () => {\n${hostDecls}\n${cjsScript} })();`);
    return undefined;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Syntax error in script: ${msg}`;
  }
}

/**
 * 派发期语法闸失败（runWorkflow / resumeRun 在启动 worker 前抛出）。
 *
 * 文案 = 生成期同款诊断 + 恢复指引：派发期没有 AI 自纠正回路，用户/agent 需要知道
 * 具体是「顶层声明撞了宿主预声明的名字」以及怎么改。
 */
export class WorkflowScriptSyntaxError extends Error {
  readonly workflowName: string;

  constructor(workflowName: string, detail: string) {
    super(
      `Workflow '${workflowName}' cannot run: ${detail} ` +
        `Recovery: rename the script-level declaration — the worker pre-declares these names ` +
        `in the script scope: ${WORKER_IIFE_HOST_DECLARED_NAMES.join(", ")}.`,
    );
    this.name = "WorkflowScriptSyntaxError";
    this.workflowName = workflowName;
  }
}

/**
 * 派发前语法闸（run / resume 入口共用）；失败先于任何副作用。
 *
 * 空脚本文本跳过：旧格式 run-created 记录无 scriptSource 字段（只有截断的
 * argsSummary），无文本可查；模板脚本的跳过面由各模板自带的 scriptPath 内建检查
 * 承担（缺锚即 core_module_load_failed）。
 */
export function assertWorkflowScriptSyntax(scriptName: string, scriptSource: string): void {
  if (scriptSource.trim() === "") return;
  const detail = checkWorkflowScriptSyntax(scriptSource);
  if (detail !== undefined) throw new WorkflowScriptSyntaxError(scriptName, detail);
}
