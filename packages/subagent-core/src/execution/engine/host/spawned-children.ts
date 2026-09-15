// src/execution/engine/host/spawned-children.ts
//
// core 侧 spawnedChildren 状态镜像（W6 建立；[W3 chat 域收口] 去除 inproc 过渡桥，
// 纯镜像形态——设计 §3.8 D2 归属裁定的终态：spawnedChildren Map + 子进程收割的
// 持有方 = 引擎进程，core 只持状态投影）。
//
// 本文件是 core 侧的公共消费面：
//   - subagent-service / subprocess-agent-runner 的注册与镜像记账调用改经本模块，
//     不深路径 import 引擎内部（R3 S-C / R1 MF-5 改线落点）；
//   - lifecycle-predicates（hasLiveProcessHandle / isResumable）读本模块读点。
//
// [W3] 数据源两路（协议化形态）：① cli 引擎经 host/childSpawned / childStateChanged
// 反向通道上报（client/mirror.ts 落本镜像——失效语义同构）；② 历史调用点
// （cancel/close/idle timer/watchdog 的 killRecordChildWithEscalation）写镜像置死位。
// 实际进程终止**不经本模块**——子进程活在引擎进程内，终止经协议 interact
// cancel/close / run 域 cancel 帧承载（宿主侧杀链 = EngineClient killAll 进程组收割，
// 见 remote-engine abort 分级）。inproc 委托（session-runner Map 并读/委托杀）随
// inproc pi 引擎目录 删除消亡。

import type { ChildProcess } from "node:child_process";

// 镜像项（recordId 键 + killed 判据，与 client/mirror.ts 载荷契约同构）。
export interface SpawnedChildMirrorEntry {
  /** 引擎侧一次性子进程 pid（诊断面；recordId 才是镜像 key）。 */
  pid?: number;
  /** 必含判据（`child !== undefined && !child.killed` 同构）：true = 已被杀/已终止。 */
  killed: boolean;
  /** 最近一次状态变更的墙钟时间戳（诊断面）。 */
  updatedAt: number;
}

/**
 * core 侧 spawnedChildren 状态镜像（进程级单例，globalThis[Symbol.for] 持有防 jiti
 * 双路径加载分裂——registry.ts 同款惯例）。镜像只是状态投影：不发信号、不杀进程
 * （收割 = 引擎进程组级，见文件头）。
 */
class CoreSpawnedChildrenMirror {
  private readonly entries = new Map<string, SpawnedChildMirrorEntry>();

  /** 落项 / 覆盖（同 recordId 重 spawn = 覆盖旧句柄，与引擎侧 Map 同语义）。 */
  register(recordId: string, child: { pid?: number; killed: boolean }): void {
    this.entries.set(recordId, {
      pid: child.pid,
      killed: child.killed,
      updatedAt: Date.now(),
    });
  }

  /** 单项置死（杀链入口：killRecordChildWithEscalation 途经）。 */
  markKilled(recordId: string): void {
    const entry = this.entries.get(recordId);
    if (entry !== undefined) {
      entry.killed = true;
      entry.updatedAt = Date.now();
    }
  }

  /** 整体置死 + 清空（失效语义 2+3：引擎 exit / 重建 / dispose / killAll）。 */
  killAll(): void {
    this.entries.clear();
  }

  getChildByRecord(recordId: string): SpawnedChildMirrorEntry | undefined {
    return this.entries.get(recordId);
  }

  /** 句柄存活谓词（镜像面；判据与引擎侧 `!child.killed` 同构）。 */
  hasLiveProcessHandle(recordId: string): boolean {
    const entry = this.entries.get(recordId);
    return entry !== undefined && !entry.killed;
  }

  /** 快照（诊断/测试）。 */
  snapshot(): Array<SpawnedChildMirrorEntry & { recordId: string }> {
    return [...this.entries.entries()].map(([recordId, entry]) => ({ recordId, ...entry }));
  }

  /** 测试隔离专用（生产禁用——进程级全局状态）。 */
  clear(): void {
    this.entries.clear();
  }
}

const MIRROR_SLOT_KEY = Symbol.for(
  "@zhushanwen/pi-subagent-workflow.coreSpawnedChildrenMirror",
);

function coreMirrorSlot(): CoreSpawnedChildrenMirror {
  let slot = Reflect.get(globalThis, MIRROR_SLOT_KEY) as CoreSpawnedChildrenMirror | undefined;
  if (!slot) {
    slot = new CoreSpawnedChildrenMirror();
    Reflect.set(globalThis, MIRROR_SLOT_KEY, slot);
  }
  return slot;
}

/** core 侧镜像访问点（诊断/测试；生产读点走下方公共 API）。 */
export function coreSpawnedChildrenMirror(): CoreSpawnedChildrenMirror {
  return coreMirrorSlot();
}

// ── 公共面 API（subagent-service / SAR 消费）─────────────────────────

/**
 * 子进程注册（宿主记账回调 RunContext.onChildSpawned 的落点）：写镜像。
 * 引擎经 host/childSpawned 上报的形态经 client/mirror 落同一张镜像（单源）。
 */
export function registerSpawnedChildForRecord(recordId: string, child: ChildProcess): void {
  coreMirrorSlot().register(recordId, { pid: child.pid, killed: child.killed });
}

/**
 * 单 record 终止记账（镜像置死位）：实际终止在引擎进程内（协议 interact cancel /
 * close 或 run 域 cancel 帧承载）；宿主侧调用点是终止意图的记账面，宿主进程组级
 * 收割兜底 = EngineClient killAll（EnginePort.dispose / abort 杀链，见 remote-engine）。
 */
export function killRecordChildWithEscalation(recordId: string, _source: string): void {
  coreMirrorSlot().markKilled(recordId);
}

/** 全量收割记账（dispose / parent-shutdown）：镜像整体置死。 */
export function killAllSpawnedChildren(_signal: NodeJS.Signals = "SIGTERM"): number {
  const before = coreMirrorSlot().snapshot().length;
  coreMirrorSlot().killAll();
  return before;
}

/**
 * 句柄存活读点（lifecycle-predicates 的 hasLiveProcessHandle / isResumable 消费）。
 * 镜像是唯一数据源（host/childSpawned 上报 + 终止意图置死位）。
 */
export function hasLiveProcessHandleCore(recordId: string): boolean {
  return coreMirrorSlot().hasLiveProcessHandle(recordId);
}

/** 测试隔离：清镜像。 */
export function _resetCoreSpawnedChildrenMirrorForTest(): void {
  coreMirrorSlot().clear();
}
