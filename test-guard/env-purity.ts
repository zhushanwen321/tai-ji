// 全仓测试 env 纯净度防线（宿主链路泄漏类净化——factory 单点注入）。
//
// 背景（2026-10-02 质量门禁双假红）：质量门禁经子代理会话编排时，测试运行在真实
// taiji/pi 子代理 shell 内，宿主注入的 PI_SUBAGENT_* 身份贯穿 env（键名单源 = SDK
// identity-env 的 SUBAGENT_IDENTITY_ENV，跨进程 spawn 时写入）被测试进程原样继承，
// 与「测试进程是根进程」的默认语义基线冲突，两处假红同根：
//   1. subagent-core：SubagentService.initSession 读 PI_SUBAGENT_SELF_RECORD_ID 建
//      嵌套基线 → coldLookup 跨层归属守卫误拒根层 record（成员复用 revive 假红）；
//   2. subagent-workflow：session_start 兜底维护轮读 PI_SUBAGENT_ROOT_CWD 推
//      recordsDir 编码段 → 锚进宿主真实 cwd 段（测试 seed 在 fake ctx cwd 段）→
//      裁剪轮扫空目录（retention 断言假红）。
// 主会话（根进程）shell 跑测恒绿、子代理 shell 跑测恒红——「间歇性」假象的来源是
// 运行者进程身份，不是时序竞态。
//
// 语义基线：测试进程 = 根进程（身份 env 未设）。用例内显式 stubEnv/set 模拟子进程
// 身份不受影响（本净化先于用户 setupFiles 与全部用例运行；vi.stubEnv 在净化后捕获
// 的原始值 = undefined，unstub 还原后仍是「未设」语义）。与各包既有 vitest.setup.ts
// 的同族净化幂等叠加（前缀 delete 重复执行无副作用）。
//
// 本文件不 import 源码模块（与 global-setup 同纪律）：前缀字面量与 SDK
// SUBAGENT_IDENTITY_ENV 对应，SDK 侧加新键时本前缀天然覆盖。

/** 宿主链路泄漏前缀（当前唯一成员 = 子代理身份贯穿族）。 */
const HOST_IDENTITY_ENV_PREFIXES = ['PI_SUBAGENT_'] as const

for (const prefix of HOST_IDENTITY_ENV_PREFIXES) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(prefix)) delete process.env[key]
  }
}
