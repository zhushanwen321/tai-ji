// src/node-executor.ts
//
// 引擎 CLI 启动解析（W9，impl-plan §2.9「启动解析（宿主 × 平台二维矩阵）」）。
//
// 为什么在 SDK：core/引擎包都不可 import runtime（runtime 包只存在于 taiji 宿主
// 链），而矩阵的三宿主（pi 扩展 / runtime sidecar / standalone）两侧都要消费同一套
// 解析规则——探针逻辑在 SDK 侧复刻 runtime 先例
// packages/runtime/src/infra/relay/relay-env.ts:47-90（行为保持一致：同超时、同
// --eval process.exit(0) 探针体、同 PATH/HOME 最小 env、同 Electron RUN_AS_NODE 条件）。
//
// 矩阵（规格逐行对应）：
//   ① pi 扩展宿主（打包）：process.execPath 是 Bun standalone binary，再拉就是又起
//      一个 pi——必须用注入执行器 TAIJI_AGENT_ENGINE_NODE（与 relay 的
//      TAIJI_SUBAGENT_RELAY_NODE 不复用，单一名字）；执行器为 Electron 二进制时同时带
//      ELECTRON_RUN_AS_NODE=1；首次使用前跑探针，失败 → engine_not_found + 指引。
//   ② runtime sidecar：process.execPath + ELECTRON_RUN_AS_NODE=1（sidecar 本身由主进程
//      以该形态 spawn，其 execPath 即宿主 Electron / dev node）。
//   ③ standalone pi / zsw：PATH node（缺 node → engine_not_found + 安装指引）。
//   Windows：入口 .mjs 不需 shim；引擎声明 .cmd → 禁 shell:true，改显式
//   cmd.exe /c + 参数数组。
//
// env 名常量与 packages/shared/src/constants.ts 的 W9 挂载块同源（SDK 不 import
// shared——F9，见 env.ts 头注释同款理由）。

import { spawn } from "node:child_process";

import { EngineSdkError } from "./protocol/error-codes.ts";

/** L0 注入的引擎执行器路径 env（与 relay 的 TAIJI_SUBAGENT_RELAY_NODE 不复用）。 */
export const ENGINE_NODE_ENV = "TAIJI_AGENT_ENGINE_NODE";

/** 探针超时（与 relay-env.ts 先例一致：spawn 执行器跑 --eval "process.exit(0)" 的上限）。 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * 探针：验证执行器能以纯 node 语义执行 JS（先例 = runtime relay-env.ts:47-90）。
 *
 * 为什么需要：打包态 pi 宿主的候选执行器可能是 Electron 二进制——直接当 node 用会
 * 拉起 GUI，必须同 env 注入 ELECTRON_RUN_AS_NODE=1 才是纯 node 模式；探针被证伪则
 * 按矩阵① 报 engine_not_found（带可操作指引），不静默回落 PATH 探测。
 */
export function probeNodeExecutor(
  execPath: string,
  isElectron: boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {
        // 已退出，正常路径
        void 0;
      }
      resolve(ok);
    };
    const env: Record<string, string> = {};
    if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
    if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
    if (isElectron) env.ELECTRON_RUN_AS_NODE = "1";

    try {
      child = spawn(execPath, ["--eval", "process.exit(0)"], {
        env,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    timer.unref();
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

/** 探针结果缓存（key = execPath:isElectron）。失败也缓存——重试窗口留给宿主重启。 */
const probeCache = new Map<string, Promise<boolean>>();

function probeCached(execPath: string, isElectron: boolean): Promise<boolean> {
  const key = `${execPath}:${isElectron}`;
  let p = probeCache.get(key);
  if (!p) {
    p = probeNodeExecutor(execPath, isElectron);
    probeCache.set(key, p);
  }
  return p;
}

/** 测试钩子：清探针缓存（生产无调用方；与 relay-env resetRelayNodeProbeCache 同款）。 */
export function resetEngineNodeProbeCache(): void {
  probeCache.clear();
}

/** 宿主形态（矩阵行；EngineClient 的 hostKind 自由字符串经 hostKindOf 归一）。 */
export type EngineNodeHostKind = "pi-extension" | "runtime-sidecar" | "standalone";

/** resolveEngineNodeLaunch 的可注入项（测试隔离用；生产全部走缺省推导）。 */
export interface EngineNodeLaunchOptions {
  /** 引擎 CLI 入口绝对路径（descriptor command / staged bin 解析结果）。 */
  entryPath: string;
  /** 入口附加参数（descriptor args；缺省 []）。 */
  args?: readonly string[];
  /** 宿主形态。 */
  hostKind: EngineNodeHostKind;
  /** 读取 TAIJI_AGENT_ENGINE_NODE 的 env 快照（矩阵① 的注入通道）。 */
  env?: Record<string, string | undefined>;
  /** 宿主 process.execPath（缺省 process.execPath）。 */
  execPath?: string;
  /** 宿主自身是否 Electron（缺省 process.versions.electron !== undefined）。 */
  isElectronHost?: boolean;
  /** 平台覆盖（缺省 process.platform）。 */
  platform?: NodeJS.Platform;
}

/** 解析结果：spawn(command, args) 形态 + buildEngineChildEnv 的 electronRunAsNode 输入。 */
export interface EngineNodeLaunch {
  command: string;
  args: string[];
  /** 执行器为 Electron 二进制 → true（L0 注入 ELECTRON_RUN_AS_NODE=1）。 */
  electronRunAsNode: boolean;
}

function engineNotFound(detail: string, recovery: string): EngineSdkError {
  return new EngineSdkError("engine_not_found", detail, recovery);
}

/** 传入 opts.env 的快照（矩阵① env 缺省 = 宿主 process.env）。 */
function launchEnvOf(opts: EngineNodeLaunchOptions): Record<string, string | undefined> {
  return opts.env ?? process.env;
}

/**
 * 矩阵①：pi 扩展宿主（打包）——必须用注入执行器 TAIJI_AGENT_ENGINE_NODE
 * （env 缺失 = engine_not_found；执行器探针失败 = engine_not_found + 指引）。
 */
async function resolvePiExtensionLaunch(
  entryPath: string,
  entryArgs: string[],
  env: Record<string, string | undefined>,
): Promise<EngineNodeLaunch> {
  const engineNode = env[ENGINE_NODE_ENV]?.trim();
  if (engineNode === undefined || engineNode === "") {
    throw engineNotFound(
      `pi extension host must spawn engines via injected executor ${ENGINE_NODE_ENV}, `
        + `but it is not set (host process.execPath is the pi binary, not a node executor)`,
      `The taiji runtime injects ${ENGINE_NODE_ENV} when spawning the pi host. `
        + `If you are running the extension inside a packaged app, report this as a packaging `
        + `regression; standalone pi installs do not use the pi-extension host kind.`,
    );
  }
  // 执行器为 Electron 二进制时宿主会同时注入 ELECTRON_RUN_AS_NODE=1（矩阵① 同点注入）
  const isElectron = env.ELECTRON_RUN_AS_NODE === "1";
  if (!(await probeCached(engineNode, isElectron))) {
    throw engineNotFound(
      `injected node executor failed the probe: ${engineNode} (isElectron=${isElectron})`,
      `Verify the executor exists and can run plain node semantics `
        + `(Electron binaries need ELECTRON_RUN_AS_NODE=1). The host re-probes after restart.`,
    );
  }
  return { command: engineNode, args: [entryPath, ...entryArgs], electronRunAsNode: isElectron };
}

/**
 * 矩阵②：runtime sidecar——process.execPath + ELECTRON_RUN_AS_NODE=1（Electron 宿主时，
 * 探针先行）。
 */
async function resolveRuntimeSidecarLaunch(
  entryPath: string,
  entryArgs: string[],
  opts: EngineNodeLaunchOptions,
): Promise<EngineNodeLaunch> {
  const execPath = opts.execPath ?? process.execPath;
  const isElectron = opts.isElectronHost ?? process.versions.electron !== undefined;
  if (!(await probeCached(execPath, isElectron))) {
    throw engineNotFound(
      `runtime sidecar executor failed the probe: ${execPath} (isElectron=${isElectron})`,
      `The sidecar process.execPath must run plain node semantics (ELECTRON_RUN_AS_NODE=1 `
        + `for Electron binaries). Check how the runtime sidecar was spawned.`,
    );
  }
  return { command: execPath, args: [entryPath, ...entryArgs], electronRunAsNode: isElectron };
}

/** 矩阵③：standalone——PATH node（探针被证伪 = engine_not_found + 安装指引）。 */
async function resolveStandaloneLaunch(
  entryPath: string,
  entryArgs: string[],
): Promise<EngineNodeLaunch> {
  if (!(await probeCached("node", false))) {
    throw engineNotFound(
      `no usable 'node' on PATH for standalone engine launch (entry: ${entryPath})`,
      `Install Node.js >= 22 and ensure 'node' is on PATH `
        + `(https://nodejs.org/), or configure the engine explicitly via subagents/config.json.`,
    );
  }
  return { command: "node", args: [entryPath, ...entryArgs], electronRunAsNode: false };
}

/**
 * 宿主 × 平台二维矩阵解析（W9 §2.9）。返回 spawn argv；不直接 spawn——调用方
 * （EngineClient / runtime）持有各自的平台参数（detached / 进程组收割语义）。
 *
 * 判定序（与规格逐行对应）：
 *   Windows + entry .cmd → cmd.exe /c 显式形态（禁 shell:true 的注入面）；
 *   pi-extension → 注入执行器（env TAIJI_AGENT_ENGINE_NODE），缺失/探针失败 =
 *     engine_not_found + 指引；
 *   runtime-sidecar → process.execPath（Electron 时 electronRunAsNode，探针先行）；
 *   standalone → PATH node（探针失败 = engine_not_found + 安装指引）；
 *   其余（dev 形态、非 Windows 非 .cmd、无矩阵命中的兜底）→ 直接 spawn 入口本体
 *   （shebang `#!/usr/bin/env node` 走 PATH node——引擎 bin 均带 shebang，dev/独立
 *   安装形态与现状一致）。
 */
export async function resolveEngineNodeLaunch(
  opts: EngineNodeLaunchOptions,
): Promise<EngineNodeLaunch> {
  const platform = opts.platform ?? process.platform;
  const entryArgs = [...(opts.args ?? [])];

  // Windows 规则：入口 .cmd → 显式 cmd.exe /c + 参数数组（禁 shell:true）
  if (platform === "win32" && opts.entryPath.toLowerCase().endsWith(".cmd")) {
    return {
      command: "cmd.exe",
      args: ["/c", opts.entryPath, ...entryArgs],
      electronRunAsNode: false,
    };
  }

  // 非 JS 入口（原生二进制 / shell 脚本形态的引擎或测试 fixture）自管理执行体：
  // 不经 node 执行器改写、不探针——直接 spawn 入口本体（shebang/原生入口语义）。
  if (!/\.(?:js|mjs|cjs|ts)$/i.test(opts.entryPath)) {
    return { command: opts.entryPath, args: entryArgs, electronRunAsNode: false };
  }

  if (opts.hostKind === "pi-extension") {
    return resolvePiExtensionLaunch(opts.entryPath, entryArgs, launchEnvOf(opts));
  }

  if (opts.hostKind === "runtime-sidecar") {
    return resolveRuntimeSidecarLaunch(opts.entryPath, entryArgs, opts);
  }

  if (opts.hostKind === "standalone") {
    return resolveStandaloneLaunch(opts.entryPath, entryArgs);
  }

  // 非矩阵形态（理论不可达——hostKind 是封闭联合）；保守回落直接 spawn 入口本体。
  return { command: opts.entryPath, args: entryArgs, electronRunAsNode: false };
}

/**
 * EngineClient 的自由字符串 hostKind（'pi' / 'runtime' / …）→ 矩阵行归一：
 *   'runtime*' → runtime-sidecar（②：sidecar execPath 权威）；
 *   env 已注入 TAIJI_AGENT_ENGINE_NODE（打包态 runtime 注入主 pi 进程的通道）→
 *     pi-extension（①：必须用注入执行器——pi 宿主自身 execPath 是 pi binary）；
 *   其余 → standalone（③：PATH node）。
 */
export function hostKindOf(
  hostKind: string,
  env: Record<string, string | undefined> = process.env,
): EngineNodeHostKind {
  if (hostKind.startsWith("runtime")) return "runtime-sidecar";
  const engineNode = env[ENGINE_NODE_ENV]?.trim();
  if (engineNode !== undefined && engineNode !== "") return "pi-extension";
  return "standalone";
}
