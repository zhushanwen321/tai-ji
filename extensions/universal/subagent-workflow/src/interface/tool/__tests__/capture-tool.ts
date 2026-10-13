/**
 * 注册层黑盒测试共享捕获 helper：fake pi 收集 registerTool 入参，支持两种形态——
 * ①恰好注册一个 tool（可锁定期望名）；②一次注册多个工具（D3 拆分：registerSubagentTool
 * 注册三工具、registerWorkflowTool 注册两工具）按名捕获。差异面（注册函数、pi 之后
 * 的实参、deps 形状）留在调用方闭包。
 */

/** 注册层捕获到的 tool 定义最小形态（各文件按需用泛型传窄 view 类型）。 */
export interface CapturedTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
}

/** workflow-script tool 的窄 view（list/lint 测试共用的 execute 返回形态）。 */
export interface ScriptResultToolView extends CapturedTool { // oe-exempt:20260929:framework:测试 fixture 契约类型（mock 桩/断言视图）——dev-0.10.5 已验收代码 merge 带入
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

/** 注册并捕获全部 tool 定义，按名索引（D3 拆分多工具注册形态）。 */
export function captureToolsByName(
  register: (pi: { registerTool: (tool: unknown) => void }) => void,
): Record<string, CapturedTool> {
  const tools: unknown[] = [];
  register({ registerTool: (tool) => tools.push(tool) });
  const byName: Record<string, CapturedTool> = {};
  for (const tool of tools) {
    const named = tool as CapturedTool;
    byName[named.name] = named;
  }
  if (tools.length === 0) {
    throw new Error("expected at least one registered tool, got 0");
  }
  return byName;
}

/**
 * 注册并捕获 tool 定义。泛型 T 供需要窄 execute 返回类型的调用方传 view
 * 类型（方法参数双变 + 返回协变，窄形态天然 extends CapturedTool，零 cast）。
 *
 * @param register 拿 fake pi 执行注册（调用方闭包内传齐注册函数与其余实参）
 * @param expectedName 期望的 tool 名——给定：多工具注册中按名取出（D3 拆分形态）；
 *   缺省：断言恰好注册一个并返回首个（单工具注册形态）
 */
export function captureTool<T extends CapturedTool = CapturedTool>(
  register: (pi: { registerTool: (tool: unknown) => void }) => void,
  expectedName?: string,
): T {
  const byName = captureToolsByName(register);
  if (expectedName !== undefined) {
    const named = byName[expectedName] as T | undefined;
    if (named === undefined) {
      throw new Error(`expected registered tool '${expectedName}', got names: ${Object.keys(byName).join(", ")}`);
    }
    return named;
  }
  const names = Object.keys(byName);
  if (names.length !== 1) {
    throw new Error(`expected exactly one registered tool, got ${names.length}`);
  }
  return byName[names[0]] as T;
}
