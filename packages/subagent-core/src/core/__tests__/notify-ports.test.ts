// notify-ports.test.ts —— NotifyDomainPorts 配置态 / 缺省降级语义 / 重置隔离。
//
// 缺席语义（设计 D2 + §3.4 core_port_missing「可选端口缺席是合法形态」）：
//   - 计数器缺席 → 恒 0（零活跃，pending 门全开）——缺省内聚在端口层；
//   - 投递工厂缺席 → createDelivery 为 undefined，由消费方降级直发（后续单元接线）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureNotifyDomain,
  getNotifyDomainPorts,
  resetNotifyDomainForTests,
  type DeliveryConfig,
  type DeliveryHandle,
  type DeliveryPort,
} from "../notify-ports.ts";

beforeEach(() => {
  resetNotifyDomainForTests();
});

afterEach(() => {
  resetNotifyDomainForTests();
});

/** 形态对齐 pi 会话 JSONL 的 pending register/unregister custom entry（unknown[] 注入）。 */
function pendingEntries(): unknown[] {
  return [
    { customType: "pending:register", data: { id: "sa-1" } },
    { customType: "other:entry" },
    { customType: "pending:unregister", data: { id: "sa-1" } },
  ];
}

function makePort(): DeliveryPort {
  return {
    supportedPayloads: ["custom"],
    isIdle: () => true,
    hasPendingMessages: () => false,
    send: () => {},
  };
}

describe("getNotifyDomainPorts（未注入 → 缺省降级）", () => {
  it("计数器缺省恒 0（即便 entries 含 pending 形态内容也不消费）", () => {
    const ports = getNotifyDomainPorts();
    expect(ports.countActiveFromEntries?.([])).toBe(0);
    expect(ports.countActiveFromEntries?.(pendingEntries())).toBe(0);
  });

  it("投递工厂缺席为 undefined（消费方降级直发的判据）", () => {
    expect(getNotifyDomainPorts().createDelivery).toBeUndefined();
  });
});

describe("configureNotifyDomain", () => {
  it("注入计数器后按实现计数，entries 原样透传", () => {
    const counter = vi.fn<(entries: unknown[]) => number>((entries) => entries.length);
    configureNotifyDomain({ countActiveFromEntries: counter });

    const entries = pendingEntries();
    expect(getNotifyDomainPorts().countActiveFromEntries?.(entries)).toBe(3);
    expect(counter).toHaveBeenCalledWith(entries);
  });

  it("注入投递工厂后可调用，port/options 透传、handle 原样返回", () => {
    const port = makePort();
    const options: DeliveryConfig = { intent: "interrupt-at-turn-boundary", mergeWindowMs: 60_000 };
    const handle: DeliveryHandle = {
      send: () => {},
      flush: () => {},
      dispose: () => {},
    };
    const factory = vi.fn((receivedPort: DeliveryPort, receivedOptions?: DeliveryConfig): DeliveryHandle => {
      expect(receivedPort).toBe(port);
      expect(receivedOptions).toBe(options);
      return handle;
    });
    configureNotifyDomain({ createDelivery: factory });

    const ports = getNotifyDomainPorts();
    expect(ports.createDelivery?.(port, options)).toBe(handle);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("重复注入以后者覆盖", () => {
    const first = vi.fn<(entries: unknown[]) => number>(() => 1);
    const second = vi.fn<(entries: unknown[]) => number>(() => 2);
    configureNotifyDomain({ countActiveFromEntries: first });
    configureNotifyDomain({ countActiveFromEntries: second });

    expect(getNotifyDomainPorts().countActiveFromEntries?.([])).toBe(2);
    expect(first).not.toHaveBeenCalled();
  });

  it("resetNotifyDomainForTests 后回到缺省降级（计数 0 / 工厂缺席）", () => {
    configureNotifyDomain({ countActiveFromEntries: () => 99 });
    resetNotifyDomainForTests();

    const ports = getNotifyDomainPorts();
    expect(ports.countActiveFromEntries?.(pendingEntries())).toBe(0);
    expect(ports.createDelivery).toBeUndefined();
  });
});
