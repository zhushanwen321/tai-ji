// src/execution/assembly/channel-registry-access.ts
//
// Channel registry 的访问入口（本扩展内部用 + 契约文档化导出）。
//
// ask-user 等扩展通过本模块注册 channel handler，让 subagent 子进程的 UI 请求
// 能透传到主进程渲染。所有扩展各自直接读写
// globalThis[Symbol.for("@zhushanwen/pi-subagents.channelHandshake")]，
// 拿到结构兼容 ChannelRegistryHandshake 的同一握手对象。
//
// ── 升级说明（决策 D 修复 M4）─────────────────────────────────
// 历史问题：原协议槽位直接存 UiChannelRegistry 实例，谁先 session_start 谁创建。
// ask-user 先到时会自建简化 registry 占位，劫持 canonical 槽位，subagent-workflow
// 后到时拿到的是 ask-user 的非 canonical 实例，行为不一致。
//
// 修复：槽位从「存 registry 实例」升级为「存握手对象 {version, registry?, pending[]}」。
// canonical registry 实例永远由 subagent-workflow 单一创建点（本模块的
// getOrCreateChannelRegistry）实例化。ask-user 先到时只往 pending 推 handler，
// 等 subagent-workflow 来 flush；subagent-workflow 先到时直接创建 registry 并
// 接收后续 ask-user 推入的 pending。
//
// ── 跨扩展协议契约（必须与 ask-user 侧严格一致）──────────────
// key 字面量：     "@zhushanwen/pi-subagents.channelHandshake"
//                  ↑ 必须与 ask-user/src/channel-registry-register.ts 完全一致
// handshake 形状： ChannelRegistryHandshake（version=1）
// version 守卫：    slot.version !== 1 时 console.warn + 丢弃重建（向前兼容未来升级）

import { getLogger } from "../../core/logger.ts";

import { createUiChannelRegistry, type UiChannelRegistry, type ChannelHandler } from "../ui/ui-channels.ts";

const logger = getLogger("subagents");

/** 进程级 channel 握手的 globalThis key（Symbol.for 跨模块共享）。
 *
 *  **协议契约**：字面量 `"@zhushanwen/pi-subagents.channelHandshake"` 必须与
 *  ask-user 扩展的 `ask-user/src/channel-registry-register.ts` 完全一致——
 *  两边读写同一个 Symbol.for key 才能拿到同一握手对象。
 *
 *  改名历史：原 `CHANNEL_REGISTRY_KEY`（字面量 `...channelRegistry`）在决策 D
 *  中升级为 `CHANNEL_HANDSHAKE_KEY`（字面量 `...channelHandshake`），槽位形状
 *  从 registry 实例改为握手对象。 */
export const CHANNEL_HANDSHAKE_KEY = Symbol.for("@zhushanwen/pi-subagents.channelHandshake");

/** 握手版本。未来若形状不兼容升级，递增此常量并在 getOrCreateChannelRegistry
 *  的 version 守卫里加迁移逻辑。 */
const HANDSHAKE_VERSION = 1 as const;

/** pending channel handler 条目。ask-user 先到、registry 未就绪时临时存放。 */
export interface ChannelRegistryHandshakePendingEntry {
  channel: string;
  handler: ChannelHandler;
}

/** 跨扩展 channel registry 握手对象（globalThis 槽位形状）。
 *
 *  - `version`：协议版本，当前固定 1。读取时若 ≠1 视为不兼容，丢弃重建。
 *  - `registry`：canonical UiChannelRegistry 实例。仅由 subagent-workflow 的
 *    getOrCreateChannelRegistry 创建并填充。未就绪时为 undefined。
 *  - `pending`：ask-user 在 registry 就绪前推入的 handler 条目。
 *    subagent-workflow 创建 registry 后逐条 flush（注册），然后清空。 */
export interface ChannelRegistryHandshake {
  version: typeof HANDSHAKE_VERSION;
  registry?: UiChannelRegistry;
  pending: ChannelRegistryHandshakePendingEntry[];
}

/** 读取握手槽位；若 version 不匹配则视为缺失（warn + 返回 undefined）。
 *  类型不安全的 globalThis 反射访问集中在本函数，外层逻辑保持类型严谨。 */
function readHandshakeSlot(): ChannelRegistryHandshake | undefined {
  const slot = Reflect.get(globalThis, CHANNEL_HANDSHAKE_KEY) as unknown;
  if (slot === undefined) return undefined;
  // 形状校验：必须是对象且 version===1，否则视为不兼容
  if (typeof slot !== "object" || slot === null) {
    logger.warn(
      "[pi-subagent-workflow] channel handshake slot is not an object; discarding and recreating.",
    );
    return undefined;
  }
  // 断言目标含必填 version 字段（object/null 已守卫；version 值本身在下一行校验），
  // 对齐 format.ts extractAgentName 的必填字段断言先例，避免全可选断言零校验。
  const version = (slot as { version: unknown }).version;
  if (version !== HANDSHAKE_VERSION) {
    logger.warn(
      `[pi-subagent-workflow] channel handshake version mismatch (got ${String(
        version,
      )}, expected ${HANDSHAKE_VERSION}); discarding and recreating.`,
    );
    return undefined;
  }
  // version 正确，但 pending 可能被恶意/错误地塞了非数组；防御性处理
  const candidate = slot as ChannelRegistryHandshake;
  if (!Array.isArray(candidate.pending)) {
    logger.warn(
      "[pi-subagent-workflow] channel handshake pending is not an array; discarding and recreating.",
    );
    return undefined;
  }
  return candidate;
}

/** 将 pending 条目逐个注册进 registry，注册完清空 pending。
 *  pending 内部 entry 的形状由 ask-user 侧保证，此处不再二次校验。 */
function flushPending(registry: UiChannelRegistry, pending: ChannelRegistryHandshakePendingEntry[]): void {
  for (const entry of pending) {
    registry.register(entry.channel, entry.handler);
  }
}

/** 获取或创建进程级 channel registry（canonical 单例）。
 *
 *  **唯一创建点**：canonical UiChannelRegistry 实例仅由本函数创建。
 *  ask-user 扩展绝不自建 registry——它在 registry 未就绪时只往 slot.pending 推条目。
 *
 *  行为分支：
 *    1. 槽位不存在或 version ≠ 1 → warn（version 不匹配时）+ 建新 slot
 *       `{version:1, pending:[], registry:<newly created>}`
 *    2. 槽位存在但 registry 未就绪（ask-user 先到过，塞过 pending）→
 *       创建 canonical registry + flush pending + 清空 pending
 *    3. 槽位存在且 registry 已就绪（本函数已被调用过）→
 *       直接返回同一实例引用（===），不重建、不重复 flush
 *
 *  @returns 进程级 canonical UiChannelRegistry 单例（永不返回 undefined） */
export function getOrCreateChannelRegistry(): UiChannelRegistry {
  let slot = readHandshakeSlot();
  if (slot === undefined) {
    // 分支 1：无合规槽位，新建并立即创建 canonical registry
    const registry = createUiChannelRegistry();
    slot = { version: HANDSHAKE_VERSION, registry, pending: [] };
    Reflect.set(globalThis, CHANNEL_HANDSHAKE_KEY, slot);
    return registry;
  }
  if (slot.registry === undefined) {
    // 分支 2：ask-user 先到过，flush pending 进 canonical registry
    const registry = createUiChannelRegistry();
    flushPending(registry, slot.pending);
    slot.pending = [];
    slot.registry = registry;
    return registry;
  }
  // 分支 3：registry 已就绪，返回同一实例
  return slot.registry;
}

export type { UiChannelRegistry, ChannelHandler };
