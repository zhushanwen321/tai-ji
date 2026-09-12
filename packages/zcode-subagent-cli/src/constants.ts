// src/execution/engine/engines/zcode/constants.ts
//
// ZcodeEngine 共享常量（P3）。独立成模块的原因：reader.ts 是双端复用的无状态模块
// （设计 §3.3.7：runtime 侧也会 import），它需要的常量不能连带其他模块的模块级
// 副作用（如 logger 初始化）一起加载——constants.ts 保持零 import 纯常量。
//
// 2026-09 重构（共享宿主 HOME）：删除 CLI spawn 降级链与 HOME 池化全部常量
// （home-appserver 池/锁/pidfile/派生上限/凭据引导/probe 冒烟/漂移降级码）。
// 引擎只走 app-server RPC，spawn env 不覆写 HOME（共享宿主 ~/.zcode/）；会话库
// 随 2026-09 会话库隔离设计独立于宿主库（隔离路径契约见 db-path.ts 的
// zcodeSessionDbPath/zcodeDbPathAllowlist，下方 ZCODE_HOST_DB_SUFFIX 降级为存量
// 兼容锚点）。

/** zcode 引擎的 registry key。 */
export const ZCODE_ENGINE_ID = "zcode";

/** zcode 适配器版本（handle.adapterVersion 数据源——golden 样本对齐排查锚点）。 */
export const ZCODE_ADAPTER_VERSION = "2.0.0";

/**
 * zcode CLI 缺省路径（12.4MB node bundle，不在 PATH——2026-08-25 实测）。
 * 组合根可用 deps.cliPath 覆盖（测试注入 / 未来安装形态变化）。
 */
export const ZCODE_CLI_DEFAULT_PATH = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

/**
 * 唯一凭据源 config（桌面端登录态，zsub V2_CONFIG_PATH 同构）。
 * 为什么绝不读 ~/.zcode/cli/config.json 作为引擎侧凭据校验源：它不在 ZCode GUI
 * 管理面，可能残留历史验证配置（2026-08-25 事故：8/24 zsub 开发残留把默认模型
 * 劫持到失效 router 端点，turn 0 即 401）；桌面端登录凭据落在 v2/config.json，
 * 是 zsub 生产验证过的凭据源。共享宿主 HOME 后引擎侧只读它做模型解析校验；
 * app-server 进程侧 CLI 只认 ~/.zcode/cli/config.json（GUI 从不写该文件），由
 * appserver-launcher 的 fs 拦截 wrapper 把对该文件的读取重定向为「真实文件 +
 * v2 provider 注入」内存合并（同 id 时 v2 整条优先）——凭据实际供数仍以 v2 为
 * 权威源，并非直接消费宿主 HOME 的原始 cli config。
 */
export const ZCODE_V2_CONFIG_PATH_SUFFIX = [".zcode", "v2", "config.json"] as const;

/** zsub 同构的兜底缺省模型（v2 config 无 model.main 且 task 未指定时）。 */
export const ZCODE_FALLBACK_DEFAULT_MODEL = "builtin:bigmodel-coding-plan/GLM-5.3";

/**
 * 宿主 HOME 下 zcode 会话 db 的相对位置（绝对路径 = join(os.homedir(), ...suffix)，
 * 仅由 db-path.hostZcodeDbPath 消费）。2026-09 会话库隔离后定位降级为「存量兼容
 * 锚点」：新 handle.dbPath 恒为隔离库路径（db-path.zcodeSessionDbPath），读侧白名单
 * （db-path.zcodeDbPathAllowlist 第二项）仅放行「共享 HOME 时代」record 已落盘的
 * 宿主绝对路径；旧池时代 records 的相对 dbPath 仍按 poolKey 锚定兼容。
 */
export const ZCODE_HOST_DB_SUFFIX = [".zcode", "cli", "db", "db.sqlite"] as const;

/** 杀链 grace 窗口：SIGTERM 后等这么久再 SIGKILL（zsub 同构 5s；实测 SIGTERM→exit 仅 103ms）。 */
export const ZCODE_KILL_GRACE_MS = 5_000;

/** 错误信息里保留的 stdout 尾部长度（engine_run_failed 规格：够诊断、不刷屏）。 */
export const ZCODE_ERROR_TAIL_CHARS = 2000;

/**
 * [R2] app-server 控制面请求默认超时（ms）。依据：旧 zsw 实现 REQUEST_TIMEOUT_MS=15s
 * （60+ fake-server 用例 + 真机 e2e 验证值）。
 */
export const ZCODE_APPSERVER_REQUEST_TIMEOUT_MS = 15_000;

/**
 * [R2] 连接崩溃错误信息附带的 stderr 尾部长度（字符）。设计 zcode-engine-appserver-
 * resident.md §3.1 失败路径 2 / §3.3 错误规格表「进程意外退出」行：stderr 尾 400 字符。
 */
export const ZCODE_APPSERVER_STDERR_TAIL_CHARS = 400;

/**
 * [R2] stderr 滚动缓冲上限（字符）：只保最近内容供崩溃诊断。旧 zsw 实现同值 2048。
 */
export const ZCODE_APPSERVER_STDERR_TAIL_BUFFER_CHARS = 2048;

/**
 * [R3] 终态判定后 session/read 兜底拉取的超时（ms）。read 是全文权威来源（不变量 1
 * 的双来源之二），失败不抛——降级收尾帧/delta 聚合。旧 zsw 实现 READ_TIMEOUT_MS=5000。
 */
export const ZCODE_APPSERVER_TURN_READ_TIMEOUT_MS = 5_000;

/**
 * [R3] 任务收尾 session/close 的控制面超时（ms，best-effort——失败只 warn 不抛）。
 * 旧 zsw 实现 RELEASE_CLOSE_TIMEOUT_MS=1500（wave2 D2，同值同语义）。
 */
export const ZCODE_APPSERVER_TURN_CLOSE_TIMEOUT_MS = 1_500;

/**
 * [R3 → superseded by P0-1] 旧「一轮终态等待」固定墙钟缺省值（ms）。**已被
 * `ZCODE_TURN_IDLE_TIMEOUT_MS`（idle 主判定）+ `ZCODE_TURN_MAX_TIMEOUT_MS`
 * （总上界兜底）两 timer 语义替换，session-channel 不再消费本值**——固定墙钟
 * 「到点=不可推进」判定被 2026-09 T001 深诊击穿（21% 活跃任务被误杀，见设计
 * timeout-zcode-turn-and-settled-watchdog.md §3.1/§4）。符号保留：audit/设计
 * 文档（timeout-audit-2026-09.md 等）以本名记录事故成因，删除即产生悬空引用。
 */
export const ZCODE_APPSERVER_TURN_DEFAULT_TIMEOUT_MS = 300_000;

// ============================================================
// [P0-1 U1] turn 等待两 timer（idle 主判定 + 总上界回收兜底）
// 设计权威源：docs/design/timeout-zcode-turn-and-settled-watchdog.md §6 D1/D2
// ============================================================

/** turn idle 主判定的 env 覆盖通道（>0 覆盖、≤0 关闭、非法值 warn+回落默认）。 */
export const ZCODE_TURN_IDLE_TIMEOUT_ENV = "XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS";

/** turn 总上界的 env 覆盖通道（语义同上；0=关闭后 chatty-wedge 无自动回收）。 */
export const ZCODE_TURN_MAX_TIMEOUT_ENV = "XYZ_ZCODE_TURN_MAX_TIMEOUT_MS";

/**
 * [P0-1 D1] turn idle 主判定缺省阈值（ms）：该 turn 任何事件到达刷新计时，连续
 * 静默达此值判「执行已不可推进」。活跃事件流零误杀（ADR-0047 逆否面）。默认
 * 30min 为先验值，⛔P-Z1 门（事件流 inter-event gap 分布）标定前用此默认。
 */
export const ZCODE_TURN_IDLE_TIMEOUT_MS = 1_800_000;

/**
 * [P0-1 D1] turn 总上界缺省值（ms）：从 openTurn 挂载起固定不刷新，兜 idle 覆盖
 * 不了的 chatty-wedge（事件持续但终态永不到达）。对超上界的合法极长任务是显式
 * 接受的残余误杀面（env 可调/可关 + 错误文案附自救指引）。默认 60min 为先验值
 * （T001 34 任务最长 541s，先验远离 6.6×），⛔P-Z0 门（任务总时长分布）标定前
 * 用此默认。
 */
export const ZCODE_TURN_MAX_TIMEOUT_MS = 3_600_000;

/** `parseZcodeTurnTimeoutEnv` 的解析结果（可判别联合——valid 分支 ms 必有）。 */
export type ZcodeTurnTimeoutEnvParse =
  | { state: "unset" }
  | { state: "valid"; ms: number }
  | { state: "invalid" };

/**
 * 解析 turn 阈值 env 原始值（空串视同未设置，对齐 lifecycle-manager 先例的
 * `if (!raw)` 口径）。**与 `XYZ_SUBAGENT_IDLE_TIMEOUT_MS` 先例的刻意分歧（设计
 * D2/r3 SG-5 显式登记）**：先例 ≤0=非法回落且禁用后不认 env；本通道 ≤0=显式
 * 关闭该 timer（规则 19 的 opt-out 出路），非法（非数字）才回落默认——调用方
 * 必须对 invalid 与 ≤0 关闭分别 warn 留痕（生效行为可见，A10① 断言依据）。
 */
export function parseZcodeTurnTimeoutEnv(
  raw: string | undefined
): ZcodeTurnTimeoutEnvParse {
  if (raw === undefined || raw === "") return { state: "unset" };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { state: "invalid" };
  return { state: "valid", ms: parsed };
}

/**
 * 共享宿主 HOME 语义下的 journal 分组 key（与 pi 引擎 PI_POOL_KEY='shared' 同构）：
 * journal 落 engineDataDir/engines/zcode/shared/journal-<taskId>.jsonl。无 HOME 池、
 * 无派生目录——key 是固定字面量，仅作 pool-manager 通用契约的分组锚点。隔离会话库
 * 不在此目录内（db-path.zcodeSessionDbPath 选址 engines/zcode/session-db/，池目录
 * 之外，设计 D1/F11）。
 */
export const ZCODE_SHARED_POOL_KEY = "shared";

/**
 * [R4 D3] abort 链第一级：session/stop 的控制面超时（ms）。stop 失败/超时即落
 * killChain（协议此时已不可信）。
 */
export const ZCODE_APPSERVER_STOP_TIMEOUT_MS = 3_000;

/**
 * [R4 D3] abort 链第二级：stop 送达后的终态确认 grace 窗口（ms）。窗口内终态
 * 到达 → 不杀共享进程；超时 → killChain 连坐。
 */
export const ZCODE_APPSERVER_ABORT_GRACE_MS = 3_000;

/**
 * [R4] app-server 内部错误码中「模型配置缺失」的归类判据（A.3：-32603 内部错误族，
 * 消息含 "Model config is missing"——错误规格表第 2 行：报 engine_credential_missing）。
 */
export const ZCODE_APPSERVER_ERR_MODEL_CONFIG_MISSING = -32603;

/**
 * [R5] app-server 内部错误码「会话忙」：send 时该会话已有轮在跑（busy 不排队不打断）。
 * 单会话一任务是结构保证，运行中命中即 bug（错误文案引导上报 sessionId 与 state 流水）。
 */
export const ZCODE_APPSERVER_ERR_BUSY_SESSION = -32010;

/**
 * [R5] 崩溃收割确认的兜底窗口（ms）：killChain 在 `exit` 事件 resolve，而连接
 * finalize（onClose → 在途 turn 崩溃收割）挂 `close` 事件——channel 退订前等 onClose
 * 触发，本窗口兜底防 `close` 永不到达时 dispose 挂死。
 */
export const ZCODE_APPSERVER_HARVEST_GRACE_MS = 1_000;

/**
 * 失败终态判据（⛔P-Z2 门修正）：真实 status 枚举 = ["success","interrupted",
 * "failed"]（app-server dist schema f.enum 实证，**无 "error"**——v1 判据
 * `=== "error"` 对真实 failed 终态漏分流即假成功，本修复轮根修）。裁决：
 *   - "failed" → run-failed（模型/服务端真实失败——§5.2 F-3）；
 *   - "interrupted" → 不分流（用户中断，不属引擎失败——随宿主 abort 主路径收口，
 *     引擎侧不抢先把它终态化为失败）；
 *   - "error" → 保留为容错分支（非真实枚举，防协议漂移/旧版本形态再滑入假成功；
 *     假成功代价 >> 误报失败代价，取并集防御）。
 * 收编自 zcode-engine.ts（原模块私有）：session-channel 的迟到终态分级日志与引擎
 * 失败分流共用同一口径（分类集合单源，禁止双轨漂移）。
 */
export function isFailedTerminalStatus(status: string | undefined): boolean {
  return status === "failed" || status === "error";
}
