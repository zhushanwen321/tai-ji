// src/execution/__tests__/helpers/pi-mock.ts
//
// SubagentService 族测试共享的 makePi 三键 stub（质量审查 C-2 测试脚手架重复收敛批）：
// 存量 26 个测试文件逐字重复 `function makePi()` 同构体（appendEntry / events.emit /
// sendMessage 三键 vi.fn），收敛到本 module 单源——桩形变更此文件，消费方同步生效。
//
// 迁移策略：存量 26 文件按触改批迁移（改动到哪个文件顺手换，不一次全量改）；
// **新测试强制走本 helper**，禁止再内联本地 makePi。
//
// PiMock 结构上可赋给 subagent-service 的 PiLike（三必填键匹配；PiLike.on? 可选键未提供
// 时 notifier 走内核退避路径）——历史文件内联版的 `as unknown as PiLike` 强转随收敛去除。
// 需要断言 .mock.calls / mockClear 的文件直接以 PiMock 为变量类型（vi.fn 精确类型保留）。

import { vi, type Mock } from "vitest";
import type { PiLike } from "../../notify/notify-host.ts";

/**
 * makePi 产物的精确 mock 类型（断言面：appendEntry.mock.calls / sendMessage.mock 等）。
 * 成员签名取自 PiLike 对应方法——Mock<具体签名> 结构上可赋给 PiLike（历史内联版
 * `ReturnType<typeof vi.fn>` 是 Procedure|Constructable 宽联合，才被迫 `as unknown as` 强转）。
 */
export interface PiMock {
  appendEntry: Mock<PiLike["appendEntry"]>;
  events: { emit: Mock<PiLike["events"]["emit"]> };
  sendMessage: Mock<PiLike["sendMessage"]>;
}

/** PiLike 最小三键 stub（运行时注入对象，非模块 mock——直接 import 调用，无 vi.mock 注册）。 */
export function makePi(): PiMock {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}
