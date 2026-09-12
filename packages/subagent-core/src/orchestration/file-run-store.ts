// src/orchestration/file-run-store.ts
//
// RunStore port 的通用文件实现（D2 设计件——zsw 回接 host-surface 单元）。
//
// 为什么需要它：pi 壳的 JsonlRunStore 深耦合 pi session（appendEntry /
// sessionManager，经 pi SDK 落盘 session JSONL），zcode 侧宿主没有这两个设施，
// 无法复用。RunStore port 早在 ports.ts 定义却只有 pi 一份 Infra 实现——本文件
// 补上「宿主无关」的第二份实现，双宿主的 workflow state 持久化从此同源（消灭
// 失败模式 B：行为不一致各自修）。
//
// 落盘布局：<dataRoot>/workflow-state/<runId>.jsonl（D2 规定，与 pi 壳
// <sessionDir>/workflow-state/<runId>.jsonl 同名分量、锚点不同：pi 锚 session，
// 本实现锚宿主数据根——zcode 宿主无 session dir 概念，daemon 重启后按 dataRoot
// 重水合孤儿 run）。
//
// dataRoot 通道选型：直接走 getHostServices().dataRoot()（core/host-services.ts），
// 不用 getEngineDataDir（engine/common/data-dir.ts）——后者是引擎 journal/隔离池
// 通道，带 XYZ_AGENT_DATA_DIR env 优先 + warn-once 语义（xyz-agent 宿主注入专用）；
// workflow run 快照是宿主编排状态，语义归属宿主数据根本身，宿主 configureCore
// 注入什么就落什么，不引入第二条 env 覆盖链。

import { readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { getHostServices } from "../core/host-services.ts";
import { getLogger } from "../core/logger.ts";
import type { RunStore } from "./models/ports.ts";
import { WorkflowRun } from "./models/workflow-run.ts";
import { SNAPSHOT_VERSION, fromRunSnapshot, toRunSnapshot } from "./run-snapshot.ts";

const logger = getLogger("file-run-store");

/** run 状态目录名（<dataRoot> 下的固定分量）。 */
const STATE_DIR_NAME = "workflow-state";

// ── 磁盘保留（C1，语义对齐 pi jsonl-run-store mtime 裁剪） ─────────

/** run state 文件名 glob：runId 形如 `wf-<ts>-<rand>`（lifecycle.ts 生成），只删命中者。
 *  同目录可能存在的非 state 文件永不碰（对齐 pi STATE_FILE_GLOB）。 */
const STATE_FILE_GLOB = /^wf-.*\.jsonl$/;

/**
 * 磁盘保留默认上限（OR-5 跨 run 保留修复）：envName 通道在 env 未设/空时生效。
 *
 * OR-5 将「STATE_MAX_RUNS opt-in 默认关」（无界累积）改为默认开：跨 run state
 * 文件按 mtime 裁剪到本上限。取值 50 是无真实 run 体积分布数据下的保守值
 * （设计 §11-4：标定待 S-A 验收后复核）——偏大不碍事（有界即达标），偏小会
 * 误删仍被引用的 run 缓存，故取保守端。env 显式设置（有效正数）优先于本值；
 * 显式非法值是 opt-out 通道（不清理，见 pruneStateFilesBeyondCap）。
 */
export const DEFAULT_STATE_MAX_RUNS = 50;

// ── save 节流（OR-5 单 run 快照 O(n²) 主修） ──────────────────

/**
 * 同一 run 两次快照落盘的最小间隔（ms）。OR-5 单 run O(n²) 主修参数：现状每
 * 次 save 都 append 全量快照（快照体积 O(calls) × save 次数 O(calls)），节流后
 * 落盘次数有界为 ceil(run 时长 / 本间隔)（§11-4 量级推演见 impl-plan 偏差登记：
 * 100-call run 从 ~200 次落盘 / ~50MB 降到 ~17 次 / ~8MB，增量 append diff 需
 * 改造两宿主共享 codec（基线+delta 行 + loadAll 重放 + 版本兼容），收益不抵
 * 复杂度，节流即终案）。取值对齐 jsonl-run-store 去抖同款考量：agent-call 间隔
 * 秒级，60s 窗口把快照次数压到与「分钟级 run 时长」同量级，又不让崩溃窗口
 * （未落盘的 running 尾部丢失，等价崩溃链由恢复路径收编）超出分钟级。
 */
export const DEFAULT_SAVE_MIN_INTERVAL_MS = 60_000;

/** FileRunStore 构造参数（全部可选；缺省即生产形态）。 */
export interface FileRunStoreOptions {
  /**
   * save 节流最小间隔（ms）；0 = 禁用节流（每次 save 都落盘）。缺省
   * {@link DEFAULT_SAVE_MIN_INTERVAL_MS}。测试经此注入小窗口（fake timers 推进）。
   */
  saveMinIntervalMs?: number;
  /**
   * [F-1 修复] run 状态目录覆盖。缺省 = `<dataRoot>/workflow-state`（zcode 宿主布局，
   * 见 stateDir()）；pi 宿主的读侧装配点（round-supervisor sweep / idle-gc）必须传
   * resolvePiWorkflowStateDir()（execution/workflow-state-root.ts）——pi 宿主 run state
   * 由 JsonlRunStore 落 `<sessionDir>/workflow-state/`，与缺省根不相交。
   */
  stateDir?: string;
}

/** Node fs 错误 code 判定（ENOENT = 路径不存在，并发删除场景；对齐 pi isEnoentError）。 */
function isEnoentError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err &&
    (err as { code?: unknown }).code === "ENOENT";
}

// ── 快照形状 / 序列化 / 重水合 ────────────────────────────────
//
// 投影与版本衔接语义收敛于 ./run-snapshot.ts 单源 codec（下沉收口 D4/U8）：
// 本 store 只保留 IO 策略（append-only + 从尾向头取最后有效行）。版本衔接的
// 宿主侧职责（D4 裁决②③，见 parseLine）：「缺 v 宽容读」预处理与「版本不
// 匹配 warn 可见性」在此实现——不内聚进 codec，保 pi 侧「v1 存量静默跳过」
// 语义不被宽容化误读。

// ── 磁盘保留原语（C1，两宿主单源）──────────────────────────
//
// pruneStateFilesBeyondCap 主体是宿主无关的目录裁剪原语（S4-A7 收口为导出单源）：
// pi 宿主（subagent-workflow 扩展的 jsonl-run-store）此前持有一份逐段同构的私有实现，
// retention 语义（glob 命中才删 / mtime 升序裁最旧 / 任何失败不抛）双份各自演化是
// 漂移隐患——现在两宿主消费同一实现，日志与错误字符串化经 deps 注入（宿主各自的
// logger tag / error 工具保持自治，行为差异仅 log tag 文案）。

/** pruneStateFilesBeyondCap 的宿主注入依赖（日志与错误字符串化——tag 前缀由注入方决定）。 */
export interface PruneStateDeps {
  /** warn 通道（readdir / unlink 失败留证；清理是旁路维护，失败不抛） */
  warn: (msg: string) => void;
  /** debug 通道（成功裁剪记录） */
  debug: (msg: string) => void;
  /** error → 可读字符串（core 侧 err.message 兜底 String，宿主可用自有 error 工具） */
  toMsg: (err: unknown) => string;
}

/**
 * 把 state 目录裁剪到 cap 个最新 state 文件（mtime 升序删最旧，C1）。
 *
 * 语义（OR-5，两宿主单源）：
 * - 只删目录内命中 {@link STATE_FILE_GLOB} 的文件；任何失败都不抛（清理是旁路
 *   维护，不能拖垮持久化主链路）：readdir 失败静默放弃本轮（ENOENT = 从未持久化，
 *   正常态），单个 unlink 失败（非 ENOENT）warn 留证后继续删其余——ENOENT 视为
 *   并发删除竞态下的已达成目标，不告警；
 * - stat 全集取 mtime，allSettled 部分降级——单文件 stat 失败（并发删除 ENOENT
 *   等）静默跳过该文件，不阻断本轮裁剪。
 *
 * cap 解析（env 通道等）归调用方：FileRunStore 方法含 envName 通道超集；
 * pi 宿主 jsonl-run-store 经 getEnvStateMaxRuns 解析后直传。
 */
export async function pruneStateFilesBeyondCap(
  stateDir: string,
  cap: number,
  deps: PruneStateDeps,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch (err) {
    if (!isEnoentError(err)) {
      deps.warn(`state retention: readdir ${stateDir} failed: ${deps.toMsg(err)}`);
    }
    return;
  }
  const stateFiles = names.filter((n) => STATE_FILE_GLOB.test(n)).sort();
  if (stateFiles.length <= cap) return;

  // stat 全集取 mtime；allSettled 部分降级（单文件失败静默跳过，不阻断本轮）
  const settled = await Promise.allSettled(
    stateFiles.map(async (name) => {
      const full = join(stateDir, name);
      return { full, mtimeMs: (await stat(full)).mtimeMs };
    }),
  );
  const byMtimeAsc = settled
    .flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const victims = byMtimeAsc.slice(0, byMtimeAsc.length - cap);
  for (const victim of victims) {
    try {
      await unlink(victim.full);
      deps.debug(`state retention: pruned ${victim.full}`);
    } catch (err) {
      if (isEnoentError(err)) continue; // 并发删除已达成目标
      deps.warn(`state retention: failed to delete ${victim.full}: ${deps.toMsg(err)}`);
    }
  }
}

// ── FileRunStore ────────────────────────────────────────────

/**
 * RunStore port 的宿主无关文件实现（port 见 models/ports.ts）。
 *
 * - save：append-only + 节流——快照行仍全量（崩溃时旧快照仍在，loadAll 取最后
 *   一条有效行恢复到最后一致状态），但同一 running run 两次落盘有最小间隔
 *   （OR-5 ⑥a：节流前每次状态变更都 append 全量快照，快照体积 O(calls) ×
 *   save 次数 O(calls) = 单 run 磁盘 O(n²)；节流参数与语义见 save 注释）。
 * - loadAll：扫 <dataRoot>/workflow-state/*.jsonl，每文件从尾向头取第一条形状
 *   有效的快照行；损坏行（JSON.parse 失败 / 形状校验不过 / 版本不匹配）跳过并
 *   warn——单行损坏不拖垮整个 run 的恢复（与 pi 壳 kill-9 恢复同容忍度）。
 *   版本衔接（快照 codec 归 run-snapshot.ts 单源，D4）：存量无 v 行按当前版本
 *   宽容读、写入恒补 v、v 不匹配跳过 + warn（三裁决明细见 parseLine 注释）。
 * - stateFilePath：纯路径计算（<状态目录>/<runId>.jsonl），不建目录。状态目录 =
 *   构造注入的 stateDir 覆盖，或缺省 <dataRoot>/workflow-state（pi 宿主读侧装配点
 *   必须传 resolvePiWorkflowStateDir()——见 FileRunStoreOptions.stateDir 与
 *   execution/workflow-state-root.ts 的同源布局论证）。
 *
 * 未 configureCore 即 save/loadAll 会抛 core_host_not_configured（dataRoot 端口
 * 语义，host-services.ts §3.4）——宿主壳必须在初始化最早期注入。
 */
export class FileRunStore implements RunStore {
  /** run 状态目录绝对路径（显式覆盖优先——pi 宿主读侧装配点；缺省 dataRoot 每次现取
   *  ——宿主覆盖配置即刻生效，对齐 data-dir.ts「不缓存路径防测试/宿主切换读到旧值」
   *  先例）。 */
  private stateDir(): string {
    return this.stateDirOverride ?? join(getHostServices().dataRoot(), STATE_DIR_NAME);
  }

  /** 显式状态目录覆盖（构造注入；见 FileRunStoreOptions.stateDir）。 */
  private readonly stateDirOverride: string | undefined;

  /** save 节流最小间隔（ms），0 = 禁用。 */
  private readonly saveMinIntervalMs: number;
  /**
   * per-runId 上次实际落盘时刻（节流判据）。终态落盘成功即删（终态后 runId 不再
   * save）；残留条目只出现在「running 中 run 消失（崩溃/宿主弃用）」场景，单条
   * ~100B 可忽略（对齐 jsonl-run-store chains「每 runId 残留 settled Promise」
   * 的取舍先例）。时间源 Date.now()（fake timers 下可推进，测试友好）。
   */
  private readonly lastSavedAt = new Map<string, number>();

  constructor(opts?: FileRunStoreOptions) {
    this.saveMinIntervalMs = Math.max(0, opts?.saveMinIntervalMs ?? DEFAULT_SAVE_MIN_INTERVAL_MS);
    this.stateDirOverride = opts?.stateDir;
  }

  stateFilePath(runId: string): string {
    return join(this.stateDir(), `${runId}.jsonl`);
  }

  /**
   * 快照落盘（OR-5 ⑥a 节流后）：
   * - 首写（该 runId 尚无落盘记录）永不节流——保证新 run 至少一条快照，
   *   loadAll 重水合可发现；
   * - 终态（status 非 running）永不节流——最终状态必落盘，末行即终态快照；
   * - running 中间态距上次落盘不足 {@link saveMinIntervalMs} → 跳过本次 append
   *   （状态仍在调用方内存 runs Map，下次落盘带全量最新快照；本文件最后一条
   *   快照因此最多落后真实状态一个节流窗口——崩溃语义与 jsonl-run-store 去抖
   *   同源：未落盘的 running 尾部丢失，等价崩溃链由恢复路径收编）。
   *
   * 节流判据在落盘成功后才更新（IO 失败不吞下一次重试机会）。
   */
  async save(run: WorkflowRun): Promise<void> {
    const isTerminal = run.state.status !== "running";
    const now = Date.now();
    const last = this.lastSavedAt.get(run.runId);
    if (!isTerminal && last !== undefined && now - last < this.saveMinIntervalMs) {
      return; // 节流窗口内：跳过本次全量快照 append
    }
    // mkdir recursive 每次 save 前执行：幂等零成本（目录已存在时仅一次 stat），
    // 且免「构造时预建」——构造时建会在宿主尚未 configureCore 的窗口抛错。
    await mkdir(this.stateDir(), { recursive: true });
    // toRunSnapshot 补 v 字段（D4 裁决②写入侧）；live strip 已随 [H2 W3] live 字段删除退役
    const line = JSON.stringify(toRunSnapshot(run));
    await appendFile(this.stateFilePath(run.runId), line + "\n", "utf8");
    if (isTerminal) {
      this.lastSavedAt.delete(run.runId);
    } else {
      this.lastSavedAt.set(run.runId, now);
    }
  }

  async loadAll(): Promise<WorkflowRun[]> {
    let files: string[];
    try {
      files = await readdir(this.stateDir());
    } catch {
      // 目录不存在 = 从未持久化过（首启/干净环境），空集是正常态不是错误。
      return [];
    }

    const runs: WorkflowRun[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const run = await this.loadLatestValidLine(join(this.stateDir(), file), file);
      if (run) runs.push(run);
    }
    return runs;
  }

  /**
   * [W4 sweep 判据，F2] 按 runId 同步查 run 状态（注册对账 sweep 的 workflow 收口
   * 判据）。同步形态：sweep 在 session_start 同步链内运行（runReconcileSweep 同步
   * 契约），不能 await loadAll——对单 runId 做同步文件读（对齐 sweep 自身的 sync fs
   * 读先例），逐行解析复用 parseLine（版本衔接 + 形状校验与 loadLatestValidLine
   * 单源，同步只读不触碰 lastSavedAt 节流记账）。
   *
   * 判定（宁挂账不失明——误注销活跃 run 是事故方向，判据保守侧取「不可判定」）：
   * - state 文件不存在 → missing（设计判据「已归档/不存在视同终态」——run 从未
   *   落盘或已被清理，注册是死亡窗口残留）；
   * - 末条有效快照 status = running → running（活跃，sweep 跳过）；
   * - 末条有效快照 status ≠ running（done）→ terminal + reason（I2：done ⟹ reason
   *   有值；reason 作 pending unregister 的 status 语义源）；
   * - 文件存在但全部行损坏（无有效快照）→ running（读不出 ≠ 不存在，不补注销）。
   */
  findStateByIdSync(runId: string): { kind: "running" } | { kind: "terminal"; reason: string | undefined } | { kind: "missing" } {
    let content: string;
    try {
      content = readFileSync(this.stateFilePath(runId), "utf8");
    } catch {
      return { kind: "missing" }; // ENOENT（未落盘/已清理）等不可读形态同视——见头注判定
    }
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === "") continue; // 尾部空行（末行 \n 产物）静默跳过
      const run = this.parseLine(line, `${runId}.jsonl`, i);
      if (run === undefined) continue; // 损坏行继续向前找——最后一条有效行可能早于文件尾部
      if (run.state.status === "running") return { kind: "running" };
      return { kind: "terminal", reason: run.state.reason };
    }
    // 全部行损坏：读不出 ≠ 不存在——保守按活跃处理（宁挂账不误注销）
    return { kind: "running" };
  }

  /** 单文件从尾向头取第一条有效快照行；整文件无有效行返回 undefined（warn）。 */
  private async loadLatestValidLine(absPath: string, display: string): Promise<WorkflowRun | undefined> {
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[file-run-store] skip unreadable state file ${display}: ${msg}`);
      return undefined;
    }

    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === "") continue; // 尾部空行（末行 \n 产物）静默跳过
      const run = this.parseLine(line, display, i);
      if (run) return run;
      // 损坏行 warn 后继续向前找——最后一条「有效」行可能早于文件尾部（半行写入崩溃）
    }
    logger.warn(`[file-run-store] no valid snapshot line in ${display} (empty or all corrupted)`);
    return undefined;
  }

  /**
   * 单行解析 + 版本衔接预处理（D4 裁决②③，宿主侧职责）+ 形状校验；损坏
   * warn 并返回 undefined。
   *
   * - 缺 v 字段（core 存量行）→ 就地补当前版本再进 codec（「缺版本 = 当前
   *   版本」宽容读，不做自动迁移——写回时经 toRunSnapshot 自然补 v 完成渐进
   *   收敛）；预处理留在 store 层而非 codec，保 pi 侧「v1 存量静默跳过」语义
   *   不被宽容化误读（D4 裁决②归属裁决）。
   * - v 存在但不匹配（未知更高版本/降级写入）→ 跳过 + warn（补可见性，对齐
   *   pi 静默跳过语义；字符串版本无大小序，不引入比较逻辑——D4 裁决③）。
   *   此处版本判断仅为 warn 可见性，数据防线仍是 codec 内 guard（双保险，
   *   pi 切换 codec 后共享同一防线）。
   */
  private parseLine(line: string, display: string, lineNo: number): WorkflowRun | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[file-run-store] skip corrupted line ${display}:${lineNo}: ${msg}`);
      return undefined;
    }
    if (parsed !== null && typeof parsed === "object") {
      const rec = parsed as { v?: unknown };
      if (rec.v === undefined) {
        rec.v = SNAPSHOT_VERSION;
      } else if (rec.v !== SNAPSHOT_VERSION) {
        logger.warn(
          `[file-run-store] skip snapshot with unsupported version ${display}:${lineNo}: v=${JSON.stringify(rec.v)} (this build only reads v=${JSON.stringify(SNAPSHOT_VERSION)}; the run line is skipped). To recover: upgrade @zhushanwen/subagent-core, or migrate/delete this state file if its runs are no longer needed`,
        );
        return undefined;
      }
    }
    const run = fromRunSnapshot(parsed);
    if (run === undefined) {
      logger.warn(`[file-run-store] skip malformed snapshot ${display}:${lineNo} (shape validation failed)`);
      return undefined;
    }
    return run;
  }

  /**
   * 把 workflow-state 目录裁剪到上限个最新 state 文件（mtime 升序删最旧，C1）。
 *
 * 主体委托导出单源 {@link pruneStateFilesBeyondCap}（retention 语义两宿主单源，
 * S4-A7；日志经 deps 注入本模块 logger + `[file-run-store]` tag，行为与收口前
 * 逐字一致）。磁盘裁剪不动内存 runs Map（内存侧淘汰归
 * lifecycle.evictDoneRunsBeyondCap，两域独立）。
 *
 * 上限解析（envName 通道，OR-5 ⑥b 默认开；显式非法值 opt-out 对齐 pi 解析风格）：
 * - `envName` 提供 → env 通道：`process.env[envName]` 未设/空 → 按默认上限
 *   {@link DEFAULT_STATE_MAX_RUNS} 裁剪（**默认开**——OR-5 修复前的 opt-in
 *   「默认关」正是跨 run 无界累积缺陷本身）；设了有限正数 → 上限 = env 值
 *   （env 值即上限）；设了非法值（非有限数/≤0）→ 不清理（显式 opt-out 通道：
 *   用户意图不明时不动磁盘——对齐本方法 readdir/stat 失败一律放弃的保守哲学，
 *   宿主如需自管保留可设足够大的正数值）；
 * - `envName` 缺省 → 无 env 通道，直接按 `max` 参数裁剪（上限 = max，调用方
 *   自管启用时机）。
 *
 * @param max 上限（envName 缺省时生效；env 通道启用时被 env 值覆盖）
 * @param envName opt-in 开关 + 上限覆盖 env 变量名（可选；pi 先例
 *   `XYZ_SUBAGENT_STATE_MAX_RUNS`）
 */
  async pruneStateFilesBeyondCap(max: number, envName?: string): Promise<void> {
    let cap = max;
    if (envName !== undefined) {
    // 未设/空 → 默认开（OR-5 ⑥b：DEFAULT_STATE_MAX_RUNS）；非法/≤0 → 不清理
    // （显式 opt-out 通道，见方法注释）；有效正数 → env 值覆盖
      const raw = process.env[envName];
      if (raw === undefined || raw === "") {
        cap = DEFAULT_STATE_MAX_RUNS;
      } else {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) return;
        cap = parsed;
      }
    }
    await pruneStateFilesBeyondCap(this.stateDir(), cap, {
      warn: (msg) => logger.warn(`[file-run-store] ${msg}`),
      debug: (msg) => logger.debug(`[file-run-store] ${msg}`),
      toMsg: (err) => (err instanceof Error ? err.message : String(err)),
    });
  }
}
