// src/execution/worktree/worktree-patch-collection.ts
//
// [§3.1.6 双份接线收敛] worktree 未提交改动的 patch 快照落盘原语（单源）。
//
// 变化轴 = 「什么时候把 worktree 的未提交改动落成 patch 备份、路径怎么落」。两个调用
// 时点同属该轴，此前各写一份（persistence/finalize-record.ts 的终态收尾 Step 0 与
// service/record-lifecycle.ts 的归档资源回收）：正文逐行等价，但 try 边界（lifecycle
// 在 try 外取 manager，getter 抛错会上抛）与日志标签不一致——修一处漏一处即漂移，
// 故收敛到本文件。调用方语义差异只剩标签。

import * as fs from "node:fs";
import * as path from "node:path";

import { bestEffort } from "../assembly/best-effort.ts";
import { getSubagentSessionDir } from "../assembly/path-encoding.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

/**
 * worktree 绑定时把未提交改动快照到 sessionsDir/<branch>.patch，`written` 时回填
 * record.patchFile（防悬空路径：collectPatch 未写出则不留指针）。
 *
 * 落点在 worktree 之外（sessionsDir，rootSessionId 树内分区——随会话整树回收），
 * 避免随 cleanup 删除（[MF#3]）。
 * best-effort 语义在内部统一：任一环失败记日志不阻断调用方的收尾链（patch 失败 =
 * 续聊重建时无备份可恢复，形态①降级承接）。
 */
export async function collectWorktreePatch(opts: {
  /** 目标 record（读 worktreeHandle；`patch.written` 时回填 patchFile；分区键 =
   *  record.rootSessionId——嵌套派发全层同值，.patch 与 sessions/records 同树）。 */
  record: ExecutionRecord;
  /** WorktreeManager 取值（调用时点解引用——与各聚合 deps 的晚绑定口径一致）。 */
  getWorktreeManager: () => WorktreeManager;
  /** best-effort 失败标签（调用方语境，如 "collectPatch (finalizeRecord Step0)"）。 */
  label: string;
}): Promise<void> {
  const handle = opts.record.worktreeHandle;
  if (!handle) return;
  const rootSessionId = opts.record.rootSessionId;
  if (rootSessionId === undefined) {
    // record 尚未盖章 rootSessionId（spawn 窗口异常态）——无分区键可落，best-effort
    // 跳过（patch 缺失 = 续聊重建无备份，形态①降级承接，与 collectPatch 失败同向）。
    bestEffort(
      new Error("collectWorktreePatch: record.rootSessionId undefined (pre-bind window) — patch skipped"),
      opts.label,
    );
    return;
  }
  try {
    const sessionsDir = getSubagentSessionDir(rootSessionId);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const patchFile = path.join(sessionsDir, `${handle.branch}.patch`);
    const patch = await opts.getWorktreeManager().collectPatch(handle, patchFile);
    if (patch.written) opts.record.patchFile = patchFile;
  } catch (err) {
    bestEffort(err, opts.label);
  }
}
