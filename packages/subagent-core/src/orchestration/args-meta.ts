// src/orchestration/args-meta.ts
//
// U9（D9 / B3 / B4）：workflow @pi-meta parameters（JSON Schema）→ 已知参数键集、
// args 平铺检测、参数归一组装。平移自 pi-sw tool-workflow.ts:136-196（m6「schema 即
// SSOT」——替代 21 键硬编码 KNOWN_ARG_KEYS，消除与参数定义的漂移面）。
//
// 相对 pi-sw 原实现的两处平台耦合剥离（行为等值，见实施计划偏差登记表）：
// - TOOL_TOP_LEVEL（pi workflow tool 顶层键集，pi 侧 schema 事实）→ 参数化 reservedKeys
//   由宿主注入（同 U1 knownNames / D7 queuePolicy 的宿主差异参数化先例）；core 引擎
//   无关，不内嵌任何宿主 tool schema。pi-sw 消费改造时传自己的 TOOL_TOP_LEVEL 即得
//   等值行为。
// - @zhushanwen/pi-extension-logger → core logger facade（同语义 warn，平台中立）。
//
// 平铺检测语义（m6 定稿，勿改）：弱模型把 args 子字段平铺到 params 顶层是 P0 级
// 静默失败（args ?? {} 会静默空启动），检测命中必须显式暴露——core 以 warnings 数据
// 承载，是否升级为 fatal 由宿主裁决（pi 现行为是 throw，消费改造时 adapter 对
// flattened_args 警告 throw 即等值）。

import { getLogger } from "../core/logger.ts";

const logger = getLogger("args-meta");

const EMPTY_RESERVED_KEYS: ReadonlySet<string> = new Set<string>();

/** 已知参数键集：exact = properties 精确键；patterns = patternProperties 原样转正则。 */
export interface ArgKeySet {
  readonly exact: ReadonlySet<string>;
  readonly patterns: readonly RegExp[];
}

/** 键集构建选项（宿主差异注入点）。 */
export interface ArgMetaOptions {
  /**
   * 宿主调用信封顶层保留键（如 pi workflow tool 的 action/name/slug/args/model/...）。
   * workflow 参数名与保留键撞名时，顶层同名键是信封参数而非平铺（m6 评审 M-3）：
   * exact 构建排除保留键；能命中任一保留键的 pattern 整条跳过（^run.*$ 类会误伤
   * runId/name 等合法调用，m6 exec-review S1）。缺省空集（core 中性形态）。
   */
  readonly reservedKeys?: ReadonlySet<string>;
}

/**
 * properties → exact 精确键集（排除 reservedKeys——workflow 参数名与保留键撞名时，
 * 顶层同名键是信封参数而非平铺，m6 评审 M-3）。非对象形状（含 undefined/null）
 * 返回空集。
 */
function collectExactKeys(props: unknown, reserved: ReadonlySet<string>): Set<string> {
  const exact = new Set<string>();
  if (props === null || typeof props !== "object") return exact;
  for (const k of Object.keys(props as Record<string, unknown>)) {
    if (!reserved.has(k)) exact.add(k);
  }
  return exact;
}

/**
 * patternProperties → 正则数组（schema pattern 已是正则源码，直接 new RegExp；
 * 自动兼容 \d{2} 等变体）。跳过能命中保留键的 pattern——否则 ^run.*$ 类 pattern
 * 会匹配 runId/name 等信封键，合法调用恒误报（m6 exec-review S1）。非法 pattern
 * （schema 校验 m3 已保证合法，双保险）跳过并 warn。
 */
function compilePatterns(pp: unknown, reserved: ReadonlySet<string>): RegExp[] {
  const patterns: RegExp[] = [];
  if (pp === null || typeof pp !== "object") return patterns;
  for (const p of Object.keys(pp as Record<string, unknown>)) {
    try {
      const re = new RegExp(p);
      if ([...reserved].some((tk) => re.test(tk))) continue;
      patterns.push(re);
    } catch (err) {
      logger.warn(`[args-meta] patternProperties 非法正则跳过: ${p}`, {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return patterns;
}

/**
 * 从 workflow 参数 schema（@pi-meta parameters）动态构建平铺检测的已知键集。
 *
 * - exact：properties keys（精确匹配，排除 reservedKeys）
 * - patterns：patternProperties 原样转正则数组（schema pattern 已是正则源码，
 *   直接 new RegExp；自动兼容 \d{2} 等变体）
 * - meta 缺失/非对象 → 空键集（legacy const-meta 类无参数契约，检测跳过）
 */
export function argKeysFromMeta(
  meta: Record<string, unknown> | undefined | null,
  options?: ArgMetaOptions,
): ArgKeySet {
  const reserved = options?.reservedKeys ?? EMPTY_RESERVED_KEYS;
  if (meta === undefined || meta === null || typeof meta !== "object") {
    return { exact: new Set<string>(), patterns: [] };
  }
  const schema = meta as Record<string, unknown>;
  return {
    exact: collectExactKeys(schema.properties, reserved),
    patterns: compilePatterns(schema.patternProperties, reserved),
  };
}

/**
 * 平铺检测内部谓词（接收已构建键集）——normalizeArgsByMeta 复用以避免二次构建
 * 键集触发重复 warn；公开入口 findFlattenedArgKeys(params, meta) 按设计签名接收
 * meta 并内联构建。两路径谓词逐字同源，行为必然一致。
 */
function filterFlattenedKeys(p: Record<string, unknown>, keys: ArgKeySet): string[] {
  const args = typeof p.args === "object" && p.args !== null ? p.args : undefined;
  const isKnownKey = (k: string) =>
    keys.exact.has(k) || keys.patterns.some((re) => re.test(k));
  // hasOwnProperty.call 而非 in（原型链——constructor/toString 类参数名不被继承键掩盖）
  return Object.keys(p).filter(
    (k) =>
      isKnownKey(k) &&
      !(args !== undefined && Object.prototype.hasOwnProperty.call(args, k)),
  );
}

/**
 * 检测弱模型把 args 子字段平铺到 params 顶层（P0 静默失败防护）。
 * 返回被平铺的键名列表（空 = 未平铺）。匹配谓词：exact 命中 || pattern 命中
 * （pattern 自带数字后缀语义——loose startsWith 会误报 batchl/target1）；args 内
 * 已存在的键不算平铺（顶层 + args 共存不算平铺）。
 *
 * 参数取 unknown 以解耦宿主 params 类型限制、便于测试构造任意对象。
 */
export function findFlattenedArgKeys(
  params: unknown,
  meta: Record<string, unknown> | undefined | null,
  options?: ArgMetaOptions,
): string[] {
  if (typeof params !== "object" || params === null) return [];
  const keys = argKeysFromMeta(meta, options);
  return filterFlattenedKeys(params as Record<string, unknown>, keys);
}

/** 组装层警告（结构化承载，宿主决定展示/日志/fatal 升级）。 */
export type ArgMetaWarning =
  | {
      /** 无参数契约（meta 未声明或解析为空）——平铺检测跳过，args 不校验（m6 M-2 显式信号）。 */
      code: "no_parameter_contract";
      message: string;
    }
  | {
      /** args 子字段被平铺到顶层——修正动作留宿主（pi 现行为是带 Correct 正例 throw）。 */
      code: "flattened_args";
      message: string;
      keys: readonly string[];
    };

/** normalizeArgsByMeta 产物。 */
export interface NormalizedArgs {
  /**
   * 归一后的 args：params.args ?? {}（params 非对象时为 {}）。args 字段为非对象
   * 标量时原样透传——类型校验责任在 args-validator（schema chokepoint），本函数
   * 不发明约束（与 m3 exec-review M2 裁决一致）。
   */
  readonly args: unknown;
  readonly warnings: readonly ArgMetaWarning[];
}

/**
 * 组装函数：按 meta 归一 params 为 { args, warnings }（pi actionRun 参数处理段的
 * 纯函数化——argKeysFromMeta + 空契约信号 + 平铺检测 + args 归一四步单点收口）。
 *
 * 警告语义与 pi 现行为对位：
 * - no_parameter_contract ↔ pi logger.warn「未声明参数契约——平铺检测跳过」（M-2）
 * - flattened_args ↔ pi throw「Detected ... they belong inside 'args'」（Correct
 *   正例含宿主 tool 键 action/name——平台事实留宿主拼接，core 文案保持中立）
 */
export function normalizeArgsByMeta(
  params: unknown,
  meta: Record<string, unknown> | undefined | null,
  options?: ArgMetaOptions,
): NormalizedArgs {
  const keys = argKeysFromMeta(meta, options);
  const warnings: ArgMetaWarning[] = [];
  if (keys.exact.size === 0 && keys.patterns.length === 0) {
    // m6 exec-review M1：无参数契约（未声明/解析空）→ 显式警告——静默退化变显式
    warnings.push({
      code: "no_parameter_contract",
      message: "未声明参数契约（或解析为空）——平铺检测跳过，args 不校验",
    });
  }
  if (typeof params === "object" && params !== null) {
    const p = params as Record<string, unknown>;
    const flattened = filterFlattenedKeys(p, keys);
    if (flattened.length > 0) {
      warnings.push({
        code: "flattened_args",
        keys: flattened,
        message: `Detected ${flattened.join(", ")} at top level — they belong inside 'args'.`,
      });
    }
    return { args: p.args ?? {}, warnings };
  }
  return { args: {}, warnings };
}
