// src/channel-registry-register.ts
//
// ask-user 侧的 channel handler 握手注册纯函数。
//
// 设计动机（PR #85 #M4 修复）：原实现 ask-user 先 session_start 时会自建简化 Map-based
// registry 占据 canonical 槽位，劫持后续 getOrCreateChannelRegistry 拿到的实例
// （packages/subagent-core 的 createUiChannelRegistry（execution/ui/ui-channels.ts）才是
// canonical——它带排队、dialog 队列等完整能力）。修复后的握手协议改为「带 version 的 slot」：
//   - 承载 subagent-core 的 subagent-workflow 扩展 session_start 时往 slot 写
//     {version, registry, pending:[]}（registry 由 subagent-core 创建）
//   - ask-user session_start 时只读 slot，registry 就绪则调 registry.register，未就绪则 push pending
//   - ask-user **永不**创建 registry 实例，**永不**写 slot.registry
//
// 这是 ask-user 侧的注册入口；canonical registry 由 packages/subagent-core 创建（经
// channel-registry-access.ts 的 getOrCreateChannelRegistry + flush）。本模块永不创建
// registry 实例——仅往 slot 写 pending 或调 slot.registry.register。

import type { ChannelHandler } from "./channel-handler";
import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("ask-user");

/**
 * 进程级 channel registry 握手的 globalThis key（Symbol.for 跨模块共享）。
 *
 * ⚠️ 必须与 packages/subagent-core/src/execution/assembly/channel-registry-access.ts 的字面量
 * 完全一致——两边用同一字符串确保拿到同一 slot 实例。改名必须两侧同步。
 */
export const CHANNEL_HANDSHAKE_KEY = Symbol.for(
	"@zhushanwen/pi-subagents.channelHandshake",
);

/** 握手协议版本号。读写 slot 时校验 version !== 1 视为不兼容（warn + 重建 slot）。 */
const HANDSHAKE_VERSION = 1;

/** channel 名称（ask-user 固定注册 "ask_user"）。 */
const ASK_USER_CHANNEL = "ask_user";

/**
 * channel registry 的本地等价接口（与 packages/subagent-core 的 UiChannelRegistry 形状一致，
 * execution/ui/ui-channels.ts 定义）。本模块不静态 import packages/subagent-core（host 侧包，
 * 非本包依赖——两侧经 globalThis slot 握手协作）；运行时结构兼容即可。
 */
interface ChannelRegistry {
	register(channel: string, handler: ChannelHandler): void;
	resolve(channel: string): ChannelHandler | undefined;
	list(): string[];
}

/** pending 队列元素：channel + handler。packages/subagent-core flush（channel-registry-access.ts）时遍历调用 registry.register。 */
interface PendingEntry {
	channel: string;
	handler: ChannelHandler;
}

/**
 * globalThis slot 的形状。
 *
 * - `version`：握手协议版本（运行时校验，不兼容则丢弃重建）
 * - `registry`：canonical 实例，**仅 packages/subagent-core 创建**；缺失表示 registry 未就绪，
 *   ask-user 把 handler 入 pending 队列等待 flush
 * - `pending`：未消费的注册请求（registry 就绪后由 packages/subagent-core 一次性 flush）
 */
export interface ChannelRegistryHandshake {
	version: 1;
	registry?: ChannelRegistry;
	pending: PendingEntry[];
}

/** 从 globalThis 读 slot；version !== 1 视为无 slot（返回 undefined）。 */
function readSlot(): ChannelRegistryHandshake | undefined {
	const slot = Reflect.get(globalThis, CHANNEL_HANDSHAKE_KEY) as
		| ChannelRegistryHandshake
		| undefined;
	if (slot === undefined) return undefined;
	if (slot.version !== HANDSHAKE_VERSION) {
		logger.warn('channel handshake slot version mismatch, discarding and rebuilding', {
			expected: HANDSHAKE_VERSION,
			got: slot.version,
		});
		return undefined;
	}
	return slot;
}

/** 在 globalThis 上建一个空 slot（仅 pending，无 registry——ask-user 永不建 registry）。 */
function ensureSlot(): ChannelRegistryHandshake {
	const slot: ChannelRegistryHandshake = { version: HANDSHAKE_VERSION, pending: [] };
	Reflect.set(globalThis, CHANNEL_HANDSHAKE_KEY, slot);
	return slot;
}

/**
 * 注册 ask_user channel handler 到 globalThis 握手 slot。
 *
 * 行为：
 *   1. slot 不存在或 version 不兼容 → 建 slot（仅 pending），handler 入 pending；
 *      **slot.registry 保持 undefined**（M4 核心：ask-user 不建 registry）
 *   2. slot 存在但 registry 未就绪 → handler 入 pending
 *   3. slot 存在且 registry 就绪 → 直接调 registry.register("ask_user", handler)
 *
 * 多次调用幂等：registry 就绪时 register 同名覆盖；未就绪时 pending.length 增长
 * （packages/subagent-core flush 时一次性消费所有 pending）。
 *
 * @param handler ask_user channel handler（createAskUserChannelHandler 产出）
 */
export function registerAskUserChannelHandler(handler: ChannelHandler): void {
	const slot = readSlot() ?? ensureSlot();
	if (slot.registry !== undefined) {
		slot.registry.register(ASK_USER_CHANNEL, handler);
		return;
	}
	slot.pending.push({ channel: ASK_USER_CHANNEL, handler });
}
