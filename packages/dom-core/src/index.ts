// @taiji/dom-core — DOM-bound 前端逻辑（ADR-0058）。
// 分层：shared ← core（真 headless）← dom-core（DOM API only，零 electron）← ui ← renderer。
// 承载「需要 DOM API、无 electron、跨 DOM renderer 复用」的逻辑（首批：composer/input）。
// 与 core 的边界：core 零 DOM 零 jsdom；dom-core 明确使用浏览器 DOM API。
export * from './composer/input'
