// src/execution/persistence/engine-journal-gc.ts
//
// 引擎 journal TTL 回收定时器（30 天 mtime TTL）+ worktree .patch 孤儿清扫。
//
// 范围（2026-10-12 用户裁决：会话下挂内容的回收统一归删主会话级联——runtime
// session-content-cascade）：本模块只负责两类「无精确回收锚、只能按 mtime 兜底
// 回收」的文件——
//   1. 引擎 journal（engines/<engineId>/<分组>/journal-*.jsonl 与池时代 refs.json
//      残留，经 cleanupExpiredJournals）。journal 是引擎运行证据域而非会话下挂内容
//      ——record 主数据（主 session 文件里的 subagent-record entry）由引擎侧管理，
//      其删除对 core 无触发点：done record 的 journal 没有精确回收锚，workflow 域
//      （taskId 占位无 record 生命周期锚）同样无锚，只能按 mtime 兜底回收。子代理
//      会话文件（<agentDir>/subagents 树：*.jsonl / sidecar / records manifest /
//      *.events）不再有 TTL 清理——归属级联删除（主会话删 → 族删），外部删除主文件
//      场景接受残留。
//   2. worktree .patch 备份（<agentDir>/subagents/<enc>/sessions/<branch>.patch，
//      落盘源 = worktree/worktree-patch-collection.ts）。按 branch 命名、与 .jsonl
//      basename 无关联，v2 条目契约不承载 patchFile/branch（record-store-rebuild
//      缺省纪律，权威源在 manifest 与子 session 文件）——级联的引用并集（record id
//      ∪ sessionFile）无锚可达。该清理原由 session-file-gc 孤儿 sidecar 名单承担
//      （[MF#2]），随机制废弃一并断链（ADR-0133 误判为接受残留——正常路径产物永久
//      堆积不成立，原注释即以「避免永久堆积」为清理义务依据），恢复为仅 *.patch 的
//      两层枚举 mtime TTL 清扫（cleanupOrphanWorktreePatches）：不触碰级联领地的
//      .jsonl / sidecar / manifest / .events 族；record.patchFile 指针超龄后悬空 =
//      「续聊重建无备份可恢复」的既有形态①降级承接，无新增危害。
//
// 触发确定性：进程内首次接线即扫一次 + 每 24h 定时复扫（startEngineJournalGcTimer，
// 对齐 main 侧 log-retention 形态），best-effort（失败不影响启动）；
// 调用方以 oncePerProcess 守卫防重复接线。.patch 清扫根经 getSessionStoreDir 缺省
// 推导（session 存储树，与写侧同源）；引擎 journal 段独立于此参数恒生效。

import * as fs from "node:fs";
import * as path from "node:path";

import { getSessionStoreDir, isPiSessionId } from "@taiji/shared/paths";

import { getEngineDataDir } from "../engine/common/data-dir.ts";
import { cleanupExpiredJournals } from "../engine/common/pool-manager.ts";

/** worktree patch 备份文件后缀（worktree-patch-collection.ts 落盘字面量）。 */
const WORKTREE_PATCH_SUFFIX = ".patch";

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
 * 回收引擎 journal + worktree .patch 孤儿（确定性触发，由调用方决定时机）。
 * best-effort——任何异常不外抛。dataDir 解析失败 = 未配置宿主服务，同样吞掉。
 * dataDir 传入时同批清扫 session 存储树各会话树 `<root>/<sid>/subagents/sessions/`
 * 内的 .patch（文件头范围 2；缺省 = 仅引擎 journal）。
 */
export function cleanupExpiredEngineJournals(dataDir?: string): void {
  try {
    cleanupExpiredJournals(getEngineDataDir(), TTL_MS);
    if (dataDir !== undefined) cleanupOrphanWorktreePatches(getSessionStoreDir(dataDir), TTL_MS);
  } catch (_e) {
    // best-effort：异常不外抛
    void _e;
  }
}

/**
 * worktree .patch 孤儿清扫：`<storeRoot>/<sessionId>/subagents/sessions/` 三段枚举，
 * 仅 `*.patch` 按 mtime TTL unlink（布局 = worktree-patch-collection 落盘点
 * getSubagentSessionDir 的 `<root>/<rootSessionId>/subagents/sessions/`，
 * session-store-layout-inversion D2/D3 换根——.patch 属 subagent 文件族随会话树走；
 * 引擎 journal 段不迁移，见文件头豁免登记）。一级目录名须是合法 sessionId 形态
 * （isPiSessionId 同域判定——非会话目录跳过，防手放目录被误扫）。逐文件逐目录
 * best-effort（单文件失败静默——文件可能已被删除；存储树根不存在 = 从未有过
 * 会话，合法空态）。不递归 walk、不触碰非 .patch 文件——级联领地（.jsonl /
 * sidecar / manifest / .events）的回收权威在 runtime session-content-cascade。
 */
function cleanupOrphanWorktreePatches(storeRoot: string, ttlMs: number): void {
  let sessionDirs: fs.Dirent[];
  try {
    sessionDirs = fs.readdirSync(storeRoot, { withFileTypes: true });
  } catch (_e) {
    void _e; // 根不存在（从未有过会话）或不可读：无可清理，静默
    return;
  }
  for (const ent of sessionDirs) {
    if (!ent.isDirectory() || !isPiSessionId(ent.name)) continue;
    const sessionsDir = path.join(storeRoot, ent.name, "subagents", "sessions");
    let names: string[];
    try {
      names = fs.readdirSync(sessionsDir);
    } catch (_e) {
      void _e; // 该会话树无 subagents/sessions 子目录：合法空态
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(WORKTREE_PATCH_SUFFIX)) continue;
      const full = path.join(sessionsDir, name);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > ttlMs) fs.unlinkSync(full);
      } catch (_e) {
        void _e; // 文件可能已被删除，忽略
      }
    }
  }
}

/**
 * 确定性触发接线：立即扫一次 + 每 24h 定时复扫（unref 不 hold 进程退出），
 * 返回 stop 函数（测试清理用）。形态对齐 main 侧 log-retention 的 startLogRetentionTimer；
 * 调用方以 oncePerProcess 守卫防重复接线。无参——.patch 清扫根经 getSessionStoreDir
 * 缺省推导（与写侧同源同值；单测注入走 cleanupExpiredEngineJournals(dataDir)）。
 */
export function startEngineJournalGcTimer(): () => void {
  cleanupExpiredEngineJournals();
  const timer = setInterval(() => {
    cleanupExpiredEngineJournals();
  }, GC_RESWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
