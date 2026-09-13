// src/execution/__tests__/agents-assembly.test.ts
//
// discoverAgents 装配函数测试（sink 设计 U2 / A6 / u-core-agent 验收②）。
//
// 等值对照口径：fixture 目录下，discoverAgents 产出与 pi 壳现装配循环
// （subagent-list-injector.discoverAllAgents）产出「同序同名同字段」。
// pi 壳装配循环无法直接 import 进 core 测试（core 对 pi-coding-agent /
// pi-extension-logger 零运行时触点——vitest.config 头注红线），故 oracle 在
// 测试内按 pi 循环逐句同构复刻，但全部消费 core 既有原语
// （discoverResources + parseResourceMeta 严格层 + sortByCodepoint）——
// 这正是 pi 循环消费的同一批 core 原语（pi 的 parseAgentFrontmatter 内部即
// parseResourceMeta(content, "agent") 投影）。oracle 与被测实现走不同解析路径
// （严格层 vs parseAgentProfile 宽容层），非自证。
//
// fixture 含全部清单可见性分支：正常条目（多形态）、同名遮蔽（hostRoots
// last-writer-wins）、无 frontmatter（README，两边都不进清单）、IF1 失败
// （缺 description，两边都不进清单）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureCore, resetCoreForTests } from "../../core/host-services.ts";
import type { AgentEntry } from "../../shared/injection-render.ts";
import { sortByCodepoint } from "../../shared/injection-render.ts";
import { parseResourceMeta } from "../../shared/meta-parser.ts";
import {
  clearFileCache,
  discoverResources,
  getCachedFileContent,
  type ScanConfig,
} from "../../shared/resource-discovery.ts";
import type { DiscoveryRoot } from "../../core/host-services.ts";
import { discoverAgents } from "../assembly/agents-assembly.ts";

// ── oracle：pi 壳 discoverAllAgents 装配循环的逐句同构（消费同一批 core 原语）──

async function piAssemblyOracle(
  workspaceRoot: string,
  hostRoots: DiscoveryRoot[],
): Promise<AgentEntry[]> {
  const config: ScanConfig = { kind: "agents", workspaceRoot, hostRoots };
  const resources = await discoverResources(config);

  const agentMap = new Map<string, AgentEntry>();
  for (const resource of resources) {
    if (!resource.available) continue;
    const content = getCachedFileContent(resource.path);
    if (content === null) continue; // pi: catch → logger.error → skip
    // pi parseAgentFrontmatter 的投影面（parseResourceMeta 严格层）
    const meta = parseResourceMeta(content, "agent");
    if (meta && meta.kind === "agent") {
      agentMap.set(meta.name, {
        name: meta.name,
        description: meta.description,
        when: meta.when,
        examples: meta.examples,
        path: resource.path,
      });
    } else if (content.trimStart().startsWith("---")) {
      // pi: startsWithFrontmatter → logger.warn（清单可见性口径：无 frontmatter 不 warn）
    }
  }
  return sortByCodepoint([...agentMap.values()], (a) => a.name);
}

// ── fixture ──────────────────────────────────────────────────

function writeAgent(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

describe("discoverAgents", () => {
  let outerDir: string;
  let workspaceRoot: string;
  let hostRoot: string;
  let logCalls: Array<{ level: string; component: string; message: string; data?: unknown }>;

  beforeEach(() => {
    outerDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-assembly-"));
    workspaceRoot = path.join(outerDir, "ws");
    hostRoot = path.join(outerDir, "host", "agents");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    logCalls = [];
    configureCore({
      dataRoot: () => outerDir,
      log: (level, component, message, data) => {
        logCalls.push({ level, component, message, data });
      },
    });
  });

  afterEach(() => {
    resetCoreForTests();
    clearFileCache();
    fs.rmSync(outerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("与 pi 壳现装配循环产出等值（同序同名同字段）——多形态 fixture 对照", async () => {
    // project-pi 源（workspaceRoot/.pi/agents）
    writeAgent(
      workspaceRoot,
      ".pi/agents/alpha.md",
      `---
name: alpha
description: single-line agent
model: provider/model-a
---
alpha body`,
    );
    // block-scalar description + 多行 - item（zsw mini parser 全形态）
    writeAgent(
      workspaceRoot,
      ".pi/agents/beta.md",
      `---
name: beta
description: |
  beta line one
  beta line two
tools:
  - read
  - bash
---
beta body`,
    );
    // 无 frontmatter（两边都不进清单、都不 warn）
    writeAgent(workspaceRoot, ".pi/agents/README.md", "# docs\n");
    // IF1 失败（缺 description，两边都不进清单、都 warn）
    writeAgent(
      workspaceRoot,
      ".pi/agents/broken.md",
      `---
name: broken
model: provider/x
---
broken body`,
    );
    // hostRoots 注入源（序位高于 project-pi）——同名遮蔽 alpha + 新增 gamma
    writeAgent(
      hostRoot,
      "alpha.md",
      `---
name: alpha
description: host shadowing version
---
host alpha body`,
    );
    writeAgent(
      hostRoot,
      "gamma.md",
      `---
name: gamma
description: inline array agent
tools: [read, grep]
maxTurns: 2
---
gamma body`,
    );

    const hostRoots: DiscoveryRoot[] = [{ dir: hostRoot, source: "project-host" }];
    const [actual, oracle] = await Promise.all([
      discoverAgents(workspaceRoot, hostRoots),
      piAssemblyOracle(workspaceRoot, hostRoots),
    ]);

    // 同序同名同字段（逐条目投影对比，path 为绝对路径逐字节一致）
    expect(actual).toEqual(oracle);
    // 码点序：alpha < beta < gamma
    expect(actual.map((a) => a.name)).toEqual(["alpha", "beta", "gamma"]);
    // 同名遮蔽：alpha = hostRoots 胜出版（path + description 都是注入根的）
    const alpha = actual.find((a) => a.name === "alpha");
    expect(alpha?.path).toBe(path.join(hostRoot, "alpha.md"));
    expect(alpha?.description).toBe("host shadowing version");
    // 无 frontmatter / IF1 失败不进清单
    expect(actual.some((a) => a.path.endsWith("README.md"))).toBe(false);
    expect(actual.some((a) => a.path.endsWith("broken.md"))).toBe(false);
  });

  it("hostRoots 为空时仍扫硬编码槽（project .pi/agents），等值口径不破", async () => {
    writeAgent(
      workspaceRoot,
      ".pi/agents/solo.md",
      "---\nname: solo\ndescription: only one\n---\nbody",
    );
    const [actual, oracle] = await Promise.all([
      discoverAgents(workspaceRoot, []),
      piAssemblyOracle(workspaceRoot, []),
    ]);
    expect(actual).toEqual(oracle);
    expect(actual.map((a) => a.name)).toEqual(["solo"]);
  });

  it("IF1 失败（有 frontmatter）→ warn 口径内聚：仅该类文件 warn，README 不 warn", async () => {
    writeAgent(
      workspaceRoot,
      ".pi/agents/broken.md",
      "---\nname: broken\nmodel: provider/x\n---\nbody",
    );
    writeAgent(workspaceRoot, ".pi/agents/README.md", "# plain doc\n");

    const actual = await discoverAgents(workspaceRoot, []);
    expect(actual).toEqual([]);

    const warns = logCalls.filter((c) => c.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("broken.md");
    expect(warns[0]!.message).toContain("IF1 校验不通过");
  });

  it("空目录 / 不存在的 workspaceRoot：空清单不抛", async () => {
    const actual = await discoverAgents(path.join(outerDir, "nonexistent"), []);
    expect(actual).toEqual([]);
  });
});
