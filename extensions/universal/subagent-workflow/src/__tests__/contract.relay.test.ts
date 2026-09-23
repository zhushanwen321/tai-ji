// contract.relay.test.ts —— conformance relay 变体（E 方案 §2.3，默认 CI 层，免 LLM）。
//
// [W3 改写] 断言口径收敛到「宿主侧仍拥有的契约面」：
//   1. 协议常量镜像一致性：relay.mjs（零依赖脚本不能 import workspace 包，只能内嵌
//      镜像）与 relay-env.ts SSOT 逐字对齐——改名/改值双侧不同步即此处转红（§10-5）。
//
// 随 W3 chat 域收口废弃的两段（行为迁出宿主进程，原断言面无宿主侧对应物，非跳过）：
//   - C-通道（getPiInvocation 三分支）：spawn 目标解析随 inproc session-runner 删除
//     整体迁入引擎进程（packages/pi-subagent-cli/src/pi-invocation.ts），三分支契约
//     （三 env 齐备 → 代理 / 任一缺失 → 直连 / relay:false 强制直连）由引擎包自有
//     pi-invocation.test.ts 的「getPiInvocation relay 分支」describe 逐条覆盖。
//   - C-归属（buildChildEnv 归属键写入）：宿主侧不再 spawn pi 子进程——归属键
//     （RELAY_SESSION_ID/RECORD_ID）写入点迁至引擎进程 spawn-runner.buildChildEnv
//     （deny 终态后按 run ctx 显式重写），原「mock spawn 捕获 childEnv」观测面在
//     宿主侧不存在。
//
// 真机全链（经代理 spawn 真实 pi）是 live 手动门：engine-conformance.live.test.ts 的
// relay describe（ENGINE_CONFORMANCE_LIVE=1 + relay env 齐备），不在本文件。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RELAY_ENV_NODE,
  RELAY_ENV_RECORD_ID,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_SOCKET,
  RELAY_EXIT_CODES,
  RELAY_PROTOCOL_VERSION,
} from "@zhushanwen/subagent-core/relay-env";
import {
  RELAY_FRAME_DIRS,
  RELAY_FRAME_KINDS,
  RELAY_REJECT_REASONS,
} from "@zhushanwen/subagent-engine-sdk";

/** 被锁定的代理脚本：包根 relay/relay.mjs（与 src/ 平行的零依赖脚本）。 */
const RELAY_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../relay/relay.mjs",
);

// ── 1. 协议常量镜像一致性（relay-env.ts SSOT ↔ relay.mjs 内嵌镜像）──

describe("relay 变体 C-镜像：relay.mjs 内嵌常量与 relay-env.ts SSOT 一致", () => {
  const source = fs.readFileSync(RELAY_SCRIPT_PATH, "utf8");

  /** 字符串常量：`const NAME = "value"` 形式逐字对齐（值来自 SSOT 导出，漂移即红）。 */
  const stringVars: Array<[string, string]> = [
    ["RELAY_ENV_SOCKET", RELAY_ENV_SOCKET],
    ["RELAY_ENV_SESSION_ID", RELAY_ENV_SESSION_ID],
    ["RELAY_ENV_RECORD_ID", RELAY_ENV_RECORD_ID],
  ];

  it.each(stringVars)("镜像字符串常量 %s 与 SSOT 逐字一致", (name, value) => {
    expect(source).toMatch(new RegExp(`${name}\\s*=\\s*["']${value}["']`));
  });

  it("镜像协议版本 RELAY_PROTOCOL_VERSION 与 SSOT 一致", () => {
    expect(source).toMatch(new RegExp(`RELAY_PROTOCOL_VERSION\\s*=\\s*${RELAY_PROTOCOL_VERSION}\\b`));
  });

  it("镜像退出码 RELAY_EXIT_CODES 四值与 SSOT 一致", () => {
    const pairs: Array<[keyof typeof RELAY_EXIT_CODES, number]> = [
      ["VERSION_MISMATCH", RELAY_EXIT_CODES.VERSION_MISMATCH],
      ["SOCKET_UNREACHABLE", RELAY_EXIT_CODES.SOCKET_UNREACHABLE],
      ["SOCKET_CLOSED", RELAY_EXIT_CODES.SOCKET_CLOSED],
      ["MISSING_IDENTITY", RELAY_EXIT_CODES.MISSING_IDENTITY],
    ];
    for (const [key, value] of pairs) {
      expect(source).toMatch(new RegExp(`${key}:\\s*${value}\\b`));
    }
  });

  it("镜像面不自作主张扩充：NODE/SCRIPT 不在镜像表（代理零消费，见 relay.mjs 头注）", () => {
    // 若未来有人在 relay.mjs 加镜像而忘记消费，契约面应当显式扩表——此处断言现状
    // 「镜像常量恰好是代理实际消费的三个 env 名」防镜像面无界生长。
    expect(source).toMatch(/const RELAY_ENV_SOCKET/);
    expect(source).not.toMatch(/const RELAY_ENV_NODE\b/);
    expect(source).not.toMatch(/const RELAY_ENV_SCRIPT\b/);
  });
});

// ── 2. 帧词表镜像一致性（relay-frames.ts SSOT ↔ relay.mjs 内嵌字面量）──
//
// relay.mjs 对帧词表是「值字面量内嵌」（kind/dir 出现在构造与比较点，非命名常量——
// 零依赖脚本保持无声明面）。断言按源内实际形态锁定每个协议点，值来自 SSOT 导出，
// 词表改值/改形态双侧不同步即此处转红（与上方 env 常量段同款纪律）。

describe("relay 变体 C-帧词表：relay.mjs 内嵌帧字面量与 relay-frames.ts SSOT 一致", () => {
  const source = fs.readFileSync(RELAY_SCRIPT_PATH, "utf8");

  it("握手帧构造：kind 与 SSOT handshake 一致", () => {
    expect(source).toMatch(new RegExp(`kind:\\s*["']${RELAY_FRAME_KINDS.handshake}["']`));
  });

  it("下行数据帧构造：kind / dir 与 SSOT data / down 一致", () => {
    expect(source).toMatch(
      new RegExp(`kind:\\s*["']${RELAY_FRAME_KINDS.data}["']`),
    );
    expect(source).toMatch(new RegExp(`dir:\\s*["']${RELAY_FRAME_DIRS.down}["']`));
  });

  it("协商应答比较：reject / accept 与 SSOT 一致", () => {
    expect(source).toMatch(
      new RegExp(`frame\\.kind\\s*===\\s*["']${RELAY_FRAME_KINDS.reject}["']`),
    );
    expect(source).toMatch(
      new RegExp(`frame\\.kind\\s*===\\s*["']${RELAY_FRAME_KINDS.accept}["']`),
    );
  });

  it("上行数据帧比较：kind data + dir up / up-stderr 与 SSOT 一致", () => {
    expect(source).toMatch(
      new RegExp(`frame\\.kind\\s*===\\s*["']${RELAY_FRAME_KINDS.data}["']`),
    );
    expect(source).toMatch(new RegExp(`frame\\.dir\\s*===\\s*["']${RELAY_FRAME_DIRS.up}["']`));
    expect(source).toMatch(
      new RegExp(`frame\\.dir\\s*===\\s*["']${RELAY_FRAME_DIRS.upStderr}["']`),
    );
  });

  it("终局帧比较：exit 与 SSOT 一致", () => {
    expect(source).toMatch(
      new RegExp(`frame\\.kind\\s*===\\s*["']${RELAY_FRAME_KINDS.exit}["']`),
    );
  });

  it("reject reason 语义键（代理对 version 退出码 10 的行为耦合）在 SSOT 词表内", () => {
    // 代理侧对 reject 只统一处理（非零退出），不逐 reason 分支——但 E-1 的
    // version→10 耦合登记在 SSOT 注释里，词表成员变更时此断言强制人工复核。
    const reasons = Object.values(RELAY_REJECT_REASONS);
    expect(reasons).toContain("version");
  });
});

// SSOT 面回归锚（原 C-通道段消费的两个常量随段废弃——保留导入面活性断言，防
// SSOT 导出被静默删除而镜像测试仍误绿）：
describe("relay 变体 SSOT 导出面：代理启动键仍在 relay-env.ts", () => {
  it("RELAY_ENV_NODE / RELAY_ENV_SCRIPT 非空（代理进程启动键）", () => {
    expect(RELAY_ENV_NODE).toBeTruthy();
    expect(RELAY_ENV_SCRIPT).toBeTruthy();
    // 代理启动键不进 relay.mjs 镜像（上方「镜像面不扩充」锁死）——两断言互证：
    // SSOT 有、镜像无 = 代理经 env 接收启动键而非内嵌，契约面自洽。
    expect(RELAY_ENV_NODE).not.toBe(RELAY_ENV_SOCKET);
    expect(RELAY_ENV_SCRIPT).not.toBe(RELAY_ENV_SOCKET);
  });
});
