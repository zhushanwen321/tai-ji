// src/pi-invocation.ts
//
// 定位 pi 二进制并组装 spawn 调用（W7 迁 pi 包，core engines/pi/pi-invocation.ts
// 逐字等价副本；relay 常量经 @zhushanwen/subagent-engine-sdk 单源）。
//
// 处理三种运行时：
//   1. bun bundle（/$bunfs/root/ 虚拟脚本）→ 退化到 pi-in-PATH
//   2. 有真实脚本路径（node + script）→ node <script> <args>
//   3. node/bun generic runtime（无脚本）→ pi <args>（依赖 PATH）
//
// 注意：pi 在扩展进程内运行时 process.execPath 是 node/bun，process.argv[1]
// 是 pi 的入口脚本。子进程需要复现同样的启动方式才能保证扩展/配置一致加载。

import * as fs from "node:fs";
import * as path from "node:path";

import { isRelayActive, RELAY_ENV_NODE, RELAY_ENV_SCRIPT } from "@zhushanwen/subagent-engine-sdk";

/** spawn 调用描述符：command + args（透传给 spawnEngineChild）。 */
export interface PiInvocation {
  /** 可执行文件路径（node/bun/pi 二进制）。 */
  command: string;
  /** 命令行参数（可能含 [scriptPath, ...userArgs] 或直接 [...userArgs]）。 */
  args: string[];
}

/** getPiInvocation 可选项。 */
export interface PiInvocationOptions {
  /**
   * false = 强制直连 spawn 真实 pi（不经 relay 代理）。唯一现役消费点是 probe
   * ——探针意图是 pi 本体可解析性，经 relay 探到的是 runtime 健康，语义错位。
   */
  relay?: boolean;
}

/** bun 虚拟文件系统前缀（非磁盘真实文件，不能直接 spawn）。 */
const BUN_VIRTUAL_PREFIX = "/$bunfs/root/";

/** 引擎 CLI 自身 bin 的 basename（自举守卫用，见 getPiInvocation）。 */
const SELF_CLI_BIN_BASENAME = "pi-subagent-cli.mjs";

/**
 * 判断 execPath 的 basename 是否为通用运行时（node/bun）。
 * 通用运行时需要脚本路径才能启动 pi；非通用（pi standalone binary）可直接执行。
 */
function isGenericRuntime(execPath: string): boolean {
  const execName = path.basename(execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(execName);
}

/**
 * 组装 pi 子进程的 spawn 调用。
 *
 * 决策链（按优先级）：
 *   0. relay 激活（三 env 齐备且未显式禁用）→ <RELAY_NODE> <RELAY_SCRIPT> <userArgs>
 *      （W8/H12：改进程拓扑不改 pi 语义；归属键 SESSION_ID/RECORD_ID 不在此注入
 *      ——由 spawn-runner 按 run ctx 重写）
 *   1. process.argv[1] 是真实磁盘文件且非 bun 虚拟路径 → <execPath> <argv[1]> <userArgs>
 *   2. execPath 非通用运行时（pi standalone binary）→ <execPath> <userArgs>
 *   3. 通用运行时但无可用脚本路径 → "pi" <userArgs>（依赖 PATH）
 */
// [perf] 决策链只依赖 process.argv[1] / process.execPath（进程内恒定），唯一磁盘
// 探测（existsSync）结果按 argv[1] 值 memo——测试 mock 切换 argv[1] 自动失效重算。
let scriptExistsCache: { script: string | undefined; exists: boolean } | undefined;

/** process.argv[1] 是真实磁盘脚本（非 bun 虚拟路径）且存在。 */
function currentScriptExists(): boolean {
  const currentScript = process.argv[1];
  if (scriptExistsCache === undefined || scriptExistsCache.script !== currentScript) {
    scriptExistsCache = {
      script: currentScript,
      exists:
        currentScript !== undefined &&
        !currentScript.startsWith(BUN_VIRTUAL_PREFIX) &&
        fs.existsSync(currentScript),
    };
  }
  return scriptExistsCache.exists;
}

export function getPiInvocation(userArgs: string[], opts?: PiInvocationOptions): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith(BUN_VIRTUAL_PREFIX);
  // [W7] 引擎 CLI 自举守卫：本进程 argv[1] 是 pi-subagent-cli 自身 bin（真实磁盘
  // 文件，会被分支 1 误认成「pi 入口脚本」而递归 spawn 自己）。镜像语义的消费方
  // 是「pi 扩展进程内 spawn 子代理」（argv[1] = pi 入口）；引擎 CLI 进程不是 pi
  // 进程，argv[1] 指向自身时跳过分支 1，落 PATH / standalone 解析。
  const isSelfCliBin = currentScript !== undefined && path.basename(currentScript) === SELF_CLI_BIN_BASENAME;

  // 分支 0（前置）：relay 激活——spawn 目标切换为 <RELAY_NODE> <RELAY_SCRIPT>
  // <原 pi spawnArgs>。isRelayActive 已保证三 env 非空，取局部变量仅为 TS 收窄。
  if (opts?.relay !== false && isRelayActive(process.env)) {
    const relayNode = process.env[RELAY_ENV_NODE];
    const relayScript = process.env[RELAY_ENV_SCRIPT];
    if (relayNode !== undefined && relayScript !== undefined) {
      return { command: relayNode, args: [relayScript, ...userArgs] };
    }
  }

  // 分支 1：有真实脚本路径 → 复现启动方式（node <pi-script> <args>）
  if (currentScript && !isBunVirtualScript && !isSelfCliBin && currentScriptExists()) {
    return { command: process.execPath, args: [currentScript, ...userArgs] };
  }

  // 分支 2：非通用运行时（pi 自带 binary）→ 直接执行
  if (!isGenericRuntime(process.execPath)) {
    return { command: process.execPath, args: userArgs };
  }

  // 分支 3：通用运行时但脚本不可用 → 依赖 PATH
  return { command: "pi", args: userArgs };
}
