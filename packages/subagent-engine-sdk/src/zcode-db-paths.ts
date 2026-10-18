// src/zcode-db-paths.ts
//
// zcode 引擎专属跨侧路径段常量 SSOT（纯常量模块，零 import——同 constants.ts 纪律）。
//
// 为什么在 SDK（契约根）而非 zcode-subagent-cli：路径段是「引擎写侧（zcode-cli
// db-path.ts 构造 spawn env / handle.dbPath / 读取白名单 / preparer.ts 副本解析链）」
// 与「宿主读侧（zcode-session-source src/sqlite-access.ts 的 import allowlist 与
// runtime provider 同步写侧，均经 SDK 消费）」之间的跨侧契约——两侧必须同源推导，
// 禁止各自拼字符串漂移（同 paths.ts 头注的收编理由）。引擎包只依赖 SDK
// （W5 边界），读侧的共同依赖只能是 SDK 而非引擎包（C-ext-13：runtime 不 import
// 引擎包）；此前两侧各持同形字面量、靠 parity 测试文本比对防漂移，本模块收编为
// 单源后两侧 import 同一常量。
//
// 为什么不并入 paths.ts：paths.ts 是 engineId 参数化的通用引擎布局；本模块是 zcode
// 引擎专属路径段契约（变化原因不同——zcode 安装布局变更不影响通用布局，反之亦然）。
//
// 已知残留派生副本：scripts/zcode-session-db-cleanup.mjs 为纯 ESM 脚本（无 TS 构建链）
// 无法 import 本模块，保留等价 JS 字面量——一致性由 packages/runtime/test/
// host-db-suffix-parity.test.ts 的脚本派生文本比对检查。

/**
 * 宿主 HOME 下 zcode 会话库相对段（`~/.zcode/cli/db/db.sqlite`，绝对路径 =
 * join(os.homedir(), ...suffix)）。2026-09 会话库隔离后定位为「存量兼容锚点」：
 * 新 handle.dbPath 恒为隔离库路径（ZCODE_ISOLATED_DB_SEGMENTS），本段仅用于
 * 白名单集合第二项放行「共享 HOME 时代」record 已落盘的宿主绝对路径。
 */
export const ZCODE_HOST_DB_SUFFIX = ['.zcode', 'cli', 'db', 'db.sqlite'] as const;

/**
 * 隔离会话库相对段（`<dataDir>/engines/zcode/session-db/db.sqlite`，绝对路径 =
 * join(dataDir, ...segments)）。选址在 journal 池目录（`engines/zcode/shared/`）
 * 之外——池 TTL 清理不得触及会话库（设计 D1/F11）。
 */
export const ZCODE_ISOLATED_DB_SEGMENTS = ['engines', 'zcode', 'session-db', 'db.sqlite'] as const;

/**
 * taiji 同步副本相对段（`<dataDir>/engines/zcode/pi-synced-provider-config.json`，
 * 绝对路径 = join(dataDir, ...segments)）：runtime 启动段把 pi 侧 provider 映射落盘
 * 的合并副本（唯一写方 = runtime provider 同步模块 zcode-provider-sync-wiring.ts，
 * 读侧另一处 = session-records.ts zcodeModelListPaths 缺省拼装；引擎读侧 =
 * zcode-subagent-cli preparer.ts 个人 provider 解析链——副本存在即用之，缺失回落
 * 真实 `~/.zcode/v2/provider_config.json`）。与 ZCODE_ISOLATED_DB_SEGMENTS 同族：
 * 同以 dataDir 为 join 根的 dataDir 相对段（区别于 homedir 根的 _SUFFIX 常量）。
 */
export const ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS = [
  'engines',
  'zcode',
  'pi-synced-provider-config.json',
] as const;
