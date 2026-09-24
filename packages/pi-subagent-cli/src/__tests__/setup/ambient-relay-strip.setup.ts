// src/__tests__/setup/ambient-relay-strip.setup.ts — 包级测试 env 净化
//（每 worker、用例收集前执行；经 test-guard/factory 的 taijiTestConfig 追加在
// fs-guard 之后，见 vitest.config.ts setupFiles）。
//
// [验收门修复·红2] 剥离宿主 ambient RELAY 五键（三激活键 SOCKET/NODE/SCRIPT +
// 两归属键 SESSION_ID/RECORD_ID）。
//
// 根因：getPiInvocation 分支 0 以 isRelayActive（三激活键同非空）为判据优先改道
// relay 代理——从 pi 子进程链宿主（runtime L0 注入 RELAY 身份）跑本包测试时，
// 引擎子进程 spawn 会走 relay 而非分支 3 的 PATH 解析。测试侧没有可用 socket /
// 归属键，代理自检即退（MISSING_IDENTITY=13 / SOCKET_* 族），PATH 上的自包含
// fixture `pi`（__fixtures__/pi → fake-pi*.mjs）从未启动 → get_state 握手永无
// 应答 → host/handleReady 10s 超时：protocol-e2e / protocol-chat-e2e /
// run-spawn-once 族成批确定性红，「自包含 fixture、零网络、零真 LLM」口径被
// ambient 环境破坏（relay 分支是 pi-invocation 唯一的 env 覆盖通道，测试必须
// 钉死直连 spawn 才能保证 fixture PATH 解析优先）。
//
// pi-invocation.test.ts 此前已有同因的文件级消毒（[验收门修复] 注释，只护住了
// 自己的 execPath/argv 断言）；本 setup 把消毒提到包级，覆盖全部 spawn 形态：
// 进程内 runSpawnOnce 直读 process.env，以及 FakeHost {...process.env} 派生的
// 引擎子进程 env。用例自设 relay 键的语义不受影响（setup 先于用例执行，用例级
// 赋值/stubEnv 后写生效）：run-spawn-once 的 ghost-node ENOENT 用例、
// pi-invocation 的 relay 分支用例均自行设键，照常覆盖。
import {
  RELAY_ENV_NODE,
  RELAY_ENV_RECORD_ID,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_SOCKET,
} from "@zhushanwen/subagent-engine-sdk";

const AMBIENT_RELAY_KEYS = [
  RELAY_ENV_SOCKET,
  RELAY_ENV_NODE,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_RECORD_ID,
] as const;

for (const key of AMBIENT_RELAY_KEYS) {
  delete process.env[key];
}

export {};
