// src/orchestration/record-restart-sweep.ts
//
// [subagent-observability §3.3.4 失联清点] record 侧宿主重启清点——合并进 run 级
// startup-sweep 扫描入口（同一启动扫描、同一数据根遍历；本模块承接 record 半边，
// 编排合流在 startup-sweep.ts）。不做持续监控、不加定时器：宿主重启事实 + 快照
// 判定就是事实源方案（时间平抑红线 / ADR-0122 判定层）。
//
// 判定谓词（全部事实，两步）：
//   ① 候选枚举 = manifest 快照在途形态（executionStatus=running——manifest 快照通道，
//      禁全量事件流重放 fold 判定在途态，P0-25 红线）。轮始写点（markRoundStarted
//      的 manifest 派生视图刷新，u3 同批落地）保证 running 快照与在途轮一一对应。
//   ② 命中确认 = 事件流停在「轮在途」形态（轮收条未写）——逐候选读该 record 的
//      事件文件判末帧（有轮终/终局收条即让位：markRoundIdle 事件先落、manifest 后刷
//      的崩溃半更新窗内孤儿已自收尾，不重复补写、不覆写真实轮收条）。逐候选一次
//      有界读与 run 侧判定核逐 run 读 journal 同款比例（候选 = 崩溃残留，常态近零）。
//
// 活体判定 = 宿主代际归属：本清点只在启动扫描时点运行（先于任何 pi spawn + 单实例
// 锁，同 run 侧创建顺序契约）——此刻判读在途的 record 其执行者只可能是上一生命周期的
// 孤儿；孤儿引擎进程即使仍存活（.alive 探针核入 evidence 留证），宿主重启后已失去
// 轮终簿记的归属代际，判失联。进程清理归既有 sweep，清点不承担杀进程职责。
//
// 命中处置（§3.3.4）：轮收条补写「失联」（停因复用 interrupted-by-restart + 清点
// 附注 swept——清点事实落轮收条附注，不进停因枚举，§3.3.3）+ manifest 快照刷新
// （executionStatus=idle + 收编停因上派生视图，镜像 buildAdoptedManifestProjection
// 字段形——占用判据与计数自此摘除，manifest 直读主路径同步收敛）+ 统计快照取上一
// 收条值（缺帧诚实 0，同 run 侧收编）。record 会话本体保留——续聊即重建（resume
// 锚点），归档照常走 gc。
//
// pending 债结清（结清值 = lost，§3.3.6 结清枚举）：本清点运行在 runtime 进程启动
// 段——主 session 文件属 pi 进程序列（appendEntry 通道不存在，pi-owned 文件禁触碰），
// 结清发射归 session reattach 侧的对账 sweep（registry-reconcile：lookupRecordState
// 读失联收条事实 → lost，同批接线）。本模块只落事实，不做跨进程代写。
//
// 失败语义：单 record 处置失败 = warn 留痕 + 继续其余；目录级枚举失败逐目录折进
// errors 摘要。结构性不 reject——清点是旁路维护，绝不放大为启动失败（同 startup-sweep
// 纪律）。幂等：命中处置后 manifest executionStatus=idle（二次扫描不再命中）；
// 收条未写确认对半更新窗同样让位，重复启动不重复追加。

import { readdir, readFile } from "node:fs/promises";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Dirent } from "node:fs";

import {
  getSessionStoreDir,
  getSessionSubagentRecordsDir,
  isPiSessionId,
} from "@taiji/shared/session-store-paths";

import { resolveSessionStoreBase } from "../execution/assembly/store-base.ts";
import { manifestSnapshotInFlight } from "../execution/persistence/record-store-rebuild.ts";
import { createRecordEventStream } from "../execution/persistence/record-events.ts";
import type { ManifestRecord } from "../execution/persistence/manifest-store.ts";
import { MANIFEST_INDENT_SPACES } from "../execution/persistence/manifest-store.ts";
import { isProcessAlive, readAliveMarker } from "../execution/persistence/alive-store.ts";
import type { RecordEvent } from "../execution/persistence/record-events.ts";
import type { SweepLogChannel } from "./startup-sweep.ts";

/** 结果行前缀（startup-sweep 同通道同前缀，结果行随主扫描行之后落位）。 */
const LOG_PREFIX = "[subagents] startup sweep (records):";

/** 失联清点轮收条附注的停因值（§3.3.3：复用宿主中断族事实词，不新增停因枚举成员）。 */
export const SWEPT_STOP_REASON = "interrupted-by-restart" as const;

/** record-restart-sweep 的结果（计数 + 错误摘要，供 startup-sweep 合流与单测断言）。 */
export interface RecordRestartSweepResult { // oe-exempt:20261024:framework:startupSweep 合流结果契约——主扫描行与单测断言消费的跨包结构类型
  /** 补写失联轮收条 + 摘除占用的 record 数。 */
  swept: number;
  /** 候选中未清点的数（收条已在——半更新窗让位；manifest 损坏跳过）。 */
  skipped: number;
  /** 错误摘要（目录级/单 record 处置失败逐条；空数组 = 全程无失败）。 */
  errors: string[];
}

/**
 * session 存储树内全部 subagent records 目录（失联清点的候选枚举根）。
 *
 * 枚举对象 = `<root>/<sid>/subagents/records/`（一级 sid 目录逐个派生；非合法
 * sessionId 形态的一级目录一律跳过——isPiSessionId 树内遍历规约，与 run 侧
 * listWorkflowRunsDirs 同纪律同源原语）。
 */
async function listSubagentRecordsDirs(dataDir: string): Promise<string[]> {
  const base = resolveSessionStoreBase(dataDir);
  const storeRoot = getSessionStoreDir(base);
  let entries: Dirent[];
  try {
    entries = await readdir(storeRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }
  return entries
    .filter((ent) => ent.isDirectory() && isPiSessionId(String(ent.name)))
    .map((ent) => getSessionSubagentRecordsDir(String(ent.name), base));
}

/** 收条统计与轮计数的 carry-forward 载体（上一收条值——缺帧诚实 0）。 */
interface LastReceiptStats { // oe-exempt:20261024:framework:清点收条内部汇总结构，仅 record-restart-sweep 单消费点（Rule of Three 未满，非 ports/SDK 契约）
  round: number;
  turns: number;
  totalTokens: number;
}

/**
 * 事件流末帧判读（命中确认 + 统计 carry-forward 单点）：
 *   - "in-flight"  = 轮收条未写（末帧 ∈ 轮始前族 created/bound/round-started/reopened/
 *                    model-override）——在途形态成立；
 *   - "settled"    = 末帧是轮终/终局收条（round-idle / settled）——孤儿已自收尾，
 *                    manifest 快照只是半更新窗滞后，让位不补写。
 * 附带上一收条统计（swept 收条的 turns/totalTokens/round carry-forward——收条缺帧
 * 时诚实 0，与 run 侧收编统计口径一致）。
 */
function judgeEventTail(events: readonly RecordEvent[]): {
  verdict: "in-flight" | "settled";
  lastReceipt: LastReceiptStats;
} {
  let lastReceipt: LastReceiptStats = { round: 0, turns: 0, totalTokens: 0 };
  let verdict: "in-flight" | "settled" = "in-flight";
  for (const event of events) {
    if (event.type === "record-round-idle") {
      verdict = "settled";
      lastReceipt = {
        round: event.round,
        turns: event.turns,
        totalTokens: event.totalTokens,
      };
    } else if (event.type === "record-settled") {
      verdict = "settled";
      lastReceipt = {
        round: lastReceipt.round,
        turns: event.turns,
        totalTokens: event.totalTokens,
      };
    } else if (event.type === "record-round-started") {
      // 轮始帧 = 回到在途（续轮形态——轮终收条让位语义被轮始翻转覆盖）。
      verdict = "in-flight";
    }
  }
  return { verdict, lastReceipt };
}

/** 失联附注 evidence 组装（manifest 快照形态 + .alive 探针事实——pid 探活核入留证）。 */
function sweptEvidence(manifest: ManifestRecord): string {
  const parts = [`manifest=executionStatus:${manifest.executionStatus ?? manifest.status}`];
  const sessionFile = manifest.sessionFile;
  if (sessionFile !== undefined) {
    const marker = readAliveMarker(sessionFile);
    if (marker !== undefined) {
      // 孤儿引擎进程即使仍存活也判失联（宿主重启后代际已更替）——探活结果只进
      // evidence 留证，不改变判定（§3.3.4 活体判定语义）。
      parts.push(`aliveWriter=pid:${marker.pid}:${isProcessAlive(marker.pid) ? "alive" : "dead"}`);
    }
  }
  return parts.join("; ");
}

/** manifest 快照原子刷新（tmp + rename——半写不可见，读侧要么旧要么新）。 */
function writeManifestAtomic(recordsDir: string, id: string, manifest: ManifestRecord): void {
  const target = join(recordsDir, `${id}.json`);
  const tmp = `${target}.swept-tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(manifest, null, MANIFEST_INDENT_SPACES), "utf-8");
    renameSync(tmp, target);
  } finally {
    // rename 成功后 tmp 已不存在；失败路径 force 删残留（ENOENT 容忍——不吞主错误，
    // rename 失败原因经 finally 后原样上抛给调用方 warn 通道）。
    rmSync(tmp, { force: true });
  }
}

/**
 * 失联清点单 record 处置（判定两步 + 命中三写：manifest 快照刷新 → 失联轮收条）。
 * manifest 先刷（幂等门——二次启动不再命中）；收条后落（崩溃窗 = 快照已 idle 而
 * 收条缺，读侧 buildRecord 无收条回落 interrupted-by-restart，显示一致）。
 */
async function sweepSingleRecord(
  stream: ReturnType<typeof createRecordEventStream>,
  recordsDir: string,
  id: string,
  manifest: ManifestRecord,
  now: number,
): Promise<"swept" | "skipped"> {
  // ② 命中确认：轮收条未写（半更新窗让位）。
  const events = await stream.scan(id);
  const { verdict, lastReceipt } = judgeEventTail(events);
  if (verdict === "settled") return "skipped";

  // 命中处置一：manifest 快照刷新（executionStatus=idle + 收编停因上派生视图——
  // 字段形镜像 buildAdoptedManifestProjection：legacy status 保持 running 词形，
  // executionStatus 承载两态权威词，completedAt 落清点时点）。
  const evidence = sweptEvidence(manifest);
  writeManifestAtomic(recordsDir, id, {
    ...manifest,
    executionStatus: "idle",
    stopReason: SWEPT_STOP_REASON,
    completedAt: manifest.completedAt ?? now,
  });

  // 命中处置二：失联轮收条补写（停因复用 interrupted-by-restart + swept 附注；
  // 轮计数 = 在途轮的轮终语义值（轮始帧轮数 + 1，对齐 markRoundIdle 递增后落帧）；
  // 统计快照 = 上一收条 carry-forward，缺帧诚实 0）。
  await stream.append(id, {
    type: "record-round-idle",
    ts: now,
    round: lastReceipt.round + 1,
    stopReason: SWEPT_STOP_REASON,
    swept: { at: now, evidence },
    turns: lastReceipt.turns,
    totalTokens: lastReceipt.totalTokens,
  });
  return "swept";
}

/**
 * record 侧失联清点（startup-sweep 的 record 半边）：全树 records 目录枚举 →
 * manifest 快照在途候选 → 收条未写确认 → 命中三写。结构性不 reject——任何失败都
 * 折进返回对象的 errors 摘要，调用方（startup-sweep 合流）await 后照常继续。
 */
export async function sweepInterruptedRecords(
  getDataDir: () => string,
  log: SweepLogChannel,
): Promise<RecordRestartSweepResult> {
  const result: RecordRestartSweepResult = { swept: 0, skipped: 0, errors: [] };
  let recordsDirs: string[];
  try {
    recordsDirs = await listSubagentRecordsDirs(getDataDir());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`${LOG_PREFIX} enumeration failed (runtime continues): ${message}`);
    result.errors.push(message);
    return result;
  }
  const now = Date.now();
  for (const recordsDir of recordsDirs) {
    const stream = createRecordEventStream(() => recordsDir);
    let names: string[];
    try {
      names = await readdir(recordsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // 目录级真 IO 故障（EACCES/EIO）：折进 errors 继续（同 run 侧读错分通道纪律——
        // 静默折叠会让持续 IO 故障伪装成「0 个 record 待清点」）。
        const message = `${recordsDir}: ${err instanceof Error ? err.message : String(err)}`;
        log.warn(`${LOG_PREFIX} records dir read failed, continuing: ${message}`);
        result.errors.push(message);
      }
      continue; // ENOENT = 该 session 从未落 record，正常空态
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue; // 候选 = manifest 快照（<sa-id>.json）
      const id = name.slice(0, -".json".length);
      let manifest: ManifestRecord;
      try {
        const content = await readFile(join(recordsDir, name), "utf-8");
        const parsed: unknown = JSON.parse(content);
        if (typeof parsed !== "object" || parsed === null || typeof (parsed as ManifestRecord).id !== "string") {
          throw new Error("corrupt manifest snapshot (not a ManifestRecord shape)");
        }
        manifest = parsed as ManifestRecord;
      } catch (err) {
        // 损坏快照：warn 留痕跳过（不虚构在途判定——读侧重建通道自会按损坏处置）。
        const message = `${recordsDir}/${name}: ${err instanceof Error ? err.message : String(err)}`;
        log.warn(`${LOG_PREFIX} manifest read failed, skipping: ${message}`);
        result.errors.push(message);
        result.skipped += 1;
        continue;
      }
      // ① 候选枚举：manifest 快照在途形态（快照通道，禁全量 fold）。
      if (!manifestSnapshotInFlight(manifest)) continue;
      try {
        const outcome = await sweepSingleRecord(stream, recordsDir, id, manifest, now);
        if (outcome === "swept") result.swept += 1;
        else result.skipped += 1;
      } catch (err) {
        const message = `record ${id}: ${err instanceof Error ? err.message : String(err)}`;
        log.warn(`${LOG_PREFIX} sweep failed, continuing: ${message}`);
        result.errors.push(message);
        result.skipped += 1;
      }
    }
  }
  // 结果行只在有命中时落位（无失联的主路径不加日志行——startup-sweep 主结果行
  // 的既有断言与观测习惯不受扰动）。
  if (result.swept > 0) {
    log.info(`${LOG_PREFIX} swept ${result.swept} interrupted record(s), skipped ${result.skipped}`);
  }
  return result;
}
