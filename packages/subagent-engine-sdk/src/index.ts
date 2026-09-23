// src/index.ts
//
// @zhushanwen/subagent-engine-sdk 主 barrel。
// u-foundation 契约根（impl-plan §2 W1 行）：协议面（帧型/方法/错误码/版本协商/
// JSON Schema/契约类型）+ 引擎侧原语（7 模块）+ UI 请求契约类型。
// 不变量（设计 §3.10.1）：本包禁止 import @zhushanwen/subagent-core——守卫
// .githooks/check-engine-sdk-boundary.mjs（SDK 源码 + dist 双侧扫描）。

// ── 协议面（契约类型 SSOT + 帧型 + 方法 + 反向通道 + 错误码 + 版本协商 + schema）──
export * from "./protocol/index.ts";

// ── 引擎侧原语（7 模块，impl-plan §2.1 原语迁移处置表）──
export * from "./schema-emulation.ts";
export * from "./nesting-guard.ts";
export * from "./logger.ts";
export * from "./kill-chain.ts";
export * from "./journal-replay.ts";
export * from "./data-dir.ts";
export * from "./paths.ts";

// ── UI 请求契约类型（host/askUser 反向通道载荷；core 反向 re-export 保消费面）──
export * from "./ui-types.ts";

// UI channel 提取 + channel 注册表（round1-reuse R1：core execution 与 pi 引擎 CLI
// 的逐字等价副本自本模块 re-export 收编）。
export * from "./ui-channels.ts";

// W12 落地（impl-plan §2.12）：env/spawn 原语（三层 env 契约 + 引擎子进程唯一 spawn
// 入口 + 宿主死亡自灭守卫）。
export * from "./env.ts";
export * from "./spawn.ts";

// W9 落地（impl-plan §2.9）：引擎 CLI 启动解析（宿主 × 平台二维矩阵 + node 执行器探针，
// 探针复刻 runtime relay-env 先例）。
export * from "./node-executor.ts";

// stderr tee 轮转/清理单源（前缀参数化；两引擎包的 logs/stderr-rotation.ts 为薄包装）。
export * from "./logs/stderr-rotation.ts";

// zcode 会话库路径段常量单源（MF-1-2 收编）：zcode 引擎写侧（db-path.ts）与 runtime
// 读侧（zcode-import/sqlite-access.ts）的跨侧路径契约，两侧 import 同一常量。
export * from "./zcode-db-paths.ts";

// relay 通道 env 名与协议常量 SSOT（round1-reuse R9：core ./relay-env 子入口与 pi
// 引擎包副本自本模块 re-export 收编，消 5 个 TAIJI_SUBAGENT_RELAY_* env 名双副本）。
export * from "./relay-env.ts";

// 「错误 → 可读字符串」与 best-effort 吞错 helper 单源（round1-reuse R11：core 与
// pi/zcode 引擎包的微副本 re-export 收编；toErrorMessage 含 A8 修复——非 Error
// object 入参 JSON.stringify 结构化文本，Error 入参逐字节不变）。
export * from "./error-message.ts";
export * from "./best-effort.ts";

// journal 文件读取单源（S4 簇 6：core event-journal 与 zcode journal-io 的
// replayJournal/parseLine 逐字等价双副本收编；JournalWriter 写侧留 core）。
export * from "./journal-io.ts";

// 引擎进程内契约面七符号 + parseCtxModel（S4 簇 1：pi/zcode port-types.ts 本地镜像
// 收编，两包改 re-export shim。收主 barrel 不进 protocol/——RunContext 含
// AbortSignal/回调非序列化成员；全量任务声明名 EngineAgentCallOpts 避让 protocol
// 的 AgentCallOpts 引擎面子集）。
export * from "./port-contract.ts";

// 引擎 CLI 进程入口样板（S4 簇 2：pi/zcode main.ts 同构段收编，两包收缩为薄层；
// armEngineSelfDestruct 与 server 构造留薄层，configureLoggerSink/readline 循环
// 在此）。
export * from "./cli-entry.ts";
