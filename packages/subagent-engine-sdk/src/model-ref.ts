// src/model-ref.ts
//
// 模型引用串（`provider/id[:thinkingLevel]`）的语法与 thinking 档位词表单点。
//
// 为什么在 SDK：模型引用是引擎协议的线上面（`run.params.task.model` / `ctx.ctxModel` /
// outcome 的引擎投影都以它为单位），而消费方横跨 host（subagent-core）、壳（runtime）、
// 两个引擎 CLI 与前端——它们都能依赖本包（published、零 workspace 依赖），因此这里是
// 唯一可以放「一份实现、所有侧共用」的地方。历史形态是三份副本 + 一个比对脚本
// （llm-shared / pi-rpc / subagent-core），本模块是收敛目标。
//
// 边界纪律（与 index.ts 同款）：本包禁止 import subagent-core；本模块零依赖。
// 宿主侧裁决（registry 全等匹配、大小写孪生拒绝、纠错候选）留在 subagent-core。

/**
 * thinking level 支持顺序（低→高）。spawn 侧 `:level` 后缀只接受本白名单值。
 * 值域与 pi-ai 的 `ModelThinkingLevel` 联合一致（升级 pi 时同步，比对由
 * `scripts/check-thinking-levels.mjs` 机器拦截）。
 */
export const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 合法 thinking level 字面量联合（类型层面收窄，裸字符串不可达 spawn 拼接）。 */
export type ThinkingLevel = (typeof THINKING_ORDER)[number];

/** 运行期收窄：unknown 是否为合法 thinking level（配置/协议入参校验用）。 */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_ORDER as readonly string[]).includes(value);
}

/**
 * 校验 thinkingLevel 属于白名单，返回窄化类型。
 *
 * spawn 参数的 thinkingLevel 类型即 ThinkingLevel（联合类型，编译期挡住裸字符串）；
 * 本断言是运行期防线（防 JS 调用方/动态数据绕过类型）。undefined 透传（无显式档位）。
 */
export function assertThinkingLevel(level: string | undefined): ThinkingLevel | undefined {
  if (level === undefined) return undefined;
  const hit = THINKING_ORDER.find((l) => l === level);
  if (hit === undefined) {
    throw new Error(
      `Invalid thinkingLevel "${level}". Allowed values: ${THINKING_ORDER.join(", ")}. ` +
        `Retry with one of the allowed values, or omit the param.`,
    );
  }
  return hit;
}

/**
 * 模型引用串的无损解析结果。
 * 语法：`provider/id[:thinkingLevel]`——`/` 取第一个（id 自身可含 `/`）；`:level` 后缀
 * 只有在取值落在白名单时才不属于 id（`foo:bar` 这类冒号仍属 id）。
 */
export interface ParsedModelSelector { // oe-exempt:20260930:framework:SDK 协议契约层的解析结果类型——唯一生产者为 parseModelSelector（跨包消费面），非单实现投机抽象
  /** 原始输入串（未处理）。 */
  readonly input: string;
  /** 剥掉合法档位后缀后的串（身份裁决与 registry 匹配用）。 */
  readonly ref: string;
  /** ref 里的 provider（无 `/` 或 `/` 在首位时为空串）。 */
  readonly provider: string;
  /** ref 里的 id（无 `/` 时为空串）。 */
  readonly id: string;
  /** 串里显式写明的思考档位（仅白名单值时给出）。 */
  readonly thinkingLevel?: ThinkingLevel;
}

/** 剥离尾部 `:thinkingLevel` 后缀（仅白名单值；模块私有，对外用 parseModelSelector）。 */
function stripThinkingSuffix(modelStr: string): string {
  const alt = THINKING_ORDER.slice().sort((a, b) => b.length - a.length).join("|");
  return modelStr.replace(new RegExp(`:(${alt})$`), "");
}

/**
 * 解析模型引用串——**档位随串一起返回**。
 * 只返回剥干净的串会让调用方把串里显式写的档位丢掉（历史上正是如此：用户写
 * `model: "p/m:low"` 而实际按缺省最高档执行）。需要档位的调用方一律用本函数。
 */
export function parseModelSelector(input: string): ParsedModelSelector {
  const ref = stripThinkingSuffix(input);
  const level = ref === input ? undefined : (input.slice(ref.length + 1) as ThinkingLevel);
  const slashIdx = ref.indexOf("/");
  const provider = slashIdx > 0 ? ref.slice(0, slashIdx) : "";
  const id = slashIdx > 0 ? ref.slice(slashIdx + 1) : "";
  return {
    input,
    ref,
    provider,
    id,
    ...(level !== undefined ? { thinkingLevel: level } : {}),
  };
}

/**
 * `provider/id` 形态判据（与解析同源；provider 与 id 都必须非空）。
 * 供「先校验格式、再落盘/回显」的调用方使用，替代各自手写的正则或切分。
 */
export function isModelRef(input: string): boolean {
  const { provider, id } = parseModelSelector(input);
  return provider.length > 0 && id.length > 0;
}
