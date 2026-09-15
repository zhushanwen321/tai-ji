/**
 * Workflow Config Loader — 统一资源发现版（ADR-031）
 *
 * 扫描逻辑委托给 shared/resource-discovery（与 agent 发现共享同一套扫描源）。
 * 本文件只保留 workflow 专属的 meta 提取（经 shared/meta-parser.ts IF1 统一 parser）+ 60s TTL 缓存。
 *
 * m2 收敛：删 extractMetaViaRegex + safeEvalObject(new Function)，改调 parseResourceMeta
 * （真实 YAML 解析 @pi-meta 块注释，发现期不执行作者代码，v5 原则 6 no-eval）。
 * toCachedMeta 整对象透传（...meta），不再 {name,description,phases} 解构——消灭第 1 处重映射。
 *
 * Failed imports are marked available=false — the loader never throws.
 */


import { resolve } from "node:path";

// WorkflowMeta 规范来源是 shared/resource-meta.ts（m1 DM1）；WorkflowSource 来自 workflow-script
import type { WorkflowSource } from "./models/workflow-script.ts";
import { clearLintMemo } from "./models/workflow-script.ts";
import type { WorkflowMeta } from "../shared/resource-meta.ts";
import { getCachedFile, getCachedFileContent, clearFileCache } from "../shared/resource-discovery.ts";
import { parseResourceMeta } from "../shared/meta-parser.ts";
import { normalizeRef, WORKFLOW_REF_EXT } from "../shared/agent-ref.ts";
export type { WorkflowMeta, WorkflowSource };

import { getHostServices } from "../core/host-services.ts";
import { getLogger } from "../core/logger.ts";

const logger = getLogger("config-loader");

import {
  discoverResources,
  findWorkspaceRoot,
  type ResourceSource,
  type ScanConfig,
} from "../shared/resource-discovery.ts";

// ── Public types ──────────────────────────────────────────────

export interface CachedWorkflowMeta extends WorkflowMeta {
  /** Absolute path to the script file */
  path: string;
  /** false when the script failed to load or has no valid meta export */
  available: boolean;
  /** Whether this is a saved (fixed) or temporary (ad-hoc) workflow */
  source: WorkflowSource;
}

// ── Internal types ────────────────────────────────────────────

interface CacheEntry {
  meta: CachedWorkflowMeta;
  /** 文件 mtime（m5：mtime 键控判失效——删 60s TTL，mtime 未变即命中）。 */
  mtimeMs: number;
}

// ── Constants ─────────────────────────────────────────────────

// m5：删 60s TTL——mtime 键控判失效（TTL 只服务 getWorkflow 且造成 60s 陈旧窗口）。

// ── Cache ─────────────────────────────────────────────────────

// Keyed by workspace root so that switching projects does not serve stale entries.
const cache = new Map<string, Map<string, CacheEntry>>();

function getCacheBucket(workspaceRoot: string): Map<string, CacheEntry> {
  let bucket = cache.get(workspaceRoot);
  if (!bucket) {
    bucket = new Map<string, CacheEntry>();
    cache.set(workspaceRoot, bucket);
  }
  return bucket;
}

function isCacheValid(entry: CacheEntry): boolean {
  // m5：mtime 判变——文件 mtime 未变即命中（删 TTL 后文件变更立即反映）
  const file = getCachedFile(entry.meta.path);
  return file !== null && file.mtimeMs === entry.mtimeMs;
}

// ── Helpers ───────────────────────────────────────────────────

/** Extract filename stem (no directory, no extension). */
function stem(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// ── ResourceSource → WorkflowSource 映射 ─────────────────────

/** 统一模块的 ResourceSource 映射为 workflow 的 saved/tmp 语义 */
function toWorkflowSource(source: ResourceSource): WorkflowSource {
  return source === "project-pi-tmp" ? "tmp" : "saved";
}

/**
 * 按路径推导 ResourceSource（IF4/外部 #5 残留）。
 *
 * getWorkflowByPath 可加载任意绝对路径（不限扫描源），此前硬编码 "user-pi"
 * 使 workspaceRoot/.pi/workflows/.tmp/ 下的临时脚本按路径加载被错标 saved
 * （discoverWorkflows 对同文件正确标 tmp，两路径不一致）。修正：路径落在
 * tmp 目录前缀内 → "project-pi-tmp"，其余 → "user-pi"（非 tmp 路径输出不变，DS4）。
 */
function deriveResourceSource(filePath: string, workspaceRoot: string): ResourceSource {
  const tmpDir = resolve(workspaceRoot, ".pi/workflows/.tmp");
  const normalized = resolve(filePath);
  return normalized === tmpDir || normalized.startsWith(`${tmpDir}/`) ? "project-pi-tmp" : "user-pi";
}

// ── 单文件 → CachedWorkflowMeta（IF1 parseResourceMeta + 整对象透传）──

/**
 * 提取单个文件的 meta（经 IF1 parseResourceMeta），失败时标 available=false（fail-safe 不抛）。
 *
 * m2：整对象透传（...meta），不再 {name,description,phases} 解构——消灭第 1 处重映射，
 * parameters/usage/when/notFor 一路流到 script.meta。仅认 @pi-meta 新格式（D1 无 adapter）。
 */
async function toCachedMeta(
  filePath: string,
  source: ResourceSource,
): Promise<CachedWorkflowMeta> {
  const fallbackName = stem(filePath);
  const wfSource = toWorkflowSource(source);
  try {
    const content = getCachedFileContent(filePath); // m5：统一 mtime 缓存层
    if (content === null) throw new Error("file not readable");
    const meta = parseResourceMeta(content, "workflow");
    if (meta && meta.kind === "workflow") {
      return { ...meta, path: filePath, available: true, source: wfSource };
    }
    // m2 exec-review MINOR-4：文件可读但 meta=null → 旧 const meta 格式或格式错误，
    // 静默 available=false（D1 无 adapter）。warn 帮助用户定位需迁移到 @pi-meta 的存量 workflow。
    logger.warn(
      `[config-loader] ${filePath}: 未解析到 @pi-meta 元数据（旧 const meta 格式需迁移）→ available=false`,
    );
  } catch (err) {
    // 读失败 → available=false（fail-safe 不抛，与原行为一致）
    logger.debug(`[config-loader] skip unreadable workflow file ${filePath}`, {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    kind: "workflow",
    name: fallbackName,
    description: "",
    phases: [],
    path: filePath,
    available: false,
    source: wfSource,
  };
}

// ── Public API ────────────────────────────────────────────────

/**
 * workflow 发现的扫描配置。每个字段显式声明一个扫描源目录。
 *
 * 生产环境用 defaultScanConfig() 构造默认值（全局 ~/.pi/agent/* 目录）。
 * 测试/隔离环境构造完整 config 指向 tmp 目录，完全不碰全局文件系统。
 */
export interface WorkflowScanConfig {
  /** 项目级脚本目录（workspaceRoot/.pi/workflows） */
  projectDir: string;
  /** user 级脚本目录（~/.pi/agent/workflows） */
  userDir: string;
  /** 临时脚本目录（workspaceRoot/.pi/workflows/.tmp） */
  tmpDir: string;
  /** npm 包扫描目录（~/.pi/agent/npm/node_modules 等） */
  npmDirs: string[];
}

/**
 * 把 WorkflowScanConfig 转为统一模块的 ScanConfig。
 *
 * 测试隔离场景下传入完整 config——此时按声明的 projectDir/tmpDir 反推
 * workspaceRoot（与原行为一致：resolve(config.projectDir, "../..")），hostRoots
 * 置空（隔离 = 不注入宿主根，仅 project 根可命中）。
 * 生产场景（省略或部分 config）走 findWorkspaceRoot(cwd) + 宿主注入 workflows 根。
 */
function toScanConfig(
  configOrCwd: Partial<WorkflowScanConfig> & { cwd?: string } | undefined,
): ScanConfig {
  // 测试隔离：传入了 projectDir，直接反推 workspaceRoot
  if (configOrCwd?.projectDir) {
    const workspaceRoot = resolve(configOrCwd.projectDir, "../..");
    return {
      kind: "workflows",
      workspaceRoot,
      hostRoots: [],
      includeTmp: true,
    };
  }

  // 生产默认（hostRoots 现取——pi 壳 discoveryRoots 每次现取 getAgentDir，实例隔离）
  const cwd = configOrCwd?.cwd;
  const workspaceRoot = findWorkspaceRoot(cwd);
  return {
    kind: "workflows",
    workspaceRoot,
    hostRoots: getHostServices().discoveryRoots?.()?.workflows ?? [],
    includeTmp: true,
  };
}

/**
 * 从指定 config 扫描所有 workflow 脚本，按 tmp>project>npm>user 优先级
 * 去重，60s TTL 缓存（按 workspaceRoot 分桶）。
 *
 * 扫描逻辑委托给 shared/resource-discovery（与 agent 发现共享同一套扫描源）。
 *
 * Never throws. 解析失败的脚本以 available=false 返回。
 *
 * @param configOrCwd 完整 WorkflowScanConfig（隔离用）、部分字段（覆盖默认）、
 *                   或省略（纯生产默认）。可选 cwd 用于推导 workspaceRoot。
 */
export async function discoverWorkflows(
  configOrCwd?: Partial<WorkflowScanConfig> & { cwd?: string },
): Promise<CachedWorkflowMeta[]> {
  const scanConfig = toScanConfig(configOrCwd);
  const workspaceRoot = scanConfig.workspaceRoot;

  // 统一发现：返回已去重的资源列表（按优先级合并）
  const resources = await discoverResources(scanConfig);

  // 提取 meta（逐文件）
  const mergedMap = new Map<string, CachedWorkflowMeta>();
  for (const resource of resources) {
    const cachedMeta = await toCachedMeta(resource.path, resource.source);
    // available=false 的不覆盖已有的 available=true（与统一模块逻辑一致）
    if (!cachedMeta.available && mergedMap.has(cachedMeta.name)) {
      continue;
    }
    mergedMap.set(cachedMeta.name, cachedMeta);
  }

  // 按 name 码点序输出（KV-cache 契约，与 injector 层一致）：不依赖发现层
  // 优先级迭代序 / readdir 枚举序，重建结果顺序稳定。
  const merged = Array.from(mergedMap.values()).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  // Update cache (scoped to current workspace root)
  const bucket = getCacheBucket(workspaceRoot);
  for (const wf of merged) {
    const file = getCachedFile(wf.path);
    bucket.set(wf.name, { meta: wf, mtimeMs: file?.mtimeMs ?? 0 });
  }

  return merged;
}

/**
 * Load and cache all available workflow scripts from project-level
 * (.pi/workflows/) and user-level (~/.pi/agent/workflows/) directories.
 *
 * discoverWorkflows() 的生产 preset——用全局默认目录。
 *
 * Never throws. Failed imports are returned with available=false.
 */
export async function loadWorkflows(): Promise<CachedWorkflowMeta[]> {
  return discoverWorkflows();
}

/**
 * Get a specific workflow by name.
 * Returns cached result if still valid, otherwise triggers a fresh load.
 */
export async function getWorkflow(name: string): Promise<CachedWorkflowMeta | undefined> {
  const workspaceRoot = findWorkspaceRoot();
  const bucket = getCacheBucket(workspaceRoot);
  const cached = bucket.get(name);
  if (cached && isCacheValid(cached)) {
    return cached.meta;
  }

  const workflows = await loadWorkflows();
  return workflows.find((wf) => wf.name === name);
}

/**
 * 按绝对路径加载单个 workflow（workflowRef 统一解析入口——S2 路径统一）。
 *
 * - ~/ 前缀展开；相对路径/非 .js 引用返回 undefined（引用唯一形态 = 绝对路径）
 * - 任意路径（不限扫描源）：内置包内脚本、用户任意位置脚本均可执行
 * - meta 提取失败/文件不可读 → available=false（fail-safe，不抛）
 * - [perf] 与 getWorkflow(name) 对称走 bucket 缓存（key=绝对路径，与 stem 名不冲突），
 *   消除 workflow tool 主路径每次 run 的全文 regex + YAML.parse（mtime 判变失效）
 */
export async function getWorkflowByPath(ref: string): Promise<CachedWorkflowMeta | undefined> {
  const filePath = normalizeRef(ref, WORKFLOW_REF_EXT);
  if (filePath === null) return undefined;
  const workspaceRoot = findWorkspaceRoot();
  const bucket = getCacheBucket(workspaceRoot);
  const cached = bucket.get(filePath);
  if (cached && isCacheValid(cached)) {
    return cached.meta;
  }
  // IF4：source 按路径推导——.tmp 前缀 → project-pi-tmp（→ "tmp"），其余 user-pi 维持现值
  const meta = await toCachedMeta(filePath, deriveResourceSource(filePath, workspaceRoot));
  const file = getCachedFile(filePath);
  if (file) bucket.set(filePath, { meta, mtimeMs: file.mtimeMs });
  return meta;
}

/**
 * Invalidate the internal meta cache.
 * The next call to loadWorkflows or getWorkflow will re-scan directories.
 */
export function invalidateCache(): void {
  // m5：清统一 mtime 缓存层 + bucket（测试隔离 + mtime 漏判场景手动刷新兜底）
  // IF9：连带清 workflow-script validate 的 lint memo（同源文件缓存，测试隔离统一走它）
  clearFileCache();
  cache.clear();
  clearLintMemo();
}
