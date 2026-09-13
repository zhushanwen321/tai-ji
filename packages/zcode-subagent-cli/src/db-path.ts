// packages/zcode-subagent-cli/src/db-path.ts（原 subagent-core 路径，2026-09-09 W11 随引擎包迁出）
//
// zcode 会话库路径契约（2026-09 会话库隔离）。设计权威源：
// docs/architecture/zcode-session-db-isolation.md §3.2 D1（路径与 env 契约）/
// D2（白名单集合与 dataDir 权威源）/ D3（存量兼容）/ §3.3 不变量 2（路径单一来源）。
//
// 为什么独立成模块：constants.ts 头注约束「零 import 纯常量」，而路径构造函数需要
// node:path/node:os；且 allowlist 需引用 hostZcodeDbPath()——若留在 zcode-engine.ts
// 会成 db-path → zcode-engine → db-path 循环依赖，随本模块迁出断环（constants.ts
// 零 import，非环参与者）。
//
// 路径单一来源纪律（不变量 2）：spawn env 的 ZCODE_SESSION_DB_PATH 值、后续
// handle.sessionRef.dbPath 与两读取站点的白名单集合，全部由本模块两个构造函数
// 产出，禁止任何消费方手拼字面量（与 resolvePoolDir 同款纪律）。

import * as os from "node:os";
import * as path from "node:path";

import { ZCODE_HOST_DB_SUFFIX } from "./constants.ts";

/**
 * 隔离会话库绝对路径（单一构造函数，唯一权威）：
 * `<engineDataDir>/engines/zcode/session-db/db.sqlite`。
 *
 * 选址在池目录之外（不落 `engines/zcode/shared/`——那是 journal 池目录，被
 * `deletePoolNativeState` 覆盖，设计 D1/F11）；journal 路径不变（仍
 * `engines/zcode/shared/journal-<taskId>.jsonl`）。`cleanupExpiredPoolRefs` 会把
 * `engines/<engineId>/` 下每个子目录当池枚举，`session-db/` 中的 `db.sqlite*`
 * 不匹配任何删除条件（池 GC 守卫 = 验收场景 A9）。
 *
 * @param engineDataDir 引擎数据目录（`deps.engineDataDir()`；禁硬编码，一律由入参推导）
 */
export function zcodeSessionDbPath(engineDataDir: string): string {
  return path.join(engineDataDir, "engines", "zcode", "session-db", "db.sqlite");
}

/**
 * 存量兼容锚点：宿主 HOME 下 zcode 会话 db 的绝对路径
 * （`~/.zcode/cli/db/db.sqlite`）。
 *
 * 隔离改造（D3）后定位降级：仅用于放行「共享 HOME 时代」（2026-09–本次改造）record
 * 里已落盘的宿主绝对路径 dbPath（不迁移、不删除），出现在白名单集合第二项与兼容
 * 测试里；新写入一律走 zcodeSessionDbPath（W2 起 handle 回填与读取判定切换）。
 */
export function hostZcodeDbPath(): string {
  return path.join(os.homedir(), ...ZCODE_HOST_DB_SUFFIX);
}

/**
 * 会话 db 白名单集合（①级读取的唯一放行来源，封闭集合——设计 D2/不变量 3）：
 * `[隔离库（现役）, 宿主库（仅存量兼容）]`。
 *
 * record/handle 来自 append-only JSONL（不可信面），两读取站点只做「集合成员判定」，
 * 只放行集合内精确绝对路径，其余拒绝①级、降 journal——防任意文件读。集合形态
 * （而非 `||` 列表）使未来第三个合法路径只需改本函数。
 *
 * @param dataDir 构造集合所用 dataDir（两站点各用它打开数据库时的同一个 dataDir；
 *   dataDir 权威源与传播前提见设计 D2——勿当同源事实）
 */
export function zcodeDbPathAllowlist(dataDir: string): readonly string[] {
  return [zcodeSessionDbPath(dataDir), hostZcodeDbPath()];
}
