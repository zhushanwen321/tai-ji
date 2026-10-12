// src/execution/persistence/engine-journal-gc.ts
//
// 引擎 journal TTL 回收定时器（30 天 mtime TTL）。
//
// 范围（2026-10-12 用户裁决：会话下挂内容的回收统一归删主会话级联——runtime
// session-content-cascade）：本模块只负责引擎 journal（engines/<engineId>/<分组>/
// journal-*.jsonl 与池时代 refs.json 残留，经 cleanupExpiredJournals）。journal 是
// 引擎运行证据域而非会话下挂内容——record 主数据（主 session 文件里的
// subagent-record entry）由引擎侧管理，其删除对 core 无触发点：done record 的
// journal 没有精确回收锚，workflow 域（taskId 占位无 record 生命周期锚）同样无锚，
// 只能按 mtime 兜底回收。子代理会话文件（<agentDir>/subagents 树：*.jsonl / sidecar
// / records manifest / *.events）不再有 TTL 清理——归属级联删除（主会话删 → 族删），
// 外部删除主文件场景接受残留。
//
// 触发确定性：进程内首次接线即扫一次 + 每 24h 定时复扫（startEngineJournalGcTimer，
// 对齐 main 侧 log-retention 形态），best-effort（失败不影响启动）；
// 调用方以 oncePerProcess 守卫防重复接线。

import { getEngineDataDir } from "../engine/common/data-dir.ts";
import { cleanupExpiredJournals } from "../engine/common/pool-manager.ts";

/** 30 天 TTL（毫秒）。 */
const TTL_DAYS = 30;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const TTL_MS = TTL_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** 每日复扫间隔（24h，对齐 main 侧 log-retention 的每日复扫形态）。 */
const GC_RESWEEP_INTERVAL_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * 回收引擎 journal（确定性触发，由调用方决定时机）。best-effort——任何异常不外抛。
 * dataDir 解析失败 = 未配置宿主服务，同样吞掉。
 */
export function cleanupExpiredEngineJournals(): void {
  try {
    cleanupExpiredJournals(getEngineDataDir(), TTL_MS);
  } catch (_e) {
    // best-effort：异常不外抛
    void _e;
  }
}

/**
 * 确定性触发接线：立即扫一次 + 每 24h 定时复扫（unref 不 hold 进程退出），
 * 返回 stop 函数（测试清理用）。形态对齐 main 侧 log-retention 的 startLogRetentionTimer；
 * 调用方以 oncePerProcess 守卫防重复接线。
 */
export function startEngineJournalGcTimer(): () => void {
  cleanupExpiredEngineJournals();
  const timer = setInterval(() => {
    cleanupExpiredEngineJournals();
  }, GC_RESWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
