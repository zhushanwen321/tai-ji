/**
 * plugin-bridge 请求的 title marker。runtime event-adapter 和 pi 侧
 * bridge extension（@zhushanwen/pi-plugin-bridge）双端消费此 marker，
 * 在 select 通道上区分 bridge 帧与普通 select（单一来源，两端口径必然一致）。
 *
 * NUL 前缀确保不会与 extension 正常的 select title 冲突。
 * 与 ASK_USER_MARKER / SESSION_MANAGER_MARKER / GUI_WIDGET_MARKER 同理。
 */
export const BRIDGE_MARKER = '\x00TAIJI_BRIDGE'

/**
 * 协议 v2 的 4 个 method 运行时集合（与 BridgeMethod 类型同源——types.ts 从此派生）。
 * event-adapter 用它校验 marker 帧的 method 合法性，
 * 非法值折叠为 'bridge:malformed' 哨兵（handler 回 malformed 错误，不静默丢弃）。
 */
export const BRIDGE_METHODS = ['bridge:sync', 'bridge:tool_execute', 'bridge:event', 'bridge:intercept'] as const
