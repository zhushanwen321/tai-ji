/**
 * provider-live-sync —— 运行中 pi 进程的**模型快照实时同步**扩展。
 *
 * 问题（根因①）：pi 0.84.4 的可用模型集合冻结在 **spawn 时刻**——`set_model` 从
 * `session.modelRuntime.getAvailableSnapshot()` 解析（`dist/modes/rpc/rpc-mode.js:367-375`），
 * 该快照建于 `ModelRuntime.create()` 的 refresh（`dist/core/model-runtime.js:63-100`），
 * 而 pi 自身**没有文件 watcher、没有 refresh RPC**。于是「会话开着 → 在设置页新增 provider/
 * 模型/凭据 → 直接切到新模型」会报 `Model not found`（缺凭据与缺模型同文案），只能重开会话。
 *
 * 解法：本扩展按固定周期读 `<agentDir>/models.json` 与 `<agentDir>/auth.json`，**内容变化**时
 * 调 pi 自己的 `ctx.modelRegistry.refresh({ allowNetwork: false })`——`ModelRuntime.refresh()`
 * 首行即 `ModelConfig.load(modelsPath)` **重读磁盘配置**，随后 `rebuildProviders()` 按新配置重组
 * （`dist/core/model-runtime.js:501-513`），因此新增/删除 provider、模型与凭据都会立即生效；
 * `allowNetwork:false` 走本地恢复相位并在任何凭据解析/入网前返回（pi-ai `dist/models.js:153-158`）
 * ——**零网络请求**。
 *
 * 设计取舍（详见 docs 侧设计文档 §3.3 D3/D11/D12）：
 * - **轮询而非 fs.watch**：仓内 `skill-registry` 有 macOS `fs.watch` 触发率 ~40% 前科；轮询不依赖
 *   事件送达，无静默漏报面。代价 = 每进程 2 个小文件 / 2s 的只读 I/O。
 * - **按文件独立「存在性 + 内容」基线**：状态 = 缺失/存在 × 内容字节。① 持续缺失 = 非变化信号
 *   （**models.json 本就不存在是 catalog-only 安装的常态**，不能因此关停另一文件的比较）；
 *   ② 「曾存在 → 缺失」（quarantine / 外部删除窗口）→ 更新基线但**抑制 refresh**（否则会以空配置
 *   重建可用集合，把坏写放大成真正丢失）；③ 非 ENOENT 读失败（EACCES 等）→ 该文件本拍不比较、
 *   不覆盖基线（另一文件照常）；④ 内容变化 / 「不存在 → 存在」→ refresh。
 *   其中 `models.json` 的「曾存在 → 缺失」抑制是**持续**的（直到文件回归）——否则下一拍另一个文件的
 *   变更仍会触发 refresh 并应用空配置，保护形同虚设；`auth.json` 消失不威胁配置，按普通变化处理
 *   （凭据缺失自愈）。
 * - **基线推进与 refresh 成败无关**：刷新抛错也不回退基线，否则同一坏内容会每拍刷新 + 每拍报错。
 * - **不解析文件内容**：纯字节比较，判定权全交 pi（pi 对 JSONC/BOM 的宽容与本扩展无关）。
 * - **错误可见性靠 pi 自己的诊断**：`refresh()` 只返回 `{aborted, errors}`，本退化类
 *   （models.json 解析失败 / schema 非法）实测 `errors.size=0`、`aborted=false`——**唯一有效判据是
 *   `ctx.modelRegistry.getError()`**（`dist/core/model-runtime.js:305-317` 合成 config error +
 *   per-provider composition error）。非空即原样落 ERROR 日志（不解析、不分类、不新增判定层）。
 * - **定时器 unref**：不阻止 pi 进程退出。
 *
 * 可配置项：无（轮询周期 2s 为设计标定值；如需调整请改本包常量并同步设计文档）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 轮询周期（ms）。设计标定：内容变更到生效的上界 ≈ 2s，小于「保存 → 切回会话 → 点选」的人工时延。 */
export const POLL_INTERVAL_MS = 2_000;

/** 受监视的两个配置文件（pi 的 models.json 授权源 + auth.json 凭据源）。 */
export const WATCHED_FILES = ["models.json", "auth.json"] as const;
export type WatchedFile = (typeof WATCHED_FILES)[number];

/** 单文件观察状态：读失败（非 ENOENT）与「文件不存在」是两种不同的态，不可混为一谈。 */
export type FileObservation =
  | { state: "present"; content: string }
  | { state: "absent" }
  | { state: "unreadable" };

/** 单文件基线（上一拍成功观察到的态）。 */
export type FileBaseline = { state: "present"; content: string } | { state: "absent" };

export interface Snapshot {
  baselines: Map<WatchedFile, FileBaseline>;
  /** 是否至少成功比较过一次（首拍只建基线，不触发 refresh）。 */
  initialized: boolean;
  /**
   * **曾存在 → 缺失且尚未恢复**的文件（quarantine / 外部删除窗口）。
   *
   * 抑制是**持续**的（不是一拍）：只要 `models.json` 处于这个集合里，任何 refresh 都会重读磁盘、
   * 以「无 override 的空配置」重建可用集合——把一次坏写放大成用户自定义 provider 的**真正丢失**
   * （设计 D3②/§3.6「『曾存在 → 缺失』跃迁抑制 refresh」）。恢复 = 该文件重新出现（内容变化）
   * 或会话重启（spawn 期重读）。
   *
   * 只对 `models.json` 生效：`auth.json` 消失不威胁配置本身（凭据缺失是自愈的——文件写回后
   * 下一拍 refresh 即恢复），按普通内容变化处理，避免「凭据变更被静默丢弃」。
   */
  suppressed: Set<WatchedFile>;
}

export type SyncDecision =
  | { action: "none"; reason: "no-baseline" | "unchanged" | "all-unreadable" }
  | { action: "refresh"; changedFiles: WatchedFile[] }
  | { action: "skip-missing"; missingFiles: WatchedFile[] };

/** 读单个受监视文件：ENOENT → absent；其它错误 → unreadable（含权限、I/O 故障）。 */
export async function readObservation(agentDir: string, file: WatchedFile): Promise<FileObservation> {
  try {
    const content = await readFile(join(agentDir, file), { encoding: "utf8" });
    return { state: "present", content };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { state: "absent" };
    return { state: "unreadable" };
  }
}

/**
 * 对比观察与基线，产出本拍决策**并就地推进基线**（按文件独立）。
 *
 * 规则（与设计 D3 逐条对应，顺序即优先级）：
 * 1. `unreadable` → 该文件不参与比较、基线不动（另一文件照常）；
 * 2. 与基线同态（present 内容相同 / 双双 absent）→ 变化集不含该文件；
 * 3. `present → absent`（曾存在、现在缺失）→ 记入 missing（调用方抑制 refresh 且只记一行）；
 * 4. `absent → present` 或 present 内容变化 → 记入 changed（触发 refresh）；
 * 5. 基线推进发生在**决策产出时**，与 refresh 成败无关。
 */
export function evaluateSnapshot(
  snapshot: Snapshot,
  observations: Map<WatchedFile, FileObservation>,
): SyncDecision {
  const changedFiles: WatchedFile[] = [];
  const missingFiles: WatchedFile[] = [];
  let comparable = 0;

  for (const file of WATCHED_FILES) {
    const obs = observations.get(file);
    if (!obs || obs.state === "unreadable") continue;
    comparable += 1;
    const prev = snapshot.baselines.get(file);

    if (obs.state === "present") {
      if (snapshot.suppressed.delete(file)) {
        // 文件回来了（隔离副本被写回 / 用户重新保存）→ 视为变化，恢复正常刷新。
        changedFiles.push(file);
      } else if (!prev || prev.state !== "present" || prev.content !== obs.content) {
        changedFiles.push(file);
      }
      snapshot.baselines.set(file, { state: "present", content: obs.content });
      continue;
    }

    // obs.state === "absent"
    if (prev?.state === "present") {
      if (file === "models.json") {
        // 配置源消失：抑制**整拍**刷新（refresh 会以空配置重建可用集合）；抑制持续到文件回归。
        snapshot.suppressed.add(file);
        missingFiles.push(file);
      } else {
        // auth.json 消失：不威胁 provider 配置，按普通变化处理（凭据缺失自愈——写回即恢复）。
        changedFiles.push(file);
      }
    } else if (snapshot.suppressed.has(file)) {
      // 仍在抑制窗口内（持续缺失）：保持抑制，逐拍静默（只在跃迁那一拍有日志）。
      missingFiles.push(file);
    }
    // 持续缺失（且从未出现过）= catalog-only 常态 → 非变化信号，基线保持 absent。
    snapshot.baselines.set(file, { state: "absent" });
  }

  if (comparable === 0) return { action: "none", reason: "all-unreadable" };
  // 抑制优先于一切：配置源缺失窗口内绝不 refresh（宁可让引擎保留最后一份好快照）。
  if (snapshot.suppressed.has("models.json")) return { action: "skip-missing", missingFiles: ["models.json"] };
  if (changedFiles.length === 0 && missingFiles.length === 0) {
    return { action: "none", reason: "unchanged" };
  }
  if (changedFiles.length === 0) return { action: "skip-missing", missingFiles };
  return { action: "refresh", changedFiles };
}

/** 供上层（与测试）复用的结构化日志前缀。 */
export const LOG_PREFIX = "[provider-live-sync]";

/**
 * 日志出口 = stderr（仓内 extension 既有范式：cache-probe / structured-output 同款——
 * extension 的 no-console 规则要求；pi 会把 extension stderr 并入宿主运行日志）。
 * stderr 已销毁（EPIPE）时错误走流 error 事件而非同步 throw，无需兜底 catch。
 */
function logError(message: string): void {
  process.stderr.write(`${LOG_PREFIX} ERROR ${message}\n`);
}

function logInfo(message: string): void {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

export default function providerLiveSync(pi: ExtensionAPI): void {
  const snapshot: Snapshot = { baselines: new Map(), initialized: false, suppressed: new Set() };
  /** ctx 每次 session_start 重新捕获（pi 可能换实例；未就绪时本拍跳过且不推进基线）。 */
  let ctx: ExtensionContext | null = null;
  let timer: NodeJS.Timeout | null = null;
  /** 「曾存在 → 缺失」状态跃迁去重：只在跃迁那一拍记日志，持续缺失零输出。 */
  const missingLogged = new Set<WatchedFile>();

  pi.on("session_start", (_event, sessionCtx) => {
    ctx = sessionCtx;
  });

  const tick = async (): Promise<void> => {
    const currentCtx = ctx;
    if (!currentCtx) return; // 会话未就绪：本拍跳过且不推进基线（下拍重试，无 dirty 状态机）
    try {
      const agentDir = getAgentDir();
      const observations = new Map<WatchedFile, FileObservation>();
      for (const file of WATCHED_FILES) {
        observations.set(file, await readObservation(agentDir, file));
      }
      const decision = evaluateSnapshot(snapshot, observations);
      if (decision.action === "skip-missing") {
        for (const file of decision.missingFiles) {
          if (!missingLogged.has(file)) {
            missingLogged.add(file);
            logError(
              `config file disappeared: ${file} — refresh suppressed until it is written again `
              + "(rebuilding from an empty config would drop the user's custom providers from the running "
              + "engine; it keeps its last good snapshot meanwhile; restarting the session also recovers).",
            );
          }
        }
        return;
      }
      for (const file of WATCHED_FILES) missingLogged.delete(file);
      if (decision.action !== "refresh") return;
      // 首个基线拍不刷新（进程启动时 pi 已按磁盘配置建过快照，重复刷新纯浪费）。
      const firstBaseline = !snapshot.initialized;
      snapshot.initialized = true;
      if (firstBaseline) return;

      logInfo(`config change detected (${decision.changedFiles.join(", ")}) → refreshing model snapshot`);
      const result = await currentCtx.modelRegistry.refresh({ allowNetwork: false });
      // 有效判据 = getError() 全文（本退化类 errors.size/aborted 恒为空/假，见模块头注释）。
      const error = currentCtx.modelRegistry.getError();
      if (error) {
        logError(`model config rejected by the engine (models.json / auth.json): ${error}`);
      } else if (result.errors.size > 0 || result.aborted) {
        logError(`refresh finished with errors (aborted=${String(result.aborted)}, providers=${result.errors.size})`);
      }
    } catch (err) {
      // 轮询绝不自杀：本拍失败下一拍继续（内容未变则基线已推进 → 不会重复刷新同一内容）。
      const message = err instanceof Error ? err.message : String(err);
      logError(`tick failed: ${message}`);
    }
  };

  const schedule = (): void => {
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, POLL_INTERVAL_MS);
    timer.unref();
  };

  // 首拍只建基线（不 refresh）；此后每拍比较。（pi 无 extension 生命周期 shutdown 钩子，
  // 进程退出时 unref 定时器自然消失。）
  schedule();
}
