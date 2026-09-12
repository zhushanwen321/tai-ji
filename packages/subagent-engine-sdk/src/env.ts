// src/env.ts
//
// 引擎子进程 env 契约（W12，impl-plan §2.12 / 设计 §3.5.1 D7）。
//
// F9：buildOutboundChildEnv 在 @xyz-agent/shared，而 SDK 的消费面（zsw 宿主、引擎
// CLI 包）不可依赖 shared——SDK 是跨宿主 SSOT，故本文件自持全部常量与构建器，
// 不 import @xyz-agent/shared。
//
// 基座常量单源：下方 ENGINE_ENV_PREFIXES / ENGINE_ENV_DENY_LIST 是
// packages/shared/src/constants.ts 同名 SSOT 的构建期生成物（逐项相等由
// .githooks/check_env_whitelist_sync.py 断言）；改动必须两处同批提交。

import { getLogger } from "./logger.ts";

const logger = getLogger("engine-sdk/env");

// ─────────────────────────────────────────────────────────────────────────────
// 基座常量（@generated 镜像：packages/shared/src/constants.ts ENGINE_ENV_* SSOT）
// ─────────────────────────────────────────────────────────────────────────────

/** L2 manifest 放行的保留前缀拒绝表（镜像 shared SSOT，勿单独改动）。 */
export const ENGINE_ENV_PREFIXES: readonly string[] = [
  'XYZ_', 'XYZ_AGENT_', 'XYZ_SUBAGENT_',
];

/** L1 deny + 显式剥除键集（镜像 shared SSOT，勿单独改动）。 */
export const ENGINE_ENV_DENY_LIST: readonly string[] = [
  'XYZ_AGENT_PACKAGED',
  'XYZ_RUNTIME_TOKEN',
  'XYZ_AGENT_API_KEY',
  'XYZ_SUBAGENT_RELAY_SESSION_ID',
  'XYZ_SUBAGENT_RELAY_RECORD_ID',
];

// ─────────────────────────────────────────────────────────────────────────────
// L0 基础设施键（core 过滤之后显式注入，不受放行/剥除约束）
// ─────────────────────────────────────────────────────────────────────────────

/** L0 注入的全部基础设施键（守卫断言：与 ENGINE_ENV_DENY_LIST 交集 = ∅）。 */
export const ENGINE_ENV_L0_INFRA_KEYS: readonly string[] = [
  'XYZ_AGENT_DATA_DIR',
  'XYZ_AGENT_ENGINE_NODE',
  'ELECTRON_RUN_AS_NODE',
  'XYZ_AGENT_SUBAGENT',
  'XYZ_SUBAGENT_RELAY_SOCKET',
  'XYZ_SUBAGENT_RELAY_NODE',
  'XYZ_SUBAGENT_RELAY_SCRIPT',
];

/** relay 三键形态（宿主 relay 激活时三值同时非空，全有或全无）。 */
export interface EngineRelayEnv {
  socket: string;
  node: string;
  script: string;
}

/** buildEngineChildEnv 入参。 */
export interface EngineChildEnvOptions {
  /** L0：引擎数据根（隔离库/池/journal 都相对它推导；缺 env 且无注入引擎侧须显式报错） */
  dataDir: string;
  /** L0：执行器路径（descriptor command 的执行体；Electron 二进制时另置 electronRunAsNode） */
  engineNode?: string;
  /** L0：执行器为 Electron 二进制 → 注入 ELECTRON_RUN_AS_NODE=1 */
  electronRunAsNode?: boolean;
  /** L0：relay 三键（宿主 relay 激活时传；三键必经 L0——L1 拒绝 XYZ_SUBAGENT_ 前缀、L2 是 manifest 面，两层都到不了） */
  relay?: EngineRelayEnv;
  /** L0：引擎侧身份 env（PI_SUBAGENT_ROOT_SESSION_ID 等，base-tool-enhance / 递归可见性消费） */
  identityEnv?: Record<string, string | undefined>;
  /** L2：manifest 声明的 envPrefixes 放行清单（保留前缀拒绝 + 形态校验） */
  envPrefixes?: readonly string[];
  /** L2：引擎私有 env 候选（descriptor processEnv；未声明前缀不放行 + warn） */
  processEnv?: Record<string, string | undefined>;
}

/** manifest envPrefixes 合法形态：大小写不敏感的 [A-Za-z0-9_]+（如 `MYENGINE_`）。 */
const ENV_PREFIX_SHAPE_RE = /^[A-Za-z0-9_]+$/;

/** deny/剥除键删除：Windows env 键语义不区分大小写，统一 lower-case 比较。 */
function deleteEnvKeysCaseInsensitive(
  env: Record<string, string>,
  names: readonly string[],
): void {
  const lowered = new Set(names.map((n) => n.toLowerCase()));
  for (const key of Object.keys(env)) {
    if (lowered.has(key.toLowerCase())) delete env[key];
  }
}

/**
 * L2 前缀清单武装：逐条形态校验 + 保留前缀拒绝，非法条目丢弃 + warn（包继续可用）。
 * 返回 null 表示无任何合法前缀（跳过 processEnv 放行）。
 */
function compileManifestPrefixes(prefixes: readonly string[]): string[] | null {
  const compiled: string[] = [];
  for (const raw of prefixes) {
    if (!ENV_PREFIX_SHAPE_RE.test(raw)) {
      logger.warn(
        `envPrefixes entry dropped (invalid shape, expected ^[A-Za-z0-9_]+$): ${JSON.stringify(raw)}`,
      );
      continue;
    }
    const lowered = raw.toLowerCase();
    if (ENGINE_ENV_PREFIXES.some((reserved) => lowered.startsWith(reserved.toLowerCase()))) {
      logger.warn(
        `envPrefixes entry dropped (reserved prefix, infra keys are L0-only): ${JSON.stringify(raw)}`,
      );
      continue;
    }
    compiled.push(lowered);
  }
  return compiled.length > 0 ? compiled : null;
}

/**
 * L2 manifest 放行：envPrefixes 声明前缀的 processEnv 键写入 env。
 * - 双侧声明（processEnv + envPrefixes）→ compile 后按前缀放行，未命中 warn；
 * - 只声明 processEnv（manifest 无 envPrefixes）→ 全部不放行 + warn。
 */
function applyManifestAllowlist(
  env: Record<string, string>,
  opts: EngineChildEnvOptions,
): void {
  if (opts.processEnv !== undefined && opts.envPrefixes !== undefined) {
    const compiled = compileManifestPrefixes(opts.envPrefixes);
    if (compiled !== null) {
      for (const [key, value] of Object.entries(opts.processEnv)) {
        if (value === undefined) continue;
        const loweredKey = key.toLowerCase();
        if (compiled.some((prefix) => loweredKey.startsWith(prefix))) {
          env[key] = value;
        } else {
          logger.warn(`processEnv key not allowed (no declared envPrefix matches): ${key}`);
        }
      }
    }
  } else if (opts.processEnv !== undefined) {
    for (const key of Object.keys(opts.processEnv)) {
      logger.warn(`processEnv key not allowed (manifest declares no envPrefixes): ${key}`);
    }
  }
}

/**
 * L0 基础设施键显式注入（最后写入 = 最高优先级）：dataDir 恒注入 / engineNode、
 * ELECTRON_RUN_AS_NODE（条件）/ XYZ_AGENT_SUBAGENT=1 / relay 三键 / identityEnv。
 */
function injectL0InfraKeys(
  env: Record<string, string>,
  opts: EngineChildEnvOptions,
): void {
  env.XYZ_AGENT_DATA_DIR = opts.dataDir;
  if (opts.engineNode !== undefined) env.XYZ_AGENT_ENGINE_NODE = opts.engineNode;
  if (opts.electronRunAsNode === true) env.ELECTRON_RUN_AS_NODE = "1";
  env.XYZ_AGENT_SUBAGENT = "1";
  if (opts.relay !== undefined) {
    env.XYZ_SUBAGENT_RELAY_SOCKET = opts.relay.socket;
    env.XYZ_SUBAGENT_RELAY_NODE = opts.relay.node;
    env.XYZ_SUBAGENT_RELAY_SCRIPT = opts.relay.script;
  }
  if (opts.identityEnv !== undefined) {
    for (const [key, value] of Object.entries(opts.identityEnv)) {
      if (value !== undefined) env[key] = value;
    }
  }
}

/**
 * `buildEngineChildEnv(baseEnv, opts)`：引擎子进程 env 三层契约（高者覆盖低者）。
 *
 * 写死次序 = 先过滤（L1 deny/剥除 → L2 manifest 放行）后 L0 显式注入——
 * 「core 过滤之后显式注入」即此语义：baseEnv 是调用方（core/宿主）已过滤的基座，
 * L0 键在最后写入故不受 L1 剥除影响（交集为 ∅ 由测试断言兜底）。
 *
 * 层规格（impl-plan §2.12 三层表）：
 * - L0 基础设施键：XYZ_AGENT_DATA_DIR / XYZ_AGENT_ENGINE_NODE / ELECTRON_RUN_AS_NODE
 *   （条件）/ XYZ_AGENT_SUBAGENT=1 / relay 三键 / identityEnv（injectL0InfraKeys）；
 * - L1 deny + 显式剥除（恒高于 manifest 放行）：ENGINE_ENV_DENY_LIST
 *   （deny 两键 + 凭证键 + 父身份键 + 防御性剥除三死名）；
 * - L2 manifest 放行：envPrefixes 声明前缀的 processEnv 键（保留前缀拒绝、
 *   形态校验、未声明前缀不放行 + warn）（applyManifestAllowlist）。
 *
 * 红线：纯函数，不读写 process.env 本体，不 mutate 入参。
 */
export function buildEngineChildEnv(
  baseEnv: Record<string, string | undefined>,
  opts: EngineChildEnvOptions,
): Record<string, string> {
  // 基座拷贝（undefined 值不进 env——Node spawn 的 env 值须是 string）
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }

  // L1：deny + 显式剥除（先于 L0，保证 L0 注入不受剥除影响）
  deleteEnvKeysCaseInsensitive(env, ENGINE_ENV_DENY_LIST);

  // L2：manifest envPrefixes 放行 processEnv（在 L0 之前——L0 基础设施键优先级最高）
  applyManifestAllowlist(env, opts);

  // L1 兜底复检：deny/剥除恒高于 manifest 放行——宽前缀（如声明 XYZ_ 形态的
  // 宽松清单）也不允许经 L2 把 deny 键带回来。L0 未注入，此轮只清 L2 写入面。
  deleteEnvKeysCaseInsensitive(env, ENGINE_ENV_DENY_LIST);

  // L0：基础设施键显式注入（最后写入 = 最高优先级）
  injectL0InfraKeys(env, opts);

  return env;
}

// ─────────────────────────────────────────────────────────────────────────────
// 通用出站构建器（引擎无关 deny 剥离）
// ─────────────────────────────────────────────────────────────────────────────

/** buildOutboundChildEnv 入参（SDK 版；语义见函数头注释）。 */
export interface BuildOutboundChildEnvOptions {
  /** 父进程 env 快照（调用方显式注入；本函数绝不改写它） */
  parentEnv: Record<string, string | undefined>;
  /** 强制注入/覆盖的键；值为 undefined 时执行删除语义 */
  extras?: Record<string, string | undefined>;
  /** 基座前缀白名单；缺省 = 全量继承父 env（与 shared 版的差异，见函数头注释） */
  prefixes?: readonly string[];
}

/**
 * 通用子进程出站 env 构建器（deny 剥离终态），供非引擎 spawn 面（worktree git
 * execFile 等）复用——R3 MF-C：deny 键不进 git 子进程，git hooks 等后代不再可能
 * 消费生命周期标志 / WS 令牌。
 *
 * 与 @xyz-agent/shared 版 buildOutboundChildEnv 的刻意差异：**缺省不做白名单过滤**
 * （prefixes 省略 = 全量继承父 env + deny 剥除）。理由：SDK 消费面（zsw 宿主 /
 * 引擎 CLI）不可 import shared 的 ENV_WHITELIST_PREFIXES；引擎 spawn 的基座由
 * 调用方先经 buildEngineChildEnv 组装（其 baseEnv 已是 core 过滤后的），而
 * ambient 场景（git 需要 GIT_* / proxy / ssh 等）必须保留继承面——deny-by-default
 * 兜底语义与 shared 版一致。需要白名单形态时调用方显式传 prefixes。
 *
 * 红线：纯函数，不读写 process.env 本体，不 mutate 入参。
 */
export function buildOutboundChildEnv(
  opts: BuildOutboundChildEnvOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  const loweredPrefixes =
    opts.prefixes !== undefined
      ? opts.prefixes.map((p) => p.toLowerCase())
      : null;
  for (const [key, value] of Object.entries(opts.parentEnv)) {
    if (value === undefined) continue;
    if (loweredPrefixes !== null) {
      const loweredKey = key.toLowerCase();
      if (!loweredPrefixes.some((prefix) => loweredKey.startsWith(prefix))) continue;
    }
    out[key] = value;
  }
  if (opts.extras !== undefined) {
    for (const [key, value] of Object.entries(opts.extras)) {
      if (value !== undefined) out[key] = value;
      else delete out[key];
    }
  }
  deleteEnvKeysCaseInsensitive(out, ENGINE_ENV_DENY_LIST);
  return out;
}
