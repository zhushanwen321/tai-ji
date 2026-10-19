// src/pi-invocation.ts
//
// 定位 pi 二进制并组装 spawn 调用（W7 迁 pi 包，core engines/pi/pi-invocation.ts
// 逐字等价副本）。
//
// 处理三种运行时：
//   1. bun bundle（/$bunfs/root/ 虚拟脚本）→ 退化到 pi-in-PATH
//   2. 本进程从 pi 入口脚本启动（node + pi 入口）→ node <pi 入口> <args>
//   3. 其余（引擎 CLI 进程 / 测试 / 无脚本）→ pi <args>（依赖 PATH）
//
// 注意：分支 2 的前提是「本进程就是 pi 进程」（extension 宿主在主 pi 内直接 spawn
// task pi 的场景）。判定用白名单：argv[1] 的 basename 必须是 pi 的发行入口名——
// 默认拒绝，防止把本进程自身的非 pi 入口（如 staged 引擎的 index.js）当成 pi 入口
// 递归 spawn（spawn 出的进程读不懂 pi 指令，零输出直至送达看门狗判死）。

import * as fs from "node:fs";
import * as path from "node:path";

/** spawn 调用描述符：command + args（透传给 spawnEngineChild）。 */
export interface PiInvocation {
  /** 可执行文件路径（node/bun/pi 二进制）。 */
  command: string;
  /** 命令行参数（可能含 [scriptPath, ...userArgs] 或直接 [...userArgs]）。 */
  args: string[];
}

/** bun 虚拟文件系统前缀（非磁盘真实文件，不能直接 spawn）。 */
const BUN_VIRTUAL_PREFIX = "/$bunfs/root/";

/**
 * pi 发行入口名的白名单（分支 2 资格判据，默认拒绝）：
 *   - `cli.js`：npm 包真实入口（node 直接启动 / spawn 传真实路径形态）；
 *   - `pi` / `pi.exe` / `pi.cmd`：npm bin 形态——shebang/symlink 启动时 node 收到的
 *     argv[1] 是 bin 路径本身。
 * bun 虚拟路径（basename 同为 `pi`）由调用侧的 BUN_VIRTUAL_PREFIX 检查先行排除。
 * pi standalone binary 形态（pi-<plat>-<arch>）不经分支 2：binary 直接执行时
 * argv[1] 是用户参数而非文件路径，existsSync 不命中。
 */
const PI_ENTRY_BASENAME_RE = /^(?:cli\.js|pi(?:\.exe|\.cmd)?)$/i;

/**
 * 判断 execPath 的 basename 是否为通用运行时（node/bun）。
 * 通用运行时需要脚本路径才能启动 pi；非通用（pi standalone binary）可直接执行。
 */
function isGenericRuntime(execPath: string): boolean {
  const execName = path.basename(execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(execName);
}

/** argv[1] 是否 pi 的发行入口（分支 2 资格判据，白名单词表见 {@link PI_ENTRY_BASENAME_RE}）。 */
function isPiEntryScript(scriptPath: string): boolean {
  return PI_ENTRY_BASENAME_RE.test(path.basename(scriptPath));
}

/**
 * 组装 pi 子进程的 spawn 调用。
 *
 * 决策链（按优先级）：
 *   1. 本进程从 pi 入口启动（argv[1] basename ∈ pi 发行入口白名单 + 真实磁盘文件
 *      + 非 bun 虚拟路径）→ <execPath> <argv[1]> <userArgs>（复现启动方式）
 *   2. execPath 非通用运行时（pi standalone binary）→ <execPath> <userArgs>
 *   3. 其余 → "pi" <userArgs>（依赖 PATH；taiji 宿主为引擎 env 注入 PATH 前缀，
 *      引擎 CLI 进程形态恒落此分支）
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

export function getPiInvocation(userArgs: string[]): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith(BUN_VIRTUAL_PREFIX);

  // 分支 1：本进程从 pi 入口启动 → 复现启动方式（node <pi 入口> <args>）。
  // 资格判据 = pi 入口白名单（默认拒绝）：本进程是引擎 CLI（argv[1] = staged
  // index.js / npm bin 等非 pi 入口）时不得复现，否则 spawn 出的是本进程自身
  // ——它按引擎协议解析 stdin，对 pi 指令零应答，run 只能等送达看门狗判死。
  if (
    currentScript !== undefined && !isBunVirtualScript && isPiEntryScript(currentScript) &&
    currentScriptExists()
  ) {
    return { command: process.execPath, args: [currentScript, ...userArgs] };
  }

  // 分支 2：非通用运行时（pi 自带 binary）→ 直接执行
  if (!isGenericRuntime(process.execPath)) {
    return { command: process.execPath, args: userArgs };
  }

  // 分支 3：通用运行时但脚本不可用 → 依赖 PATH
  return { command: "pi", args: userArgs };
}
