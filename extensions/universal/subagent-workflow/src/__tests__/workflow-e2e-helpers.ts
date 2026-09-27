/**
 * workflow e2e 共享测试基建——workflows-e2e.test.ts 与 review-fix-loop-e2e.test.ts
 * 两文件逐字重复段的单点收敛（行为零变化抽取）。
 *
 * 覆盖：MOCK_USAGE / JsonSchema 类型 / WORKFLOWS_DIR + wf() / extractMeta /
 * loadWorkflowsFromDir / makeRegistry / makeDeps。
 *
 * sessionDir 与 store 登记册由测试文件自持生命周期（beforeEach mkdtemp / afterEach
 * rmSync），仅经 bindRunStore 把本轮值借给 makeDeps——helpers 不拥有临时目录。
 * registry 绕过说明（原两文件同款注释）：WorkflowScriptRegistryImpl 的扫描源是固定
 * 约定目录，无法指向任意路径；这里直接读 .js 文件 + 手动构造 WorkflowScript 包装为
 * 满足 WorkflowScriptRegistry 接口的自定义 registry。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonlRunStore } from "../jsonl-run-store.ts";
import { parseResourceMeta, type LauncherDeps } from "@zhushanwen/subagent-core";
import { normalizeRef } from "@zhushanwen/subagent-core/shared/agent-ref.ts";
import type { LifecycleDeps } from "@zhushanwen/subagent-core";
import type { AgentRunner } from "@zhushanwen/subagent-core/orchestration/models/ports.ts";
import type { AgentUsage } from "@zhushanwen/subagent-core/orchestration/models/types.ts";
import {
  type WorkflowMeta,
  WorkflowScript,
  type WorkflowSource,
} from "@zhushanwen/subagent-core/orchestration/models/workflow-script.ts";
import type { WorkflowScriptRegistry } from "@zhushanwen/subagent-core";
import { WorkerHostImpl } from "@zhushanwen/subagent-core";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 路径：定位真实 workflows 目录 ─────────────────────────────────────────
// 本文件在 src/__tests__/，workflows 目录经包内 node_modules 指向 subagent-core 包
// 即 __dirname → ..  (src) → ..  (subagent-workflow 包根) → node_modules/@zhushanwen/subagent-core/workflows
export const WORKFLOWS_DIR = join(__dirname, "..", "..", "node_modules", "@zhushanwen", "subagent-core", "workflows");
// S2：workflowRef/agentRef = 绝对路径（注入段 <location> 同源）
export const wf = (name: string): string => join(WORKFLOWS_DIR, name + ".js");

// ── 通用 mock usage（AgentResult.usage 可选，给一个固定值便于排查） ──────
export const MOCK_USAGE: AgentUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 15,
  turns: 1,
};

// ── 根据 JSON schema 递归描述（generateFromSchema / miniValidator 共用形状） ──
export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  required?: string[];
};

// ── 本轮 session 目录 / store 登记册（bindRunStore 借入，测试文件自持生命周期） ──
let storeSessionDir = "";
let stores: JsonlRunStore[] = [];

/** 绑定本轮 session 目录与 store 登记册（测试文件 beforeEach 调用，afterEach 自清）。 */
export function bindRunStore(sessionDir: string, createdStores: JsonlRunStore[]): void {
  storeSessionDir = sessionDir;
  stores = createdStores;
}

/**
 * 从源码用 regex 提取 meta（与 config-loader 同语义，避免执行用户代码）。
 * m2 exec-review MINOR-1：改调 IF1 parseResourceMeta（与
 * builtin-workflows-structure.test 一致）。失败时回落到 name=文件名 stem 的空 meta。
 */
function extractMeta(source: string, fallbackName: string): WorkflowMeta {
  const meta = parseResourceMeta(source, "workflow");
  if (meta && meta.kind === "workflow") return meta;
  return { kind: "workflow", name: fallbackName, description: "", phases: [] };
}

/**
 * 从目录扫描 .js 文件，构造 WorkflowScript 实体 map（按 meta.name 索引）。
 *
 * 不依赖 WorkflowScriptRegistryImpl（其扫描源是固定约定目录，无法指向任意路径）。
 * 直接读文件 + 构造 WorkflowScript（其 validate/toExecutable 是纯函数，可直接用）。
 */
export function loadWorkflowsFromDir(dir: string): Map<string, WorkflowScript> {
  const scripts = new Map<string, WorkflowScript>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    const fullPath = join(dir, file);
    const sourceCode = readFileSync(fullPath, "utf-8");
    const stem = file.replace(/\.js$/, "");
    const meta = extractMeta(sourceCode, stem);
    const source: WorkflowSource = "saved";
    scripts.set(
      meta.name,
      new WorkflowScript({
        name: meta.name,
        source,
        path: fullPath,
        sourceCode,
        meta,
        available: true,
      }),
    );
  }
  return scripts;
}

/**
 * 包装 scripts map 为 WorkflowScriptRegistry 接口实现。
 *
 * get(name) 返回对应 WorkflowScript（undefined 当不存在）；
 * loadAll() 返回全部；invalidate() no-op（内存 map 无缓存概念）。
 */
export function makeRegistry(scripts: Map<string, WorkflowScript>): WorkflowScriptRegistry {
  return {
    get: async (name: string) => scripts.get(name),
    // S2：按路径加载（任意路径 .js，不限扫描目录）——路径未预扫则直接读文件
    getPath: async (ref: string) => {
      const normalized = normalizeRef(ref, ".js");
      if (normalized === null) return undefined;
      for (const script of scripts.values()) {
        if (script.path === normalized) return script;
      }
      try {
        const sourceCode = readFileSync(normalized, "utf-8");
        const stem = basename(normalized, ".js");
        const meta = extractMeta(sourceCode, stem);
        return new WorkflowScript({
          name: meta.name,
          source: "saved",
          path: normalized,
          sourceCode,
          meta,
          available: true,
        });
      } catch {
        return undefined;
      }
    },
    loadAll: async () => Array.from(scripts.values()),
    invalidate: () => {},
  };
}

// ── 构造完整 LauncherDeps（真实 WorkerHost + 真实 RunStore + 调用方 runner） ──

/** 构造 LauncherDeps；runner 由调用方提供（mock 形态各文件自持）。 */
export function makeDeps(runner: AgentRunner): LauncherDeps {
  const scripts = loadWorkflowsFromDir(WORKFLOWS_DIR);
  const registry = makeRegistry(scripts);
  const store = new JsonlRunStore({ sessionDir: storeSessionDir });
  stores.push(store);
  const base: LifecycleDeps = {
    store,
    workerHost: new WorkerHostImpl(),
    runner,
    runs: new Map(),
  };
  return { ...base, registry };
}
