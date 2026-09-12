// src/execution/engine/client/mirror.ts
//
// spawnedChildren 状态镜像（W2 协议客户端，impl-plan §2.2「镜像失效语义」）。
//
// 协议化后引擎进程是子进程的持有方（spawn/杀链都发生在引擎侧），core 只持
// **状态镜像**：数据源 = 反向通道 `host/childSpawned` / `host/childStateChanged`。
// 消费者 = 生命周期谓词（W6 起 lifecycle-predicates 的 hasLiveProcessHandle /
// isResumable 改读镜像，同步读、不跨进程查询）与 notify 合并窗口 / idle GC。
//
// 失效语义（impl-plan §2.2 必写死）：
//   1. 未收 `childSpawned` 前 = 无句柄（getChildByRecord undefined 等价）；
//   2. 引擎进程 exit / 重建 / dispose / killAll 时把该引擎**全部镜像项整体置死**
//      （killed=true + 状态广播）——否则 notify-host 60s 合并窗口挂住 / idle-gc TTL
//      不触发 / resumable 说谎 / 续聊被拒；
//   3. 置死广播后镜像清空，isResumable 回落「无句柄」。
//
// 载荷契约（SDK reverse-channels.ts）：`killed` 必含，判据
// `child !== undefined && !child.killed`——本镜像的状态查询面与其同构。

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

import { notifyChildProcessExited } from "../../dialog-queue.ts";

const logger = getLogger("subagents");

/** 镜像项（childSpawned/childStateChanged 载荷的落库形态）。 */
export interface MirrorEntry {
  /** 引擎内一次性子进程 pid（镜像 key）。 */
  readonly pid: number;
  /** 归属 record id。 */
  readonly recordId: string;
  /** running = 在跑；exited = 自然/被杀退出。 */
  state: "running" | "exited";
  /** 必含（判据 `child !== undefined && !child.killed`）；true = 已被杀/已终止。 */
  killed: boolean;
  exitCode?: number;
  signal?: string;
  /** 最近一次状态变更的墙钟时间戳（Date.now()，诊断面）。 */
  updatedAt: number;
}

/** 镜像状态变更事件（广播载荷）。 */
export interface MirrorChangeEvent {
  reason: "childSpawned" | "childStateChanged" | "killedAll";
  /** killedAll = 整体置死（引擎 exit / 重建 / dispose / killAll）。 */
  pid?: number;
  recordId?: string;
}

type MirrorListener = (event: MirrorChangeEvent) => void;

/**
 * spawnedChildren 状态镜像（per EngineClient 一份）。
 *
 * 镜像只是状态投影：本类不发信号、不杀进程（收割 = 引擎进程组级，见 EngineClient）；
 * 「整体置死」是对状态面的批量标记 + 广播，使宿主侧谓词/通知/GC 立即回落安全态。
 */
export class SpawnedChildrenMirror {
  private readonly entries = new Map<number, MirrorEntry>();
  private readonly listeners = new Set<MirrorListener>();

  /** `host/childSpawned`：落项（此前该 record 无句柄——失效语义 1）。 */
  recordSpawned(pid: number, recordId: string): void {
    this.entries.set(pid, {
      pid,
      recordId,
      state: "running",
      killed: false,
      updatedAt: Date.now(),
    });
    this.emit({ reason: "childSpawned", pid, recordId });
  }

  /** `host/childStateChanged`：更新项（载荷 killed 必含——类型层 required）。 */
  recordStateChanged(patch: {
    pid: number;
    recordId: string;
    state: "running" | "exited";
    killed: boolean;
    exitCode?: number;
    signal?: string;
  }): void {
    const existing = this.entries.get(patch.pid);
    const entry: MirrorEntry = {
      pid: patch.pid,
      recordId: patch.recordId,
      state: patch.state,
      killed: patch.killed,
      exitCode: patch.exitCode ?? existing?.exitCode,
      signal: patch.signal ?? existing?.signal,
      updatedAt: Date.now(),
    };
    this.entries.set(patch.pid, entry);
    this.emit({ reason: "childStateChanged", pid: patch.pid, recordId: patch.recordId });
    // [SR-4 接线] 子进程退出 → 取消其挂起 dialog：原绑定点（宿主 spawn pi 子进程时代
    // 的 session-runner child close）随协议化消失（宿主不再持句柄），新落点 = 引擎经
    // host/childStateChanged 上报 → 本镜像消费。未接线时该子进程的 pending dialog 要
    // 占住队列串行位直到 30min 队列级超时（延迟清理，非死锁）。
    if (patch.state === "exited") notifyChildProcessExited(patch.pid);
  }

  /**
   * 失效语义 2 + 3：全部镜像项整体置死（killed=true + state=exited）→ 逐项广播 →
   * 清空 Map。调用点 = 引擎进程 exit / 重建 / dispose / killAll（EngineClient 统一编排）。
   */
  killAll(): void {
    if (this.entries.size === 0) {
      this.emit({ reason: "killedAll" });
      return;
    }
    for (const entry of this.entries.values()) {
      entry.killed = true;
      entry.state = "exited";
      entry.updatedAt = Date.now();
      this.emit({ reason: "killedAll", pid: entry.pid, recordId: entry.recordId });
      // [SR-4 接线] 引擎进程消亡 = 其全部子进程已死 → 逐 pid 取消挂起 dialog
      notifyChildProcessExited(entry.pid);
    }
    this.entries.clear();
  }

  /** 未收 childSpawned / 已被整体置死清空后 → undefined（无句柄等价，失效语义 1）。 */
  getChildByRecord(recordId: string): MirrorEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.recordId === recordId) return entry;
    }
    return undefined;
  }

  getEntry(pid: number): MirrorEntry | undefined {
    return this.entries.get(pid);
  }

  /** 句柄存活谓词：镜像有项且未被置死（`child !== undefined && !child.killed`）。 */
  hasLiveProcessHandle(recordId: string): boolean {
    const entry = this.getChildByRecord(recordId);
    return entry !== undefined && !entry.killed;
  }

  /** isResumable 的镜像面（W6 lifecycle-predicates 改读本方法；语义同 hasLiveProcessHandle）。 */
  isResumable(recordId: string): boolean {
    return this.hasLiveProcessHandle(recordId);
  }

  /** 快照（诊断/测试）。 */
  snapshot(): MirrorEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  /** 订阅状态广播（W6 notify/谓词接线点）。返回退订函数。 */
  onChange(listener: MirrorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: MirrorChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // 广播监听器异常不阻断镜像主流程（监听器自身负责正式留痕）。
        logger.debug(
          `[spawned-children-mirror] listener threw for ${event.reason}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
