// src/execution/engine/client/pid-file.ts
//
// 引擎实例 pidfile：原子写 + 启动期三条件清扫（W2，impl-plan §2.2「pidfile」+
// §7.2 R9-3 / R9-3b）。
//
// 命名（必写死）：`<engineDataDir>/engines/<id>/engine.<hostKind>.<hostPid>.pid`
// —— pi 宿主与 runtime 各写自己的文件，**不得共用 `engine.pid`**（last-writer-wins
// 会误杀对方存活实例）。
//
// 写入时机 = spawn 成功后原子写（tmp + rename），内容含 enginePid / hostPid /
// engineStartTime（R9-3b：清扫时与目标 pid 实际启动时间比对，同 cmdline 的 pid
// 复用由此识别）。清理时机 = 引擎自灭 / dispose / 宿主正常退出。
//
// 三条件清扫（全部成立才杀）：① 引擎 pid 存活；② cmdline 身份校验（复用
// session-runner readProcessCmdline 先例，防 pid 复用误杀）；③ 该 pidfile 所属宿主
// pid 已死。任一**不确定**（ps 失败 / 宿主 pid 探测非 ESRCH 错误 / startTime 读不到）
// → 保守跳过不杀且保留文件（下轮再清）；判定**不成立**（pid 已死 / cmdline 不符 /
// engineStartTime 不匹配 / 内容坏）→ 删除该 pidfile（陈旧清理通道，无数量上限——
// 否则宿主每次崩溃重启新增一个 pidfile 无限堆积）。
//
// Windows：无可移植启动时间判据 → 安全方向 = **不杀只删**（孤儿引擎由自灭
// stdio EOF 兜底；文件陈旧删除通道照走，防堆积）。

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { getLogger, resolveEngineDir } from "@zhushanwen/subagent-engine-sdk";

const logger = getLogger("subagents");

/** ps 探测超时（处置路径一次性调用，防 ps 挂死拖住清扫；session-runner 先例同值）。 */
const CMDLINE_PROBE_TIMEOUT_MS = 3_000;

/** pidfile JSON 缩进（人类可排查形态；文件内容程序化消费，缩进仅为诊断友好）。 */
const PIDFILE_JSON_INDENT = 2;

/** pidfile 内容（JSON）。engineStartTime = OS 级进程启动时间串；读不到时 null。 */
export interface EnginePidfileContent {
  enginePid: number;
  hostPid: number;
  engineStartTime: string | null;
  engineId: string;
  hostKind: string;
  /** 写入时刻（ISO 8601，诊断面）。 */
  writtenAt: string;
}

export function pidfilePath(
  engineDataDir: string,
  engineId: string,
  hostKind: string,
  hostPid: number,
): string {
  return join(resolveEngineDir(engineDataDir, engineId), `engine.${hostKind}.${hostPid}.pid`);
}

/** spawn 成功后的原子写：同目录 tmp 文件 + rename（崩溃中断不落半截 JSON）。 */
export function writePidfileAtomic(path: string, content: EnginePidfileContent): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(content, null, PIDFILE_JSON_INDENT)}\n`, "utf-8");
  renameSync(tmp, path);
}

/** 读 pidfile；缺失 / 坏 JSON → undefined（调用方按陈旧处理）。 */
export function readPidfile(path: string): EnginePidfileContent | undefined {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<EnginePidfileContent>;
    if (
      typeof parsed.enginePid !== "number" ||
      typeof parsed.hostPid !== "number" ||
      typeof parsed.engineId !== "string" ||
      typeof parsed.hostKind !== "string"
    ) {
      return undefined;
    }
    return {
      enginePid: parsed.enginePid,
      hostPid: parsed.hostPid,
      engineStartTime:
        parsed.engineStartTime === null || typeof parsed.engineStartTime === "string"
          ? parsed.engineStartTime
          : null,
      engineId: parsed.engineId,
      hostKind: parsed.hostKind,
      writtenAt: typeof parsed.writtenAt === "string" ? parsed.writtenAt : "",
    };
  } catch (err) {
    // 坏 JSON / 读取失败 = 陈旧文件的正常分支（调用方按 undefined → 删除处理），debug 留痕。
    logger.debug(`[pid-file] readPidfile(${path}) failed, treating as stale: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function removePidfile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (err) {
    // 已被并发清扫删除 = 预期终态，debug 留痕。
    logger.debug(`[pid-file] removePidfile(${path}) failed (concurrent sweep = expected): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================
// EngineClient 编排面（spawn 成功写入 + 启动清扫的一次式调用）
// ============================================================

export interface EnginePidfileRegistration {
  engineDataDir: string;
  engineId: string;
  hostKind: string;
  hostPid: number;
  enginePid: number;
}

/**
 * spawn 成功后的实例 pidfile 登记一到式：读引擎 pid 的 OS 启动时间（R9-3b 清扫比对
 * 数据源）→ 原子写。返回写入路径；写失败返回 undefined（清扫覆盖降级，warn 已留）。
 */
export function registerEnginePidfile(reg: EnginePidfileRegistration): string | undefined {
  const path = pidfilePath(reg.engineDataDir, reg.engineId, reg.hostKind, reg.hostPid);
  try {
    writePidfileAtomic(path, {
      enginePid: reg.enginePid,
      hostPid: reg.hostPid,
      engineStartTime: readProcessStartTime(reg.enginePid) ?? null,
      engineId: reg.engineId,
      hostKind: reg.hostKind,
      writtenAt: new Date().toISOString(),
    });
    return path;
  } catch (err) {
    logger.warn(
      `[pid-file] pidfile write failed for ${reg.engineId} (sweep coverage degraded): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/**
 * 启动期一次性清扫的一到式包装（异常按保守跳过处理：清扫失败不阻断引擎启动，
 * warn 留痕）。删除通道无数量上限（宿主 N 次崩溃重启的堆积一次全清）。
 */
export function sweepEnginePidfiles(args: {
  engineDataDir: string;
  engineId: string;
  currentHostPid: number;
  matchesEngineCmdline: (cmdline: string) => boolean;
}): PidfileSweepResult {
  try {
    return sweepStalePidfiles(args);
  } catch (err) {
    logger.warn(
      `[pid-file] pidfile sweep failed for ${args.engineId} (conservative skip): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { killed: [], removed: [], skipped: [] };
  }
}

/**
 * 进程存活三态探测：true（存活）/ false（ESRCH = 已死）/ undefined（不确定，
 * 如 EPERM——清扫方必须保守跳过）。
 */
export function isProcessAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return undefined;
    return undefined;
  }
}

/**
 * 读目标 pid 的完整命令行（macOS + Linux 通用的 `ps -p <pid> -o command=`）。
 * 返回 undefined：ps 失败 / 超时 / 空输出（进程刚死等）——调用方按「不确定」保守跳过。
 * 复用 pi/session-runner.ts:595 readProcessCmdline 先例（同实现、同超时、同失败语义）。
 */
function readProcessCmdline(pid: number): string | undefined {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: CMDLINE_PROBE_TIMEOUT_MS,
    });
    if (r.error || r.status !== 0) return undefined;
    const out = typeof r.stdout === "string" ? r.stdout.trim() : "";
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读目标 pid 的 OS 级启动时间（`ps -p <pid> -o lstart=`，macOS/Linux 通用文本形态，
 * 如 "Mon Sep  8 21:14:32 2026"）。R9-3b 的 pid 复用识别数据源：同 cmdline 的 pid
 * 复用启动时间必不同。读不到 → undefined（保守跳过）。Windows 无可移植等价 →
 * 调用方按平台分流（win32 不杀只删）。
 */
export function readProcessStartTime(pid: number): string | undefined {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      timeout: CMDLINE_PROBE_TIMEOUT_MS,
    });
    if (r.error || r.status !== 0) return undefined;
    const out = typeof r.stdout === "string" ? r.stdout.trim() : "";
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** 清扫结果（诊断/测试可观测）。 */
export interface PidfileSweepResult {
  /** 三条件全立被杀的引擎 pid（POSIX 组杀）。 */
  killed: number[];
  /** 判定不成立被删除的陈旧 pidfile（含 Windows 不杀只删）。 */
  removed: Array<{ file: string; reason: string }>;
  /** 保守跳过（任一不确定）——文件保留，下轮再清。 */
  skipped: Array<{ file: string; reason: string }>;
}

export interface SweepStalePidfilesOptions {
  engineDataDir: string;
  engineId: string;
  /** 当前宿主 pid（跳过自己刚写的文件）。 */
  currentHostPid: number;
  /**
   * 引擎 cmdline 身份谓词（防 pid 复用误杀的第二道校验）。由调用方按 spawn command
   * 组装（如 cmdline 含引擎 CLI 入口的词形）。
   */
  matchesEngineCmdline: (cmdline: string) => boolean;
  /** 平台注入（缺省 process.platform；测试注入 win32 验证不杀只删分支）。 */
  platform?: NodeJS.Platform;
  /** 杀执行器注入（缺省 POSIX 负 pid 组杀；测试红线：绝不真杀无关进程）。 */
  killEngine?: (enginePid: number) => void;
}

/**
 * 启动期扫同 id 全部 pidfile 并按三条件清扫。
 *
 * 逐文件判定（顺序即优先级）：
 *   坏内容 → 删；自己 → 跳过；宿主 pid 存活 → 保留跳过（活实例或 pid 复用疑似）；
 *   宿主 pid 死 → win32：删（不杀）；posix：引擎 pid 死 → 删；存活 → cmdline 校验
 *   不符 → 删；engineStartTime 不匹配 → 删（pid 复用）；全过 → 组杀 + 删。
 *   ps 失败 / 探测非 ESRCH 错误 → 保守跳过 + 保留。
 */
export function sweepStalePidfiles(opts: SweepStalePidfilesOptions): PidfileSweepResult {
  const result: PidfileSweepResult = { killed: [], removed: [], skipped: [] };
  const platform = opts.platform ?? process.platform;
  const dir = resolveEngineDir(opts.engineDataDir, opts.engineId);

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".pid"));
  } catch {
    return result; // 目录不存在 = 首次启动，无可清扫
  }

  for (const file of files) {
    sweepOnePidfile(join(dir, file), file, opts, platform, result);
  }

  return result;
}

/**
 * 单个 pidfile 的前置检查（顺序即优先级）：坏内容 → 删；自己 → 跳过；宿主 pid
 * 探测不确定/存活 → 保守跳过 + 保留（活实例或宿主 pid 复用疑似）。宿主已死才进
 * 陈旧判定链（reapDeadHostEngine）。
 */
function sweepOnePidfile(
  path: string,
  file: string,
  opts: SweepStalePidfilesOptions,
  platform: NodeJS.Platform,
  result: PidfileSweepResult,
): void {
  const content = readPidfile(path);
  if (content === undefined) {
    removePidfile(path);
    result.removed.push({ file, reason: "unreadable-or-corrupt" });
    return;
  }
  if (content.hostPid === opts.currentHostPid) {
    result.skipped.push({ file, reason: "own-pidfile" });
    return;
  }

  const hostAlive = isProcessAlive(content.hostPid);
  if (hostAlive === undefined) {
    result.skipped.push({ file, reason: "host-pid-probe-uncertain" });
    return;
  }
  if (hostAlive) {
    // 宿主 pid 存活：对方宿主实例还活着（或宿主 pid 被复用疑似）——保守跳过 +
    // 保留文件（R9-3：宿主 pid 复用误判「已死」方向同样落这里保住）。
    result.skipped.push({ file, reason: "host-pid-alive" });
    return;
  }

  reapDeadHostEngine(path, file, content, opts, platform, result);
}

/**
 * 宿主已死后的陈旧判定链（pidfile 必陈旧）：win32 不杀只删；POSIX 按引擎 pid
 * 存活 → cmdline 身份 → engineStartTime 三条件逐级校验，任一不确定保守跳过 +
 * 保留，判定不成立删文件，全过 → 组杀 + 删。
 */
function reapDeadHostEngine(
  path: string,
  file: string,
  content: EnginePidfileContent,
  opts: SweepStalePidfilesOptions,
  platform: NodeJS.Platform,
  result: PidfileSweepResult,
): void {
  // 宿主已死，pidfile 必陈旧。Windows：无可移植启动时间判据 → 不杀只删。
  if (platform === "win32") {
    removePidfile(path);
    result.removed.push({ file, reason: "stale (host dead); win32 never kills" });
    return;
  }

  const engineAlive = isProcessAlive(content.enginePid);
  if (engineAlive === undefined) {
    result.skipped.push({ file, reason: "engine-pid-probe-uncertain" });
    return;
  }
  if (!engineAlive) {
    removePidfile(path);
    result.removed.push({ file, reason: "engine-pid-dead" });
    return;
  }

  const cmdline = readProcessCmdline(content.enginePid);
  if (cmdline === undefined) {
    result.skipped.push({ file, reason: "engine-cmdline-probe-uncertain" });
    return;
  }
  if (!opts.matchesEngineCmdline(cmdline)) {
    // pid 已被复用给无关进程：判定不成立 → 删文件、绝不动那个无辜进程。
    removePidfile(path);
    result.removed.push({ file, reason: "cmdline-mismatch (pid reused by unrelated process)" });
    return;
  }

  const startTime = readProcessStartTime(content.enginePid);
  if (startTime === undefined) {
    result.skipped.push({ file, reason: "engine-start-time-probe-uncertain" });
    return;
  }
  if (content.engineStartTime === null || content.engineStartTime !== startTime) {
    // 同 cmdline 的 pid 复用（R9-3b）：启动时间不同 → 判定不成立 → 删文件不杀。
    removePidfile(path);
    result.removed.push({ file, reason: "engine-start-time-mismatch (pid reused)" });
    return;
  }

  // 三条件全立：确是宿主崩溃残留的引擎实例 → 组杀 + 删文件。
  const killEngine =
    opts.killEngine ?? defaultKillEngineProcessGroup;
  killEngine(content.enginePid);
  removePidfile(path);
  result.killed.push(content.enginePid);
  result.removed.push({ file, reason: "swept after kill (stale orphan)" });
}

/** 缺省杀执行器：POSIX 负 pid 组杀（引擎 CLI 由 EngineClient detached:true spawn = 组长），失败回落单杀。 */
function defaultKillEngineProcessGroup(enginePid: number): void {
  try {
    process.kill(-enginePid, "SIGKILL");
    return;
  } catch (groupErr) {
    // 非组长 / 已死——回落单杀再兜一次。
    logger.debug(`[pid-file] process-group kill(-${enginePid}) failed, falling back to single kill: ${groupErr instanceof Error ? groupErr.message : String(groupErr)}`);
  }
  try {
    process.kill(enginePid, "SIGKILL");
  } catch (err) {
    // 已死 = 预期终态。
    logger.debug(`[pid-file] single kill(${enginePid}) failed (already dead = expected): ${err instanceof Error ? err.message : String(err)}`);
  }
}
