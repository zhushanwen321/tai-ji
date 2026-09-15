// src/main.ts
//
// zcode-subagent-cli 进程入口（bin/zcode-subagent-cli.mjs dist-first 加载：
// dist/main.js 为 tsup 构建产物——npm 发布形态的常规路径；本文件仅在 workspace
// 未构建时被回退直载——node ≥23.6 原生 TS type-stripping，realpath 须在
// node_modules 外，回退判据见 bin/zcode-subagent-cli.mjs）。
//
// 启动序（样板已收编 SDK runEngineCliEntry，S4 簇 2；本薄层保留 arm 与 server
// 构造——server 构造需要 arm 产出的 ReverseRequestClock）：
//   1. armEngineSelfDestruct（SDK）：宿主死亡自灭守卫（主判据 stdin EOF；辅助判据
//      in-flight 反向请求计时——ack 排除面见 SDK spawn.ts）；
//   2. 构造 EngineProtocolServer（stdout 独占协议通道，一行一帧）；
//   3. runEngineCliEntry（SDK）：configureLoggerSink（stderr 兜底 + host/log
//      反向请求）+ stdin 行解析（NDJSON）→ server.handleFrame + close 留痕。
//
// 进程退出面：宿主 stdin EOF → 自灭守卫杀进程组（任务子进程同组连带收割）；正常
// dispose 不退进程（引擎进程生命周期归宿主 EngineClient / 自灭守卫）。

import {
  armEngineSelfDestruct,
  runEngineCliEntry,
  type ReverseRequestClock,
} from "@zhushanwen/subagent-engine-sdk";

import { EngineProtocolServer } from "./server.ts";

const clock: ReverseRequestClock = armEngineSelfDestruct({ stdin: process.stdin });

runEngineCliEntry({
  component: "zcode-engine-cli",
  server: new EngineProtocolServer({
    write: (frame) => {
      process.stdout.write(`${JSON.stringify(frame)}\n`);
    },
    reverseClock: clock,
  }),
});
