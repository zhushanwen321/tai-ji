/**
 * migration/parsers barrel —— 各源真实解析器入口（W3）。
 *
 * Pi / ZCode / Claude / Codex 四源真实解析器，替换 W2 provider-parser.ts 内的 Mock。
 * provider-parser.ts 的 parseProviders dispatcher 改为 import 本 barrel 的真实解析器。
 */
export * from './pi-parser.js'
export * from './zcode-parser.js'
export * from './claude-parser.js'
export * from './codex-parser.js'
