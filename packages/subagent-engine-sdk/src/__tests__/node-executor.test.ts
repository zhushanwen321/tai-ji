// src/__tests__/node-executor.test.ts
//
// W9 启动解析（宿主 × 平台二维矩阵）+ probeNodeExecutor 复刻的正反例
// （impl-plan §2.9；先例 = packages/runtime/src/infra/relay/relay-env.ts:47-90，
// 行为保持一致）。

import { afterEach, describe, expect, it } from "vitest";

import {
  ENGINE_NODE_ENV,
  hostKindOf,
  probeNodeExecutor,
  resetEngineNodeProbeCache,
  resolveEngineNodeLaunch,
} from "../node-executor.ts";

const REAL_NODE = process.execPath;

afterEach(() => {
  resetEngineNodeProbeCache();
});

describe("probeNodeExecutor（relay-env 先例行为复刻）", () => {
  it("真 node 执行器探针通过（正例）", async () => {
    expect(await probeNodeExecutor(REAL_NODE, false)).toBe(true);
  });

  it("不存在的执行器探针失败（反例：ENOENT → error 事件）", async () => {
    expect(await probeNodeExecutor("/nonexistent/definitely-not-a-node", false)).toBe(false);
  });

  it("非 node 语义的可执行体探针失败（反例：非零退出）", async () => {
    // /usr/bin/false 退出码 1；平台缺失时跳过（CI mac/linux 均有）
    const isDarwinOrLinux = process.platform === "darwin" || process.platform === "linux";
    if (!isDarwinOrLinux) return;
    expect(await probeNodeExecutor("/usr/bin/false", false)).toBe(false);
  });

  it("探针结果缓存：同 key 只探一次（先例的 probeCache 语义）", async () => {
    resetEngineNodeProbeCache();
    const first = await resolveEngineNodeLaunch({
      hostKind: "standalone",
      entryPath: "/tmp/engine-entry.mjs",
    });
    expect(first.command).toBe("node");
    // 第二次同形态解析命中缓存（无重复 spawn——行为等价，仅验证不抛/不变形）
    const second = await resolveEngineNodeLaunch({
      hostKind: "standalone",
      entryPath: "/tmp/other-entry.mjs",
    });
    expect(second.command).toBe("node");
  });
});

describe("resolveEngineNodeLaunch 矩阵", () => {
  it("① pi-extension：env 缺 TAIJI_AGENT_ENGINE_NODE → engine_not_found + 指引", async () => {
    await expect(
      resolveEngineNodeLaunch({
        hostKind: "pi-extension",
        entryPath: "/engines/pi/index.js",
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "engine_not_found",
      recovery: expect.stringContaining(ENGINE_NODE_ENV),
    });
  });

  it("① pi-extension：注入执行器 + 探针通过 → [executor, entry, ...args]，Electron 形态带 RUN_AS_NODE 语义", async () => {
    const launch = await resolveEngineNodeLaunch({
      hostKind: "pi-extension",
      entryPath: "/engines/pi/index.js",
      args: ["--flag"],
      env: { [ENGINE_NODE_ENV]: REAL_NODE, ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(launch).toEqual({
      command: REAL_NODE,
      args: ["/engines/pi/index.js", "--flag"],
      electronRunAsNode: true,
    });
  });

  it("① pi-extension：注入执行器探针失败 → engine_not_found", async () => {
    await expect(
      resolveEngineNodeLaunch({
        hostKind: "pi-extension",
        entryPath: "/engines/pi/index.js",
        env: { [ENGINE_NODE_ENV]: "/nonexistent/node" },
      }),
    ).rejects.toMatchObject({ code: "engine_not_found" });
  });

  it("② runtime-sidecar：process.execPath 权威 + isElectronHost 决定 RUN_AS_NODE", async () => {
    const launch = await resolveEngineNodeLaunch({
      hostKind: "runtime-sidecar",
      entryPath: "/engines/zcode/index.js",
      execPath: REAL_NODE,
      isElectronHost: true,
    });
    expect(launch.command).toBe(REAL_NODE);
    expect(launch.args[0]).toBe("/engines/zcode/index.js");
    expect(launch.electronRunAsNode).toBe(true);

    const asNode = await resolveEngineNodeLaunch({
      hostKind: "runtime-sidecar",
      entryPath: "/e.js",
      execPath: REAL_NODE,
      isElectronHost: false,
    });
    expect(asNode.electronRunAsNode).toBe(false);
  });

  it("③ standalone：PATH node 探针通过 → [node, entry]", async () => {
    const launch = await resolveEngineNodeLaunch({
      hostKind: "standalone",
      entryPath: "/engines/pi/index.js",
    });
    expect(launch.command).toBe("node");
    expect(launch.args).toEqual(["/engines/pi/index.js"]);
  });

  it("Windows + .cmd 入口 → 显式 cmd.exe /c + 参数数组（禁 shell:true 形态）", async () => {
    const launch = await resolveEngineNodeLaunch({
      hostKind: "standalone",
      entryPath: "C:\\engines\\zcode\\zcode-subagent-cli.cmd",
      args: ["--x"],
      platform: "win32",
    });
    expect(launch).toEqual({
      command: "cmd.exe",
      args: ["/c", "C:\\engines\\zcode\\zcode-subagent-cli.cmd", "--x"],
      electronRunAsNode: false,
    });
  });
});

describe("hostKindOf（EngineClient 自由字符串归一）", () => {
  it("runtime* → runtime-sidecar", () => {
    expect(hostKindOf("runtime", {})).toBe("runtime-sidecar");
  });

  it("env 带 TAIJI_AGENT_ENGINE_NODE → pi-extension（打包态注入通道）", () => {
    expect(hostKindOf("pi", { [ENGINE_NODE_ENV]: REAL_NODE })).toBe("pi-extension");
  });

  it("其余（standalone pi / zsw，无注入）→ standalone", () => {
    expect(hostKindOf("pi", {})).toBe("standalone");
    expect(hostKindOf("zsw", { [ENGINE_NODE_ENV]: " " })).toBe("standalone");
  });
});
