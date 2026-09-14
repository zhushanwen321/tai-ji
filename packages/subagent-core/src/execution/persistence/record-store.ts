// src/execution/persistence/record-store.ts
//
// Record 的统一容器 + 意图原语立面。内存只留 running record；磁盘 record 从
// session.jsonl + `.state` 按 §3.2.4 重建单规则重建（一律 idle + stopReason 单源）。
//
// [H4 三轴拆分（2026-09-13）] 本文件保留容器职责（构造/字段/依赖注入/生命周期）+
// 意图原语立面（public 签名不变，实现转发）+ 有状态扫描编排（fileCache/dirStamp/
// 索引/孤儿恢复）；三轴实现拆至同级文件（D7 写面约束：`.state`/`.alive`/manifest
// 写函数的调用与 import 只留在本文件，轴文件经 ctx 注入，守卫零改动）：
//   - record-store-terminal.ts —— 终态原语轴（终态/settle/意愿动作原语实现）
//   - record-store-rounds.ts —— 轮次簿记轴（轮始/轮末收口 + binding settle 快照）
//   - record-store-rebuild.ts —— 重建与投影轴（buildRecord 单规则/entry 重建/
//     manifest 投影/缓存戳类型——纯读纯投影，无写面）
//
// 职责：
//   - 持有 running record（归档/回收 record 在 archive 时立即从内存移除）
//   - onChange 订阅（TUI widget/list 据此重渲）
//   - collectRecords：内存(running) ∪ 磁盘(sessions/*.jsonl 重建) ∪ 主 session entry 源
//     （[U7/B-restart] zcode record 专用缺员补源）∪ manifest(sessions-index.json 补充) 四源合并
//   - 提供 snapshot() 只读视图给 TUI（永不返回可变引用）
//
// ════════════════════════════════════════════════════════════════════
// [U1 / record 持久化收敛 §3.1] 意图级操作 API 立面（store 唯一写入口）
// ════════════════════════════════════════════════════════════════════
// 调用方说「发生了什么」，不说「写哪个文件」——文件布局知识收在本类内部。
// 迁移已完成：全部写点经本 API，旧直写路径已删除（守卫见 D7）。
//
// | 意图原语 | 语义 | 内部写面 |
// |---------|------|---------|
// | register(record) | 创建入册（既有方法，意图语义补齐） | entry（best-effort）+ 缓存一致性（stat 戳自校验承接） |
// | appendEvent(id, event) | 事件追加（过程；turns 归约） | entry 变迁（best-effort） |
// | markRoundStarted(id) | 轮始重置（status=running + result/resumable 清除） | entry（best-effort） |
// | markRoundIdle(id, outcome) | 轮末收口（[two-state-convergence U4/D3] 轮终翻边写 idle，resumable 不再写——idle 即 resumable；簿记全集①-⑪见方法注释；簿记⑦ `.alive` 保留——写权声明跨轮延续，D3a；⑩⑪ A-lite 轮终 stopReason 展示位 + `.state` 收条/binding 快照） | `.state` 收条 + binding 快照（A-lite）+ entry + 注销发射点② |
// | markBatchFinalized(records) | sync 批终态（barrier：manifest 落盘完成先于批通知写账——「通知可达 ⇒ 索引就位」构造性保证） | barrier + 批 entry + manifest |
// | adoptEngineDeath(id, {error}) | 引擎死亡收养（error/result/resumable 三写；监督器接管编排留调用方） | entry（best-effort） |
// | markResurrected(record, wasClosed) | 磁盘终态位翻回活态（acquire-first 三件套 + 内存翻回 + register，单 try 域原子收敛，任一步失败响亮抛错，D3c） | `.alive` 写（writeSync）先 → `.state`/`.finalized`/`.cancelled` 删 + 内存翻回 + register |
// | acquireWriteLease(sessionFile, id) | store 内部 acquire 动作（writeAliveMarker 唯一包装；spawn 侧 sessionFile 回填挂钩用，D3a 时机①，U2b 消费） | `.alive` 写（失败响亮抛错） |
//
// ── legacy 例外原语（workflow D7 例外族 / 监督器放弃专用；新调用面禁用）──
// | markFinalized(record, reason) | closed 终态化（仅 workflow D7 例外族 / 监督器放弃 / 引擎死亡不可接管兜底消费；副作用编排 abort/kill/disarm/CAS/promote 留调用方） | `.state` writeSync 先 → binding（updateRecordBinding）→ entry/archive → manifest writeSync → `.alive` 删（D8 v7 写序） |
// | markCancelled(record) | cancelled 终态化（仅 workflow D7 例外族 abort 路径；tombstone endedAt） | 同 markFinalized 写序（writeCancelledState） |
// | markIdleArchived(record) | markIdleEvicted 的 deprecated 转发别名（@deprecated，存量测试消费；生产调用点已迁名） | 完整委托 markIdleEvicted |
//
// ── [永久会话模型 / u-foundation 骨架] 新意图原语（设计 subagent-permanent-session-model.md
//    §3.2.2 事件表 / §3.2.3 reopen / §3.2.5 意愿动作表；签名已定，实现 U2 填肉）──
// | markSettled(record, stopReason) | 轮收口（settle：成功/失败/中断统一落 idle + stopReason；替代 markFinalized/markCancelled 的轮收口角色） | U2 定（usage 快照落 binding + manifest 投影；`.alive` 跨轮保留） |
// | markReopened(record, transcriptRef) | 带历史重开（新 transcriptRef + round 归零 + epoch+1 + stopReason=reopened，§3.2.3） | U2 定（binding 持久化 epoch/锚） |
// | markArchived(record) | close 收起（intent 翻转 archived + `.alive` release，§3.2.4 release 出口①） | U2 定（worktree/patch/注销编排留调用方） |
// | markIdleEvicted(record) | 内存回收（30 天 TTL，用户不可见，非终态化——磁盘不动、可重建接管） | store.archive 先 → manifest（running 投影）→ `.alive` release 后（archive 抛错则整体失败 marker 必未删） |
//
// ── 字段级写点全集 → 操作映射（设计 §3.1 v4 十字段逐一归口）──
//   ① status      —— 轮始重置→markRoundStarted；轮终翻边 idle（U4/D3）→markRoundIdle；
//                    终态→markFinalized/markCancelled（内存冻结由调用方 completeRecord/
//                    tryTransition 先行，store 收口持久化面）
//   ② result      —— 轮始清→markRoundStarted；轮终写→markRoundIdle(outcome)；终态→
//                    markFinalized 序言（completeRecord 冻结后随 entry/manifest 投影）
//   ③ round       —— 轮终 +1→markRoundIdle
//   ④ closedReason—— 终态→markFinalized/markCancelled；轮终清除→markRoundIdle（[S10]）
//   ⑤ resumable   —— 轮始清→markRoundStarted（轮终不再写，U4/D3 idle 即 resumable；
//                    字段删除归 U5 批）；收养→adoptEngineDeath
//   ⑥ idleSince   —— 轮终刷新→markRoundIdle
//   ⑦ sessionFile —— 回填族（run 应答/promote）归调用方内存回填 + register/
//                    markFinalized 序言随投影持久化；acquireWriteLease 在锚点确立时
//                    声明写权（D3a 时机①）
//   ⑧ turns       —— 事件累积族→appendEvent（execution-record.updateFromEvent 归约）
//   ⑨ lastError   —— 轮终失败→markRoundIdle failed 载荷
//   ⑩ error       —— 收养/失败→adoptEngineDeath/markRoundIdle
//   ⑪ stopReason  —— 轮终写（成功 completed / 失败 failed，A-lite 展示位——status
//                    已翻 idle，U4/D3）→markRoundIdle；settle 写（中断族）→markSettled
//
// [perf] 两级读写设计（修复 /subagents 打开慢）：
//   1. 列表扫描 = light：只读文件头部 identity（readIdentityHeader，64KB）+ sidecar
//      状态矩阵，不解析 message entries。列表/补全/hasRunning 只需身份与状态，
//      586MB 级 sessions 目录的全量 JSON.parse（秒级）从列表路径上消失。
//   2. 详情 = getFullRecord(id) 懒加载：选中/单独查询时才对该文件全量重建
//      （reconstructFromFile），turns/eventLog/result 等重数据仅按需解析。
//   3. per-file 缓存 + stat 戳校验（mtime+size）：register/archive 等内存事件
//      不再整体失效缓存；任何磁盘写入（jsonl append / sidecar 覆盖）只重建对应
//      单文件，其余 N-1 个文件复用缓存（stat 校验毫秒级）。
//   4. [perf L-1] sessions-index.json（sessionsDir 兄弟位置）：identity 探测结果的
//      磁盘种子——冷启动首扫读一次（惰性装载），dirty 扫描后按 60s 节流落盘
//      （fileCache 投影，fire-and-forget）；运行期 L0/L1 语义不变，损坏/低版本
//      静默回退全扫，高版本忽略不重写。见 sessions-index.ts。
//   5. [U4c / D5 缓存降级] manifest 与 sessions-index 均为可丢缓存（权威 = `.state`）：
//      重建双通道 = boot revive 完成后全量（rebuildIndexes，宿主 boot 钩子接线）+
//      查询面惰性（mergedRecords 对 manifest 缺员的磁盘重建 record 单点补建，每 id
//      每进程一次）；重建失败静默降级（子 session 已 GC/损坏 → 该条跳过，整轮不抛）。

import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "../../core/logger.ts";

import { snapshot as toSnapshot } from "./execution-record.ts";
import { statStateStamp, writeFinalizedState, writeCancelledState, writeSettledState } from "./state-marker.ts";
// [UF-1] record 绑定 sidecar：宿主侧 id→file 映射（engine-CLI 化后子文件无 identity
// entry 时代的身份载体）——scanFile 探测分支在 identity miss 时消费它重建 light record。
// [U7 / §3.2.7 统计口径] zcodeAnchorBasePath 供 zcode 锚的 binding/写权声明键派生
// （U6-D2 交接：binding 键 = 锚基底 + 扩展名，pi 锚基底 = 子 session 文件路径）；
// binding 读写函数的调用已随终态轴/投影轴外迁（readRecordBinding/writeRecordBinding/
// updateRecordBinding 仅经轴文件 import——读函数与 binding 写不在 D7 七名拦截面）。
import { RECORD_BINDING_SIDECAR_EXT } from "./state-marker.ts";
import { toSubagentRecordEntry } from "./record-entry.ts";
import type { ManifestRecord, ManifestStore } from "./manifest-store.ts";
import { INDEX_WRITE_MIN_INTERVAL_MS, loadIndex, saveIndex } from "./sessions-index.ts";
import type { SessionsIndexEntry, SessionsIndexNegativeEntry } from "./sessions-index.ts";
// [H4 三轴拆分] 重建与投影轴（record-store-rebuild.ts）：buildRecord 重建单规则 /
// entry 重建族 / manifest 读写投影 / 缓存戳类型——纯读纯投影纯函数（无写面，
// D7 七名写函数零 import），容器扫描与原语实现共同消费。依赖方向单向：
// store → rebuild（rebuild 不回 import store，无环）。
import {
  buildFileCacheEntry,
  buildRecord,
  collectLastRecordEntries,
  compareRecords,
  derivedManifestRecord,
  detectIdentity,
  identityFromBinding,
  isFreshCache,
  manifestToSubagent,
  mergeOrphanLastEntry,
  readSidecarPayloads,
  rebuildEntryRecord,
  recordToSubagent,
  sameStamp,
  statStamp,
  terminalManifestRecord,
} from "./record-store-rebuild.ts";
import type { FileCacheEntry, FileCacheValue, FileStamps, Stamp } from "./record-store-rebuild.ts";
// [H4 三轴拆分] 终态原语轴（record-store-terminal.ts）：markFinalized/markCancelled/
// markSettled/markArchived 等终态/settle/意愿动作原语实现 + binding settle 快照族——
// 经 TerminalCtx 注入本类写面（七名写函数调用字面只留在本文件，D7 守卫零改动）。
// 依赖方向单向：store → terminal → {rebuild}（terminal 不回 import store，无环）。
import {
  MANIFEST_INDENT_SPACES,
  markArchivedImpl,
  markBatchFinalizedImpl,
  markCancelledImpl,
  markFinalizedImpl,
  markIdleArchivedImpl,
  markIdleEvictedImpl,
  markReactivatedImpl,
  markReopenedImpl,
  markResurrectedImpl,
  markSettledImpl,
} from "./record-store-terminal.ts";
import type { TerminalCtx } from "./record-store-terminal.ts";
// [H4 三轴拆分] 轮次簿记轴（record-store-rounds.ts）：appendEvent/markRoundStarted/
// markRoundIdle/adoptEngineDeath 实现——轮次过程簿记（轮始重置/轮末收口/事件归约/
// 收养）。经 RoundsCtx 注入（records 共享 Map + persistSettledState 写面注入）。
// 依赖方向单向：store → rounds → {terminal, rebuild}（不回 import store，无环）。
import {
  adoptEngineDeathImpl,
  appendEventImpl,
  markRoundIdleImpl,
  markRoundStartedImpl,
} from "./record-store-rounds.ts";
import type { RoundsCtx } from "./record-store-rounds.ts";
import { reconstructFromFile } from "./session-reconstructor.ts";
import type {
  AgentEvent,
  ClosedReason,
  ExecutionRecord,
  RecordSnapshot,
  StopReason,
  SubagentRecord,
  TranscriptRef,
} from "../assembly/types.ts";
// [U4a / D3b (a″)] findForeignLiveInstance：孤儿恢复的活实例跳过判据——现查探针
// 替代重建时 externalInstance 缓存（pid 单判据 + self-pid 排除，比缓存更新鲜）。
import { writeAliveMarker, removeAliveMarker, findForeignLiveInstance } from "./alive-store.ts";
import type { RoundSettlementOutcome } from "./finalize-record.ts";
import { writeAtomicFileSync } from "../../shared/atomic-write.ts";

const logger = getLogger("subagents");

// ============================================================
// 常量
// ============================================================
// [D8 v7] manifest 同步写缩进常量（MANIFEST_INDENT_SPACES）已随终态原语轴外迁
// record-store-terminal.ts（本文件经 import 消费）。

/** store 变更监听器（返回取消订阅函数）。 */
export type ChangeListener = () => void;

/** status 过滤模式（collectRecords 的核心能力参数）。 */
export type StatusFilter = "running" | "all";

/** Pi ExtensionAPI 的最小子集（仅 collectRecords 跳过损坏 manifest 时上报用）。
 *  解构为局部类型，避免与 subagent-service 的 PiLike 循环依赖。 */
export type RecordStorePi = {
    appendEntry?: (customType: string, data: unknown) => void;
} | null | undefined;

// ============================================================
// RecordStore
// ============================================================

/**
 * Record 容器。进程单例（随 SubagentService 重建）。
 *
 * 内存只留 running record——终态 record 在 archive 时立即移除，collectRecords
 * 读时从 sessions/*.jsonl 重建（[perf] light 头部扫描 + per-file 缓存）。
 *
 * 任何 mutate → notifyChange()（仅通知监听器；磁盘缓存靠 stat 戳自校验，不清空）。
 *
 * record 状态查询面（U10① D6）：按状态枚举 listRunning/collectRecords(statusFilter)、
 * 按 id 查询 getMutable/findLightById/getFullRecord——方法签名即导出形态，本类零改动。
 *
 * @experimental execution 运行时面（设计 docs/design/subagent-core-sink-design.md（已删，git 可追溯） §3.3 D6）：
 * 一个 minor 周期内允许签名微调，稳定后转常规 semver 承诺。
 */
export class RecordStore {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly listeners = new Set<ChangeListener>();
  private _disposed = false;
  /** 孤儿终态恢复的已判定缓存（residual-fixes）：resumable 形态无 sidecar 锚，同进程重复调用跳过。 */
  private orphanJudged = new Set<string>();
  /** Pi handle（用于 appendEntry 上报损坏 manifest）。构造时可空，setPi() 后续注入。
   *  显式存为字段而非构造参数 readonly：setPi 需要写权限。 */
  private pi: RecordStorePi = null;

  /** [perf] per-file 缓存（key = sessionFile 绝对路径）。不再整体失效——stat 戳精准校验。
   *  值含负缓存（确认无 identity 的文件），防每轮全文 fallback 重读。 */
  private readonly fileCache = new Map<string, FileCacheValue>();
  /** record id → sessionFile 索引（getFullRecord 按 id 定位文件）。随 fileCache 同步维护。 */
  private readonly idToFile = new Map<string, string>();
  /** [perf] sessionsDir 最近一次全量扫描的 mtime（快路径判变，见 reconstructAll）。
   *  null = 未扫过 / 已 dispose。 */
  private dirStamp: { mtimeMs: number } | null = null;

  /** [perf L-1] 首扫惰性装载的磁盘索引只读映像（key = jsonl basename）。
   *  扫描尾（flushIndexAfterScan）与 readdir 失败路径释放——运行期索引不再被读（L1 接管）。 */
  private indexEntries: Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry> | null = null;
  /** [perf L-1] 本轮起未落盘的探测标志：scanFile 走过探测分支即置位。发起写时消费
   *  （置 false）、写失败恢复；未写路径不清位——未落盘的探测成果跨轮携带直至真正写入。 */
  private indexDirty = false;
  /** [perf L-1] 上次成功落盘墙钟（节流基准）。0 = 从未写过 → 首扫 dirty 必写；
   *  仅成功分支推进（写失败不推进节流窗，下轮过窗重试）。 */
  private lastIndexWriteAt = 0;
  /** [perf L-1] loadIndex 高版本标志的进程级持久态：true 时本进程所有后续扫描均不
   *  落盘（防 v1/v2 last-writer-wins 覆盖振荡），直至下次 loadIndex 重新评估。 */
  private indexHigherVersion = false;

  /** [U4c / G1] manifest 惰性重建的每 id 尝试守卫（mergedRecords 高频路径防磁盘写
   *  放大：每 id 每进程至多一次；dispose/revive 随其余缓存态一并重置）。 */
  private manifestRebuildTried = new Set<string>();

  /** [U7 / B-restart store 面] 主 session 文件路径（entry 源读取锚——经
   *  recoverOrphanRecords / recoverEntryOnlyOrphans 入参记忆，record-access
   *  initSession 恢复段供给；undefined = 未初始化（测试/纯内存形态），entry 源空转）。 */
  private mainSessionFile: string | undefined;
  /** [U7] entry 源缓存 + stat 戳（主 session append 频繁——戳同零读复用，稳态成本
   *  1×statSync；变化重读「每 id 末条」全量行，collectLastRecordEntries 快过滤承担）。 */
  private mainEntryStamp: Stamp | null = null;
  private mainEntryCache: SubagentRecord[] = [];

  /**
   * [D8 v7] manifest 同步写目录（与 manifestStore 同一 records 目录，由构造方提供——
   * manifestStore.dir 私有，本类不经反射访问）。提供时终态原语（markFinalized /
   * markCancelled / markBatchFinalized）走 writeAtomicFileSync 同步落盘——停机窗
   * fire-and-forget 竞态构造性消灭（disposeAllRecords 同步链全链同步段内完成）；
   * 已接线（subagent-service.ts 构造点 recordsDir）；缺省分支仅纯内存测试形态。
   */
  private readonly manifestDir: string | undefined;

  /**
   * [§3.1 markRoundIdle 簿记⑧] pending-notifications 轮终注销（发射点②）的注入面。
   * store 不直接依赖 pending 注册表（「零副作用编排」边界——文件布局收口 ≠ 通知
   * 注册表依赖）；由 SubagentService 构造点注入 emitPendingUnregister 闭包（U5 收口
   * 接线），缺省 no-op（纯内存测试形态不发射）。
   */
  private pendingUnregister: ((id: string, status: string) => void) | undefined;

  /**
   * [H4 三轴拆分] 终态原语轴（record-store-terminal.ts）的写面通道：D7 七名写函数
   * 的调用字面与 manifest/entry 写面收口在本类（守卫白名单物理边界 = 本文件），轴
   * 实现经注入消费——注入名避开七名（persistFinalized / acquireLease 等，见
   * TerminalCtx 注释）。构造时一次性绑定（this 闭包，运行时读字段——pi 等 setPi
   * 注入的通道随调用时点取值）。
   */
  private readonly terminalCtx: TerminalCtx;

  /**
   * [H4 三轴拆分] 轮次簿记轴（record-store-rounds.ts）的通道：records 传共享 Map
   * 引用（零拷贝）；`.state` 收条经 persistSettledState 注入（避开七名）；pending
   * 注销经 emitPendingUnregister 闭包（调用时读 this.pendingUnregister——
   * setPendingUnregister 注入后生效）。
   */
  private readonly roundsCtx: RoundsCtx;

  constructor(
    private readonly sessionsDir: string,
    private readonly manifestStore?: ManifestStore,
    /** Pi 入口（注入 appendEntry 用于上报损坏 manifest）。
     *  SubagentService 构造时 this.pi 尚未注入（session_start 之前），传 undefined 兜底；
     *  后续通过 setPi() 注入（见下）。允许 null = 兼容 PiLike 字段类型。 */
    pi?: RecordStorePi,
    /** [D8 v7] manifest 同步写目录（见 manifestDir 字段注释）。 */
    manifestDir?: string,
  ) {
    this.pi = pi ?? null;
    this.manifestDir = manifestDir;
    // 终态轴通道绑定：写函数经箭头闭包**调用时解引用**（与原方法体内联调用同款
    // 懒访问形态——vi.mock 部分模拟 alive-store 等场景下，未触达的写面不因构造期
    // 顶层解引用而报 mock 缺 key）；容器方法经 this 闭包（pi 通道在调用时点取值，
    // setPi 后生效）。
    this.terminalCtx = {
      persistFinalized: (file, reason) => writeFinalizedState(file, reason),
      persistCancelled: (file, endedAt) => writeCancelledState(file, endedAt),
      persistSettledState: (file, payload) => writeSettledState(file, payload),
      acquireLease: (file, marker) => writeAliveMarker(file, marker),
      releaseLease: (file) => removeAliveMarker(file),
      writeBatchManifest: (m) => this.manifestStore!.writeManifest(m),
      manifestDir,
      archive: (r) => this.archive(r),
      register: (r) => this.register(r),
      reportRecordTransition: (r) => this.reportRecordTransition(r),
      reportSubagentRecord: (r) => this.reportSubagentRecord(r),
      writeManifestPersisted: (id, m) => this.writeManifestPersisted(id, m),
      writeTerminalManifest: (r) => this.writeTerminalManifest(r),
      notifyChange: () => this.notifyChange(),
    };
    // 轮次轴通道绑定：records 共享引用；写函数调用时解引用（同上——懒访问形态）。
    this.roundsCtx = {
      records: this.records,
      persistSettledState: (file, payload) => writeSettledState(file, payload),
      emitPendingUnregister: (id, status) => this.pendingUnregister?.(id, status),
      reportRecordTransition: (r) => this.reportRecordTransition(r),
      notifyChange: () => this.notifyChange(),
    };
  }

  /** session_start 后由 SubagentService.initSession 调，注入真实 Pi handle。
   *  设计为独立方法而非要求构造时必传——RecordStore 在 SubagentService 构造时即建
   *  （与 sessionsDir/manifestStore 一同初始化），但 this.pi 此时尚未注入。
   *  后续构造期外的 appendEntry 上报才有意义。 */
  setPi(pi: RecordStorePi): void {
    this.pi = pi ?? null;
  }

  /** 注册新 record。触发 onChange。
   *  W16 [D4]：record 诞生（→ running）即 append 自描述快照 entry——pi 文件是
   *  扩展数据持久化权威，custom entry 不进 LLM context。 */
  register(record: ExecutionRecord): void {
    this.records.set(record.id, record);
    this.pi?.appendEntry?.("subagent-record", toSubagentRecordEntry(recordToSubagent(record)));
    this.notifyChange();
  }

  /**
   * 归档：record 已被 completeRecord 设置了终态 status。
   * 立即从内存移除（终态 record 下次读时从 session.jsonl 重建）。
   * cancelled record 由调用方先写终态 sidecar（cancel 路径），此处只负责移除。
   *
   * W16 [D4]：终态冻结字段（result/endedAt/closedReason）在 completeRecord 已就绪，
   * 此处 append 的快照即完整终态记录（所有终态路径的必经锚点）。
   */
  archive(record: ExecutionRecord): void {
    this.records.delete(record.id);
    this.pi?.appendEntry?.("subagent-record", toSubagentRecordEntry(recordToSubagent(record)));
    this.notifyChange();
  }

  /**
   * W16 [D4]：类外状态写点上报（record-store 内的迁移点 register/archive 已内置）。
   *
   * 供 service 层直接改 record.status 的恢复写点调用（chatMode 续轮 idle→running
   * 冷路径 resumeRound；轮终收口已随 markRoundIdle 簿记⑨内置，不经本方法）——这些
   * 写点绕过 register/archive，若不显式上报，pi 文件缺失该次迁移、重建源滞后。
   * pi 未注入（session_start 前）时可选链静默降级，不阻断主流程。
   */
  reportRecordTransition(record: ExecutionRecord): void {
    this.pi?.appendEntry?.("subagent-record", toSubagentRecordEntry(recordToSubagent(record)));
  }

  // ════════════════════════════════════════════════════════════
  // [U1 / §3.1] 意图级操作 API 立面（store 唯一写入口；映射表见模块头）
  // ════════════════════════════════════════════════════════════

  /**
   * 注入 pending-notifications 轮终注销闭包（markRoundIdle 簿记⑧发射点②，见字段
   * pendingUnregister 注释）。装配点 = SubagentService 构造器（U5 收口接线）。
   */
  setPendingUnregister(fn: ((id: string, status: string) => void) | undefined): void {
    this.pendingUnregister = fn;
  }

  /**
   * 意图原语：事件追加（过程记录）。turns/eventLog/totalTokens 经 execution-record
   * 事件归约累积（字段⑧），随后 entry 变迁上报（best-effort——过程面可丢，重建由
   * 子 session 文件承接）。调用方按事件粒度决定调用频率（高频 delta 逐事件上报会
   * 放大 entry 写面，编排粒度属调用方职责）。
   *
   * @returns false = id 不在内存（未注册/已归档）——事件丢弃并 debug 留痕。
   */
  appendEvent(id: string, event: AgentEvent): boolean {
    return appendEventImpl(id, event, this.roundsCtx);
  }

  /**
   * 意图原语：轮始重置（字段①②⑤）。status=running + result/resumable 清除——
   * §5.4 isStreaming 公式要求 result undefined 才显示 streaming，不清则续轮流仍显示
   * waiting。归口写点：热路径轮始与冷启动 resume 续轮（subagent-service，U3 迁移）。
   *
   * @returns false = id 不在内存（debug 留痕，无副作用）。
   */
  markRoundStarted(id: string): boolean {
    return markRoundStartedImpl(id, this.roundsCtx);
  }

  /**
   * 意图原语：轮末收口——**写 idle**（[two-state-convergence U4/D3] A-lite 桥接退役：
   * 收口权威词对齐 §3.2.2 事件表；SP-5 升级链兼容性依据见 record-store-rounds
   * 方法头）。簿记全集（①-⑪）：
   *   ① status 写 idle；② result 按 outcome 写入（成功=content / 失败=前值??
   *      失败摘要 + lastError）；③ round+1；④ closedReason 清除（[S10]）；⑤ resumable
   *      不再写（idle 即 resumable——正常路径轮始已清，轮终保持 undefined）；⑥
   *      idleSince 刷新（idle-GC 判据锚）；⑦ **`.alive` 保留**
   *      （D3a 跨轮延续——写权声明至 release 两出口[终态原语/idle-GC 归档]，轮终
   *      record 随时续聊 spawn 写同一 sessionFile，删则轮后跨进程防御
   *      空窗）；⑧ pending 注销发射点②（进程已死，从活跃后代差集移除——经
   *      setPendingUnregister 注入，未注入时跳过）；⑨ reportRecordTransition（entry
   *      携带新 round 与本轮 result）；
   *      ⑩ [A-lite] stopReason 展示位（成功轮 completed / 失败轮 failed——status 已
   *      idle，endedAt 不写）；⑪ [A-lite / U7] 轮终磁盘面（锚分派对齐 markSettled：
   *      pi 腿 `.state` 收条 + binding 快照 / zcode 腿锚键 binding 快照——正常轮终后
   *      宿主崩溃 revive 水合 turns/tokens 不归零）。
   * worktree/通知等副作用编排留调用方。
   *
   * @param outcome 轮终结果（kind 判别：success=content / failed=reason）
   * @returns false = id 不在内存（debug 留痕，无副作用）。
   * @throws Error record 终态簿记已冻结（endedAt 已设——复活终态的调用即 bug，
   *         fail-fast，对齐 doFinalizeRoundToIdle A3 断言）。
   */
  markRoundIdle(id: string, outcome: RoundSettlementOutcome): boolean {
    return markRoundIdleImpl(id, outcome, this.roundsCtx);
  }

  /**
   * 意图原语：正常终态（含 disposeAllRecords 编排性关闭，reason=parent-*，D8 矩阵）。
   * 只吸收**持久化面**——collectPatch / worktree cleanup / pending 注销① / onFinalized
   * 钩子留调用方编排（§3.1 副作用边界）。内存终态冻结（completeRecord/tryTransition
   * 桥接：置 idle + closedReason/stopReason 双写）亦留调用方——状态机操作非文件布局。
   *
   * 内部写序（D8 v7）：`.state` writeSync **先**（终态权威优先落）→ entry/archive →
   * manifest writeSync 后 → `.alive` 删除（release 出口①）。
   *
   * 失败语义（§3.4）：`.state` 重试耗尽仍未落 → 返回 false，**零持久化副作用**（不
   * archive / 不写 manifest / 不 release 写权声明）——record 留 running 形态（磁盘无
   * 终态位，下次 boot 孤儿恢复终态化承接）；错误已在 state-marker 层 error 级响亮暴露。
   *
 * [U2 桥接期] 永久会话模型下终态概念删除，本原语保留旧持久化编排直至 U5 意愿动作
 * 接线退役（正常收口归 markSettled、归档归 markArchived、编排性关闭归新编排）；
 * `.state` 旧格式由 U3 读侧单规则上行映射（finalized → idle + stopReason=reason）。
   *
   * @returns true = 持久化面完成；false = `.state` 未落（record 不应被视作已终态化）。
   * @deprecated U5 退役（归 markSettled / markArchived / 编排性关闭新编排承接）。
   */
  markFinalized(record: ExecutionRecord, closedReason?: ClosedReason): boolean {
    return markFinalizedImpl(record, closedReason, this.terminalCtx);
  }

  /**
   * 意图原语：取消终态（tombstone）。写序与失败语义同 markFinalized（D8 v7）；区别
   * 仅 `.state` 载荷 = {status:"cancelled", endedAt}（重建判定分支消费精确结束时间）。
   * 归口写点：cancelBackground 终态写面（record-lifecycle，U2a 迁移）。
   *
   * [U2 桥接期] 新模型下 cancel = 中断当前轮回 idle（不终态化，stopReason=interrupted）
   * ——U5 意愿动作接线后本原语退役为 markSettled("interrupted") 路径。
   *
   * @deprecated U5 退役（cancel 语义归 markSettled("interrupted") + 放弃轮标记）。
   */
  markCancelled(record: ExecutionRecord): boolean {
    return markCancelledImpl(record, this.terminalCtx);
  }

  /**
   * 意图原语：sync 批终态（统一写点）。内部写序显式复刻 barrier：manifest 落盘
   * **完成**先于批通知写账（batchFinalized 落标 entry）——「通知可达 ⇒ 索引就位」
   * 构造性保证（session-reader 指针行反查依赖；缓存降级下 barrier 不可删，D4②/D5）。
   * manifestDir 提供时为同步写（写完即返回）；缺省降级 allSettled 异步屏障（原
   * writeSyncBatchManifestBarrier，已随 U3 归口删除）。
   */
  async markBatchFinalized(records: readonly SubagentRecord[]): Promise<void> {
    await markBatchFinalizedImpl(records, this.terminalCtx);
  }

  /**
   * 意图原语：引擎死亡收养（字段⑤⑩——error/result/resumable 三写，record 保持
   * resumable 交监督器接管，禁 completed 谎报 / closed 直接终局）。归口写点：
   * adoptResumableAfterEngineDeath（run-orchestration——已随 U2b 修复轮迁移）；
   * 监督器 adoptOnProcessDeath 编排留调用方。
   *
   * @returns false = id 不在内存（debug 留痕，无副作用）。
   */
  adoptEngineDeath(id: string, opts: { error: string }): boolean {
    return adoptEngineDeathImpl(id, opts, this.roundsCtx);
  }

  /**
   * 意图原语：磁盘终态位翻回活态（透明重生回边整体收编，D3c 规格）。
   *
   * acquire-first 顺序（单 try 域原子收敛）：写 `.alive` 写权声明（acquire）→ 删
   * `.state` → 删 `.finalized`/`.cancelled` legacy（读侧兼容回退认领旧名，残留未删
   * 则重建仍读出终态），随后 resurrectClosed 内存翻回 + register——
   * 任一步失败**响亮抛错**（禁止 best-effort 吞错续跑：acquire 失败 = 双写风险敞口；
   * acquire-first 顺序保证失败时磁盘保持 closed 可读形态——极端形态下经 legacy
   * 文件名回退仍读出终态，见 catch 文案）。reportTransition（entry 上报）留编排层
   * （纯投递副作用，失败不破坏状态一致性）。
   *
   * 两种接管形态统一（wasClosed 判别）：closed 候选 = 三件套全量；running 候选接管
   * （跨重启磁盘重建）= 跳过删终态位（无 `.state` 可删）**仍 acquire marker**
   * （「接管即声明」——现状此路径不写 marker 的双写窗随归口消灭）。
   * 中间形态推演（G3 单点论证）见设计 D3c (i)(ii)(iii)：三形态无卡死态、无双写窗。
   *
   * [U7 / §3.2.6 锚分派] zcode 锚不再被「no sessionFile anchor」硬拒：写权声明的
   * 物理对象 = 会话库条目（dbPath 单库共享，双宿主开同一 dataDir 时互斥语义与 pi
   * 同构），声明键 = transcriptRef 派生锚基底（zcodeAnchorBasePath）。zcode 无
   * `.state`/legacy 终态位（settle 不写——无文件锚），wasClosed 删位动作只对 pi 腿。
   * zcode 的异进程占用探针收编到 acquire 点（cold-lookup 探针面只覆盖 sessionFile
   * 形态——findColdLookupCandidate 对无 sessionFile 候选不探）。
   *
   * [U7 / §3.2.7] revive 统计基线水合先于 acquire/register：冷复活链的 createRecord
   * 产物 turnCount/totalTokens/round/epoch 全部归零，不水合则 register/reportRecordTransition
   * 的 entry 投影以归零值 last-writer-wins 覆盖磁盘原值（GUI 快修批次⑤根因）——
   * binding 快照（settle 权威终值）恢复基线，新轮增量在其上累加（跨轮连续）。
   *
   * @param record 调用方重建的可变 record（createRecord 产物）
   * @param wasClosed 磁盘候选是否为 closed 形态（cold-lookup 的 found.status 判定）
   * @throws Error acquire 或终态位删除失败（含双锚皆缺——无锚点无法声明写权）；
   *         zcode 锚被异进程持有时 ResurrectDeniedError（含 pid 与恢复指引）。
   */
  markResurrected(record: ExecutionRecord, wasClosed: boolean): void {
    markResurrectedImpl(record, wasClosed, this.terminalCtx);
  }

  /**
   * 意图原语：idle-GC 归档（30 天 TTL 内存回收，**非终态化**——record 磁盘仍 running
   * 可接管；归档 ≠ 放弃可重连性，故不写 `.state`「gc」——那会把「可接管」变「不可
   * 重连硬拒」，D3a 被否分支）。
   *
   * [U2 更名] 统一语言更名 markIdleEvicted（「内存回收」义），本名保留为 deprecated
   * 别名（生产点 idle-gc.ts 已迁名；存量测试写序全等断言仍消费，删除随测试迁名一并处理）。
   *
   * @deprecated 改用 {@link RecordStore.markIdleEvicted}。
   */
  markIdleArchived(record: ExecutionRecord): void {
    markIdleArchivedImpl(record, this.terminalCtx);
  }

  /**
   * 意图原语：内存回收（evicted，§3.2.4 release 出口②）。markIdleArchived 的统一
   * 语言更名（30 天 TTL 内存回收，用户不可见，非终态化——磁盘不动、可重建）。
   *
   * 写序（D3a/轮 5，语义不变）：store.archive **先**、`.alive` release **后**——
   * archive 抛错则原语整体失败、marker 必未删（持有与声明一致）；release 失败
   * best-effort 留痕（removeAliveMarker 内部 warn——GC 为旁路维护路径不阻断
   * interval，泄漏窗 = 至宿主退出，已接受）。回收 record 后续被接管时统一
   * acquireWriteLease 重新声明。
   *
   * [U4c / G2] 回收点补写 manifest（投影 running——磁盘确仍 running）：record 离开
   * 内存后，外部 session-reader 的 identity 富字段主路径只剩 manifest（子文件
   * identity entry 随 30 天 GC 衰减），回收时不落盘则该 record 在 manifest 面长期
   * 缺席。写失败走 writeTerminalManifest 同款响亮上报（终态写面共用通道）。
   */
  markIdleEvicted(record: ExecutionRecord): void {
    markIdleEvictedImpl(record, this.terminalCtx);
  }

  /**
   * [A6 / D3a 时机①] store 内部 acquire 动作——writeAliveMarker 的唯一包装（G1 口径
   * = store 内部写面；非新意图原语）。spawn 侧 sessionFile 锚点确立（run 应答回填 /
   * 冷启动 resume 续轮）时由调用方挂钩（U2b），宿主开始往 session 文件写即声明写权。
   *
   * @throws Error 写失败原样上抛（acquire 失败 = 双写风险敞口，调用方响亮处理——
   *         禁止 best-effort 吞错续跑，D3c 失败语义）。
   */
  acquireWriteLease(sessionFile: string, recordId: string): void {
    writeAliveMarker(sessionFile, { pid: process.pid, id: recordId, startedAt: Date.now() });
  }

  // ════════════════════════════════════════════════════════════
  // [永久会话模型 / U2] 新意图原语（设计 subagent-permanent-session-model.md
  // §3.2.2 事件表 / §3.2.3 reopen / §3.2.5 意愿动作表；u-foundation 骨架填肉）。
  // 实现收在 store 内即满足 C-data-20 写面唯一入口约束（不外泄到类外）。
  // ════════════════════════════════════════════════════════════

  /**
   * 意图原语：轮收口（settle）。§3.2.2 事件表 settle 行——「轮完成 / 失败 / 中断
   * 收口」统一落 idle + stopReason 展示值写入；承接 markFinalized / markCancelled
   * 的轮收口角色（两旧原语 U5 退役）。**不终态化**：record 留内存 idle（随时可接
   * 下一条 message），closedReason 不写（桥接不变量的新侧——settle 产出的 idle 不
   * 携带旧终态遗留位）。
   *
   * CAS：仅 running 可收口（对 idle record 重复 settle = 非法迁移，拒绝返回 false
   * + warn 留痕——与 tryTransition 抢锁语义同族）。
   *
   * 写序（D8：`.state` 先 → binding → manifest 后）：
   *   ① `.state` 新格式收条 {status:"idle", stopReason, endedAt}（writeSettledState；
   *      U2/U3 窗口期现有读侧对本格式落存在性降级分支，读侧兼容归 U3）；
   *   ② usage 快照落 binding（§3.2.7 统计口径——binding 快照为基准；含 round 推进）；
   *   ③ manifest 派生投影（settle 非终态 → legacy "running"——session-reader 视角
   *      的活跃成员，§3.2.8 下行映射）。
   *
   * **`.alive` 跨轮保留**（§3.2.4——settle 不释放写权声明，idle record 随时可能
   * 续写同一 transcript）；副作用编排（进程按 idle timer 回收等）留调用方。
   * record.endedAt 不写（非终态，duration 语义保持 running 起算）。
   *
   * @param stopReason 展示值（成功/失败轮用旧值族、中断轮用 interrupted 族——
   *        值域见 types.ts StopReason；纯展示 + 排障，不参与资格判定）。
   * @returns true = 收口完成；false = CAS 拒绝（record 非 running）。
   */
  markSettled(record: ExecutionRecord, stopReason: StopReason): boolean {
    return markSettledImpl(record, stopReason, this.terminalCtx);
  }

  /**
   * 意图原语：message 隐含寻回（§3.2.2 事件表 archived+message → running+active 行、
   * §3.2.5 寻回行——「寻回不需要显式动作」）。intent 翻回 active（{@link markArchived}
   * 的对称反向原语，U4 留桩的本单元接线点）。纯列表意愿位：占用位（status）与资格
   * 判据（§3.2.3 三件套）均不涉本原语——续聊链在寻回前后行为一致。
   *
   * manifest 投影随翻回刷新（archived→closed 下行映射归 U8，桥接期经 derived 投影
   * 保持索引在册）。幂等：intent 已 active/undefined 时 no-op（寻回只对 archived 有
   * 语义——挂点调用方已在 archived 分支内）。
   *
   * @returns true = 写面完成（含幂等 no-op）；false = 无（恒 true，签名对称性保留）。
   */
  markReactivated(record: ExecutionRecord): boolean {
    return markReactivatedImpl(record, this.terminalCtx);
  }

  /**
   * 意图原语：带历史重开（reopen，锚失效降级路径 §3.2.3）。同 id 不换——新
   * transcriptRef（pi 新 sessionFile / zcode 新 sessionId）+ round 归零 + epoch+1 +
   * stopReason=reopened；首轮 prompt 的历史摘要注入编排留调用方（U4 reopen 降级
   * 路径接线）。触发方式：仅用户显式 message（不自动重开）。
   *
   * CAS：仅 idle 可重开（running = 一轮在飞，非法迁移拒绝）。
   *
   * epoch 持久化（跨重启单调是硬要求，丢 epoch 会被二次 reopen 击穿）：pi 锚经
   * writeRecordBinding 在新 sessionFile 旁落盘完整 binding（新锚旁无存量 binding 可
   * merge——updateRecordBinding 不造新，reopen 的新文件锚必须走创建入口）；
   * [U7 / U6-D2 收编] zcode 锚同款落盘（锚键基底派生，见 zcodeAnchorBasePath）。
   * 宿主闭包 reopenRecord 的 engine 分派（run-orchestration 领地，U6b 接线）只构造
   * pi 锚——zcode 腿接线前本分支经内存 idle record 的显式 transcriptRef 可达，写面
   * 就位即 U6b 的依赖锚点。残留 lastAbandonedRound 不迁移（跨 epoch 自然失效，
   * §3.2.7——判定第一步以 record 当前 epoch 为基准丢弃旧世代回注）。`.alive` 写权
   * 声明迁移归调用方编排（acquireWriteLease 于新锚确立时）。
   *
   * @returns true = 重开完成；false = CAS 拒绝（record 非 idle）。
   */
  markReopened(record: ExecutionRecord, transcriptRef: TranscriptRef): boolean {
    return markReopenedImpl(record, transcriptRef, this.terminalCtx);
  }

  // [H4 三轴拆分] settleSnapshotPatch / fullBindingPayload / persistSettleSnapshot
  // （binding settle 快照族，[U7 / §3.2.7] 统计单基准的写侧载荷）已迁
  // record-store-terminal.ts——markRoundIdle 经 persistSettleSnapshot import 消费。

  /**
   * 意图原语：close 收起（意愿动作 §3.2.5 close 行）。intent 翻转 archived +
   * `.alive` release（§3.2.4 release 出口①——归档即放弃写权）。
   *
   * 顺序约束 [写死]：收口轮 settle → 轮次通知送达 → intent 翻转 + 归档注销
   * （intent 翻转必须在通知链之后，否则吞掉收口轮通知）。worktree 回收（patch
   * 落盘前移到归档点）与 pending 注销补发的编排留调用方（U5 意愿动作接线）；
   * 本原语只吸收 intent 位 + 写权声明两写面 + worktreeHandle 清句（S5 修复——
   * 归档即绑定消亡，重建守卫据 hadWorktree 触发）。
   *
   * 幂等：intent 恒置 archived、release 对缺失 marker 静默（重复 close 无害）。
   * record 留内存（archived ≠ 内存回收——列表可见性由 intent 承载，占用位不动）。
   * session-reader 的 archived 下行映射（U5-D10，§3.2.8）：本原语经
   * derivedManifestRecord 投影 legacy status="closed"（「已收起」在旧消费者语义里
   * = 结束）+ executionStatus="idle"（两态权威词）双写——旧版 session-reader 按
   * 既有 closed 语义归入已完成分区，行为域内无未知值。
   *
   * @returns true = 归档写面完成（幂等，恒 true）。
   */
  markArchived(record: ExecutionRecord): boolean {
    return markArchivedImpl(record, this.terminalCtx);
  }

  // [H4 三轴拆分] releaseWriteLease（写权 release 锚分派）已迁 record-store-terminal.ts
  // （releaseWriteLeaseImpl）——markIdleEvicted/markArchived 实现内部消费。

  // [H4 三轴拆分] terminalManifestRecord / batchManifestRecord /
  // legacyManifestStatusFields / derivedManifestRecord（manifest 投影族）已迁
  // record-store-rebuild.ts（投影轴）——本类经 import 调用，投影单点语义不变。

  /**
   * [D8 v7] manifest 落盘统一通道：manifestDir 提供时 writeAtomicFileSync 同步写
   * （停机竞态构造性消灭；与 ManifestStore.writeManifest 字节形态一致——2 空格缩进
   * JSON，读侧/外部 session-reader 不感知差异）；缺省 fire-and-forget 异步写（仅纯
   * 内存测试形态）。写失败响亮（error 日志 + 用户可见 entry，对齐 writeManifestBestEffort）。
   */
  private writeManifestPersisted(id: string, manifest: ManifestRecord): void {
    if (this.manifestDir !== undefined) {
      try {
        writeAtomicFileSync(
          path.join(this.manifestDir, `${id}.json`),
          JSON.stringify(manifest, null, MANIFEST_INDENT_SPACES),
        );
      } catch (err) {
        RecordStore.reportManifestWriteFailure(id, err, this.pi);
      }
      return;
    }
    if (this.manifestStore !== undefined) {
      void this.manifestStore.writeManifest(manifest).catch((err: unknown) => {
        RecordStore.reportManifestWriteFailure(id, err, this.pi);
      });
    }
  }

  /**
   * [D8 v7] 终态 manifest 落盘（markFinalized/markCancelled 共用，投影 status 恒
   * closed）。同步性与失败语义见 writeManifestPersisted。
   */
  private writeTerminalManifest(record: ExecutionRecord): void {
    this.writeManifestPersisted(record.id, terminalManifestRecord(record));
  }

  // ── [U4c / D5] 缓存降级重建通道 ──────────────────────────────

  /**
   * [U4c / G1] 全量重建可丢缓存（boot 通道：boot revive 完成后由宿主调用）。
   *
   * manifest 与 sessions-index 均为可丢缓存（D5）：权威 = `.state`，重建源 =
   * `.state` + entry 尽力。本方法：
   *   1. 触发全量扫描（reconstructAll）——sessions-index 的重建隐式完成于既有机制
   *      （loadIndex 空/损坏 → 探测 → dirty → saveIndex，「损坏静默回退全扫」同款
   *      先例），不另设第二条索引写路径；
   *   2. 对扫描重建出的每个 record，manifest 缺失时补写（幂等补缺，不覆写幸存
   *      manifest——幸存者可能比重建源新鲜，覆写 = 用尽力数据降级权威快照）。
   *
   * 失败降级（D5 三要素）：单 record 重建源不可用（子 session 已 GC/损坏 → 不在
   * 扫描集）或 manifest 写失败 → debug 留痕跳过该条，整轮不抛（S5「重建照常无错
   * 误静默吞」）——缓存补缺失败不构成宿主错误。
   *
   * @returns 补写的 manifest 数（诊断/日志用）。
   */
  rebuildIndexes(): number {
    const records = this.reconstructAll(undefined);
    let rebuilt = 0;
    for (const rec of records) {
      if (this.rebuildManifestIfMissing(rec)) rebuilt++;
    }
    return rebuilt;
  }

  /**
   * [U4c / G1] 单 record 的 manifest 惰性补建（rebuildIndexes 全量轮 + mergedRecords
   * 惰性通道共用）。manifest 已存在 → 跳过；无 manifest 落点（manifestDir/manifestStore
   * 均缺省，纯内存测试形态）→ 跳过；每 id 每进程至多尝试一次（manifestRebuildTried
   * 守卫——boot 全量轮与惰性通道共享，防重复磁盘写）。写失败 debug 留痕不抛
   * （缓存面，§3.4「缓存损坏」行——无需动作）。
   *
   * @returns true = 本次实际补写。
   */
  private rebuildManifestIfMissing(rec: SubagentRecord): boolean {
    if (this.manifestDir === undefined && this.manifestStore === undefined) return false;
    if (this.manifestRebuildTried.has(rec.id)) return false;
    this.manifestRebuildTried.add(rec.id);
    if (this.manifestDir !== undefined) {
      const manifestPath = path.join(this.manifestDir, `${rec.id}.json`);
      try {
        if (fs.existsSync(manifestPath)) return false;
        writeAtomicFileSync(manifestPath, JSON.stringify(derivedManifestRecord(rec), null, MANIFEST_INDENT_SPACES));
        return true;
      } catch (err) {
        logger.debug("[subagents] rebuildIndexes: manifest rebuild skipped (write failed)", {
          detail: { id: rec.id, error: err instanceof Error ? err.message : String(err) },
        });
        return false;
      }
    }
    // 缺省降级形态（manifestDir 缺省、manifestStore 在，纯内存测试形态外的测试分支）：
    // 异步写，失败同样静默降级。
    void this.manifestStore!.writeManifest(derivedManifestRecord(rec)).catch((err: unknown) => {
      logger.debug("[subagents] rebuildIndexes: manifest rebuild skipped (write failed)", {
        detail: { id: rec.id, error: err instanceof Error ? err.message : String(err) },
      });
    });
    return true;
  }

  /** manifest 写失败的双通道上报（error 日志给开发者 + entry 给用户，对齐
   *  writeManifestBestEffort 现状）。 */
  private static reportManifestWriteFailure(
    id: string,
    err: unknown,
    pi: RecordStorePi,
  ): void {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[subagents] manifest write failed (record=${id}): ${msg}`);
    pi?.appendEntry?.("subagent:manifest-write-failed", { id, error: msg });
  }

  /**
   * [H4 收口 / G1] entry 重物化腿的 manifest 投影补写（record-access 可重连终态
   * 重物化通道的唯一入口——store 外零 manifest 直写）。manifest 是可丢缓存（D5），
   * 本方法只做缺员补写：失败 warn 留痕不响亮（缓存补缺失败不构成宿主错误，对齐
   * U4c rebuildIndexes 的降级语义——区别于终态面 writeManifestPersisted 的响亮）；
   * manifestDir 接线时为同步写（停机窗防护与终态面同源）。
   */
  rematerializeManifest(manifest: ManifestRecord): void {
    const warnFailure = (err: unknown): void => {
      logger.warn("[subagents] rematerialize manifest write failed (cache backfill)", {
        detail: { id: manifest.id, error: err instanceof Error ? err.message : String(err) },
      });
    };
    if (this.manifestDir !== undefined) {
      try {
        writeAtomicFileSync(
          path.join(this.manifestDir, `${manifest.id}.json`),
          JSON.stringify(manifest, null, MANIFEST_INDENT_SPACES),
        );
      } catch (err) {
        warnFailure(err);
      }
      return;
    }
    if (this.manifestStore !== undefined) {
      void this.manifestStore.writeManifest(manifest).catch(warnFailure);
    }
  }

  /** 按 id 查找。返回可变 record（仅 runtime 内部用）。 */
  getMutable(id: string): ExecutionRecord | undefined {
    return this.records.get(id);
  }

  /**
   * abort 所有 running record 的 controller（background 子进程 SIGTERM）。
   *
   * 仅在 SubagentService.dispose（进程退出路径）调用。不做 CAS/终态标记——dispose
   * 是终局，状态机收尾无意义；目的是让 background 子进程的 AbortSignal 触发 →
   * runSpawn 的 signal listener → child.kill("SIGTERM")，防止主进程退出后子进程成孤儿。
   *
   * sync record 无 controller（undefined），跳过——sync 是阻塞调用，主进程不会先于
   * sync subagent 退出（除非 SIGKILL/崩溃，此时任何清理都无效）。
   *
   * 返回被 abort 的 record 数（诊断用）。
   */
  abortRunningControllers(): number {
    let n = 0;
    for (const r of this.records.values()) {
      if (r.status === "running" && r.controller) {
        r.controller.abort();
        n++;
      }
    }
    return n;
  }

  /** 列出所有 running record 的只读快照（widget 计数、诊断用）。 */
  listRunning(): RecordSnapshot[] {
    return [...this.records.values()]
      .filter((r) => r.status === "running")
      .map((r) => toSnapshot(r));
  }

  /** SP-4: 列出所有活跃 record（running + idle）的可变引用。
   *  供 SubagentService.disposeAllRecords 做级联关闭。 */
  listAllActive(): ExecutionRecord[] {
    return [...this.records.values()]
      .filter((r) => r.status === "running");
  }

  /**
   * 合并内存(running) + 磁盘(sessions/*.jsonl 重建) → SubagentRecord[]。
   *
   *   ╔══════════════════════════════════════════════════════════════════╗
   *   ║  1. 磁盘源：扫 sessionsDir 的 .jsonl，逐个 scanFile（[perf] 头部    ║
   *   ║     identity 轻量重建 + stat 戳缓存命中零读取）。cancelled          ║
   *   ║     终态 sidecar override status。详情字段（eventLog/result/turns）    ║
   *   ║     缺省，由 getFullRecord(id) 懒加载                              ║
   *   ║  2. 内存源覆盖（同 id 内存优先——running record 更新鲜）          ║
   *   ║  3. session 过滤：只留 rootSessionId === rootSessionFilter 的       ║
   *   ║     record。rootSessionId 缺失（旧文件）的 record 一律排除        ║
   *   ║     （无法判定归属，隔离优先）。rootSessionFilter 为 undefined       ║
   *   ║     时不过滤（向后兼容）。                                          ║
   *   ║  4. statusFilter："running" → 只留 running（内存源）；            ║
   *   ║                   "all"（默认）→ 内存 + 磁盘                       ║
   *   ║  5. 排序：STATUS_PRIORITY + startedAt desc                        ║
   *   ║  6. slice(limit)                                                  ║
   *   ╚══════════════════════════════════════════════════════════════════╝
   *
   * statusFilter="running" 时仍先取够多再过滤（防 limit 截断把 running 滤没），
   * 与旧 listHandler 的防截断逻辑一致，下沉到此。
   *
   * session 隔离：同一 cwd 下多个 Pi session 共享 sessionsDir，靠 rootSessionId
   * 区分。内存与磁盘源都按 rootSessionFilter 过滤后再 merge/sort/slice。
   *
   * [H2 W1] includeWorkflow（设计 subagent-workflow-record-unification §3.3 D1）：
   * 缺省 false = 过滤 origin==="workflow" 的 record（subagents tool list / TUI
   * /subagents 等消费面默认不展示 workflow 派发的 record）；true = 全量（排查通道）。
   * 过滤只在查询消费面——治理路径（recoverOrphanRecords / recoverEntryOnlyOrphans /
   * revive）与本参数无关，永远全量可见（D1 ⑥ 负向规格）。
   */
  collectRecords(
    limit: number,
    statusFilter: StatusFilter = "all",
    rootSessionFilter?: string,
    includeWorkflow: boolean = false,
  ): SubagentRecord[] {
    let result = [...this.mergedRecords(rootSessionFilter).values()];

    // 3. statusFilter。
    if (statusFilter === "running") {
      result = result.filter((r) => r.status === "running");
    }

    // 3.5 [H2 W1] origin 过滤（缺省排除 workflow 来源）。负向判定：origin 缺省
    // （undefined = "tool" 语义）与显式 "tool" 均保留。
    if (!includeWorkflow) {
      result = result.filter((r) => r.origin !== "workflow");
    }

    // 4-5. 排序 + slice。
    return result
      .sort(compareRecords)
      .slice(0, limit);
  }

  /**
   * [H2 W1] 按 workflow run id 列 record（parentRunId 查询入口，W2 run 视图进度 /
   * W3 下钻消费）。查询域 = collectRecords 现状口径（内存 ∪ 磁盘重建 ∪ manifest 补充，
   * 设计 D2「查询域显式」）。不过滤 origin——按 parentRunId 显式查询即下钻/治理语义
   * （tool 来源 record parentRunId 恒 undefined，不会被误中）。
   *
   * 返回排序与 slice 口径同 collectRecords（STATUS_PRIORITY + startedAt desc + limit）。
   */
  collectRecordsByParentRunId(
    parentRunId: string,
    limit: number,
    rootSessionFilter?: string,
  ): SubagentRecord[] {
    return [...this.mergedRecords(rootSessionFilter).values()]
      .filter((r) => r.parentRunId === parentRunId)
      .sort(compareRecords)
      .slice(0, limit);
  }

  /**
   * collectRecords / collectRecordsByParentRunId 共用的四源合并（磁盘重建 ∪ 主
   * session entry 源 ∪ manifest 补充 ∪ 内存覆盖；entry 源 [U7 / B-restart] 只补
   * zcode record，见 1.7 段注）。返回 byId Map（内存优先——running record 是活态
   * 比磁盘重建新）。
   * [D1 ⑤] 磁盘重建投影本身不做任何 origin 过滤——record 全量重建，过滤只在上层
   * 查询消费面按参数生效。
   */
  private mergedRecords(rootSessionFilter?: string): Map<string, SubagentRecord> {
    const byId = new Map<string, SubagentRecord>();

    // 1. 磁盘源（重建终态 record）。 reconstructAll 已按 rootSessionFilter 过滤。
    for (const rec of this.reconstructAll(rootSessionFilter)) {
      byId.set(rec.id, rec);
    }

    // [metrics-gate cyclo 偿还] 四源合并按源拆私有 helper（行为保持：合并次序 / 判据 /
    // 逐字段投影逐字节等价，各 helper 共享 byId 引用原地写入）。
    this.mergeEntrySourceRecords(byId, rootSessionFilter);
    this.mergeManifestRecords(byId, rootSessionFilter);
    this.mergeMemoryRecords(byId, rootSessionFilter);
    this.rebuildMissingManifests(byId);

    return byId;
  }

  /** mergedRecords 源 1.7（主 session entry 源，[U7 / B-restart store 面]）。行为保持：
   *  自 mergedRecords 原样提取，判据与投影零变化。 */
  private mergeEntrySourceRecords(byId: Map<string, SubagentRecord>, rootSessionFilter: string | undefined): void {
    // 主 session entry 源：补「磁盘扫描缺员」的 **zcode record**（无子 session 文件
    // 不在扫描集，重启后唯一 store 侧可见面）。锚恢复 = entry 的
    // engineHandle.sessionRef（zcode 锚单源，冷查链 resurrectColdRecord 经
    // transcriptAnchorOf 派生消费）；统计/round 随 entry 投影（best-effort 过程面，
    // settle 权威值在 binding——markResurrected 水合覆盖）。刻意收窄到
    // engine==='zcode'：pi entry-only record（spawn 窗口 entry-born / 旧终态 entry）
    // 的 store 可见性语义是 U8 投影面决策域（H4 M1「不重物化」守护），不随 zcode
    // 锚恢复顺带变更。manifest 投影契约扩展（engineHandle 下行）归 U8。
    for (const rec of this.entrySourceRecords()) {
      if (byId.has(rec.id)) continue;
      if (rec.engine !== "zcode") continue;
      if (rootSessionFilter !== undefined && rec.rootSessionId !== rootSessionFilter) continue;
      byId.set(rec.id, rec);
    }
  }

  /** mergedRecords 源 1.5（manifest 源补充 orphan 记录，FR-8）。行为保持：自
   *  mergedRecords 原样提取，优先级（内存 > 磁盘重建 > manifest）与损坏处置零变化。 */
  private mergeManifestRecords(byId: Map<string, SubagentRecord>, rootSessionFilter: string | undefined): void {
    // manifest 仅补充 session.jsonl 重建失败的记录。
    if (this.manifestStore) {
      for (const manifest of this.readManifestsSync()) {
        if (byId.has(manifest.id)) continue; // 已被磁盘/内存源覆盖
        if (rootSessionFilter !== undefined && manifest.rootSessionId !== rootSessionFilter) continue;
        const rec = manifestToSubagent(manifest);
        if (!rec) {
          // manifest status 越界=数据损坏（含历史 "error"、意外 crashed 值）：跳过而非降级 failed，
          // 避免损坏 record 被误显示为 failed（触发错误重试/告警）。
          // 双通道上报：logger.warn 给开发者（事后排查，appendEntry 持久化，不显 TUI）；
          // pi.appendEntry 给用户（session 内可见，即使退出后也能从 session.jsonl 复盘事故原因）。
          // SubagentService 构造时 pi 未注入（session_start 之前），appendEntry 走可选链安全降级。
          logger.warn("[subagents] skip manifest with invalid status", {
            detail: { id: manifest.id, status: manifest.status },
          });
          this.pi?.appendEntry?.("subagent:manifest-invalid-status", {
            id: manifest.id,
            status: manifest.status,
            rootSessionId: manifest.rootSessionId,
            agentName: manifest.agentName,
          });
          continue;
        }
        byId.set(rec.id, rec);
      }
    }
  }

  /** mergedRecords 源 2（内存源覆盖，running record 优先——它是活态，比磁盘重建
   *  更新鲜）。行为保持：自 mergedRecords 原样提取，同样按 session 过滤。 */
  private mergeMemoryRecords(byId: Map<string, SubagentRecord>, rootSessionFilter: string | undefined): void {
    for (const r of this.records.values()) {
      if (rootSessionFilter !== undefined && r.rootSessionId !== rootSessionFilter) continue;
      byId.set(r.id, recordToSubagent(r));
    }
  }

  /** mergedRecords 源 3（[U4c / G1 惰性通道] manifest 反查 miss 的惰性重建，D5 双通道
   *  的惰性腿）。行为保持：自 mergedRecords 原样提取。磁盘源已重建的 record 若在
   *  manifest 索引缺员（缓存被删/boot 全量轮漏扫），此处补建——manifest 是外部
   *  session-reader 的 identity 富字段主路径与指针行反查索引，缺员窗口不应等到下次
   *  boot。在途 record（内存持有，本 host 的终态写点会落 manifest——「创建时不写」
   *  契约保持）不在补建集；每 id 每进程只尝试一次（rebuildManifestIfMissing 内
   *  manifestRebuildTried 守卫，防高频 collectRecords 放大磁盘写）。 */
  private rebuildMissingManifests(byId: Map<string, SubagentRecord>): void {
    for (const rec of byId.values()) {
      if (this.records.has(rec.id)) continue;
      this.rebuildManifestIfMissing(rec);
    }
  }

  /**
   * [U7 / B-restart] 主 session entry 源的缓存读（stat 戳校验）。mainSessionFile
   * 未初始化 / 已消失 → 空集（entry 源空转，行为与无该源等价）；戳变化（entry
   * append）触发一次「每 id 末条」重读。缓存结果为浅共享数组——消费方只读遍历
   * （mergedRecords 拷贝进 byId 后不 mutate 源元素），无逃逸别名写风险。
   */
  private entrySourceRecords(): SubagentRecord[] {
    if (this.mainSessionFile === undefined) return [];
    const stamp = statStamp(this.mainSessionFile);
    if (stamp === null) {
      this.mainEntryStamp = null;
      this.mainEntryCache = [];
      return [];
    }
    if (this.mainEntryStamp !== null && sameStamp(this.mainEntryStamp, stamp)) {
      return this.mainEntryCache;
    }
    this.mainEntryStamp = stamp;
    this.mainEntryCache = this.scanLastRecordEntries(this.mainSessionFile);
    return this.mainEntryCache;
  }

  // ── 孤儿终态恢复（residual-fixes 设计 §6.1.2）──────────────────

  /**
   * 重建 SubagentRecord 的自描述 entry 落盘入口（签名适配：reportRecordTransition 收
   * ExecutionRecord，重建孤儿的数据源是 SubagentRecord——直接经 toSubagentRecordEntry
   * 投影 appendEntry，绕过 recordToSubagent）。pi 未注入时可选链静默。
   */
  reportSubagentRecord(record: SubagentRecord): void {
    this.pi?.appendEntry?.("subagent-record", toSubagentRecordEntry(record));
  }

  /**
   * 孤儿恢复（§3.2.4 降权后的残职责：entry 面纠偏）。重建单规则下磁盘重建恒 idle
   * （§3.2.4：两态下 running 只在轮次在飞时有意义，崩溃后必然空闲），磁盘面已无
   * 「终态化」职责；本方法只纠一处残留——**主 session 末条 entry 仍停在 running**
   * （父扩展死在轮中，再无人写收口 entry → runtime 侧栏 spinner 永久）时，落一条
   * idle entry 纠偏（一律保留 idle——锚在，等 revive 续聊，不直断不终态化）。
   *
   * 判据链：entry 末条 running（磁盘重建 idle 的 entry 面投影滞后）→ 无异宿主在持
   * （[U4a / D3b (a″)] findForeignLiveInstance 现查探针：pid 活 = record 可能在真跑，
   * 持有宿主的轮终链会写 entry，本宿主不代写）→ 未判过（orphanJudged 防重，appendEntry
   * 失败时的次级防线——纠正 entry 落盘后末条变 idle，判据自然不再命中）。
   *
   * [v2 D3] mainSessionFile = merge 数据源（主 session 每 id 末条 entry）：崩溃前的批域
   * 标记（collectMode/batchFinalized）与轮终 result/model 只活在主文件 entry，覆写前
   * 不 merge 就会被抹掉。缺省（undefined）时扫描空集，方法空转（与既有 best-effort
   * 语义一致）。调用方：record-access initSession 恢复段（一次）。
   */
  recoverOrphanRecords(rootSessionFilter?: string, mainSessionFile?: string): void {
    // [U7 / B-restart] 主 session 路径记忆（entry 源读取锚——initSession 恢复段每
    // session 供给一次；/resume /fork 后新主文件随下次调用覆盖）。
    if (mainSessionFile !== undefined) this.mainSessionFile = mainSessionFile;
    const lastById = new Map(this.scanLastRecordEntries(mainSessionFile).map((r) => [r.id, r]));
    for (const rec of this.reconstructAll(rootSessionFilter)) {
      const lastEntry = lastById.get(rec.id);
      // 纠偏对象 = entry 面残留 running：末条缺失（无 entry 可纠）或已收口/轮终非
      // running（entry 自洽）都跳过。
      if (lastEntry === undefined || lastEntry.status !== "running") continue;
      if (rec.sessionFile !== undefined && findForeignLiveInstance(rec.sessionFile) !== undefined) {
        continue;
      }
      if (this.orphanJudged.has(rec.id)) continue;
      this.orphanJudged.add(rec.id);
      this.finalizeOrphanRecord(rec, lastEntry);
    }
  }

  /**
   * 单孤儿 record 的 entry 纠偏落盘（§3.2.4 孤儿恢复简化后唯一职责）。防重锚
   * （orphanJudged 标记）已由调用方完成。
   *
   * 一律保留 idle（锚在，等 revive）：旧直断分支（SP-5 完成态 closed+gc / in-flight
   * closed+gc+error / chatMode-resumable 分流 / 末行截断判读）随「不存在不可逆终态」
   * 整体删除——record 的 stopReason 已由重建单规则从 `.state` 或 interrupted-by-restart
   * 兜底给出，本方法不做任何终态判定（子文件末行内容不再参与，超长/截断行无感知）。
   *
   * 覆写前 merge（lastEntry）保留既有信息（批域标记 + 轮终正文/模型 + resumable 信号）：
   * 覆写是状态迁移不是信息重建。
   */
  private finalizeOrphanRecord(rec: SubagentRecord, lastEntry: SubagentRecord): void {
    const rec0 = mergeOrphanLastEntry(rec, lastEntry);
    this.reportSubagentRecord({ ...rec0, status: "idle" });
  }

  /**
   * [E2E 实测缺口] entry-born 孤儿恢复：register entry 已落主 session、但子 session 文件
   * 从未创建（父进程死在 spawn 窗口期——register 写点与子进程首笔写入之间的窗口；外部
   * 删除子文件的已知边界同形）。目录扫描（reconstructAll）看不见这类 record（无文件即
   * 无扫描集），recoverOrphanRecords 判不到，侧栏（runtime entry 扫描源）永久 spinner。
   *
   * 判定：读主 session 的 subagent-record entry，取每 id 末条；末条 status=running 且
   * 无子文件锚（不在 reconstructAll 结果中）且不在内存活 record（防误杀刚 register 的
   * 在途 spawn）→ 落 idle entry 纠偏（一律保留 idle，不直断）。
   *
   * [U3 / §3.2.4] 直断分支（closed+gc+error）删除：entry-born 无 transcript 锚的
   * 续聊拒绝由 U4 准入判据单点给出唯一占用拒绝文案（zcode 锚 U6 落地前，无锚
   * record 保持 idle 可见、不可续聊——本单元只删直断、保留记录可见）。
   * 调用点：initSession 的 recoverOrphanRecords 之后（session_start，内存恒空）。
   */
  recoverEntryOnlyOrphans(mainSessionFile: string | undefined, rootSessionFilter?: string): void {
    if (mainSessionFile === undefined) return;
    // [U7 / B-restart] 同 recoverOrphanRecords 的记忆点（两个 initSession 恢复入口
    // 任一先达即锚定 entry 源）。
    this.mainSessionFile = mainSessionFile;
    let content: string;
    try {
      content = fs.readFileSync(mainSessionFile, "utf-8");
    } catch {
      return; // 主文件不可读（含新 session 未 flush 的 ENOENT）：静默跳过（best-effort 恢复）
    }
    const lastById = collectLastRecordEntries(content);
    if (lastById.size === 0) return;
    const anchoredIds = new Set(this.reconstructAll(rootSessionFilter).map((r) => r.id));
    for (const [id, d] of lastById) {
      if (!this.isEntryOrphanCandidate(id, d, rootSessionFilter, anchoredIds)) continue;
      this.orphanJudged.add(id);
      const rec = rebuildEntryRecord(id, d);
      if (rec === null) continue; // 损坏 entry：跳过（orphanJudged 已标记，不重判）
      this.finalizeEntryOnlyOrphan(rec);
    }
  }

  /**
   * entry-born 孤儿候选判定（recoverEntryOnlyOrphans 的守卫链拆出）：末条 running、
   * root session 匹配、无子文件锚、不在内存活 record（防误杀在途 spawn）、未判过。
   */
  private isEntryOrphanCandidate(
    id: string,
    d: Record<string, unknown>,
    rootSessionFilter: string | undefined,
    anchoredIds: Set<string>,
  ): boolean {
    if (d.status !== "running") return false; // 末条已收口/轮终：entry 自洽，无需恢复
    if (rootSessionFilter !== undefined && d.rootSessionId !== rootSessionFilter) return false;
    if (anchoredIds.has(id)) return false; // 有子文件锚：主循环已判（或 sidecar 已收口）
    if (this.records.has(id)) return false; // 内存活 record：在途 spawn，不得误杀
    return !this.orphanJudged.has(id);
  }

  /**
   * entry-born 孤儿纠偏落 entry：一律保留 idle（§3.2.4——spawn 窗口期死亡 = 在途中断，
   * stopReason 兜底 interrupted-by-restart；无直断、无终态化）。锚在等 revive：zcode
   * transcriptRef 锚（U6）落地前无锚形态的续聊拒绝走 U4 准入判据文案。
   */
  private finalizeEntryOnlyOrphan(rec: SubagentRecord): void {
    this.reportSubagentRecord({
      ...rec,
      status: "idle",
      stopReason: rec.stopReason ?? "interrupted-by-restart",
    });
  }

  /**
   * [E1/U5] sync 批崩溃恢复扫描：主 session 文件「每 id 末条 subagent-record entry」
   * （collectLastRecordEntries + rebuildEntryRecord 组合通路，设计 §3.1.3「标记读取
   * 通路」——batchFinalized 落标 entry 写主 session 文件，本扫描同文件域才可见；禁走
   * collectRecords light 路径，它只读子文件 identity 头+sidecar，主 session 落标
   * entry 不可见）。返回每 id 末条重建的完整 record（含 collectMode/batchFinalized /
   * 终态五字段，损坏 entry 跳过）；调用方（service.recoverSyncCollectBatch 的 E1 过滤、
   * recoverOrphanRecords 的覆写 merge）自行取舍。主文件不可读（含新 session 未 flush
   * 的 ENOENT）→ 空数组静默。
   */
  scanLastRecordEntries(mainSessionFile: string | undefined): SubagentRecord[] {
    if (mainSessionFile === undefined) return [];
    let content: string;
    try {
      content = fs.readFileSync(mainSessionFile, "utf-8");
    } catch {
      return []; // 与 recoverEntryOnlyOrphans 同判：best-effort 恢复，不可读静默跳过
    }
    const out: SubagentRecord[] = [];
    for (const [id, d] of collectLastRecordEntries(content)) {
      const rec = rebuildEntryRecord(id, d);
      if (rec !== null) out.push(rec);
    }
    return out;
  }

  /** 订阅变更。返回取消订阅函数。 */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 触发所有监听器（TUI widget/list requestRender）。dispose 后短路。
   *  [perf] 不清空磁盘缓存：per-file stat 戳自校验（任何磁盘写入改变戳 → 单文件重建），
   *  内存事件（register/archive）不改变磁盘文件——旧实现整体失效是全量重扫的根因。 */
  notifyChange(): void {
    if (this._disposed) return;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** session 结束清理。 */
  dispose(): void {
    this._disposed = true;
    this.listeners.clear();
    this.fileCache.clear();
    this.idToFile.clear();
    this.dirStamp = null;
    this.orphanJudged.clear();
    // [perf L-1] 索引状态重置为初始值（「清内存」语义完备）。不取消挂起的 fire-and-forget
    // 写——in-flight 写的丢失显式接受（revive 后 dirStamp===null 重扫会重新装载/重写）。
    this.indexEntries = null;
    this.indexDirty = false;
    this.lastIndexWriteAt = 0;
    this.indexHigherVersion = false;
    this.manifestRebuildTried.clear();
    // [U7 / B-restart] entry 源随 session 结束释放（主 session 文件属 session 状态）。
    this.mainSessionFile = undefined;
    this.mainEntryStamp = null;
    this.mainEntryCache = [];
  }

  /**
   * /resume /fork /new 后复活（dispose 的逆操作）。
   *
   * [PS-10/T6④] 同步复位 orphanJudged 防重缓存：纠偏 entry 写失败（appendEntry 异常）
   * 时判据（末条 running）不会自愈，重判资格完全由本缓存承载——dispose 时有 clear
   *（session 结束），revive 此前不复位会让「写失败 record 永久停留未纠偏」。
   * /new 复活正是「重开」语义：下次 recoverOrphanRecords 对仍残留 running entry 的
   * record 重新纠偏（幂等——已落盘的 idle entry 使判据不再命中）。
   */
  revive(): void {
    this._disposed = false;
    this.orphanJudged.clear();
    // [U4c / G1] /new /resume 重开后 manifest 态可能已变（外部删除/异宿主写入），
    // 惰性重建守卫随缓存态一并复位（对齐 orphanJudged 的「重开重判」语义）。
    this.manifestRebuildTried.clear();
    // [U7 / B-restart] entry 源缓存戳复位（/resume /fork 后主文件可能已换——
    // initSession 恢复段的 recover* 调用会重设 mainSessionFile 并触发重读；复位
    // 保证复位前窗口内的首次读取不命中旧 session 的缓存）。
    this.mainEntryStamp = null;
    this.mainEntryCache = [];
  }

  // ── 内部 ──────────────────────────────────────────────────

  /**
   * 三分支状态矩阵重建（终态 marker / 兜底；[perf] light 版）。
   *
   * 优先级：
   *   1. 终态 sidecar status=cancelled → closed（closedReason=cancelled）
   *   2. 终态 sidecar status=finalized → closed（closedReason=内容 reason；空/旧格式 → disconnected）
   *   （旧名 .finalized/.cancelled 由 readStateMarker 归一，判定分支不区分来源）
   *   3. 兜底（其余一切，含 .alive 在持形态）→ running（v4 B-1 可续聊语义）
   *
   * [U4a / D3b (a)] 原分支 3（.alive + pid 活 → running + externalInstance 投影）已
   * 移除：探活缓存的读面角色由 (a′)(a″) 的 findForeignLiveInstance 现查探针替代，
   * status 判定与 .alive 解耦（终态判定由 `.state` 权威分支承接）。
   *
   * [perf]：逐文件 scanFile（stat 戳校验 + 头部 identity 轻量重建）。命中缓存的
   * 文件零文件读取；变化的文件只重建自身，其余 N-1 个复用缓存。
   *
   * session 隔离：rootSessionFilter 非空时，只保留 rootSessionId 匹配的 record。
   * rootSessionId 缺失（旧文件，未带身份字段）一律排除（无法判定归属）。
   */
  private reconstructAll(rootSessionFilter?: string): SubagentRecord[] {
    // [perf] 目录 mtime 快路径：sessionsDir mtime 未变 ⇒ 文件集合与 sidecar 集合都未变
    //（任何文件新建/删除/重命名都改目录 mtime），且 jsonl append 不影响 light 态
    //（identity/status 由首行与 sidecar 决定，进度重数据走 getFullRecord 的独立 stat
    //校验）→ 跳过 readdir + N×3 statSync，直接复用缓存 light。/subagents overlay 打开
    //期间 250ms 动画 timer + 120ms debounce 双驱动高频扫描，快路径把 ~N×3 stat 降到
    // 1 次（目录本身）。
    // 已知局限（与 mtime 缓存同族）：目录 mtime 粒度粗糙的文件系统（NFS/2s FAT）
    // 可能漏判——APFS 微秒级可靠。
    let dirMtimeMs: number;
    try {
      dirMtimeMs = fs.statSync(this.sessionsDir).mtimeMs;
    } catch {
      return [];
    }
    // [perf L-1] 首扫（dirStamp===null）惰性装载磁盘索引。必须位于 statSync 之后：
    // sessionsDir 不存在的 early-return 不装载映像（防解析产物滞留内存）；首扫时
    // 下方快路径条件必不成立，插在快路径 if 前后等价。
    if (this.dirStamp === null) {
      const loaded = loadIndex(path.dirname(this.sessionsDir));
      this.indexEntries = loaded.entries;
      this.indexHigherVersion = loaded.higherVersion;
    }
    if (this.dirStamp !== null && this.dirStamp.mtimeMs === dirMtimeMs) {
      const out: SubagentRecord[] = [];
      for (const entry of this.fileCache.values()) {
        if (entry.negative) continue;
        out.push(entry.light);
      }
      return rootSessionFilter === undefined
        ? out
        : out.filter((r) => r.rootSessionId === rootSessionFilter);
    }

    let files: string[];
    try {
      files = fs.readdirSync(this.sessionsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(this.sessionsDir, f));
    } catch {
      this.indexEntries = null; // [perf L-1] 该 early-return 路径同样释放映像（内存卫生）
      return [];
    }

    // 修剪：磁盘上已消失的文件（GC/手动删）同步移出缓存与索引。删了条目必须置
    // indexDirty——否则纯修剪轮（无其他探测）flush 第一道门 !dirty return，磁盘索引的
    // 陈旧条目永不清除（fileCache 已删仅影响内存投影，落盘快照不会自发跟随）。
    const disk = new Set(files);
    for (const [file, entry] of this.fileCache) {
      if (!disk.has(file)) {
        this.fileCache.delete(file);
        if (!entry.negative) this.idToFile.delete(entry.light.id);
        this.indexDirty = true;
      }
    }

    const out: SubagentRecord[] = [];
    for (const file of files) {
      const entry = this.scanFile(file);
      if (entry) out.push(entry.light);
    }
    this.dirStamp = { mtimeMs: dirMtimeMs };
    this.flushIndexAfterScan();
    if (rootSessionFilter === undefined) return out;
    return out.filter((r) => r.rootSessionId === rootSessionFilter);
  }

  /**
   * 扫描单文件：stat 戳（jsonl + 终态 sidecar + record 绑定）校验，全同 →
   * 复用缓存（零文件读取，含负缓存直接返回 null）；否则重建 light。
   * identity 定位两级：头部 64KB（首轮会话）→ 全文 fallback（续聊场景 identity
   * append 在尾部）；两级都找不到 → [UF-1] record 绑定 sidecar 回退（宿主侧身份
   * 载荷重建 light）→ 仍无 → 写负缓存（防每轮全文重读）。
   * 返回 null：文件消失/读失败/无 identity 且无绑定 → 跳过。
   */
  private scanFile(file: string): FileCacheEntry | null {
    const jsonl = statStamp(file);
    if (!jsonl) {
      this.fileCache.delete(file);
      return null;
    }
    const stamps: FileStamps = {
      jsonl,
      state: statStateStamp(file),
      binding: statStamp(`${file}${RECORD_BINDING_SIDECAR_EXT}`),
    };

    const cached = this.fileCache.get(file);
    if (cached !== undefined && isFreshCache(cached, stamps)) {
      if (cached.negative) return null; // 负缓存命中：确认无 identity，零读取跳过
      return cached;
    }

    // [perf L-1] 磁盘索引查询（首扫惰性装载，miss/空索引时 get 恒 undefined = 无索引）。
    // 条目戳匹配 jsonl 当前 stat → 零内容读取构造缓存条目。undefined = 未命中
    // （落到下方探测），null = 负条目命中（零探测跳过）。
    // [UF-1] 绑定 sidecar 存在的文件跳过索引投影：SessionsIndexEntry 不含
    // chatMode/round（身份域子集），索引命中会把绑定承载的对话形态域抹成 undefined。
    if (stamps.binding === null) {
      const fromIndex = this.buildEntryFromIndex(file, stamps);
      if (fromIndex !== undefined) return fromIndex;
    }

    // [perf L-1] 索引 miss/戳不匹配落到原三级探测：本轮探测结果必须进索引（含负探测）。
    // 覆盖两种形态：首扫（映像已装载但 miss/不匹配）与后续轮次（映像已释放，凡进重建分支必是戳变化）。
    this.indexDirty = true;

    const payloads = readSidecarPayloads(file, stamps);
    const header = detectIdentity(file, jsonl.size);
    // [UF-1] 身份源两级：子文件 identity entry（历史权威，命中时绑定不参与）→
    // record 绑定 sidecar（engine-CLI 化后子文件无身份 entry，宿主在 sessionFile
    // 回填点落盘的 id→file 映射承担恢复能力）。两者皆缺 → 负缓存。
    const base = header ?? identityFromBinding(payloads.binding, file);
    if (!base) {
      // 负缓存：确认无 identity。后续扫描 stat 命中直接跳过；戳变化（文件补写 /
      // 绑定后到落盘）自动重试。
      this.fileCache.set(file, { negative: true, ...stamps });
      return null;
    }
    const entry = buildFileCacheEntry(base, file, stamps, payloads);
    // [U7 / §3.2.7 统计口径单基准] binding 补投影扩展到 identity 基底（原仅 binding
    // 基底）：binding 快照是 settle 写点的统计权威（.state 收条不冗余承载 round/
    // usage，§3.2.4），light 重建一律从 binding 恢复 turns/tokens/round/endedAt 终值
    // ——「冷复活前后计数一致」的读侧半边（写侧 = markSettled 快照 + markResurrected
    // 水合）。快照可滞后于在飞轮（settle 后 jsonl 续写），此时 record 在内存由
    // mergedRecords 内存源覆盖（内存增量覆盖磁盘终值），详情走 getFullRecord 从
    // jsonl 全量重放——三面优先级衔接无跳变。
    if (payloads.binding !== undefined) {
      const b = payloads.binding;
      if (b.round !== undefined) entry.light.round = b.round;
      if (b.totalTokens !== undefined) entry.light.totalTokens = b.totalTokens;
      if (b.turns !== undefined) entry.light.turns = b.turns;
      if (b.endedAt !== undefined) entry.light.endedAt = b.endedAt;
    }
    this.fileCache.set(file, entry);
    this.idToFile.set(base.id, file);
    return entry;
  }

  /**
   * [perf L-1] 磁盘索引查询（首扫惰性装载，miss/空索引时 get 恒 undefined = 无索引）。
   * 条目戳匹配 jsonl 当前 stat → 零内容读取构造缓存条目。sidecar payload（终态 marker）
   * 是活态数据，沿用探测分支的每轮重读语义；终态 reason 静态数据仅在 sidecar 存在
   * 时读一次（文件小，成本可忽略）。
   *
   * 返回 undefined = 索引未命中/戳不匹配（调用方落到原三级探测）；null = 负条目命中
   * （「确认无 identity」跨实例持久，零探测跳过，与内存负缓存同款形态）。
   */
  private buildEntryFromIndex(file: string, stamps: FileStamps): FileCacheEntry | null | undefined {
    if (this.indexEntries === null) return undefined;
    const hit = this.indexEntries.get(path.basename(file));
    if (hit === undefined || hit.mtimeMs !== stamps.jsonl.mtimeMs || hit.size !== stamps.jsonl.size) {
      return undefined;
    }
    if (hit.negative === true) {
      this.fileCache.set(file, { negative: true, ...stamps });
      return null;
    }
    const payloads = readSidecarPayloads(file, stamps);
    const entry = buildFileCacheEntry(
      {
        ...hit,
        forkDepth: undefined,
        sessionFile: file,
        // [H2 S3] 显式归一（exactOptionalPropertyTypes：索引可选属性 → recon 必填）；
        // 值已过 loadIndex 守卫（undefined/字面量白名单），直传即安全。
        origin: hit.origin,
        parentRunId: hit.parentRunId,
      },
      file,
      stamps,
      payloads,
    );
    this.fileCache.set(file, entry);
    this.idToFile.set(hit.id, file);
    return entry;
  }

  /**
   * [perf L-1] 扫描尾索引落盘（节流）：释放映像 → dirty/高版本/60s 节流窗三重门 →
   * fire-and-forget saveIndex（fileCache 全量投影）。写决策与发起在同步栈（collectRecords
   * 返回后不会再有本轮写）；仅写完成的回调（推进节流窗）是异步的。所有 return 路径均
   * 不清 dirty——未落盘的探测成果跨轮携带，直至真正写入。
   *
   * 并发安全：节流基准只在写成功后推进，W1 在途时新一轮过窗扫描可再 dispatch W2（不做
   * 进程内排队——fire-and-forget 语义保持）。安全性由 saveIndex 的 tmp 唯一性
   * （pid+单调序号）保证：交错 rename 的终态必为某一次的完整快照（last-writer-wins，
   * 陈旧快照胜出时下轮戳不匹配自愈），不依赖本方法串行化。
   */
  private flushIndexAfterScan(): void {
    this.indexEntries = null; // 释放映像：运行期索引不再被读（L1 接管）
    if (!this.indexDirty) return; // 纯命中轮零探测，不写
    if (this.indexHigherVersion) return; // 磁盘是更高版本：只忽略不重写（防 v1/v2 互相覆盖）
    if (Date.now() - this.lastIndexWriteAt < INDEX_WRITE_MIN_INTERVAL_MS) return; // 60s 节流窗内
    const entries = this.projectIndexEntries();
    this.indexDirty = false; // 发起时消费（写失败在 .catch 恢复）
    const encDir = path.dirname(this.sessionsDir);
    saveIndex(encDir, { entries })
      .then(() => {
        this.lastIndexWriteAt = Date.now(); // 仅成功分支推进节流窗
      })
      .catch((err: unknown) => {
        this.indexDirty = true; // 失败恢复 dirty，下轮过窗重试
        // [PS-14/T7③] 升 warn：索引反复写失败（权限/磁盘满）曾仅 debug 级，排障时
        // 无线索。失败会跨轮重试（dirty 恢复），warn 每次过窗写失败都会出现——
        // 正是「反复写失败需要可见」的信号面。
        logger.warn("[subagents] sessions-index write failed", {
          detail: { dir: encDir, error: err instanceof Error ? err.message : String(err) },
        });
      });
  }

  /**
   * [perf L-1] fileCache 全量投影 → 索引快照（basename → 正/负条目）。
   * 投影式单一 SSOT：不维护第二份可变索引映像（防双轨漂移）；fileCache 已被
   * reconstructAll 修剪掉消失文件（修剪时置 indexDirty），下次过窗写时快照清除
   * 磁盘上的陈旧条目。
   */
  private projectIndexEntries(): Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry> {
    const entries = new Map<string, SessionsIndexEntry | SessionsIndexNegativeEntry>();
    for (const [file, cached] of this.fileCache) {
      const base = path.basename(file);
      if (cached.negative) {
        entries.set(base, { negative: true, mtimeMs: cached.jsonl.mtimeMs, size: cached.jsonl.size });
      } else {
        entries.set(base, {
          mtimeMs: cached.jsonl.mtimeMs,
          size: cached.jsonl.size,
          id: cached.light.id,
          agent: cached.light.agent,
          mode: cached.light.mode,
          task: cached.light.task,
          slug: cached.light.slug,
          startedAt: cached.light.startedAt,
          rootSessionId: cached.light.rootSessionId,
          parentRecordId: cached.light.parentRecordId,
          depth: cached.light.depth,
          model: cached.light.model,
          thinkingLevel: cached.light.thinkingLevel,
          // [H2 S3] 来源域随投影入索引：light→索引→重建往返闭合（origin 丢失面与
          // binding 缺失面互补，索引命中路径不再静默抹掉 workflow 身份）。
          origin: cached.light.origin,
          parentRunId: cached.light.parentRunId,
        });
      }
    }
    return entries;
  }

  /**
   * [perf] byId 索引直查 light record（单文件 stat 校验，不触发 getFullRecord 的
   * 全量重建）。idToFile 未热（进程重启后尚未扫描过）时返回 undefined，调用方
   * 自行兜底全目录扫描——用于把「跨重启后每条 message 一次 collectRecords 全扫」
   * 降为 O(1) 索引命中。（反查 miss 的索引自愈不在此层——miss 契约被 cold-lookup
   * 链与 record-binding 测试钉死；manifest 惰性重建挂 mergedRecords，见其注释。）
   */
  findLightById(id: string): SubagentRecord | undefined {
    const file = this.idToFile.get(id);
    if (!file) return undefined;
    return this.scanFile(file)?.light;
  }

  /**
   * [perf] 单 record 详情懒加载：内存 running record 投影全量；磁盘 record 全量重建
   * （reconstructFromFile）并套用同一 sidecar 状态矩阵。结果缓存在 FileCacheEntry.full，
   * stat 戳变化时随 light 一起失效。列表 collectRecords 返回 light（无 eventLog/
   * result/turns 等重数据），详情面板/工具 list 按需调本方法补齐。
   *
   * 返回 undefined：id 不存在（内存与磁盘均无）。reconstructFromFile 失败（无
   * assistant message 等）→ 返回 light（无详情可补，缓存哨兵防重复全文重读）。
   */
  getFullRecord(id: string): SubagentRecord | undefined {
    // 内存 running record 天然全量（recordToSubagent 投影完整活态数据）。
    const mem = this.records.get(id);
    if (mem) return recordToSubagent(mem);

    const file = this.idToFile.get(id);
    if (!file) return undefined;
    const entry = this.scanFile(file);
    if (!entry) return undefined;
    if (entry.full === undefined) {
      const recon = reconstructFromFile(file);
      if (recon) {
        entry.full = buildRecord(recon, {
          state: entry.stateMarker,
          jsonlMtimeMs: entry.jsonl.mtimeMs,
          fullEndedAt: recon.endedAt,
        });
      } else {
        entry.full = entry.light; // 哨兵：无详情可补，后续直取 light（戳变化时重置重试）
      }
    }
    return entry.full;
  }

  // [H4 三轴拆分] buildFileCacheEntry / buildRecord（重建单规则）/ compareRecords /
  // manifestToSubagent / recordToSubagent 已迁 record-store-rebuild.ts（投影轴）。

  // [PS-15/T7⑤] 「从缓存与索引移除单文件」的旧私有方法已整体删除：全仓无调用方
  // 的死代码（设计 §4.3 PS-15 实锤，顺手清理，无行为影响）。「文件删除时移除缓存」
  // 的职责实际由 reconstructAll 的消失文件修剪路径承担。

  /** FR-8: 同步读取所有 manifest 记录（封装 ManifestStore.listAllSync，消除反射访问）。 */
  private readManifestsSync(): readonly ManifestRecord[] {
    return this.manifestStore?.listAllSync() ?? [];
  }
}
