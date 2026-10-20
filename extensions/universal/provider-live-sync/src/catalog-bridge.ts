/**
 * 目录投喂桥（provider-catalog-sync U2）——把 taiji 的模型目录缓存经 pi 官方注册点
 * 注入 pi 注册表，单点修复 8 个同根因症状（rename 静默跳过 / `set_model` 报
 * ENGINE_MODEL_MISSING / subagent 模型校验抛错 / smart-context 压缩回退 /
 * permission 分类器 fail-closed / scheduler 切模型失效 / 对账 config_only 漂移 /
 * spawn `--model` 近似回退）。
 *
 * 职责边界（设计 §3.3 D1/D2/D5）：
 * - **注册时机（D1）**：工厂函数体内 `pi.registerProvider(...)`——pi 内部进 pending
 *   队列，装配链在 `--model` 解析之前统一 flush + 本地 refresh（PS-81）。不用
 *   `session_start` 钩子：它 emit 于 `createAgentSessionFromServices` 内，晚于
 *   `--model` 解析，覆盖不了 spawn 近似回退那个症状。
 * - **注入集（D2）**：「内置基线 ⊕ 有效条目」全量并集，同 id 缓存版本整对象替换
 *   基线版本，数组内去重。有效条目 = taiji 缓存与 pi store 两份经条目级新者胜
 *   合并的结果——两份都读、缺一不可（任一份独有模型若不在注入集内会被挤出视图）。
 *   判据本体在 `@zhushanwen/pi-llm-shared` 的 catalog-overlay（零 IO 纯函数），
 *   本模块只做 IO + 日志 + 注册。
 * - **运行中窗口（D5）**：注册时携带 `refreshModels` 钩子——钩子重读两份缓存
 *   （带 mtime 短路：文件未变直接返回上次结果不重算），fresh 返回新并集、
 *   expired/never-seen 返回纯内置基线（R6 撤销）、运行期读失败返回 undefined
 *   （R7 保留当前注入）。触发方 = provider-live-sync 既有 tick 挂载的第三个
 *   监视条目（`createOverlayCacheWatcher`，绝对路径 + mtime 比较），其基线在
 *   **工厂期播种**（`injectCatalogOverlay` 在 runPass 之前捕获 mtime 传入）——
 *   「工厂期注入 → tick 1」约 2s 窗内的缓存变更必须可检出，否则运行中窗口在该
 *   窗口断裂且此后 mtime 稳定即永不重检。钩子只覆盖**已注册**的 provider（pi-ai
 *   `ModelsStore.refresh` 只刷新带 `refreshModels` 的 provider），故 tick 检出变化后
 *   先经 `reconcile` 做一次**注册对账**：对本拍 fresh 且尚未注册的 provider 补
 *   `registerProvider`（挂同一钩子）——覆盖「工厂期 expired / never-seen / 损坏 →
 *   运行中变 fresh」的跃迁；工厂返回后的注册直连注册表立即生效、无需 /reload（PS-87）。
 *
 * 失败路径映射（设计 §3.1 R1-R7，全部 fail-safe 降级不抛错）：
 * - R1 无 `TAIJI_AGENT_DATA_DIR`（原生 pi 用户）→ 入口返回 null，零文件访问、零注册；
 * - R2 缓存缺失记 debug / 损坏或不可读记 warn，两分支都按 never-seen 跳过注入；文件
 *   恢复后下一拍 tick 的注册对账重建注入（恢复路径不依赖重开会话）；
 * - R3 fresh 条目缺 `api`/`baseUrl` 且同 id 无内置定义可继承 → 判据层已滤并回传
 *   `skipped`，本模块负责 warn 日志（保守档：只认同 id 继承，不从任意同 provider
 *   模型继承——兜底继承到的端点语义未经上游目录声明）；
 * - R4 `registerProvider` 抛错（结构校验失败）→ 捕获 + error 日志（含 pi 原文与
 *   恢复动作）+ 不阻断其他 provider 的注入；失败的 provider 不入已注册集，缓存下次
 *   重写后的对账自动重试；
 * - R5 expired（含远端 404/501 落盘的否定信号）与 never-seen 不注入 + debug；
 * - R6 钩子对非 fresh 态返回纯内置基线（等价撤销注入）；
 * - R7 钩子运行期任一份缓存损坏/不可读 → warn + 返回 undefined。
 *
 * R2 与 R7 对「损坏」的处置**有意不同**：注册侧（工厂期与运行中对账）对尚未注册的
 * provider 没有已注入的集合可保，损坏即降级为 never-seen（不注入）；已注册的 provider
 * 在运行期有注入在，损坏按 R7 由钩子保留最后一份好快照。同一份文件对两类 provider 的
 * 风险面不同，不是双轨判据。
 *
 * 文件读取用同步 API（`readFileSync`/`statSync`）：工厂期注册必须发生在**同步的工厂
 * 函数体内**——pi 的 pending 队列在全部工厂返回后统一 flush，异步化会把注册推到
 * flush 之后，D1 的时机前提即失效（运行中对账已过 flush 期，走 post-bind 直连路径，
 * 同步读在此只是沿用）；且两份缓存都是 KB 级小文件、读取频率 ≤ 每 2s 一拍，与写入方
 * runtime `provider-catalog-refresh.ts` 的同款同步读一致。
 *
 * 日志通道 = `@zhushanwen/pi-extension-logger` 的 `provider-live-sync` 具名
 * singleton（`getLogger` 按名缓存，与 src/index.ts 是同一实例）——warn/error 落
 * pi.appendEntry 持久化 + `TAIJI_AGENT_DEBUG`/`TAIJI_AGENT_EXT_LOG` 文件日志，
 * 不依赖 pi 不捕获的 extension stderr。
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import {
  computeInjectionSet,
  getPiStorePath,
  getTaijiOverlayCachePath,
  mergeEntriesNewerWins,
  parseOverlayCache,
  type ComputeInjectionSetResult,
  type OverlayEntry,
  type OverlayModel,
} from "@zhushanwen/pi-llm-shared";

const logger = getLogger("provider-live-sync");

/** `RefreshModelsContext` 不经 pi 主入口导出，从 `ProviderConfig.refreshModels` 的函数类型反推。 */
type RefreshModelsContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];

/**
 * 本模块 `refreshModels` 钩子的实际返回类型——比 pi 的声明类型宽一档（多 `undefined`）。
 *
 * pi 声明 `Promise<ProviderModelConfig[]>`（`dist/core/extensions/types.d.ts:1403`），
 * 但实装对 falsy 返回值有显式分支：`dist/core/provider-composer.js:388-396` 的
 * `if (refreshed) { ...publish... }`——返回 undefined 即「本次不发布新列表」，注册表
 * 保留当前注入。R7 依赖的正是这个语义（宁可保留最后一份好快照，不因瞬时读失败清空
 * 可见集合），故钩子按实装语义声明，挂到 `ProviderConfig` 上时做一次显式断言。
 */
type RefreshModelsFn = (context: RefreshModelsContext) => Promise<ProviderModelConfig[] | undefined>;

// ──────────────────────── 缓存文件读取 ────────────────────────

/** 单份缓存文件的读取态。`absent` 是合法态（never-seen 的输入），不是失败。 */
type CacheRead =
  | { status: "ok"; entries: Record<string, OverlayEntry> }
  | { status: "absent" }
  | { status: "corrupt" }
  | { status: "unreadable" };

/**
 * 读一份缓存文件。ENOENT → absent（首装未开过设置页的正常形态）；JSON/结构非法 →
 * corrupt；其它 IO 故障（EACCES 等）→ unreadable。双形态解析（taiji 的 version
 * 包装 / pi store 的顶层 providerId 分桶）由 llm-shared 的 `parseOverlayCache` 承担。
 */
function readCacheFile(path: string): CacheRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { status: "absent" };
    return { status: "unreadable" };
  }
  const parsed = parseOverlayCache(raw);
  return parsed.status === "ok" ? { status: "ok", entries: parsed.entries } : { status: "corrupt" };
}

/**
 * 读一份缓存并按 R2 分级记日志（缺失 debug / 损坏与不可读 warn——级别区分常态与异常）。
 * 返回该文件贡献的 entries（失败 = 空）与是否失败（失败时整拍作废，见 R2/R7 注释）。
 */
function readCacheEntries(
  label: string,
  path: string,
): { entries: Record<string, OverlayEntry>; failed: boolean } {
  const read = readCacheFile(path);
  if (read.status === "absent") {
    logger.debug(
      `catalog cache absent (${label}): ${path} — its providers fall to never-seen `
      + "(normal before the first Settings provider-page catalog refresh)",
    );
    return { entries: {}, failed: false };
  }
  if (read.status === "corrupt") {
    logger.warn(
      `catalog cache corrupt (${label}), overlay injection skipped: ${path} — fix or delete the file; `
      + "the next catalog refresh rewrites it",
    );
    return { entries: {}, failed: true };
  }
  if (read.status === "unreadable") {
    logger.warn(`catalog cache unreadable (${label}), overlay injection skipped: ${path} — check file permissions`);
    return { entries: {}, failed: true };
  }
  return { entries: read.entries, failed: false };
}

/** 两份缓存条目级新者胜合并（缺 `lastModified` 视为最旧；判据在 llm-shared）。 */
function mergeSources(
  taiji: Record<string, OverlayEntry>,
  store: Record<string, OverlayEntry>,
): Record<string, OverlayEntry> {
  const merged: Record<string, OverlayEntry> = {};
  for (const providerId of new Set([...Object.keys(taiji), ...Object.keys(store)])) {
    const entry = mergeEntriesNewerWins(taiji[providerId], store[providerId]);
    if (entry !== undefined) merged[providerId] = entry;
  }
  return merged;
}

// ──────────────────────── 桥状态与单拍计算 ────────────────────────

/** 两份缓存文件的 mtime 戳（缺失 = -1，与 runtime `mtimeOf` 同哨兵）。 */
type CacheStamp = { taiji: number; store: number };

/** 投喂桥的进程内状态（taiji 每会话一个独立 pi 进程，无跨会话残留问题）。 */
type BridgeState = {
  taijiPath: string;
  /** pi store 路径（`getPiStorePath` 委托 pi `getAgentDir` 推导，恒有值）。 */
  storePath: string;
  /** 已成功注册的 provider id——缓存里消失的 provider 也要进计算集（否则撤销注入无从触发）。 */
  registered: Set<string>;
  /** 上次成功计算的 mtime 戳与结果；null = 尚未计算过。 */
  cache: { stamp: CacheStamp; results: Map<string, ComputeInjectionSetResult> } | null;
};

/**
 * 单拍计算结果。`read-failed` = 两份缓存之一损坏或不可读——注册期按 R2 跳过注入，
 * 钩子期按 R7 返回 undefined 保留当前注入。
 */
type PassOutcome =
  | { status: "ok"; results: Map<string, ComputeInjectionSetResult> }
  | { status: "read-failed" };

/** 单文件 mtime 观测态（与既有 `FileObservation` 同构的三分态，比较对象是 mtime 而非内容字节）。 */
export type MtimeObservation =
  | { state: "present"; mtimeMs: number }
  | { state: "absent" }
  | { state: "unreadable" };

/** stat 单个监视目标：ENOENT → absent；其它错误 → unreadable（含权限、I/O 故障）。 */
function observeMtime(path: string): MtimeObservation {
  try {
    return { state: "present", mtimeMs: statSync(path).mtimeMs };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { state: "absent" };
    return { state: "unreadable" };
  }
}

/** 观测态 → mtime 戳（非 present 一律 -1，与 runtime `mtimeOf` 同哨兵）。 */
function stampOf(observation: MtimeObservation): number {
  return observation.state === "present" ? observation.mtimeMs : -1;
}

function readStamp(state: BridgeState): CacheStamp {
  return {
    taiji: stampOf(observeMtime(state.taijiPath)),
    store: stampOf(observeMtime(state.storePath)),
  };
}

function sameStamp(previous: CacheStamp, current: CacheStamp): boolean {
  return previous.taiji === current.taiji && previous.store === current.store;
}

/**
 * 单拍计算：读两份缓存 → 条目级新者胜合并 → per-provider 并集判据。
 *
 * mtime 短路（设计 D5）：两份文件 mtime 与上次成功计算相同 → 直接返回上次结果，
 * 不重读不重算。钩子被 pi 在**每次**注册表刷新时调用，其中绝大多数与目录缓存无关
 * （凭据变化、其它 provider 注册、tick 的 models.json/auth.json 变更），短路省掉
 * 每拍的 JSON 解析与并集计算。
 */
function runPass(state: BridgeState): PassOutcome {
  const stamp = readStamp(state);
  if (state.cache !== null && sameStamp(state.cache.stamp, stamp)) {
    return { status: "ok", results: state.cache.results };
  }

  const taiji = readCacheEntries("taiji overlay cache", state.taijiPath);
  const store = readCacheEntries("pi models store", state.storePath);
  if (taiji.failed || store.failed) return { status: "read-failed" };

  const merged = mergeSources(taiji.entries, store.entries);
  const results = new Map<string, ComputeInjectionSetResult>();
  // 计算集 = 缓存里的 provider ∪ 已注册的 provider：后者在缓存里消失时也要算出
  // never-seen 的纯基线，撤销注入才有触发点（R6）。
  for (const providerId of new Set([...Object.keys(merged), ...state.registered])) {
    results.set(providerId, computeInjectionSet({ providerId, entry: merged[providerId] }));
  }
  state.cache = { stamp, results };
  return { status: "ok", results };
}

// ──────────────────────── 注入集形状转换 ────────────────────────

/**
 * 注入集元素 → pi 注册入参形状。
 *
 * llm-shared 的 `OverlayModel` 是「内置基线（pi-ai `Model`）与缓存条目（pi.dev
 * 返回的宽松 JSON）」的共同可读面上界（该类型注释即此定位），运行时对象是完整
 * 模型定义。pi 的组合入口 `extensionModelFromDefinition` 只补 `api`/`baseUrl`，
 * 其余字段经 `{...definition}` 原样透传（`dist/core/provider-composer.js:135`），
 * 故此处不做字段重建。
 *
 * 等价性由 U4 的 SDK 契约测试锁定（`__tests__/sdk-contract.test.ts`：Model 对象
 * 全字段经组合后保留，唯一规范化是 headers 恒 undefined）。缺 `api`/`baseUrl`
 * 的条目已在判据层按 R3 滤掉，其余字段完整性属上游目录数据的责任——本层不发明
 * 缺省值（凭空补的 contextWindow/maxTokens 比缺字段更危险）。
 */
function toProviderModels(models: OverlayModel[]): ProviderModelConfig[] {
  return models as ProviderModelConfig[];
}

// ──────────────────────── refreshModels 钩子 ────────────────────────

/**
 * 注册时携带的 `refreshModels` 钩子（设计 D5 运行中窗口）。
 *
 * pi 在每次注册表刷新时调用它——含 provider-live-sync 既有 tick 检出缓存文件
 * mtime 变化后的 `refresh({ allowNetwork: false })`。返回值语义：
 * - fresh → 新并集（新模型立即可见，无需重开会话）；
 * - expired / never-seen → 纯内置基线（R6 撤销注入）；
 * - 任一份缓存损坏或不可读 → undefined（R7：pi 保留当前注入——宁可保留最后一份
 *   好快照，不因瞬时读失败清空可见集合）。
 */
function makeRefreshModels(state: BridgeState, providerId: string): RefreshModelsFn {
  return async () => {
    const outcome = runPass(state);
    if (outcome.status === "read-failed") {
      logger.warn(
        `catalog cache unreadable during refresh for ${providerId}, keeping the current injection — `
        + "recovers on the next poll once the file is readable again",
      );
      return undefined;
    }
    const result = outcome.results.get(providerId);
    // 不可达：注册成功后才挂本钩子，`registered` 恒含该 provider，计算集必含它。
    // Map.get 的 undefined 类型面要求显式收窄，按 R7 的保守语义返回 undefined。
    if (result === undefined) return undefined;
    if (result.state !== "fresh") {
      logger.debug(
        `catalog overlay revoked for ${providerId}: state=${result.state} — returning the builtin baseline`,
      );
    }
    return toProviderModels(result.models);
  };
}

// ──────────────────────── 第三个监视条目 ────────────────────────

/** 第三个监视条目的观测器（provider-live-sync 既有 tick 每拍调用一次）。 */
export type OverlayCacheWatcher = {
  /** 监视目标标签（tick 日志用；= taiji 自刷缓存文件名）。 */
  readonly label: string;
  /** 本拍观测：mtime 变化 → true（内部推进基线）。unreadable → 本拍不比较、不推进基线。 */
  observe(): boolean;
};

/**
 * 建第三个监视条目的观测器：taiji 目录缓存（绝对路径 + mtime 比较）。
 *
 * 为什么用 mtime 而非既有 models.json/auth.json 的内容字节比较：写入方是 taiji
 * runtime 的 tmp+rename 原子替换写（`provider-catalog-refresh.ts` 的 `writeFile`
 * + `rename`），mtime 可靠；且该文件含**全部** provider 的模型目录，逐拍字节比较
 * 是纯浪费。辖域仅限本条目——既有两条目的内容字节比较与「曾存在 → 缺失」抑制语义
 * 一字不变（设计 D5）。
 *
 * `initial` = 工厂期捕获的 mtime 观测（`injectCatalogOverlay` 在 runPass 之前观测后
 * 传入）。第三个条目的基线**必须工厂期播种**：pi 不读目录缓存，扩展工厂期注入才是
 * 初始态——若基线留到 tick 1 才建立，「工厂期注入 → tick 1」约 2s 窗内的缓存变更会
 * 被首拍基线吞掉（与「无变更」无法区分），且此后 mtime 稳定即永不重检，运行中窗口
 * （设计 D5）在该窗口断裂。缺省 undefined = 首拍建基线（恒判「变化」，由调用方的
 * firstBaseline 抑制刷新）——仅无工厂期观测的形态（测试）使用。
 */
export function createOverlayCacheWatcher(path: string, initial?: MtimeObservation): OverlayCacheWatcher {
  let baseline: MtimeObservation | undefined = initial;
  return {
    label: basename(path),
    observe(): boolean {
      const observation = observeMtime(path);
      // unreadable：本拍不比较、不推进基线（与既有 per-file 框架的 unreadable 语义一致）
      if (observation.state === "unreadable") return false;
      const changed = !sameObservation(baseline, observation);
      baseline = observation;
      return changed;
    },
  };
}

/** 两次观测是否同一态（undefined 基线 = 首拍，恒判「变化」，由调用方的 firstBaseline 抑制刷新）。 */
function sameObservation(previous: MtimeObservation | undefined, current: MtimeObservation): boolean {
  if (previous === undefined) return false;
  if (previous.state === "present" && current.state === "present") return previous.mtimeMs === current.mtimeMs;
  return previous.state === current.state;
}

// ──────────────────────── 注册执行 ────────────────────────

/**
 * 把一个 fresh 态 provider 注入 pi 注册表（工厂期循环与运行中对账共用的单 provider
 * 注册体）：R3 的 skipped warn 与 R4 的抛错捕获都在此；注册成功才入 `state.registered`
 * （失败的 provider 留在未注册集，缓存下次重写后的对账自动重试）。返回是否注册成功。
 */
function registerFreshProvider(
  pi: ExtensionAPI,
  state: BridgeState,
  providerId: string,
  result: ComputeInjectionSetResult,
): boolean {
  for (const skipped of result.skipped) {
    // R3：缺 api/baseUrl 且同 id 无内置定义可继承（判据层已滤，此处只负责日志）
    logger.warn(
      `catalog overlay model skipped: ${providerId}/${skipped.modelId} is missing api or baseUrl `
      + "and has no same-id builtin model to inherit from — waiting for the next catalog refresh "
      + "to bring complete data",
    );
  }
  try {
    pi.registerProvider(providerId, {
      models: toProviderModels(result.models),
      // 断言理由见 `RefreshModelsFn` 的类型注释：pi 声明不收 undefined，实装收（R7 靠它）
      refreshModels: makeRefreshModels(state, providerId) as ProviderConfig["refreshModels"],
    });
    state.registered.add(providerId);
    logger.debug(
      `catalog overlay injected for ${providerId}: ${result.models.length} models `
      + "(builtin baseline ⊕ cache, state=fresh)",
    );
    return true;
  } catch (err) {
    // R4：结构校验失败等——不阻断其他 provider 的注入
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `registerProvider failed for ${providerId}: ${message} — the provider keeps pi's current `
      + `behavior; fix the catalog data source (${state.taijiPath}) — the next catalog refresh `
      + "retries the registration automatically, or restart the session to retry",
    );
    return false;
  }
}

/**
 * 对一拍计算结果中**尚未注册**的 provider 执行注入判定：fresh → 注册（挂钩子）；
 * 非 fresh → R5 debug 不注入。已注册的 provider 由其 `refreshModels` 钩子负责（R6/R7），
 * 此处跳过。工厂期（已注册集为空）与运行中对账共用。返回是否有新注册。
 */
function injectUnregistered(
  pi: ExtensionAPI,
  state: BridgeState,
  results: Map<string, ComputeInjectionSetResult>,
): boolean {
  let registered = false;
  for (const [providerId, result] of results) {
    if (state.registered.has(providerId)) continue;
    if (result.state !== "fresh") {
      // R5：过期（含远端 404/501 的否定信号）与从未见过都不注入——凭空造模型禁止
      logger.debug(
        `catalog overlay not injected for ${providerId}: state=${result.state} — `
        + "falling back to pi's builtin behavior",
      );
      continue;
    }
    if (registerFreshProvider(pi, state, providerId, result)) registered = true;
  }
  return registered;
}

// ──────────────────────── 入口 ────────────────────────

/** 工厂期入口的返回值：第三个监视条目的观测器 + 运行中窗口的注册对账入口（tick 挂载用）。 */
export type CatalogOverlayBridge = {
  /** 第三个监视条目的观测器（provider-live-sync 既有 tick 每拍调用一次）。 */
  readonly watcher: OverlayCacheWatcher;
  /**
   * 注册对账（tick 检出目录缓存变化后、触发刷新之前调用一次）：重算单拍，对
   * state=fresh 且尚未注册的 provider 补 `registerProvider`（挂同一 `refreshModels` 钩子）。
   *
   * 覆盖「工厂期 expired / never-seen / 损坏 → 运行中变 fresh」的跃迁——pi-ai
   * `ModelsStore.refresh` 只刷新带 `refreshModels` 的 provider，没有钩子的 provider 单靠
   * 刷新永远重建不了注入。工厂返回后的 `registerProvider` 直连注册表立即生效（PS-87）。
   *
   * 返回本次是否有新注册。read-failed 拍不动作：未注册的 provider 没有注入可建（R2 同款，
   * 读取层已记 warn），已注册的由各自钩子按 R7 保留。
   */
  reconcile(): boolean;
};

/**
 * 工厂期目录投喂入口（设计 D1）。
 *
 * 在扩展工厂函数体内**同步**完成注册：pi 的 `registerProvider` 在加载期只进
 * pending 队列，装配链在 `--model` 解析之前统一 flush + 本地 refresh（PS-81）。
 *
 * 返回值 = 第三个监视条目的观测器 + 运行中窗口的注册对账入口（供 provider-live-sync
 * 既有 tick 挂载：每拍 `watcher.observe()`，检出变化先 `reconcile()` 再刷新）；
 * R1（`TAIJI_AGENT_DATA_DIR` 缺失 = 非 taiji 托管环境）返回 null——调用方整条
 * 跳过，零文件访问、零注册，该 provider 自然落 never-seen、上层零投喂。
 */
export function injectCatalogOverlay(pi: ExtensionAPI): CatalogOverlayBridge | null {
  const taijiPath = getTaijiOverlayCachePath();
  if (taijiPath === null) return null; // R1：原生 pi 用户的 pass-through 设计态
  const storePath = getPiStorePath();
  const state: BridgeState = { taijiPath, storePath, registered: new Set(), cache: null };

  // 工厂期播种第三个监视条目的基线（读取前捕获 = 保守方向：最坏一次无害重复刷新，
  // 不会漏检）。首拍抑制的前提（「进程启动时 pi 已按磁盘配置建过快照」）只对既有
  // models.json/auth.json 两条目成立；第三个条目不成立——pi 不读目录缓存，扩展工厂期
  // 注入才是初始态，基线必须工厂期播种，否则「工厂期注入 → tick 1」约 2s 窗内的缓存
  // 变更会被 tick 首拍基线吞掉且此后 mtime 稳定即永不重检（运行中窗口 D5 断裂）。
  const initialObservation = observeMtime(taijiPath);

  const outcome = runPass(state);
  // R2 的损坏/不可读分支（read-failed）：本次不注入——没有已注入的集合可保。监视条目与
  // 对账入口照样返回：文件修复后 mtime 变化，下一拍 tick 的 reconcile 重建注入，不依赖
  // 重开会话（设计 §3.1 R2）
  if (outcome.status === "ok") injectUnregistered(pi, state, outcome.results);

  return {
    watcher: createOverlayCacheWatcher(taijiPath, initialObservation),
    reconcile: (): boolean => {
      const pass = runPass(state);
      if (pass.status === "read-failed") return false;
      return injectUnregistered(pi, state, pass.results);
    },
  };
}
