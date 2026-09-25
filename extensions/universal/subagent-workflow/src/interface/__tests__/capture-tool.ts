/**
 * 注册层黑盒测试共享捕获 helper：fake pi 收集 registerTool 入参，断言恰好注册
 * 一个 tool（可锁定期望名）并返回首个。此前 7 个测试文件各自内联同构拷贝
 * （fake pi + tools 数组 + name 断言 + CapturedTool 类型），收敛至此单点；
 * 差异面（注册函数、pi 之后的实参、deps 形状）留在调用方闭包。
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
export interface ScriptResultToolView extends CapturedTool {
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

/**
 * 注册并捕获 tool 定义。泛型 T 供需要窄 execute 返回类型的调用方传 view
 * 类型（方法参数双变 + 返回协变，窄形态天然 extends CapturedTool，零 cast）。
 *
 * @param register 拿 fake pi 执行注册（调用方闭包内传齐注册函数与其余实参）
 * @param expectedName 期望的 tool 名（缺省不锁定——仅断言恰好注册一个）
 */
export function captureTool<T extends CapturedTool = CapturedTool>(
  register: (pi: { registerTool: (tool: unknown) => void }) => void,
  expectedName?: string,
): T {
  const tools: unknown[] = [];
  register({ registerTool: (tool) => tools.push(tool) });
  const first = tools[0] as T | undefined;
  if (first === undefined || tools.length !== 1) {
    throw new Error(`expected exactly one registered tool, got ${tools.length}`);
  }
  if (expectedName !== undefined && first.name !== expectedName) {
    throw new Error(`expected registered tool '${expectedName}', got '${String(first.name)}'`);
  }
  return first;
}
