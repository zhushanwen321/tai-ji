/**
 * verify-taiji 能力原语层入口（lib）。
 * 契约：capabilities/API-CONTRACT.md §1（冻结）。
 *
 * 零第三方依赖（仅 node:*）；ui 的 Playwright 由 repo 解析（instance.loadPlaywright）。
 */
export { resolveRepo, createInstance } from './instance.mjs'
export { createProtocol } from './protocol.mjs'
export { createUI } from './ui.mjs'
export { createEvidence } from './evidence.mjs'
