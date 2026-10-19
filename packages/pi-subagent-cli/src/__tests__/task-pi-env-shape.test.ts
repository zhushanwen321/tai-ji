// src/__tests__/task-pi-env-shape.test.ts
//
// [P-15] env 矩阵形状回归（A-U-1 / C-U2 / B-U-9 去重项）：
//   - 引擎进程 env：有 control 两键 + `TAIJI_ENGINE_RAW_MIRROR`（fd3 镜像宣告）；
//   - task pi 出站 env：有 control 两键（嵌套 extension / engine_open 归属键是合法
//     读者），**无** `TAIJI_ENGINE_RAW_MIRROR`（设计 D4 矩阵 task pi 行 ❌）。
//
// 为什么必须显式剥除：引擎→task pi 的 spawn 走 SDK `buildOutboundChildEnv`（deny =
// `ENGINE_ENV_DENY_LIST`，刻意不含 raw mirror——引擎自身要读 fd 3），shared 的
// `SPAWN_ENV_OUTBOUND_DENY_LIST` 只作用于 shared builder，task pi 路径没有消费者。
// 本文件同时断言上层事实（SDK builder 单独调用会保留该键 = 剥除是承重步骤），防未来
// 「以为 deny 清单已覆盖」而删掉显式 delete。
//
// 纯函数级：显式传入 parentEnv（不读写/污染 process.env，不触发真实 fd3 写入器）。

import { describe, expect, it } from "vitest";

import {
  buildEngineChildEnv,
  buildOutboundChildEnv,
  CONTROL_ENV_ROOT_SESSION_ID,
  CONTROL_ENV_SOCKET,
  SUBAGENT_IDENTITY_ENV,
} from "@zhushanwen/subagent-engine-sdk";

import { isRawMirrorActive, RAW_MIRROR_ENV_VAR } from "../raw-mirror.ts";
import { buildChildEnv, type SpawnRunParams } from "../spawn-runner.ts";

const CONTROL_SOCKET = "/tmp/taiji-control.sock";
const ROOT_SESSION_ID = "sess-root-1";

/** 引擎进程 launch env 的形状（runtime buildEngineLaunchEnv 的等价两步：SDK 三层 +
 * 显式 L0 注入；raw mirror 在 buildEngineChildEnv 之后注入是设计 D6 的规定）。 */
function engineLaunchEnvShape(): Record<string, string> {
  const env = buildEngineChildEnv(
    {
      PATH: "/usr/bin",
      [CONTROL_ENV_SOCKET]: CONTROL_SOCKET,
      [CONTROL_ENV_ROOT_SESSION_ID]: ROOT_SESSION_ID,
    },
    { dataDir: "/tmp/engine-data" },
  );
  env[RAW_MIRROR_ENV_VAR] = "1";
  return env;
}

function baseParams(overrides: Partial<SpawnRunParams> = {}): SpawnRunParams {
  return {
    recordId: "sa-task-pi",
    task: "do the thing",
    agentName: "impl-worker",
    model: "prov/model-1",
    sessionDir: "/tmp/sessions",
    cwd: "/repo/worktree",
    ...overrides,
  };
}

describe("[P-15] task pi env 形状（raw mirror 只给引擎）", () => {
  it("引擎 env 有 raw mirror 宣告（引擎是唯一合法读取方）", () => {
    const engineEnv = engineLaunchEnvShape();
    expect(engineEnv[RAW_MIRROR_ENV_VAR]).toBe("1");
    expect(isRawMirrorActive(engineEnv)).toBe(true);
  });

  it("task pi（顶层）从引擎 env 出站：无 raw mirror、有 control 两键", () => {
    const engineEnv = engineLaunchEnvShape();
    const taskEnv = buildChildEnv(baseParams(), engineEnv);

    expect(taskEnv[RAW_MIRROR_ENV_VAR]).toBeUndefined();
    expect(isRawMirrorActive(taskEnv)).toBe(false);
    // 设计 D4：control 两键供 task pi 内的嵌套 extension 读取（不剥）
    expect(taskEnv[CONTROL_ENV_SOCKET]).toBe(CONTROL_SOCKET);
    expect(taskEnv[CONTROL_ENV_ROOT_SESSION_ID]).toBe(ROOT_SESSION_ID);
  });

  it("嵌套 task pi（父为引擎 spawn 的 task pi）：同样剥除，身份链继续贯穿", () => {
    const engineEnv = engineLaunchEnvShape();
    const parentTaskEnv = buildChildEnv(baseParams(), engineEnv);
    // 模拟嵌套：父 task pi 作为下一跳的 parentEnv（深度已由身份写回置 1）
    const nestedEnv = buildChildEnv(baseParams({ recordId: "sa-nested" }), parentTaskEnv);

    expect(nestedEnv[RAW_MIRROR_ENV_VAR]).toBeUndefined();
    expect(nestedEnv[CONTROL_ENV_SOCKET]).toBe(CONTROL_SOCKET);
    expect(nestedEnv[SUBAGENT_IDENTITY_ENV.selfRecordId]).toBe("sa-nested");
    expect(nestedEnv[SUBAGENT_IDENTITY_ENV.depth]).toBe("2");
  });

  it("承重性：SDK buildOutboundChildEnv 单独调用会保留 raw mirror（deny 清单不含该键）", () => {
    // 这条断言锁定「显式 delete 不可删」的事实前提：若未来 SDK deny 加键或 runtime
    // 改写注入方式，本用例翻转会提示同批核对设计 D4/D6 与这里的三方契约。
    const inherited = buildOutboundChildEnv({ parentEnv: engineLaunchEnvShape() });
    expect(inherited[RAW_MIRROR_ENV_VAR]).toBe("1");
  });
});
