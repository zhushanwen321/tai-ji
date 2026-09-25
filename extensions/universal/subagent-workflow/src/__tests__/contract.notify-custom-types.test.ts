// contract.notify-custom-types.test.ts —— notify 通道 customType 词表 conformance 锁
// （第五轮审查 Worth 项：customType 双侧裸字面、零跨侧锚定，commit 21578c74f 手工
// 同步在案——收 extension-protocol 单源后的防回潮锁）。
//
// 锁两面（参照 contract.relay.test.ts 的镜像锁形态——值无法经 import 对齐的写点
// （历史 JSONL entry、消费方字面量）用「值锚定 + 源码形态断言」钉住）：
//   1. 值锚定：三个 customType 的值是跨侧公开契约（已落盘 session JSONL 的历史 entry
//      + shared/runtime/core 消费方逐字节依赖）——改值 = 跨侧破坏性变更，必须先红
//      本测试（有意识动作），不允许顺手改 SSOT 值静默漂移。
//   2. 源码形态锁：生产写点不得本地重定义/裸写字面量（回潮 = 新的裸字面量漂移面）。
//      生产侧写点 = 壳三处（workflow-notify 收口通知 / index messageRenderer 注册 /
//      subagents 定向留痕）+ subagent-core notify-ledger（notifier 送达 + 放弃分诊）。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SUBAGENT_BG_NOTIFY_CUSTOM_TYPE,
  SUBAGENT_DIRECTIVE_CUSTOM_TYPE,
  WORKFLOW_RESULT_CUSTOM_TYPE,
} from "@zhushanwen/extension-protocol";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 壳 src/ 上溯四级 = workspace root（src → subagent-workflow → universal → extensions → root）
const REPO_ROOT = path.resolve(SRC_ROOT, "../../../..");

/** 被锁的生产写点源文件（壳三处 + subagent-core notify 域）。 */
const PRODUCER_FILES = {
  workflowNotify: path.join(SRC_ROOT, "workflow-notify.ts"),
  index: path.join(SRC_ROOT, "index.ts"),
  subagents: path.join(SRC_ROOT, "interface/subagents.ts"),
  notifyLedger: path.join(
    REPO_ROOT,
    "packages/subagent-core/src/execution/notify/notify-ledger.ts",
  ),
} as const;

function readSource(file: string): string {
  return fs.readFileSync(file, "utf8");
}

// ── 1. 值锚定：SSOT 值逐字节锁定（跨侧公开契约） ──────────────────────────────

describe("notify customType 词表：值锚定（extension-protocol SSOT）", () => {
  it("WORKFLOW_RESULT_CUSTOM_TYPE === 'workflow-result'（runtime W18 失效信号 + display 覆写集合按它判型）", () => {
    expect(WORKFLOW_RESULT_CUSTOM_TYPE).toBe("workflow-result");
  });

  it("SUBAGENT_BG_NOTIFY_CUSTOM_TYPE === 'subagent-bg-notify'（messageRenderer 注册 + notifier 送达 + legacy 扫描按它判型）", () => {
    expect(SUBAGENT_BG_NOTIFY_CUSTOM_TYPE).toBe("subagent-bg-notify");
  });

  it("SUBAGENT_DIRECTIVE_CUSTOM_TYPE === 'subagent-directive'（定向留痕 entry + renderer 定向气泡按它判型）", () => {
    expect(SUBAGENT_DIRECTIVE_CUSTOM_TYPE).toBe("subagent-directive");
  });
});

// ── 2. 生产写点形态锁：不得本地重定义/裸写字面量（镜像回潮即红） ────────────────

describe("notify customType 词表：生产写点单源形态（防裸字面量回潮）", () => {
  it("壳 workflow-notify.ts 不本地定义 WORKFLOW_RESULT_CUSTOM_TYPE（经 import 单源消费）", () => {
    expect(readSource(PRODUCER_FILES.workflowNotify)).not.toMatch(
      /const\s+WORKFLOW_RESULT_CUSTOM_TYPE\s*=/,
    );
  });

  it("壳 interface/subagents.ts 不本地定义 SUBAGENT_DIRECTIVE_CUSTOM_TYPE（经 import 单源消费）", () => {
    expect(readSource(PRODUCER_FILES.subagents)).not.toMatch(
      /const\s+SUBAGENT_DIRECTIVE_CUSTOM_TYPE\s*=/,
    );
  });

  it("壳 index.ts 的 messageRenderer 注册经 SSOT 常量：import 常量 + registerMessageRenderer(常量)", () => {
    const source = readSource(PRODUCER_FILES.index);
    expect(source).toMatch(/import\s*\{[^}]*SUBAGENT_BG_NOTIFY_CUSTOM_TYPE[^}]*\}\s*from\s*["@/]/);
    expect(source).toMatch(/registerMessageRenderer\(\s*SUBAGENT_BG_NOTIFY_CUSTOM_TYPE\s*,/);
    // 裸字面量注册回潮即红（注释/文档提及不在本断言面——只锁注册调用形态）
    expect(source).not.toMatch(/registerMessageRenderer\(\s*["']/);
  });

  it("subagent-core notify-ledger.ts：NOTIFY_CUSTOM_TYPE 为 SSOT 别名（非字面量赋值），workflow-result 分诊经常量比较", () => {
    const source = readSource(PRODUCER_FILES.notifyLedger);
    // NOTIFY_CUSTOM_TYPE 必须存在（兼容别名导出面），但不得字面量赋值
    expect(source).toMatch(/export const NOTIFY_CUSTOM_TYPE\s*=\s*SUBAGENT_BG_NOTIFY_CUSTOM_TYPE/);
    expect(source).not.toMatch(/NOTIFY_CUSTOM_TYPE\s*=\s*["']/);
    // 放弃分诊的通道判型（item.deliveryCustomType 比较）不得裸写 customType 值字面量
    // （typeof x === "string" 形态的类型守卫不在本断言面——词表判型点都带 item. 前缀）
    expect(source).not.toMatch(/item\.deliveryCustomType\s*(?:===|!==)\s*["']/);
  });
});
