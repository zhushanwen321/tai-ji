// src/shared/resource-discovery.ts
//
// 统一资源发现模块——agent .md 与 workflow .js/.mjs 共享同一套扫描逻辑。
//
// 设计原则（ADR-031 统一资源发现）：
// 1. 扫描源前缀统一：user/project 级目录用相同前缀，末级目录名（agents/workflows）参数化
// 2. 路径动态获取：宿主级根经 ScanConfig.hostRoots 注入（u0-data-discovery，D2 语义
//    边界——宿主提供根列表，扫描/遮蔽语义归 core），project 级用 findWorkspaceRoot(cwd)
// 3. npm/dev 包内发现：有 manifest（pi.agents/pi.workflows）只走 manifest，无 manifest 扫约定目录
// 4. manifest 路径存在性校验：声明的路径不存在 → 该包发现失败，不 fallback
// 5. 废弃 discovery.json：扫描路径完全由代码内推导，无外部依赖
//
// 优先级（低→高）：user .pi/agent → user .agents → npm global → npm dev → ext-paths(TAIJI_EXTENSION_PATHS/dev-link) → project .pi → project .pi/.tmp(仅workflow) → project .agents

import * as fsSync from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import type { DiscoveryRoot } from "../core/host-services.ts";
import { getLogger } from "../core/logger.ts";

// 模块级 logger（facade：configureCore 前落缺省 console，配置后透明切换宿主实现——
// pi 壳经 pi-host 桥接到宿主结构化日志 appendEntry 通路，输出面不变）
const logger = getLogger("subagents");

// [D8d] warn 路径进程内去重集合：key=(kind, stem, shadowedPath, keptPath)，
// cap 1024 超限先清空再 add（对齐 ui-request-observability 的 MAX_WARNED_SESSIONS 范式）。
// debug 路径不去重（默认 no-op，无成本）。
const shadowWarnDedup = new Set<string>();
const MAX_SHADOW_WARN_DEDUP = 1024;

/** @internal 测试辅助：重置 warn 去重集合（cap 测试用，生产代码不调用）。 */
export function __testResetShadowDedup(): void {
  shadowWarnDedup.clear();
}

/** @internal 测试辅助：向 warn 去重集合注入 key（cap 测试用）。 */
export function __testInjectShadowDedupKey(key: string): void {
  shadowWarnDedup.add(key);
}

// ── 类型 ─────────────────────────────────────────────────────

/** 资源种类：agent 或 workflow */
export type ResourceKind = "agents" | "workflows";

/** 发现到的单个资源文件（原始数据，由调用方解析 frontmatter/meta） */
export interface DiscoveredResource {
  /** 绝对路径 */
  path: string;
  /** 来源层级 */
  source: ResourceSource;
  /** 是否可用（manifest 校验失败的包整体标 false） */
  available: boolean;
  /**
   * 不可用原因（P5 D4-3 invalid 具名上报的数据通道）：available=false 时由发现层
   * 填充（如 manifest 声明路径不存在），消费方（resource-list-injector）据此渲染
   * `invalid: [{path, reason}]` 形态的上报，损坏资源不再静默跳过。available=true
   * 时恒缺席。
   */
  reason?: string;
}

/** 资源来源层级 */
export type ResourceSource =
  | "user-pi"
  | "user-agents"
  | "npm"
  | "npm-dev"
  | "user-extension-paths"
  | "project-pi"
  | "project-pi-tmp"
  | "project-agents";

/** 扫描配置 */
export interface ScanConfig {
  /** 资源种类 */
  kind: ResourceKind;
  /** 项目根目录（findWorkspaceRoot 推导结果） */
  workspaceRoot: string;
  /** 宿主注入的发现根（DiscoveryRoot.dir 已含 kind 末级目录与安装布局，
   *  source 为宿主语义标签——pi 壳 = user-pi/npm/npm-dev 三根）。buildScanTargets
   *  按标签填充对应槽位，宿主未提供某标签根时该槽位条目整体缺席。
   *  同标签多根语义（W2④）：同标签多条目依注入序全部保留、同序位依次扫描——
   *  宿主（zsw）把「目录 symlink 展开目标 + 本体根」按注入序注入同标签，core
   *  合并 last-writer-wins 下靠后者胜，本体根必须注入在展开目标之后（本体胜，
   *  红线 2）。user-agents/project-agents 硬编码槽与同标签注入合并时硬编码根
   *  自动后置（同为「本体在后」语义）。 */
  hostRoots: DiscoveryRoot[];
  /** 是否包含 tmp 源（仅 workflow 用 .pi/workflows/.tmp/） */
  includeTmp?: boolean;
}

// ── 常量 ─────────────────────────────────────────────────────

/** 机器源集合：包管理/工程配置产物，其同名重复是安装拓扑常态（非用户配置错误）。
 *  用户个人源（user-pi / user-agents）不在此列——双个人源同名重复保留 warn。 */
const MACHINE_SOURCES: ReadonlySet<ResourceSource> = new Set<ResourceSource>([
  "npm",
  "npm-dev",
  "user-extension-paths",
  "project-pi",
  "project-pi-tmp",
  "project-agents",
]);

/** 判断 source 是否属于机器源（安装拓扑常态，同名重复降 debug）。
 *  导出仅为测试穷举断言用（封闭 8 值枚举 × 分级边界）。 */
export function isMachineSource(source: ResourceSource): boolean {
  return MACHINE_SOURCES.has(source);
}

/** workspace root 向上查找的最大深度 */
const WORKSPACE_ROOT_MAX_DEPTH = 20;

// ── workspace root 推导（从 config-loader 提取，agent/workflow 共用） ──

/**
 * 判断 dir 是否是 workspaceRoot 的直接子目录（一层深度）。
 * 用于 bare+worktree 结构里识别 worktree 根。
 */
function isDirectChildOfWorkspaceRoot(dir: string, workspaceRoot: string): boolean {
  return resolve(dir, "..") === workspaceRoot;
}

/**
 * 从 cwd 向上查找 workspace root。
 *
 * bare+worktree 优先找 .bare；普通 repo 找最顶层 .git；fallback 找 .pi。
 * 与 config-loader 原有逻辑一致（合并后提取为共享函数）。
 */
// ── 统一 mtime 缓存层（m5 IF10）────────────────────────────────────
//
// 模块级 Map<path, { mtimeMs, content }>：mtime 判变缓存文件内容。
// - sync 实现（statSync/readFileSync）：getCachedFile 同步返回，供 async 发现流程
//   与 agent-registry loadByPath 在流程内同步读缓存
// - stat 失败/ENOENT → 驱逐条目（mtime 缓存下文件删除不自愈——A3 修复）
// - 已知局限（C3 记录）：内容变 mtime 未变（cp -p/rsync -t 保留源 mtime、
//   2s 粒度文件系统）→ 漏判，invalidateCache/clearFileCache 兜底；
//   APFS mtimeMs 微秒级浮点 === 判变可靠（探针 P-mtime-精度）

interface MtimeCacheEntry {
  mtimeMs: number;
  content: string;
}

const mtimeCache = new Map<string, MtimeCacheEntry>();

// [perf] findWorkspaceRoot 结果按 cwd memo——每次调用最多 3 phase × 20 层 existsSync
//（30-60 次 stat），调用点（session_start、discoverWorkflows、getWorkflow）在 spawn/
// tool 热路径上重复付。cwd 不变则祖先目录结构（.bare/.git/.pi）不变；变化场景由
// clearFileCache 兜底（invalidateCache 语义，测试隔离也走这里）。
const workspaceRootCache = new Map<string, string>();

// [perf] npm/dev 包 package.json manifest 缓存（swf-perf-impl cleanup TC1/IF1）。
// key = package.json 绝对路径；缓存 parse 后的整个 pi 对象（agents/workflows 两 kind
// 共享一次 parse，不按 kind 分裂条目）。失效 = mtimeMs 严格相等判定（与 mtimeCache 同构，
// 『内容变 mtime 未变』漏判局限共享 C3 声明，clearFileCache 兜底）。
// 失败语义（消歧，三方 TC1/DM1/IF1 同一口径）：
// - stat 失败（文件不存在/不可 stat）→ 驱逐该 path 条目 + undefined（对齐 getCachedFile：
//   文件已删条目无意义）
// - read 失败（stat 与 read 间竞态删除/EACCES）或 JSON.parse 失败（坏 JSON）→
//   不缓存（不写新条目、不驱逐已有好条目）+ undefined，下次调用重试——毒条目永不入缓存，
//   坏文件被修复且 mtime 变化后正常覆写。
// pi === undefined 条目仅在『read+parse 成功且 manifest 无 pi 字段』时写入（合法解析结果）。
interface ManifestCacheEntry {
  mtimeMs: number;
  pi: Record<string, unknown> | undefined;
}

const manifestCache = new Map<string, ManifestCacheEntry>();

/** 从缓存的 pi 对象派生 kind manifest（廉价操作，每次调用新数组——语义与旧直读版一致）。 */
function piToManifest(pi: Record<string, unknown> | undefined, kind: ResourceKind): string[] | undefined {
  if (!pi) return undefined;
  const entries = pi[kind];
  if (!Array.isArray(entries)) return undefined;
  // 过滤非字符串元素
  return entries.filter((p): p is string => typeof p === "string");
}

/**
 * package.json 文本 → pi 字段对象（pi.agents / pi.workflows 的容器）。
 * [review 修复] 结构守卫：JSON.parse 对 "42" / '"str"' / "null" 等合法 JSON 产出
 * 非对象值，旧 `as Record<string, unknown>` 盲断言下 .pi 访问是「碰巧不抛」
 * （primitive 装箱返 undefined / null 抛 TypeError 落入 catch）——显式判非对象，
 * 按「无 manifest」（undefined）处理，后果与原先一致但语义不再依赖巧合。
 * pi 字段本身非对象（如 {"pi":42}）或为数组（如 {"pi":[]}——数组不是合法 pi 容器，
 * typeof "object" 守卫会放行，Record 断言对数组是谎言）同样显式归 undefined。
 * JSON SyntaxError 向上抛，由调用方 catch 承担「坏 JSON 不缓存、下次重试」语义。
 */
function parsePiField(content: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const pi: unknown = (parsed as Record<string, unknown>).pi;
  return typeof pi === "object" && pi !== null && !Array.isArray(pi)
    ? (pi as Record<string, unknown>)
    : undefined;
}

/**
 * stat + content 统一缓存。文件不存在/不可读 → null（并驱逐条目）。
 * mtime 未变 → 返回缓存 content（不重 read）；变 → readFileSync + 缓存。
 */
export function getCachedFile(filePath: string): { mtimeMs: number; content: string } | null {
  let mtimeMs: number;
  try {
    mtimeMs = fsSync.statSync(filePath).mtimeMs;
  } catch {
    mtimeCache.delete(filePath);
    return null;
  }
  const entry = mtimeCache.get(filePath);
  if (entry && entry.mtimeMs === mtimeMs) return entry;
  let content: string;
  try {
    content = fsSync.readFileSync(filePath, "utf-8");
  } catch {
    // stat 与 read 之间的删除/EACCES 竞态 → 驱逐并返回 null（exec-review major-2：
    // docstring 承诺「不可读 → null」——readFileSync 也必须入守卫）
    mtimeCache.delete(filePath);
    return null;
  }
  const cached = { mtimeMs, content };
  mtimeCache.set(filePath, cached);
  return cached;
}

/** 便捷封装：只取 content（不存在 → null）。 */
export function getCachedFileContent(filePath: string): string | null {
  return getCachedFile(filePath)?.content ?? null;
}

// [perf] 解析结果缓存（KV-cache 稳定性改造）：key = path，value = { mtimeMs, parsed }。
// 单层 path key 的前提：isTargetFile 按 kind 判扩展名互斥（agents=.md / workflows=.js|.mjs），
// 同一 path 恒由同一 parse（agent frontmatter vs workflow meta）处理，不存在跨 parse
// 类型污染。用普通 Map 而非 WeakMap：clearFileCache 需全量清空（测试隔离），WeakMap
// 不可遍历；parse 函数均为模块级常量，强引用无泄漏。复用 getCachedFile 的 mtime 判变
// ——mtime 未变时跳过 parse（frontmatter YAML 解析是重建发现时最大的可省 CPU 项）。
// parse 的确定性结果（含 null，如 frontmatter 非法）均可缓存：同一 content 必然解析出
// 同一结果。失效与 mtimeCache 同步（clearFileCache）。
const parsedCache = new Map<string, { mtimeMs: number; parsed: unknown }>();

/**
 * mtime 级解析结果缓存：mtime 未变返回缓存 parsed，变则经 getCachedFile 取 content
 * 重新 parse 并缓存。文件不存在/不可读 → null（并驱逐条目）。
 */
export function getCachedParsed<T>(filePath: string, parse: (content: string) => T): T | null {
  const file = getCachedFile(filePath);
  if (!file) {
    parsedCache.delete(filePath);
    return null;
  }
  const entry = parsedCache.get(filePath);
  if (entry && entry.mtimeMs === file.mtimeMs) return entry.parsed as T;
  const parsed = parse(file.content);
  parsedCache.set(filePath, { mtimeMs: file.mtimeMs, parsed });
  return parsed;
}

/** 清空（invalidateCache 语义——测试隔离 + mtime 漏判场景手动刷新兜底）。 */
export function clearFileCache(): void {
  mtimeCache.clear();
  workspaceRootCache.clear();
  manifestCache.clear();
  parsedCache.clear();
}

export function findWorkspaceRoot(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  const memo = workspaceRootCache.get(dir);
  if (memo !== undefined) return memo;
  const root = computeWorkspaceRoot(dir);
  workspaceRootCache.set(dir, root);
  return root;
}

function computeWorkspaceRoot(dir: string): string {
  const root = resolve("/");

  // Phase 1: bare repo 优先——先全路径扫一遍找 .bare
  let probe = dir;
  for (let i = 0; i < WORKSPACE_ROOT_MAX_DEPTH; i++) {
    if (fsSync.existsSync(resolve(probe, ".bare"))) {
      // worktree 是 workspace 根的直接子目录。若 cwd 自身有 .pi/，优先用 cwd
      if (probe !== dir && isDirectChildOfWorkspaceRoot(dir, probe) && fsSync.existsSync(resolve(dir, ".pi"))) {
        return dir;
      }
      return probe;
    }
    if (probe === root) break;
    probe = resolve(probe, "..");
  }

  // Phase 2: 无 .bare 时，找最顶层的 .git
  let topLevel = dir;
  probe = dir;
  for (let i = 0; i < WORKSPACE_ROOT_MAX_DEPTH; i++) {
    if (fsSync.existsSync(resolve(probe, ".git"))) {
      topLevel = probe;
    }
    if (probe === root) break;
    probe = resolve(probe, "..");
  }
  if (topLevel !== dir) {
    return topLevel;
  }

  // Phase 3: fallback——用第一个遇到的 .pi
  probe = dir;
  for (let i = 0; i < WORKSPACE_ROOT_MAX_DEPTH; i++) {
    if (fsSync.existsSync(resolve(probe, ".pi"))) {
      return probe;
    }
    if (probe === root) break;
    probe = resolve(probe, "..");
  }

  return dir;
}

// ── 文件扩展名判定 ───────────────────────────────────────────

/** 根据资源种类判定脚本文件扩展名 */
function isTargetFile(name: string, kind: ResourceKind): boolean {
  // _ 前缀 = draft/示例，不参与发现（与原 agent-registry/workflow 约定一致）
  if (name.startsWith("_")) return false;
  if (kind === "agents") {
    return name.endsWith(".md") && !name.endsWith(".chain.md");
  }
  // workflows
  return name.endsWith(".js") || name.endsWith(".mjs");
}

/** 提取文件名 stem（去目录去扩展名） */
function stem(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// ── 目录扫描 ─────────────────────────────────────────────────

/**
 * 扫描单个目录下的资源文件。
 * 返回文件绝对路径列表。目录不存在时返回空数组。
 */
async function scanDirectory(dirPath: string, kind: ResourceKind): Promise<string[]> {
  try {
    await access(dirPath);
  } catch {
    return [];
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (!isTargetFile(e.name, kind)) continue;
    const absPath = resolve(dirPath, e.name);
    // symlink 单独处理：Dirent.isFile() 对 symlink 返回 false
    if (e.isFile()) {
      files.push(absPath);
    } else if (e.isSymbolicLink()) {
      const targetStat = await stat(absPath).catch(() => null);
      if (targetStat?.isFile()) files.push(absPath);
    }
  }
  return files;
}

// ── npm/dev 包内 manifest 发现 ───────────────────────────────

/**
 * 读取 package.json 的 pi.{kind} manifest（pi.agents / pi.workflows）。
 * 返回 undefined 表示无 manifest 声明（无 pi / pi[kind] 非数组 / 解析失败）。
 * 内部走 manifestCache（失败语义见声明处）。
 */
async function readPackageManifest(pkgDir: string, kind: ResourceKind): Promise<string[] | undefined> {
  const pkgJsonPath = resolve(pkgDir, "package.json");
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(pkgJsonPath)).mtimeMs;
  } catch {
    // stat 失败：文件不存在/不可 stat → 驱逐条目（对齐 getCachedFile 语义）
    manifestCache.delete(pkgJsonPath);
    return undefined;
  }
  const entry = manifestCache.get(pkgJsonPath);
  if (entry && entry.mtimeMs === mtimeMs) return piToManifest(entry.pi, kind);
  let pi: Record<string, unknown> | undefined;
  try {
    const content = await readFile(pkgJsonPath, "utf-8");
    pi = parsePiField(content);
  } catch {
    // read 失败或坏 JSON → 不缓存不驱逐已有好条目，下次调用重试
    return undefined;
  }
  manifestCache.set(pkgJsonPath, { mtimeMs, pi });
  return piToManifest(pi, kind);
}

/**
 * 处理单个 npm/dev 包：按 manifest 或约定目录发现资源。
 *
 * 规则：
 * - 有 manifest → 只按 manifest 声明路径加载。路径不存在 → 整包失败（返回 available=false 占位）
 * - 无 manifest → 扫约定目录 {kind}/（agents/ 或 workflows/）
 */
async function processPackage(
  pkgDir: string,
  kind: ResourceKind,
): Promise<DiscoveredResource[]> {
  const manifestPaths = await readPackageManifest(pkgDir, kind);

  // manifest 模式：只按声明路径加载，路径不存在则整包失败
  if (manifestPaths && manifestPaths.length > 0) {
    const results: DiscoveredResource[] = [];
    let allFailed = true;

    for (const relPath of manifestPaths) {
      const absPath = resolve(pkgDir, relPath);
      const fileStat = await stat(absPath).catch(() => null);
      if (!fileStat) {
        // manifest 声明的路径不存在 → 记录失败占位（路径存在性校验），
        // reason 具名（P5 D4-3：消费方渲染 invalid 上报，不再静默）
        results.push({
          path: absPath,
          source: "npm",
          available: false,
          reason: "manifest declared path not found",
        });
        continue;
      }

      if (fileStat.isDirectory()) {
        const files = await scanDirectory(absPath, kind);
        for (const f of files) {
          results.push({ path: f, source: "npm", available: true });
          allFailed = false;
        }
      } else if (fileStat.isFile()) {
        results.push({ path: absPath, source: "npm", available: true });
        allFailed = false;
      }
    }

    // manifest 全失败：返回 available=false 占位，不 fallback 到约定目录
    if (allFailed) {
      return results;
    }
    return results;
  }

  // 无 manifest：扫约定目录 {kind}/
  const conventionDir = resolve(pkgDir, kind);
  const files = await scanDirectory(conventionDir, kind);
  return files.map((f) => ({ path: f, source: "npm", available: true }));
}

/**
 * 扫描 npm node_modules 目录下所有包的资源。
 * 支持 scoped（@scope/pkg）和 unscoped（pkg）包。
 */
async function scanNpmDir(
  nodeModulesDir: string,
  kind: ResourceKind,
): Promise<DiscoveredResource[]> {
  let entries: string[];
  try {
    entries = await readdir(nodeModulesDir);
  } catch {
    return [];
  }

  // [perf] 包级并行（swf-perf-impl cleanup TC2/IF2）：entries.map + Promise.all，
  // perEntry.flat() 按原 readdir 序 concat——输出序与 readdir 包序一致。
  // 不加新增 catch：每包失败面由 processPackage 内部既有 catch 承担，未捕获异常
  // 经 Promise.all 以首个 reject 整体向上抛。
  const perEntry = await Promise.all(
    entries.map(async (entry): Promise<DiscoveredResource[]> => {
      const entryPath = resolve(nodeModulesDir, entry);

      if (entry.startsWith("@")) {
        // scoped 包——迭代子包（子包级同样并行，flat 保序）
        let scopedEntries: string[];
        try {
          scopedEntries = await readdir(entryPath);
        } catch {
          return [];
        }
        const perScoped = await Promise.all(
          scopedEntries.map((scopedPkg) => processPackage(resolve(entryPath, scopedPkg), kind)),
        );
        return perScoped.flat();
      }
      // unscoped 包
      return processPackage(entryPath, kind);
    }),
  );

  return perEntry.flat();
}

// ── 扫描源构建 ───────────────────────────────────────────────

/** 扫描源定义：路径 + source 标签 */
interface ScanTarget {
  dir: string;
  source: ResourceSource;
  /** 该源是否参与本次扫描（如 tmp 仅 workflow 启用） */
  enabled: boolean;
}

/**
 * 读取 TAIJI_EXTENSION_PATHS 环境变量（dev-link 写入的扩展源码路径）。
 *
 * delimiter 分隔（POSIX ':' / Windows ';'），trim + 过滤空 + ~ 展开。
 * 每个路径是一个 extension 包目录（dev-link 指向源码），走 processPackage 发现其
 * agents/workflows。解析逻辑与 extension-service.getUserExtensionPaths() 一致。
 */
function readExtensionPaths(): string[] {
  const raw = process.env.TAIJI_EXTENSION_PATHS;
  if (!raw) return [];
  const paths = raw
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p));
  return [...new Set(paths)];
}

// ── 约定根单源推导 ───────────────────────────────────────────
//
// buildScanTargets 的 4 个硬编码槽与壳空态 roots 提示清单（barrel 导出
// conventionRootDirs）共用同一组单根推导——约定根增删/挪位只改这一组函数，
// 消费方禁止复刻 join 字面（壳 resource-list-injector 曾有 4 join 复刻 +
// 「须与彼处同步改」注释，收敛于此）。宿主注入根（discoveryRoots 槽）与
// TAIJI_EXTENSION_PATHS 不属于约定根：前者归宿主槽位决策，后者是 taiji
// 内部 dev-link 通道、非 agent 自救面（壳提示清单刻意不列）。

/** user 级约定根 ~/.agents/{kind}/（homedir 推导）。 */
function userAgentsConventionRoot(kind: ResourceKind): string {
  return join(homedir(), ".agents", kind);
}

/** project 级约定根 <workspaceRoot>/.pi/{kind}/。 */
function projectPiConventionRoot(workspaceRoot: string, kind: ResourceKind): string {
  return join(workspaceRoot, ".pi", kind);
}

/** project 级 tmp 约定根 <workspaceRoot>/.pi/{kind}/.tmp/（仅 workflow generate 产物）。 */
function projectPiTmpConventionRoot(workspaceRoot: string, kind: ResourceKind): string {
  return join(workspaceRoot, ".pi", kind, ".tmp");
}

/** project 级约定根 <workspaceRoot>/.agents/{kind}/。 */
function projectAgentsConventionRoot(workspaceRoot: string, kind: ResourceKind): string {
  return join(workspaceRoot, ".agents", kind);
}

/**
 * 约定根路径集合（有序：user-agents → project-pi → project-pi-tmp（仅
 * includeTmp）→ project-agents，相对序与 buildScanTargets 各槽的优先级序一致）。
 *
 * 壳 resource-list-injector 的空态 roots 提示清单消费本导出做纯投影（宿主
 * 注入根现取 + 本集合拼接），路径决策全在 core——壳侧不再持有任何 join 字面。
 */
export function conventionRootDirs(
  config: Pick<ScanConfig, "kind" | "workspaceRoot" | "includeTmp">,
): string[] {
  const { kind, workspaceRoot, includeTmp } = config;
  const roots = [
    userAgentsConventionRoot(kind),
    projectPiConventionRoot(workspaceRoot, kind),
  ];
  if (includeTmp) {
    roots.push(projectPiTmpConventionRoot(workspaceRoot, kind));
  }
  roots.push(projectAgentsConventionRoot(workspaceRoot, kind));
  return roots;
}

/**
 * 构建所有扫描源（按优先级低→高排列）。
 *
 * agent 和 workflow 共享相同的前缀体系。宿主注入根（config.hostRoots）按 source
 * 标签填充槽位条目——标签字面是 core 编排的槽位键（同时是 ResourceSource
 * 枚举成员，报告输出与历史值逐字一致）；宿主未提供某标签根时该条目跳过（该源在
 * 遮蔽序中自然缺席），其余条目（core 自建：homedir/env/workspaceRoot 推导）留原位
 * 原序，遮蔽优先级语义与注入化前逐字一致。
 *
 * 同标签多根（W2④，Map→列表）：同标签多条目依注入序全部保留、同序位依次扫描
 * （旧实现 Map(source→dir) 同标签靠后者整体覆盖，多根语义缺失）。硬编码槽
 * （user-agents/project-agents）与 hostRoots 同标签注入合并——硬编码根（本体根）
 * 排在注入条目之后：core 合并 last-writer-wins 靠后者胜，本体在后 = 本体胜（红线 2
 * 「注入/合并序语义」）。pi 单条目形态（每标签恰好一条或无注入）下 targets 序与
 * 旧实现逐项一致（回归红线，见 __tests__ pi 单条目形态快照用例）。
 */
function buildScanTargets(config: ScanConfig): ScanTarget[] {
  const { kind, workspaceRoot, hostRoots, includeTmp } = config;

  // 同标签多条目依注入序全部保留（W2④ 列表语义）：宿主把「展开目标 + 本体根」
  // 按注入序注入同标签，core 同序位依次扫描；本体靠后 → last-writer-wins 本体胜。
  const hostDirsBySource = new Map<string, string[]>();
  for (const root of hostRoots) {
    const list = hostDirsBySource.get(root.source);
    if (list) list.push(root.dir);
    else hostDirsBySource.set(root.source, [root.dir]);
  }
  const hostTargets = (source: ResourceSource): ScanTarget[] =>
    (hostDirsBySource.get(source) ?? []).map((dir) => ({ dir, source, enabled: true }));

  const targets: ScanTarget[] = [];
  // 1. user .pi/agent/{kind}/（宿主注入，pi 壳 source "user-pi"）
  targets.push(...hostTargets("user-pi"));
  // 2. user .agents/{kind}/（约定根单源推导 + 宿主可选注入合并，本体
  //    根后置 → 注入的展开目标在前、本体在后，last-writer-wins 本体胜）
  targets.push(...hostTargets("user-agents"));
  targets.push({ dir: userAgentsConventionRoot(kind), source: "user-agents", enabled: true });
  // 3. npm global: <agentDir>/npm/node_modules/*/<pkg>/（宿主注入，pi 壳 source "npm"）
  targets.push(...hostTargets("npm"));
  // 4. npm dev symlink: <agentDir>/extensions/*/<pkg>/（宿主注入，pi 壳 source "npm-dev"）
  targets.push(...hostTargets("npm-dev"));
  // user extension paths (TAIJI_EXTENSION_PATHS, dev-link): each path is a package dir,
  // 走 processPackage 读 pi.{kind} manifest 或扫 {kind}/ 目录。优先级高于 npm/npm-dev
  // （dev-link 是开发版 override），低于 project（项目正式资源优先）。
  targets.push(
    ...readExtensionPaths().map((dir) => ({ dir, source: "user-extension-paths" as const, enabled: true })),
  );
  // 5. project .pi/{kind}/
  targets.push({ dir: projectPiConventionRoot(workspaceRoot, kind), source: "project-pi", enabled: true });

  // 6. project .pi/{kind}/.tmp/（仅 workflow）
  if (includeTmp) {
    targets.push({
      dir: projectPiTmpConventionRoot(workspaceRoot, kind),
      source: "project-pi-tmp",
      enabled: true,
    });
  }

  // 7. project .agents/{kind}/（约定根单源推导 + 宿主可选注入合并，本体根后置同槽 2）
  targets.push(...hostTargets("project-agents"));
  targets.push({
    dir: projectAgentsConventionRoot(workspaceRoot, kind),
    source: "project-agents",
    enabled: true,
  });

  return targets.filter((t) => t.enabled);
}

// ── 公共 API ─────────────────────────────────────────────────

/**
 * 发现所有资源文件（agent .md 或 workflow .js/.mjs）。
 *
 * 按优先级低→高扫描所有源，同名资源靠后覆盖靠前（last-writer-wins）。
 * npm/dev 包内：有 manifest 只走 manifest（路径不存在则失败），无 manifest 扫约定目录。
 *
 * realpath 归一去重（W2①，仅 async 链）：多个不同名 symlink 指向同一物理文件时
 * （多链同文件），stem 去重防不住——清单按物理文件归一只留一条（首遇者，位置
 * 固定语义与 stem 合并一致）；同 stem 不同物理文件的遮蔽语义不受影响（仍按
 * last-writer-wins 覆盖）。realpath 解析失败（扫描后竞态删除/ELOOP 深链）回退
 * 原 path，属预期失败不抛。
 *
 * Throws on unrecoverable scan errors——未捕获异常向上抛（Promise.all 首个 reject
 * 即整体拒绝，见实现内 [perf] 注释）。
 * 预期失败不抛：目录不存在/不可读返回空列表，manifest 声明路径缺失以 available=false 返回。
 *
 * @returns 去重后的资源列表（按优先级合并，高优先级覆盖低优先级同名）
 */
export async function discoverResources(config: ScanConfig): Promise<DiscoveredResource[]> {
  const targets = buildScanTargets(config);

  // [perf] 源级并行（swf-perf-impl cleanup TC2/IF2）：targets.map + Promise.all，
  // Promise.all 对 map 数组保序——allBySource 顺序 = targets 优先级序（低→高），
  // 下方合并去重按该顺序 last-writer-wins。
  // 不加新增 catch：每源预期失败路径由内部既有 catch 面承担（scanDirectory access
  // catch / scanNpmDir readdir catch / processPackage 全链 catch）；未捕获异常经
  // Promise.all 以首个 reject 整体向上拒绝（各源只读无副作用）。
  const allBySource: Array<{ source: ResourceSource; resources: DiscoveredResource[] }> = await Promise.all(
    targets.map(async (target) => {
      if (target.source === "npm" || target.source === "npm-dev") {
        // npm/dev 目录：迭代包，走 manifest 或约定目录
        const resources = await scanNpmDir(target.dir, config.kind);
        // 覆盖 source 标签（scanNpmDir 内部统一标 "npm"，这里修正为实际源）
        const tagged = resources.map((r) => ({ ...r, source: target.source }));
        return { source: target.source, resources: tagged };
      }
      if (target.source === "user-extension-paths") {
        // TAIJI_EXTENSION_PATHS（dev-link）：每个 dir 是单个包目录，走 processPackage
        const resources = await processPackage(target.dir, config.kind);
        const tagged = resources.map((r) => ({ ...r, source: target.source }));
        return { source: target.source, resources: tagged };
      }
      // 普通目录：直接扫
      const files = await scanDirectory(target.dir, config.kind);
      const resources = files.map((f) => ({ path: f, source: target.source, available: true }));
      return { source: target.source, resources };
    }),
  );

  // [W2①] realpath 归一键（仅 async 链）：与 allBySource 同构的二维数组（源序×
  // 源内资源序）。源级并行解析（每资源一次 realpath，资源量级为个位/十位数）；
  // 失败回退原 path——扫描与 realpath 之间竞态删除/ELOOP 属预期失败，不抛
  // （对齐 scanDirectory 的 stat().catch 吞错面）。
  const realpathKeys: string[][] = await Promise.all(
    allBySource.map(async ({ resources }) =>
      Promise.all(resources.map((r) => realpath(r.path).catch(() => r.path))),
    ),
  );

  // 按优先级合并：targets 数组顺序即优先级（低→高），高优先级后写覆盖
  // 用文件名 stem 作为去重 key（与旧逻辑一致：同名资源高优先级覆盖）
  const merged = new Map<string, DiscoveredResource>();
  // realpath → 已入清单 stem key：多链同文件（不同名 symlink 指向同一物理文件）
  // 时后到链 skip——清单按物理文件只留一条，不计入遮蔽（同一文件无遮蔽语义）。
  const realpathOwner = new Map<string, string>();

  for (let si = 0; si < allBySource.length; si++) {
    const { resources } = allBySource[si]!;
    for (let ri = 0; ri < resources.length; ri++) {
      const r = resources[ri]!;
      const key = stem(r.path);
      const rp = realpathKeys[si]![ri]!;
      // 同物理文件已以另一 stem 入清单 → 多链重复，跳过（不影响 stem 遮蔽语义：
      // 同 stem 不同物理文件仍走下方 last-writer-wins）
      const owner = realpathOwner.get(rp);
      if (owner !== undefined && owner !== key) {
        continue;
      }
      const existing = merged.get(key);
      // available=false 的占位不覆盖已有的 available=true
      if (!r.available && existing) {
        continue;
      }
      // [D8d] 同名遮蔽可观测：高优先级源覆盖低优先级同名资源时分级报告——
      // 机器源重复是安装拓扑常态（npm 包与用户目录结构性同名），降 debug 默认静默
      // （TAIJI_AGENT_DEBUG=1 文件日志可查）；双用户源重复是配置错误，保留 warn 首报。
      // warn 路径进程内去重（Set cap 1024，对齐 ui-request-observability 范式）：
      // 每 session 独立进程（process-manager.ts L142-143），进程级去重 ≈ session 级首报。
      if (existing && existing.path !== r.path) {
        const msg =
          `[resource-discovery] duplicate ${config.kind} "${key}" from ${r.source} shadows ${existing.source}`;
        const data = { shadowed: existing.path, kept: r.path };
        if (isMachineSource(existing.source) || isMachineSource(r.source)) {
          // 任一侧为机器源 → 降级 debug（安装拓扑常态，排查走 TAIJI_AGENT_DEBUG=1）
          logger.debug(msg, data);
        } else {
          // 双侧均为用户源 → 保持 warn，进程内去重（同 key 只报首次）
          const dedupKey = `${config.kind}|${key}|${existing.path}|${r.path}`;
          if (!shadowWarnDedup.has(dedupKey)) {
            if (shadowWarnDedup.size >= MAX_SHADOW_WARN_DEDUP) {
              shadowWarnDedup.clear();
            }
            shadowWarnDedup.add(dedupKey);
            logger.warn(msg, data);
          }
        }
      }
      merged.set(key, r);
      realpathOwner.set(rp, key);
    }
  }

  return Array.from(merged.values());
}

