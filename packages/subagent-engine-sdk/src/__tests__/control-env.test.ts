// src/__tests__/control-env.test.ts
//
// [M3 u-foundation] control 通道 env 名 SSOT 测试：两键字面量 + transport 选择谓词
// + 键族归属（L0 在册、deny 面不含）。契约单源 = src/control-env.ts。

import { describe, expect, it } from "vitest";

import {
  CONTROL_ENV_SOCKET,
  CONTROL_ENV_ROOT_SESSION_ID,
  isControlEnvActive,
  ENGINE_ENV_DENY_LIST,
  ENGINE_ENV_L0_INFRA_KEYS,
} from "../index.ts";

describe("control env 键名 SSOT（设计 D4 env × spawn 点矩阵）", () => {
  it("两键字面量精确锁定", () => {
    expect(CONTROL_ENV_SOCKET).toBe("TAIJI_SUBAGENT_CONTROL_SOCKET");
    expect(CONTROL_ENV_ROOT_SESSION_ID).toBe("TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID");
  });

  it("键族归属：L0 基础设施键在册；刻意不进 ENGINE_ENV_DENY_LIST（引擎/嵌套 extension 是合法读者）", () => {
    expect(ENGINE_ENV_L0_INFRA_KEYS).toContain(CONTROL_ENV_SOCKET);
    expect(ENGINE_ENV_L0_INFRA_KEYS).toContain(CONTROL_ENV_ROOT_SESSION_ID);
    expect(ENGINE_ENV_DENY_LIST).not.toContain(CONTROL_ENV_SOCKET);
    expect(ENGINE_ENV_DENY_LIST).not.toContain(CONTROL_ENV_ROOT_SESSION_ID);
  });
});

describe("isControlEnvActive（D5 选择逻辑单一实现）", () => {
  it("SOCKET 非空 = 托管态（runtime transport）", () => {
    expect(isControlEnvActive({ [CONTROL_ENV_SOCKET]: "/run/subagent-1.sock" })).toBe(true);
    expect(
      isControlEnvActive({
        [CONTROL_ENV_SOCKET]: "\\\\.\\pipe\\taiji-subagent-1",
        [CONTROL_ENV_ROOT_SESSION_ID]: "root-1",
      }),
    ).toBe(true);
  });

  it("空串/缺失 = standalone（local transport）；ROOT_SESSION_ID 缺失不影响激活判定（激活只看 SOCKET）", () => {
    expect(isControlEnvActive({})).toBe(false);
    expect(isControlEnvActive({ [CONTROL_ENV_SOCKET]: "" })).toBe(false);
    expect(isControlEnvActive({ [CONTROL_ENV_SOCKET]: undefined })).toBe(false);
    expect(
      isControlEnvActive({ [CONTROL_ENV_ROOT_SESSION_ID]: "root-1" }),
    ).toBe(false);
  });
});
