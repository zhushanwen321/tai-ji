// src/execution/assembly/workflow-state-root.ts
//
// [session-store-layout-inversion D2/D3] workflow 域 run 状态目录解析（与 pi 壳
// JsonlRunStore 同源布局）。
//
// 布局（终态）：`<root>/<rootSessionId>/workflow/runs/<runId>.record.jsonl`
//   —— <root> = shared getSessionStoreDir() = `<dataDir>/ext-sessions/`。
// 分区键 = rootSessionId（run 创建记录字段，词表 run-events.ts RunCreatedEvent；
// 嵌套派发全层同值）。record 与 session 的关联从「cwd 目录分区 + rootSessionId
// 字段」升级为「目录级即字段级」——run 记录随 session 整树回收，删除链零清单。
//
// 旧布局 `<agentDir>/sessions/<cwd-slug>/workflow-state/`（encodeCwd 分区 +
// agentDir/cwd 探测）随布局反转退役：存量不迁移（设计裁决 11），读侧只认新树。
//
// 分层约束：core 不能 import extension——pi 壳 extensions/universal/
// subagent-workflow/src/session-lifecycle.ts 经 barrel 薄消费本文件的
// resolvePiWorkflowRunsDir（分区键 sid 由壳侧按 core 同式规则解析后传入）。
//
// 消费面边界 [MANDATORY]：显式 sid 推导锚「入参 sid」——任何进程、任何调用点
// 传入同一个 sid 即得同一个目录（布局单源的全部价值）。runtime 进程侧的读面
// 不猜 sid：枚举走 pi-host-run-store（扫 session 存储树一级），收编链
// journalDir 由枚举产物注入（ADR-0081）。**无参形态锚进程级当前 rootSessionId**
// （见 setPiWorkflowRootSessionId）——只在 pi 进程内、session_start 之后调用才
// 与写侧落盘一致。
//
// 公式消费 shared 新函数族（subagent-core 直接 import @taiji/shared，非镜像场景；
// shared getDataDir 读 TAIJI_AGENT_DATA_DIR，taiji 生产链经 ENV_WHITELIST_PREFIXES
// 注入 pi/引擎进程，裸跑落缺省 dev 树）。

import { getSessionStoreDir, getSessionWorkflowRunsDir, isPiSessionId } from "@taiji/shared/paths";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";

/**
 * 进程级当前 rootSessionId 锚（晚绑定）。
 *
 * 为什么是模块锚而不是逐调用点传参：run journal 的写者链（orchestration/
 * terminal-actions 的转移写点、resume-run、workflow-dispatch、model-switch 记账）
 * 与读链（run-event-journal 的模块锚解析）全部经无参形态取目录，把 sid 穿过
 * 这条链 = 一次跨编排层的大重构，超出布局反转的范围。锚的写点唯一 =
 * SessionBaselines.initSession（与 record 域 store 目录的 resolveStoreRootSessionId
 * 同一时点、同一取值），/new /resume 换 session 时随 initSession 覆写——目录绑定
 * session 生命周期（u-subagent 同款晚绑定纪律）。
 *
 * 未设定（initSession 前）时无参推导 fail-fast：静默回落到某个固定目录会让写侧
 * 落到非归属会话的树上（数据错位且不可回收），比抛错危险得多。
 */
let anchorRootSessionId: string | undefined;

/** 绑定进程级当前 rootSessionId（initSession 单点调用）。 */
export function setPiWorkflowRootSessionId(sessionId: string): void {
  anchorRootSessionId = sessionId;
}

/**
 * 解绑进程级锚（测试复位用）。
 *
 * 生产 dispose 链不清锚（当前无挂点，刻意如此）：session_shutdown 收尾的
 * terminateRunningRuns 转移帧仍须落当前 session 树——先 clear 会让收尾链的无参
 * 推导 fail-fast 抛错；锚的生命周期 = 下一次 initSession 覆写。
 */
export function clearPiWorkflowRootSessionId(): void {
  anchorRootSessionId = undefined;
}

/** 进程级锚是否已绑定（测试用——resolvePiWorkflowRunsDir 的 fail-fast 为单一文案，无分流）。 */
export function hasPiWorkflowRootSessionId(): boolean {
  return anchorRootSessionId !== undefined && anchorRootSessionId !== "";
}

/**
 * workflow run 状态目录（`<root>/<rootSessionId>/workflow/runs/`）——record 事件流
 * 与终局 manifest 的同目录落点。
 *
 * 公式单源在 shared getSessionWorkflowRunsDir（sessionId 过 isPiSessionId 同域
 * 校验，非法 sid throw = 路径穿越防线）。
 *
 * @param rootSessionId 分区键（根会话 id）；省略 = 进程级锚（见
 *   setPiWorkflowRootSessionId），未绑定时抛错
 * @param dataDir 可选数据根目录（测试注入）；缺省读 shared getDataDir()
 * @throws Error 当 rootSessionId 省略且进程级锚未绑定，或 sid 非法
 */
export function resolvePiWorkflowRunsDir(rootSessionId?: string, dataDir?: string): string {
  const sid = rootSessionId ?? anchorRootSessionId;
  if (sid === undefined || sid === "") {
    throw new Error(
      "workflow runs dir not resolvable: no rootSessionId bound (before initSession). " +
        "Recovery: pass the session id explicitly, or call setPiWorkflowRootSessionId(sid) " +
        "at session_start (SessionBaselines.initSession is the production binding point).",
    );
  }
  return getSessionWorkflowRunsDir(sid, dataDir);
}

/**
 * session 存储树内全部 workflow runs 目录（孤儿对账 / 保留维护轮的触发面枚举）。
 *
 * 枚举对象 = `<root>/` 一级 sid 目录的 `<root>/<sid>/workflow/runs/`。非合法
 * sessionId 形态的一级目录一律跳过（isPiSessionId，D7 树内遍历规约——防未来手放
 * 进存储树根的非会话目录被误枚举/误清）。
 *
 * 读错分通道（与 pi-host-run-store 的候选目录扫描层同纪律）：树根 ENOENT =
 * 从未落盘的正常空态（返回空数组）；EACCES / EIO 等真 IO 故障上抛——静默折叠成
 * 空集会让持续 IO 故障伪装成「0 个 run 待对账」。
 *
 * @param dataDir 可选数据根目录（测试注入）；缺省读 shared getDataDir()
 */
export async function listWorkflowRunsDirs(dataDir?: string): Promise<string[]> {
  const storeRoot = getSessionStoreDir(dataDir);
  let entries: Dirent[];
  try {
    entries = await readdir(storeRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }
  return entries
    .filter((ent) => ent.isDirectory() && isPiSessionId(String(ent.name)))
    .map((ent) => getSessionWorkflowRunsDir(String(ent.name), dataDir));
}
