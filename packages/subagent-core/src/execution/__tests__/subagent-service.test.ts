// src/__tests__/subagent-service.test.ts
//
// SubagentService 生命周期 + 公共 API 边界测试（[H3/R5 测试归位] 本文件为壳级测试：
// 装配 / dispose 编排 / 转发侧 / 跨域 emit 记账。run 域 execute 入口用例已迁
// run-orchestration.test.ts；ModelConfigService ctxModel 缓存已迁
// model-config-service.test.ts）。
//
// 范围:initSession / dispose / query / cancel / listRunning / collectRecords /
// onChange / assertReady -- 这些不依赖动态 import Pi SDK(getSdk)。
//
// execute() 因 buildSessionRunnerContext 会动态 import session-runner → getSdk(),
// 在单测环境无法提供真实 SDK,留给集成测试(见文件末尾 TODO)。
//
// 策略:用真实 ModelConfigService 指向 os.tmpdir() 空目录(loadGlobalConfig
// 对不存在文件返回默认配置,AgentRegistry 空目录也安全),mock PiLike。
//
// [round5-g 合并产物] 吸收 SubagentService 壳级行为姊妹件四件（logger 桩提升为
// 公共；makeTmpAgentDir 统一用本文件版；parent-guard 的 ServiceInternals 改名
// ParentGuardInternals 消歧）：
// - delivery-methods.test.ts（chat 投递车道与并发检查）
// - subagent-service-notify-gate.test.ts（notify 门二元组 + idleTimeoutMs fail-fast）
// - subagent-service-parent-guard.test.ts（getRecordForAction 直接父校验）
// - subagent-service-model-switch.test.ts（setModel 壳接线）

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../persistence/execution-record.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { ModelInfo } from "../assembly/model-resolver.ts";
import type { UiRequest, UiRequestHandler } from "../ui/dialog-queue.ts";
import { SubagentService } from "../subagent-service.ts";
// [H3/R6] 单例访问器外移支撑文件 service/service-bootstrap.ts（壳不再导出）。
import { getSubagentService, setSubagentService } from "../service/service-bootstrap.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import { makePi, type PiMock } from "./helpers/pi-mock.ts";
import { clearEngines } from "../engine/registry.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import * as lifecycle from "../lifecycle/lifecycle-manager.ts";
import { notifyGateAllowsDelivery } from "../subagent-service.ts";
import { MAX_TIMER_DELAY_MS } from "../../shared/timer-delay.ts";
import { RecordStore } from "../persistence/record-store.ts";
import type { ChildProcess } from "node:child_process";
import type { ModelRegistryLike } from "../assembly/model-resolver.ts";
import {
  _resetCoreSpawnedChildrenMirrorForTest,
  registerSpawnedChildForRecord,
} from "../engine/host/spawned-children.ts";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// ── 工具:建临时 agentDir + 真实 ModelConfigService ──

function makeTmpAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
  // agentDir/subagents/ 子目录(config 默认路径会用,空即可)
  return dir;
}

function makeModelService(agentDir: string): ModelConfigService {
  return new ModelConfigService({ agentDir, cwd: agentDir });
}

describe("SubagentService", () => {
  let agentDir: string;
  let modelService: ModelConfigService;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    modelService = makeModelService(agentDir);
    // [session-store-layout-inversion] 生产 store 目录经
    // getSubagentSessionDir(resolveStoreRootSessionId())（env dataDir 兜底）解析——
    // stubEnv 把写删目标收进本 mkdtemp 目录并保证用例间零残留（本文件用例绑同一
    // initSession sid "s1"，不注入则 records 树跨用例共享、重建互染，空目录断言漂移）。
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", agentDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // ============================================================
  // 构造 + 生命周期
  // ============================================================

  describe("构造 + 生命周期", () => {
    it("构造不抛错(空 agentDir,默认 config)", () => {
      expect(() => new SubagentService({ cwd: agentDir, modelService })).not.toThrow();
    });

    it("未 initSession 时 findRecord/cancel 抛 'pi not injected'", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      expect(() => service.queries.findRecord("any")).toThrow(/pi not injected/);
      expect(() => service.cancel("any")).toThrow(/pi not injected/);
    });

    it("initSession 后 assertReady 通过(findRecord 不再抛 pi 错,返回 undefined)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      // findRecord 现在能过 assertReady,但 record 不存在 → 返回 undefined
      expect(service.queries.findRecord("missing")).toBeUndefined();
    });

    it("dispose 后 findRecord 抛含 'disposed' 且带恢复指引", () => {
      // [HISTORICAL] 旧实现只抛 "hub disposed"--无信息,调用方和 AI 盲猜。
      // 现错误信息必须含原因 + 恢复指引,让 AI/user 知道要重启会话而非重试。
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      service.dispose();
      expect(() => service.queries.findRecord("any")).toThrow(/disposed/);
      expect(() => service.queries.findRecord("any")).toThrow(/session ended|session_start|new session/i);
    });

    it("dispose 回收 session 句柄：替换窗口内迟到的写侧不触达 stale pi（不崩进程）", () => {
      // [HISTORICAL] 2026-09-22 真机崩溃（登记见 已归档设计档案 §1.4，已根治）：
      // session 替换（newSession/fork）后 pi 旧 handle 全方法抛 stale 错（runner.invalidate
      // → assertActive），单例 Service 的 _pi 残留指向旧 session——替换窗口内迟到的
      // 异步收尾（轮终 markRoundIdle 簿记⑧ pending 注销 / 迟到 register 的 appendEntry）
      // 触达它即抛未捕获异常崩 runtime。根治 = dispose 尾部 invalidatePiBinding 作废
      // 绑定（_piUsable 翻假 + store pi 置 null），消费点经 `pi?.` 短路为 no-op。
      const STALE_MSG = "This extension ctx is stale after session replacement or reload.";
      const stalePi = makePi();
      stalePi.appendEntry.mockImplementation(() => {
        throw new Error(STALE_MSG);
      });
      stalePi.events.emit.mockImplementation(() => {
        throw new Error(STALE_MSG);
      });
      stalePi.sendMessage.mockImplementation(() => {
        throw new Error(STALE_MSG);
      });

      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: stalePi, sessionId: "s1" });
      service.dispose();
      // dispose 后 queries 面被 disposed 检查拦截（上一用例锚定），迟到写侧走 store 直驱
      const store = Reflect.get(service, "store") as RecordStore;

      // 替换窗口内迟到的 record 写侧（形态：dispose 未覆盖到的 running record 收尾）
      const record = createRecord("late-round", {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        task: "late task",
        slug: "late",
        startedAt: 1_000_000,
        rootSessionId: "s1",
      });
      // register 的 appendEntry 上报 + markRoundIdle 簿记⑧ pending 注销——句柄已回收，
      // 两路都不触达 stale pi（修复前：直接抛 STALE_MSG → 崩进程）
      expect(() => store.register(record)).not.toThrow();
      expect(() =>
        store.markRoundIdle("late-round", { kind: "success", content: "late round done" }),
      ).not.toThrow();
      // 簿记⑧ 确实走到了（record 翻边 idle）——no-op 是句柄短路不是路径没走
      expect(Reflect.get(store, "records").get("late-round").status).toBe("idle");
    });

    it("dispose 幂等(多次调用不抛)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(() => {
        service.dispose();
        service.dispose();
        service.dispose();
      }).not.toThrow();
    });

    it("initSession 可 revive 已 dispose 的 service", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      service.dispose();
      // revive
      service.initSession({ pi: makePi(), sessionId: "s2" });
      // 现在 assertReady 又通过(findRecord 返回 undefined 而非 disposed)
      expect(service.queries.findRecord("any")).toBeUndefined();
    });
  });

  // ============================================================
  // findRecord / cancel 边界
  // ============================================================

  describe("findRecord / cancel 边界 (T4)", () => {
    it("findRecord 不存在的 id 返回 undefined", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(service.queries.findRecord("nonexistent-id")).toBeUndefined();
    });

    it("cancel 不存在的 id 返回 false(不抛错,boolean 契约不变)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(service.cancel("nonexistent-id")).toBe(false);
    });
  });

  // ============================================================
  // 状态查询
  // ============================================================

  describe("状态查询", () => {
    // [D4] listRunning 已从 Service 删除（零生产调用方）——初始空态语义由
    // collectRecords 用例与 store 层 listRunning 测试覆盖。

    it("collectRecords 返回数组(空 sessions 目录时为空)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      const records = service.queries.collectRecords(100);
      expect(records).toEqual([]);
    });

    it("onChange 返回 unsubscribe 函数,调用后停止通知", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      const listener = vi.fn();
      const unsubscribe = service.queries.onChange(listener);
      expect(typeof unsubscribe).toBe("function");
      // 正向通路：store 变更必须通知 listener（通知链断裂时此处红——
      // 修复前本用例只验 unsubscribe 可调用，「停止通知」无从验证）
      const store = Reflect.get(service, "store") as RecordStore;
      const record = createRecord("notify-probe", {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        slug: "notify-probe",
        task: "notify probe",
        startedAt: 1_000_000,
        rootSessionId: "s1",
      });
      store.register(record);
      expect(listener).toHaveBeenCalledTimes(1);
      // 退订后变更不再通知
      unsubscribe();
      store.register(
        createRecord("notify-probe-2", {
          agent: "general-purpose",
          model: "test/model",
          mode: "background",
          slug: "notify-probe-2",
          task: "notify probe 2",
          startedAt: 1_000_000,
          rootSessionId: "s1",
        }),
      );
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // resolveModel 代理
  // ============================================================

  describe("resolveModel 代理", () => {
    it("代理到 modelService.resolveModel(未 init 时抛错)", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      // 未 init modelRegistry → resolveModel 拋错(fail-fast)
      expect(() => service.resolveModel("worker")).toThrow(/modelRegistry not injected/);
    });
  });

  // ============================================================
  // 进程单例访问器
  // ============================================================

  describe("进程单例访问器", () => {
    // 保存/恢复单例,避免污染其他测试(setSubagentService 类型不接受 null)
    const original = getSubagentService();
    afterEach(() => {
      if (original) setSubagentService(original);
    });

    it("setSubagentService / getSubagentService 读写一致", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      setSubagentService(service);
      expect(getSubagentService()).toBe(service);
    });
  });

  // ============================================================
  // dispose abort 子进程（R0-D：孤儿进程治理）
  // ============================================================
  //
  // [R0] 进程退出路径：SubagentService.dispose 调 store.abortRunningControllers()，
  // 触发所有 running background record 的 controller.abort() → runSpawn signal listener
  // → child.kill("SIGTERM")，防止主进程退出后 background 子进程成孤儿。
  //
  // 被测方法在 service 层，不需要 mock spawn——直接构造 record 注册到 store。
  // store 是 private 字段，用 Reflect.get 取（与 execute-nesting.test.ts 访问 pool 同模式）。

  describe("dispose abort 子进程 (R0-D)", () => {
    /** 从 service 取出 private store（测试注入 running record 用）。 */
    function getStore(service: SubagentService): RecordStore {
      return Reflect.get(service, "store") as RecordStore;
    }

    /** 构造一个 running background record（带 controller）并注册到 store。 */
    function registerRunningBackground(service: SubagentService, id: string): ExecutionRecord {
      const controller = new AbortController();
      const record = createRecord(id, {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        slug: "t",
        task: "long task",
        startedAt: 1_000_000,
        rootSessionId: "s1",
        controller,
      });
      // createRecord 默认 status="running"；background record 持有 controller。
      getStore(service).register(record);
      return record;
    }

    /** 构造一个 running sync record（无 controller）并注册到 store。 */
    function registerRunningSync(service: SubagentService, id: string): ExecutionRecord {
      const record = createRecord(id, {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        task: "sync task",
        slug: "test",
        startedAt: 1_000_000,
        rootSessionId: "s1",
        // sync 不传 controller → controller === undefined
      });
      getStore(service).register(record);
      return record;
    }

    /** 构造一个终态 background record 并注册（用于「无 running」场景）。 */
    function registerTerminalBackground(service: SubagentService, id: string): ExecutionRecord {
      const controller = new AbortController();
      const record = createRecord(id, {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        slug: "t",
        task: "done task",
        startedAt: 1_000_000,
        rootSessionId: "s1",
        controller,
      });
      // 直接改 status 模拟终态（不走 CAS——测试不关心状态机，只关心 dispose 的 abort 过滤）
      record.status = "idle";
      getStore(service).register(record);
      return record;
    }

    it("dispose 时有 running background record → controller 被 abort", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      const record = registerRunningBackground(service, "bg-1");

      // 前置：dispose 前 controller 未 abort
      expect(record.controller!.signal.aborted).toBe(false);

      service.dispose();

      // dispose 后 controller 被 abort → runSpawn 的 signal listener 会 kill 子进程
      expect(record.controller!.signal.aborted).toBe(true);
    });

    it("dispose 时无 running record → 不报错，正常清理", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      // 全是终态 record（无 running），dispose 不应抛
      registerTerminalBackground(service, "bg-done-1");

      expect(() => service.dispose()).not.toThrow();
    });

    it("dispose 已 dispose → 幂等（重复调用不抛，不重复 abort）", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      const record = registerRunningBackground(service, "bg-2");

      service.dispose();
      expect(record.controller!.signal.aborted).toBe(true);

      // 第二次 dispose：service 已 _disposed，early-return，abortRunningControllers 不再调
      // （即使调了也无害——已 abort 的 controller.abort() 是幂等 noop）
      expect(() => service.dispose()).not.toThrow();
      expect(record.controller!.signal.aborted).toBe(true);
    });

    it("sync record（无 controller）→ dispose 跳过（不因 undefined controller 出错）", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      // sync record 的 controller 是 undefined，running 状态下 dispose 不应抛
      // （abortRunningControllers 检查 r.controller 才 abort，sync 跳过）
      // [C1] sync 子进程的 kill 由 markAllSpawnedChildrenDead 兜底（spawnedChildren Set 注册），
      //      集成验证见 run-spawn-integration.test.ts 的 C1 用例（mock spawn + spy kill）。
      const syncRecord = registerRunningSync(service, "sync-1");
      expect(syncRecord.controller).toBeUndefined();

      expect(() => service.dispose()).not.toThrow();
    });
  });

  // ============================================================
  // dispose uiRequestHandler stub（dispose-cleanup Minor 优化1）
  // ============================================================
  //
  // [背景] Pi 单进程 session 串行接管。session A shutdown 发 SIGTERM 后、子进程彻底
  // close 前（graceful shutdown 窗口几十~几百 ms），子进程的 trailing extension_ui_request
  // 仍会被父进程 pump 解析，调到 A 的 handler 闭包（仍持有 A 的 ctx）。旧实现 dispose 不清
  // uiRequestHandler，该闭包触发 inproc UI 请求队列（已删） catch 分支打 `[subagents] uiRequestHandler
  // threw` 误导性 console.error。dispose 现注入 stub（始终返回 {cancelled:true}），让 trailing
  // ui_request 干净降级，不再走旧 handler 闭包。
  //
  // 被测点是 SubagentService.dispose 内的 setUiRequestHandler(stub)。uiRequestHandler 是
  // private 字段，用 Reflect.get 取（与 R0-D 块访问 store 同模式）。

  describe("dispose uiRequestHandler stub (dispose-cleanup)", () => {
    /** 从 service 取出 private uiRequestHandler（trailing ui_request 实际调用入口）。
     *  [R1 深绑改写] uiRequestHandler 随域 #2 聚合迁入 SessionBaselines，深绑路径改为
     *  service → baselines 聚合实例（断言对象与强度不变，路径对齐终态结构）。 */
    function getHandler(service: SubagentService): UiRequestHandler | undefined {
      return (Reflect.get(service, "baselines") as { uiRequestHandler: UiRequestHandler | undefined }).uiRequestHandler;
    }

    /** 最小 UiRequest（method 无关紧要——stub 不论 method 一律返回 cancelled）。 */
    function makeTrailingRequest(id: string): UiRequest {
      return { method: "notify", id };
    }

    it("dispose 后 uiRequestHandler 被 stub 替换，调用返回 {cancelled:true} 不抛错", async () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      service.dispose();

      const handler = getHandler(service);
      expect(handler).toBeDefined();
      // 模拟 dispose 后子进程 trailing ui_request 被父进程 pump 调到 handler
      await expect(handler!(makeTrailingRequest("trailing-1"))).resolves.toEqual({ cancelled: true });
    });

    it("dispose stub 覆盖旧 handler：trailing ui_request 不产生 [subagents] console.error 噪声", async () => {
      // 模拟 session A 的真实 handler 闭包——在 ctx 已 disposed 后调用会抛错
      const staleHandler: UiRequestHandler = async () => {
        throw new Error("stale ctx");
      };
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      // [D4-④] setUiRequestHandler 已删——handler 注入走 initSession 参数（唯一入口）
      service.initSession({ pi: makePi(), sessionId: "s1", uiRequestHandler: staleHandler });

      service.dispose();

      // dispose 后 handler 应被 stub 替换，不再是 staleHandler
      const handler = getHandler(service);
      expect(handler).not.toBe(staleHandler);

      // trailing ui_request 调到的是 stub，不抛错、返回 cancelled
      await expect(handler!(makeTrailingRequest("trailing-2"))).resolves.toEqual({ cancelled: true });

      // 关键价值断言：无 "[subagents] uiRequestHandler threw" 误导性噪声
      // （旧实现 dispose 不清 handler 时，trailing ui_request 走 staleHandler 抛错 →
      //   inproc UI 请求队列（已删） catch 打该日志。stub 覆盖后该路径不再触发。）
      const subagentsErrors = errorSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === "string" && args[0].includes("[subagents]"),
      );
      expect(subagentsErrors).toHaveLength(0);

      errorSpy.mockRestore();
    });
  });

  // ============================================================
  // execute() worktree 路径（worktree 与 fork 解耦）
  // → [H3/R5 测试归位] 整块迁至 run-orchestration.test.ts（run 域聚合同名域测试
  //   文件；用例名与断言零改动）。此处不留转发桩——vitest 按文件发现，无注册点。
  // ============================================================

  //
  // [背景] PR #82 在 subagent-service.ts 新增 emitPendingRegister/Unregister 调用，
  // 5 个 emit 点：register（execute L309）、unregister(failed)（finalizeFailed 经
  // finalizeRecord）、unregister(cancelled)（cancelBackground）、unregister(done)
  //（finalizeRecord 正常完成）、worktree-fail（finalizeFailed 路径，reason=failed）。
  // 此前本文件对这些 emit 零断言，本块补齐。
  //
  // [覆盖策略] 本块覆盖不依赖 runSpawn 完成的 emit 路径：
  //   - register emit：execute 内 createRecordForMode 之后立即触发，在 worktreeManager.create
  //     之前。用 worktree:true+fork:true 让 worktreeManager.create 在测试环境（agentDir 非 git
  //     repo → git status 抛错）失败，既触发 register emit，又顺路走 finalizeFailed →
  //     unregister(failed)。（T2 Wave 0 后只有 background 模式。）
  //   - unregister(cancelled)：cancelBackground 路径。手动注入 running background record 后
  //     调公共 cancel(id) API，无需 runSpawn（覆盖场景 4）。
  //
  // [未覆盖路径] 需 mock spawn 才能跑完 runSpawn 的路径，本文件约定不 mock spawn
  // （见文件头——execute 集成测试在 execute-nesting.test.ts / run-spawn-integration.test.ts）：
  //   - finalizeRecord status="closed"（background 正常完成 → unregister(closed)）
  //   - finalizeRecord status="cancelled" 经 runAndFinalize 路径（cancel 抢先 CAS 时
  //     runAndFinalize 侧 trySettleLegacyClosed 失败跳过 finalizeRecord，由 cancelBackground 侧 emit——
  //     本块 cancel 用例覆盖的即此后端 emit）
  //   - background detached 正常完成回注（finalizeRecord → emitPendingUnregister(done, {result,error,patchFile})）
  // register emit 的 payload（type:"subagent"、name）由本块 worktree-fail 路径附带覆盖。

  describe("pending-notifications emit 断言 (H4)", () => {
    /** 构造已就绪 service（initSession + initModel）并保留 pi 引用以断言 events.emit。 */
    function makeReadyServiceWithPi(): {
      service: SubagentService;
      pi: PiMock;
    } {
      const pi = makePi();
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi, sessionId: "s1" });
      // 注入 modelRegistry + ctxModel：让 resolveIdentity 越过 resolveModel，
      // 使 worktreeManager.create（git status 在非 repo 抛错）成为稳定失败点，
      // 而非 modelService.resolveModel 抛错（那会在 record 创建之前，无法触发 register emit）。
      modelService.initModel({
        modelRegistry: {
          getAvailable: () => [],
          find: () => undefined,
          hasConfiguredAuth: () => false,
        },
        sessionId: "s1",
        ctxModel: { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false },
      });
      return { service, pi };
    }

    /** 从 service 取出 private store（手动注入 running record 用，与 R0-D 块同模式）。 */
    function getStore(service: SubagentService): RecordStore {
      return Reflect.get(service, "store") as RecordStore;
    }

    /** 手动构造 running background record（带 controller）并注册到 store（绕过 execute/spawn）。 */
    function injectRunningBackground(service: SubagentService, id: string): ExecutionRecord {
      const controller = new AbortController();
      const record = createRecord(id, {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        slug: "t",
        task: "cancel target",
        startedAt: 1_000_000,
        rootSessionId: "s1",
        controller,
      });
      getStore(service).register(record);
      return record;
    }

    const ctxModel: ModelInfo = { id: "ctx-model", name: "Ctx", provider: "p", reasoning: false };

    it("background execute + worktree 创建失败 → register(bg-id) + unregister(failed) 携带 error 被 emit", async () => {
      const { service, pi } = makeReadyServiceWithPi();

      const handle = await service.execute({
        task: "wt fail bg",
        slug: "test",
        worktree: true,
        fork: true,
        ctxModel,
      });

      // worktree create 抛错在轮次 kick-off 之前（executeViaEngine 同步 catch），返回 background 形状
      expect(handle.mode).toBe("background");

      // createRecordForMode 生成的 subagentId 带 sa- 前缀（sa-<uuid>）
      expect(handle.subagentId).toMatch(/^sa-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      // register emit：background mode → id 是 sa-<uuid> 格式
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:register",
        expect.objectContaining({
          type: "subagent",
          id: expect.any(String),
          name: "general-purpose",
        }),
      );
      // [U5] 失败轮 settle（markRoundIdle）簿记⑧结清（[subagent-observability
      // §3.3.6 结清枚举新写入方] reason=failed——轮失败结清按轮终事实产出；旧恒发
      // 字面量 running 随写入方退役；旧 finalizeRecord emitUnregister(closed) 随终态化退役）
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ reason: "failed" }),
      );
    });

    it("cancel(background) → unregister(reason=interrupted) 被 emit（[U5] cancel = 中断轮 settle，不终态化）", () => {
      const { service, pi } = makeReadyServiceWithPi();
      const record = injectRunningBackground(service, "bg-cancel-1");
      expect(record.status).toBe("running");

      const ok = service.cancel("bg-cancel-1");

      // cancel CAS 抢锁成功 → cancelBackground 完整收尾 + emit
      expect(ok).toBe(true);
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-cancel-1", reason: "interrupted" }),
      );
      // record 手动注入（未走 execute）→ register 不应被 emit
      expect(pi.events.emit).not.toHaveBeenCalledWith("pending:register", expect.anything());

      service.dispose();
    });

    // ── T-NFR-8 dispose emit pending:unregister(reason=failed) ──
    //
    // [T2 AC-4.3 双重记账一致性] 进程退出时 running record 随 detached promise 丢弃，
    // finalizeRecord 不会再跑。dispose 中为每个 running record emit pending:unregister，
    // 让 pending-notifications 清理 registry entry，避免两侧状态不一致。
    // 此组验证该 emit 路径。

    it("T-NFR-8: dispose 时每个 running record 都 emit pending:unregister(reason=completed)（[U5] 编排性关闭=收尾写入 journal 记录）", () => {
      const { service, pi } = makeReadyServiceWithPi();
      injectRunningBackground(service, "bg-dispose-1");
      injectRunningBackground(service, "bg-dispose-2");
      injectRunningBackground(service, "bg-dispose-3");

      service.dispose();

      // 每个 running record 都 emit 了 pending:unregister（[U5] reason=completed——
      // 收尾点补发注销，承接原 emitUnregister 语义挂载收尾写入 journal 记录原语）
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-dispose-1", reason: "completed" }),
      );
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-dispose-2", reason: "completed" }),
      );
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-dispose-3", reason: "completed" }),
      );
    });

    it("T-NFR-8: dispose emit 次数 = running record 数（终态 record 不重复 emit）", () => {
      const { service, pi } = makeReadyServiceWithPi();
      // 2 个 running + 1 个终态
      injectRunningBackground(service, "bg-running-1");
      injectRunningBackground(service, "bg-running-2");
      const terminal = injectRunningBackground(service, "bg-done");
      terminal.status = "idle"; // 模拟终态，dispose 不应为其 emit

      service.dispose();

      // 统计 pending:unregister 调用次数
      const unregisterCalls = pi.events.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "pending:unregister",
      );
      // 只有 2 个 running record emit，终态的 bg-done 不 emit
      expect(unregisterCalls).toHaveLength(2);
      // 确认终态 record 未被 emit
      expect(pi.events.emit).not.toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-done" }),
      );
    });
  });
});

// ============================================================
// ModelConfigService ctxModel 缓存(renderCall 标题行 model 显示的核心)
// → [H3/R5 测试归位] 整块迁至 model-config-service.test.ts（被测主体 =
//   ModelConfigService 模块，非 SubagentService；用例名与断言零改动）。
// ============================================================

// ============================================================
// execute() 集成测试 — 已由 execute-integration.test.ts 覆盖
// ============================================================
// 原先此处的 TODO 已落地为 src/__tests__/execute-integration.test.ts（12 用例），
// 通过 mock 最底层的 SDK 边界（session-runner.getSdk → fakeSdk）跑通完整编排链路：
//   - sync happy / sync error / createAgentSession 失败（finalizeFailed）
//   - background 启动 / background cancel CAS（running 成功 + 已终态 false）
//   - dispose flush（sliding window 内 pending notification）
//   - run() 事件累积（turn_end / message_end usage / tool_start+end / error stopReason）
//   - sync signal abort → cancelled
//   - schema enforcement steer（漏调 structured-output）
// 同时覆盖 session-runner.run() —— event-bridge 合并进 run() 后的事件处理回归。

// ============================================================
// [§1.4 (a)] pi 绑定作废（invalidatePiBinding）：壳层的转发逻辑 + dispose 收尾作废
// ============================================================

describe("[§1.4 (a)] pi 绑定作废（dispose 收尾 + 显式作废转发）", () => {
  let agentDir: string;
  let modelService: ModelConfigService;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    modelService = makeModelService(agentDir);
    // [session-store-layout-inversion] 生产 store 目录经
    // getSubagentSessionDir(resolveStoreRootSessionId())（env dataDir 兜底）解析——
    // stubEnv 把写删目标收进本 mkdtemp 目录并保证用例间零残留（本文件用例绑同一
    // initSession sid "s1"，不注入则 records 树跨用例共享、重建互染，空目录断言漂移）。
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", agentDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** baselines 私有字段读侧（深绑测试先例：Reflect.get(service, "字段")）。 */
  function baselinesOf(service: SubagentService): { pi: unknown; piGeneration: number } {
    return Reflect.get(service, "baselines") as { pi: unknown; piGeneration: number };
  }

  it("initSession 注入后 invalidatePiBinding 作废 → 读侧 null；再 initSession 新代际恢复", () => {
    const service = new SubagentService({ cwd: agentDir, modelService });
    const pi1 = makePi();
    service.initSession({ pi: pi1, sessionId: "s1" });
    expect(baselinesOf(service).pi).toBe(pi1);
    expect(baselinesOf(service).piGeneration).toBe(1);

    service.invalidatePiBinding("session replacement (reload)");
    expect(baselinesOf(service).pi).toBeNull(); // 旧句柄消费降级 null
    expect(baselinesOf(service).piGeneration).toBe(1); // 作废不递增代际

    const pi2 = makePi();
    service.initSession({ pi: pi2, sessionId: "s2" });
    expect(baselinesOf(service).pi).toBe(pi2);
    expect(baselinesOf(service).piGeneration).toBe(2);
  });

  it("dispose 收尾显式作废：dispose 后读侧 null（关停投递链之后的最后一步）", () => {
    const service = new SubagentService({ cwd: agentDir, modelService });
    const pi = makePi();
    service.initSession({ pi, sessionId: "s-dispose" });
    expect(baselinesOf(service).pi).toBe(pi);

    service.dispose();

    expect(baselinesOf(service).pi).toBeNull();
    // dispose 幂等：重复 dispose 不再触发作废副作用（_disposed 早退）。
    expect(() => service.dispose()).not.toThrow();
    expect(baselinesOf(service).pi).toBeNull();
  });
});

// ══════ 来源: delivery-methods.test.ts ══════

// src/execution/__tests__/delivery-methods.test.ts
//
// 会话形态续聊投递单元测试（M2-B1 投递基础设施 → H1 chat-run 统一定形）。
//
// [W3 改写] 投递链路协议化：deliverChatMessage → pi EnginePort（registry cli 形态
// port 的替身 registerFakePiEngine）。
// [H1 U2/U6 改写] 每轮 = 新 run + resume 锚点（ctx.resume，键切换后唯一会话形态键），
// Continuation 单飞承接防双写者检查（原 resumeColdRound resumesInFlight 检查退役）；
// 轮末分流 = run 应答驱动（onRunSettled，D7）——[H1 U6] 旧 interact 热路径/冷路径
// 分流与 settleChatRoundFromResponse 结算载体的断言段随载体退役删除。
// 原 inproc stdin 字节断言（sendPromptCommand/streamingBehavior/EPIPE 写后死检测）
// 随 inproc pi 引擎目录 删除归 pi-subagent-cli 包内测试。
//
// 本文件断言的编排语义（检查/状态迁移/单飞隔离）与改线前逐点同构。





/** chatMode idle record（第一轮已完成，等待续聊）。sessionFile 由调用方覆盖为 agentDir 下路径。 */
function makeIdleRecord(id = "sa-chat"): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "test/test-model",
    thinkingLevel: "low",
    mode: "background",
    task: "initial task",
    slug: "chat",
    startedAt: 1000,
    rootSessionId: "root-session",
  });
  // v4 B-1：idle 折入 running。"等待续聊"态现为 status="running"（hasArmedIdleTimer/isResumable 派生谓词区分）。
  record.status = "running";
  record.round = 1;
  record.controller = new AbortController();
  return record;
}

describe("会话形态续聊投递（run + resume 锚点）", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    clearEngines();
    fake = registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord();
    // sessionFile 用 agentDir 下路径（finalizeRoundToIdle 写 .idle sidecar 不留 /tmp 垃圾）
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
    // [U4] 锚可解析性要求文件真实在盘（isAnchorResolvable = existsSync），否则续聊
    // 误触 reopen 降级——fixture 补实体空文件。
    fs.writeFileSync(record.sessionFile, "{}\n", "utf-8");
    // [U2a/B5] 轮终簿记收敛 store.markRoundIdle（按 id 查内存）——record 须 register 进
    // store（生产链路 getRecordForAction/run 流程的 record 恒在内存，测试补齐同形态）。
    (service as unknown as { store: { register: (r: ExecutionRecord) => void } }).store.register(record);
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("续聊 message → run 收到 resume 锚点（ctx.resume 唯一会话形态键）；轮终 round+1 翻 idle（[two-state-convergence U4] 写侧翻边）", async () => {
    const beforeRound = record.round;

    await service.chatActions.deliverChatMessage(record, "next round msg");

    // Continuation：锚点校验通过后派发（record 保持 running）
    expect(record.status).toBe("running");

    // detached：等协议 run 被调（续聊 = ctx.resume 锚点）
    await vi.waitFor(() => expect(fake.runs.length).toBe(1), { interval: 1 });
    const run = fake.runs[0]!;
    expect(run.task.prompt).toBe("next round msg");
    expect(run.ctx.resume).toEqual({
      recordId: record.id,
      resume: {
        sessionRef: { recordId: record.id, sessionFile: record.sessionFile },
      },
    });

    // 模拟引擎 agent_settled 应答（轮末分流 = run 应答驱动，D7）
    run.settle({ content: "round text" });

    // 等 detached 完成：round 累加、轮终翻 idle（[two-state-convergence U4/D3] 写侧
    // 翻边——idle 即 resumable，续聊经 revive 过站，SP-5 寻址链不查 status）
    await vi.waitFor(() => expect(record.round).toBe(beforeRound! + 1), { interval: 1 });
    expect(record.status).toBe("idle");
    expect(record.result).toBe("round text");
    expect(record.stopReason).toBe("completed");
  });

  it("[P3 ⛔ two-state-convergence U4] chat 轮终翻 idle → message → revive 过站直通：status 翻 running + 恰一条迁移 entry + 无其他簿记变更（round/closedReason 不动）", async () => {
    // 前置：让 record 先真实轮终一轮（写侧翻边 idle 形态——markRoundIdle 收尾）。
    // 等 stopReason（轮终产物）而非 round——makeIdleRecord 预置 round=1，round 判据
    // 会在 settle 前立即通过。
    await service.chatActions.deliverChatMessage(record, "first round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1), { interval: 1 });
    fake.runs[0]!.settle({ content: "first round text" });
    await vi.waitFor(() => expect(record.stopReason).toBe("completed"), { interval: 1 });
    // 翻边形态自检：轮终落 idle（resumable 无、closedReason 清、stopReason=completed）
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBeUndefined();
    expect(record.stopReason).toBe("completed");

    // revive 过站检查自检：锚可解析（sessionFile 实体文件 beforeEach 已落盘）。
    // [modeless 波1] 升级 gate 分支消亡——引擎轴资格与 record 形态无关。

    // message 前清迁移上报计数——「恰一条」锚定 message 触发的 entry 序列。快照式
    // 捕获（spread 字段）而非存引用：revive entry 与轮始 entry 共享同一 record 对象，
    // markRoundStarted 清 result 会回写污染引用捕获。
    const storeLike = service as unknown as {
      store: { reportRecordTransition: (rec: ExecutionRecord) => void };
    };
    const entrySnapshots: Array<{ status?: string; result?: string; round?: number }> = [];
    const transitionSpy = vi.spyOn(storeLike.store, "reportRecordTransition").mockImplementation((rec) => {
      entrySnapshots.push({ status: rec.status, result: rec.result, round: rec.round });
    });
    const roundBefore = record.round;

    await service.chatActions.deliverChatMessage(record, "revive after idle round");

    // revive 过站：tryEnterRunning 翻回 running（dispatchRoundGuarded 检查由此放行）
    expect(record.status).toBe("running");
    // 迁移 entry 精确断言（R3——断言「恰一条」而非「无副作用」）：message 链共落两条
    // 设计内 entry——①revive 迁移 entry（reviveClosedRecord 无条件落，携带上轮 result）
    // 恰一条；②轮始重置 entry（markRoundStarted 簿记，result 已清）恰一条。
    const reviveEntries = entrySnapshots.filter((e) => e.result !== undefined);
    const startedEntries = entrySnapshots.filter((e) => e.result === undefined);
    expect(reviveEntries).toHaveLength(1);
    expect(reviveEntries[0]!.result).toBe("first round text");
    expect(startedEntries).toHaveLength(1);
    // 无其他簿记变更：round 不推进（revive 格不累加，轮始 markRoundStarted 才收敛）、
    // closedReason 保持清除态。result 在 message 返回时点已被轮始清点
    //（markRoundStarted 收敛——isStreaming 公式要求），revive 过站瞬间 result 保留的
    // 证据由上方 revive entry 快照承载（e.result = "first round text"）。
    expect(record.round).toBe(roundBefore);
    expect(record.closedReason).toBeUndefined();
    expect(record.result).toBeUndefined();
    // 新轮派发：fake 引擎收到续轮 run（resume 续写原文件）
    await vi.waitFor(() => expect(fake.runs.length).toBe(2), { interval: 1 });
    expect(fake.runs[1]!.task.prompt).toBe("revive after idle round");
    expect(entrySnapshots).toHaveLength(2);
  });

  it("[U4 万物可续] 旧终态遗留位 record（idle + closedReason=gc）→ 直接接管派发，不硬拒（形态枚举 gate 消亡）", async () => {
    record.status = "idle";
    // [U4 / §3.2.3] 旧终态遗留位（closedReason 有值，无论是否可重连集）只是展示位，
    // 不参与资格判定——message 到达直接翻回 running 派发新轮（万物可续）。
    record.closedReason = "gc";
    await service.chatActions.deliverChatMessage(record, "msg");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1), { interval: 1 });
    expect(record.status).toBe("running");
    expect(record.closedReason).toBeUndefined(); // 翻边清遗留位（notifyGate 门判据）
  });

  it("[U3 / §3.2.4 桥接] 新侧 idle（closedReason undefined，轮间空闲）→ 直接接管派发，不硬拒", async () => {
    record.status = "idle";
    // markSettled 轮收尾 / 磁盘重建单规则产出的 idle 无旧终态遗留位——message 到达
    // 直接翻回 running 派发新轮（万物可续）
    expect(record.closedReason).toBeUndefined();
    await service.chatActions.deliverChatMessage(record, "msg after settle");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1), { interval: 1 });
    expect(record.status).toBe("running");
  });

  it("[U4] record 无 sessionFile（从未开跑）→ 全新 session 直派（resume:undefined），不拒绝", async () => {
    record.sessionFile = undefined;
    // [U4 / §3.2.3] 原锚点缺失同步拒绝格消亡：无锚 = 无历史可摘要，按全新 session
    // 派发承接（新锚由 run 应答回填）。
    await service.chatActions.deliverChatMessage(record, "msg");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1), { interval: 1 });
    expect(fake.runs[0]!.ctx.resume?.resume).toBeUndefined();
    expect(fake.runs[0]!.task.prompt).toBe("msg"); // 无锚无历史，不注入 reopen 摘要
  });

  it("record 无 controller → 投递 throw 行动语言（MF-4），不触发 kickOff", async () => {
    record.controller = undefined;
    await expect(service.chatActions.deliverChatMessage(record, "msg")).rejects.toThrow(/not ready for a new message/);
    expect(fake.runs.length).toBe(0);
  });
});

// ============================================================
// deliverChatMessage（chatMode 统一投递入口 → Continuation 编排）
// ============================================================

describe("deliverChatMessage（chatMode 统一投递 → Continuation 派发）", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    clearEngines();
    fake = registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord(); // chatMode:true, running, round=1
    // sessionFile：续聊锚点需要
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
    // [U4] 锚可解析性要求文件真实在盘（isAnchorResolvable = existsSync）。
    fs.writeFileSync(record.sessionFile, "{}\n", "utf-8");
    // [U2a/B5] markRoundIdle 按 id 查 store 内存——record 须 register（见上 describe 注）。
    (service as unknown as { store: { register: (r: ExecutionRecord) => void } }).store.register(record);
    lifecycle._resetLifecycleState();
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    lifecycle._resetLifecycleState();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("轮间 message → Continuation 派发新轮 + 执行态信号清除（[H1 U2] 承接原冷路径语义）", async () => {
    record.result = "上一轮增量";

    await service.chatActions.deliverChatMessage(record, "after you finish");

    // [H1 U2] 每轮 = 新 run + resume 锚点（§3.4 dispatchRound）
    await vi.waitFor(() => expect(fake.runs.length).toBe(1), { interval: 1 });
    const run = fake.runs[0]!;
    expect(run.task.prompt).toBe("after you finish");
    expect(run.ctx.resume?.recordId).toBe(record.id);
    expect(run.ctx.resume?.resume?.sessionRef["sessionFile"]).toBe(record.sessionFile);
    // 轮始执行态信号清除（§5.4 isStreaming 公式）+ 迁移上报
    expect(record.status).toBe("running");
    expect(record.result).toBeUndefined();
  });
});

// ============================================================
// 续聊并发检查（review round2 MF1：同 turn 批量两条 message 双 kickOff 双 spawn）
// ============================================================
// 复现链（reviewer 探针实证）：pi 对同一条 assistant message 的 tool calls 顺序执行，
// tool1 的投递在续聊返回即 resolve——早于协议 run 完成（pool.acquire await 等
// 异步点）；tool2 立即执行 → 第二次 kickOff。v4 两态收敛后的 status 检查对
// running-resumable record 恒放行 → 两次 kickOff → 两个 pi 子进程以 --session 同一
// JSONL 双写 + 第一个进程脱离记账成孤儿。
describe("deliverChatMessage 并发检查（review round2 MF1）", () => {
  let agentDir: string;
  let service: SubagentService;
  let record: ExecutionRecord;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    clearEngines();
    fake = registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    record = makeIdleRecord();
    record.sessionFile = path.join(agentDir, "fake-session.jsonl");
    // [U4] 锚可解析性要求文件真实在盘（isAnchorResolvable = existsSync）。
    fs.writeFileSync(record.sessionFile, "{}\n", "utf-8");
    // [U2a/B5] markRoundIdle 按 id 查 store 内存——record 须 register（见上 describe 注）。
    (service as unknown as { store: { register: (r: ExecutionRecord) => void } }).store.register(record);
    lifecycle._resetLifecycleState();
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    lifecycle._resetLifecycleState();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("同 record 轮在途连续两条 message → 第二条入队不打断单飞（构造性单写者），轮终 drain 聚合派发", async () => {
    // 第一条：派发新轮（run 挂起不 resolve——模拟在途轮）
    await expect(service.chatActions.deliverChatMessage(record, "first msg")).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fake.runs.length).toBe(1), { interval: 1 });

    // 第二条：run 在途 → [H1 U2 / D2 打断语义] abort 在途轮 signal + 入队（不打断单飞、
    // 不二次派发——修复前双 kickOff 双写 session 的检查由 Continuation 单飞构造性承接）
    await expect(service.chatActions.deliverChatMessage(record, "second msg")).resolves.toBeUndefined();
    expect(fake.runs.length).toBe(1);
    const continuation = (
      // [2026-09-13 design-code-sync 接线] continuations 队列已迁 ChatRounds 聚合——
      // 读取路径改经聚合实例（断言对象与强度不变）。
      service as unknown as {
        chatRounds: { continuations: Map<string, { pendingCount: number }> };
      }
    ).chatRounds.continuations.get(record.id);
    expect(continuation?.pendingCount).toBe(1);

    // 轮终（应答收敛）→ drain → 队列消息派发为下一轮（单写者前置满足）
    fake.runs[0]!.settle({ content: "done" });
    await vi.waitFor(() => expect(fake.runs.length).toBe(2), { interval: 1 });
    expect(fake.runs[1]!.task.prompt).toBe("second msg");
  });

  it("检查是 record 级：A 在途轮不拦截 B 的 message", async () => {
    const recordB = makeIdleRecord("sa-chat-b");
    recordB.sessionFile = path.join(agentDir, "fake-session-b.jsonl");
    // [U2a/B5] 同 beforeEach——recordB 须 register 进 store（markRoundIdle 内存查）。
    (service as unknown as { store: { register: (r: ExecutionRecord) => void } }).store.register(recordB);

    await service.chatActions.deliverChatMessage(record, "A msg");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1), { interval: 1 });

    // B 的续聊轮不受 A 在途影响（Continuation per-record 实例）
    await expect(service.chatActions.deliverChatMessage(recordB, "B msg")).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fake.runs.length).toBe(2), { interval: 1 });
    expect(fake.runs[1]!.ctx.resume?.recordId).toBe(recordB.id);

    fake.runs[0]!.settle({ content: "A done" });
    fake.runs[1]!.settle({ content: "B done" });
    // 轮终簿记完成（Continuation 无全局在途集合——终态检查由 per-record 实例承载），
    // 断言两轮各自 round+1 即单飞收尾的可观察结果。
    await vi.waitFor(() => expect(record.round).toBe(2), { interval: 1 });
    await vi.waitFor(() => expect(recordB.round).toBe(2), { interval: 1 });
  });
});

// ══════ 来源: subagent-service-notify-gate.test.ts ══════

// src/execution/__tests__/subagent-service-notify-gate.test.ts
//
// [u-svc / T4] 通知可靠性（subagent-service 侧措施）：
//   - T4①/PS-2：kickOffChatRound.then notify 门按 closedReason 白名单放行——
//     parent-new/parent-fork 不注入（可能已切换的）新 session（A-6 决策落实）；
//   - T4②/PS-4：idleTimeoutMs 非法值（>2^31-1 / 非有限值）在 spawn 入口同步 fail-fast，
//     错误含合法范围（不静默 clamp、不静默不挂）。
//   - [T4④/PS-5 随波 2 账本退役] shutdown flush 复写机制已删除——port 形态下
//     pending 在受理前已落投递日志（受理前落盘先于投递尝试），等待条目由
//     session_start 差集重放补投，shutdown 复写无对象可补（其用例段一并退役）。
//
// mock 形态沿用 subagent-service-message-close.test.ts。




// [W3 改写] 原 vi.mock(inproc pi 引擎目录/session-runner) 随删件消亡——chat 轮次走协议 seam
//（registerFakePiEngine 替身，kickOffChatRound 的 notify 门经 engine.run 应答驱动）。

interface ServiceInternals { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
  store: RecordStore;
}

type MockPi = PiMock;

function setup(initOverrides: Partial<{ isIdle: () => boolean }> = {}): {
  agentDir: string;
  service: SubagentService;
  store: RecordStore;
  pi: MockPi;
} {
  const agentDir = makeTmpAgentDir();
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "root-session", isIdle: initOverrides.isIdle });
  const store = (service as unknown as ServiceInternals).store;
  return { agentDir, service, store, pi };
}

describe("T4① notify gate 二元组（[U5 / §3.2.7] 放弃轮标记阻断 + 跨世代丢弃 / 其余放行）", () => {
  it("blocks abandoned-round hits and cross-epoch inbound; allows settled/running without marks", () => {
    // 放弃轮标记命中（承接原 cancelled 阻断防双发）：同世代回注轮 ≤ 标记轮 → 丢弃。
    expect(
      notifyGateAllowsDelivery({ lastAbandonedRound: { epoch: 0, round: 2 }, round: 2 }),
    ).toBe(false);
    // 两步判定第一步：回注声明世代 ≠ record 当前世代 → 丢弃。
    expect(
      notifyGateAllowsDelivery(
        { epoch: 1, lastAbandonedRound: { epoch: 0, round: 2 } },
        { epoch: 0, round: 2 },
      ),
    ).toBe(false);
    // 标记槽世代 ≠ 当前世代（reopen 残留）→ 标记自然失效，新世代正常轮放行。
    expect(
      notifyGateAllowsDelivery({ epoch: 1, round: 1, lastAbandonedRound: { epoch: 0, round: 2 } }),
    ).toBe(true);
    // 正常轮（round 已推进越过旧标记）放行——重复帧由 notifyId 去重兜底。
    expect(
      notifyGateAllowsDelivery({ round: 3, lastAbandonedRound: { epoch: 0, round: 2 } }),
    ).toBe(true);
    // 无标记（settle 竞态迟到回注、user-close/gc 等真实收尾）照旧回注。
    // [u-arch] gate ①（intent=archived 静默）随收起概念删除退役——编排性关闭的
    // 迟到回注阻断由放弃轮标记（下方 dispose 集成用例）+ 轮身份检查 + notifyId
    // 账本承接。
    expect(notifyGateAllowsDelivery({})).toBe(true);
    expect(notifyGateAllowsDelivery({ round: 5 })).toBe(true);
  });

  it("kickOffChatRound 迟到应答回注不注入已编排性关闭的 record（放弃轮标记 gate 承接，[u-arch] gate ①删除后主防线）", async () => {
    const { agentDir, service, store, pi } = setup();
    clearEngines();
    const fake = registerFakePiEngine();
    const record = createRecord("sa-gate-new", {
      agent: "general-purpose",
      model: "test/model",
      mode: "background",
      slug: "t",
      task: "test",
      startedAt: 1000,
      rootSessionId: "root-session",
      controller: new AbortController(),
    });
    // 模拟 disposeAllRecords 先行编排性关闭后，迟到的 kickOffChatRound 应答回注。
    // [u-arch] 关闭形态 = idle + 放弃轮标记（disposeAllRecords 置标记 → settle 持久化）
    // ——gate ① 删除后，迟到回注由放弃轮标记 gate 阻断（同世代、回注轮 ≤ 标记轮）。
    // [modeless 波1] 经 Continuation 统一入口驱动：message 派发轮（run 挂起）→
    // 编排性关闭先行（markSettledOut——disposeAllRecords 的 store 原语）→ 迟到引擎
    // 应答被 gate 阻断。
    record.status = "idle";
    store.register(record);
    await service.chatActions.deliverChatMessage(record, "go");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1), { interval: 1 });
    record.lastAbandonedRound = { epoch: record.epoch ?? 0, round: record.round ?? 0 };
    store.markSettledOut(record);
    fake.runs[0]!.settle({ content: "late round text" });
    await Promise.resolve();
    await Promise.resolve();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    service.dispose();
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("[modeless 波1] 旧终态遗留形态（idle + gc 展示位）message 续聊 → 轮终通知仍送达（revive 清遗留位，gate 无阻断）", async () => {
    const { agentDir, service, store, pi } = setup();
    clearEngines();
    const fake = registerFakePiEngine();
    const record = createRecord("sa-gate-gc", {
      agent: "general-purpose",
      model: "test/model",
      mode: "background",
      slug: "t",
      task: "test",
      startedAt: 1000,
      rootSessionId: "root-session",
      controller: new AbortController(),
    });
    // 旧终态遗留形态（idle + gc 遗留展示位——[U2 桥接] 旧终态形态读侧兼容）+
    // register 进 store 的完整生产形态。message → revive 翻边清遗留位（closedReason
    // 残留会让 notifyGate 门误拦本轮通知）→ 轮终 route 送达。
    record.status = "idle";
    record.endedAt = Date.now();
    record.closedReason = "gc";
    store.register(record);
    await service.chatActions.deliverChatMessage(record, "continue");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1), { interval: 1 });
    fake.runs[0]!.settle({ content: "round" });
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled(), { interval: 1 });
    service.dispose();
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
});

describe("T4② idleTimeoutMs entry fail-fast", () => {
  let agentDir: string;
  let service: SubagentService;

  beforeEach(() => {
    ({ agentDir, service } = setup());
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("execute rejects idleTimeoutMs above the setTimeout limit with the valid range in the message", async () => {
    await expect(service.execute({ task: "x", slug: "test", idleTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).rejects.toThrow(
      new RegExp(`${MAX_TIMER_DELAY_MS}`),
    );
    await expect(service.execute({ task: "x", slug: "test", idleTimeoutMs: 3_000_000_000 })).rejects.toThrow(/2\^31-1/);
  });

  it("execute rejects non-finite idleTimeoutMs", async () => {
    await expect(service.execute({ task: "x", slug: "test", idleTimeoutMs: Number.NaN })).rejects.toThrow(/not a finite number/);
  });

  it("rejects before any record is created (no side effects)", async () => {
    const internals = service as unknown as ServiceInternals;
    await expect(service.executeAndAwait({ task: "x", slug: "test", idleTimeoutMs: 3_000_000_000 })).rejects.toThrow();
    expect(internals.store.listRunning()).toHaveLength(0);
  });

  it("accepts valid values (0 = explicit disable, positive within limit)", async () => {
    // 校验通过后执行链继续（runSpawn 被 mock，返回 undefined result 会在后续流程抛错/
    // 返回——但绝不能是 idleTimeoutMs 校验错误）
    await expect(service.execute({ task: "x", slug: "test", idleTimeoutMs: 0 })).rejects.not.toThrow(/idleTimeoutMs/);
  });
});

// ══════ 来源: subagent-service-parent-guard.test.ts ══════

// src/execution/__tests__/subagent-service-parent-guard.test.ts
//
// [v4 A-5 / P7] getRecordForAction 直接父校验单元测试。
//
// 背景：递归 subagent 场景下，孙级 record（parentRecordId = 某子进程的 self recordId）
// 的子进程句柄只存在于其直接父进程内存。SP-8 后全树 record 的 rootSessionId 贯穿真 ROOT，
// 旧实现 getRecordForAction 仅校验 rootSessionId → 主进程可凭 rootSessionId 通过 message 孙级，
// 但孙级 B 的子进程句柄只在 A 进程里 → 主进程走冷路径重新 spawn → 双写同一 session 文件（P7）。
//
// 修复：rootSessionId 校验之后增加直接父校验——record.parentRecordId 必须等于本进程
// execCtxBaseline.recordId（主进程 baseline=null → 只能操作根层 record）。
//
// 本测试 mock execCtxBaseline 三种身份（undefined=主进程 / sa-A=直接父 / sa-B=兄弟进程），
// 断言对 record B（parentRecordId=sa-A）及顶层 record 的操作权限矩阵。



// mock logger（import 链需要 getLogger 存在）

// [W3 改写] 原 vi.mock(inproc pi 引擎目录/session-runner) 随删件消亡——本文件只测
// getRecordForAction 检查（纯内存判定，不触引擎链路），现存 import 无需再 mock 引擎替身。


type Baseline = { recordId: string | undefined; depth: number } | null;
const MAIN_PROCESS: Baseline = null;
const PARENT_A: Baseline = { recordId: "sa-A", depth: 1 };
const SIBLING_B: Baseline = { recordId: "sa-B", depth: 1 };

/** 暴露私有字段供测试注入身份。[D3-⑤] 基线住进 execNesting（公共层
 *  ExecutionNestingContext），注入经 setBaseline 测试入口。
 *  [R1 深绑改写·清单③ SI 形态] sessionRootId/execNesting 随域 #2 聚合迁入
 *  SessionBaselines——ParentGuardInternals 重定义为壳 baselines 聚合路径（store 仍为壳
 *  #1 留壳字段，路径不变）；断言对象与强度不变，路径对齐终态结构。 */
interface ParentGuardInternals {
  store: RecordStore;
  baselines: {
    sessionRootId: string | null;
    execNesting: { setBaseline(state: { recordId: string | undefined; depth: number } | null): void };
  };
}

/** 构造一个 chatMode idle record（message/close action 的典型目标态）。 */
function makeRecord(
  id: string,
  sessionRootId: string,
  overrides: Partial<ExecutionRecord> = {},
): ExecutionRecord {
  return createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "test",
    startedAt: 1000,
    rootSessionId: sessionRootId,
    controller: new AbortController(),
    ...overrides,
    slug: overrides.slug ?? "test",
  });
}

describe("[v4 A-5 / P7] getRecordForAction 直接父校验", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let sessionRootId: string;
  let internals: ParentGuardInternals;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    // initSession 建立 sessionRootId=sessionId（本 session 树的根）。execCtxBaseline 的
    // 真实值由 initSession 从 env 读取（见 recursive-visibility-baseline.test.ts），但本测试
    // 聚焦检查逻辑，故每例直接注入身份（mock），不依赖进程 env（测试进程可能继承 subagent env）。
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    internals = service as unknown as ParentGuardInternals;
    store = internals.store;
    // [R1 深绑改写] sessionRootId 经 baselines 聚合路径读取（原 internals.sessionRootId）。
    sessionRootId = internals.baselines.sessionRootId!;
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // ---------- 身份 sa-A：直接父，放行孙级 B ----------

  it("身份=sa-A（直接父）→ 放行操作孙级 record B（parentRecordId=sa-A）", () => {
    const recordB = makeRecord("sa-B", sessionRootId, { parentRecordId: "sa-A", depth: 2, status: "running" });
    store.register(recordB);
    internals.baselines.execNesting.setBaseline(PARENT_A);

    expect(service.chatActions.getRecordForAction("sa-B")).toBe(recordB);
  });

  // ---------- 身份 undefined（主进程）：拒绝孙级，放行根层 ----------

  it("身份=undefined（主进程）拒绝孙级 record B，错误含 'direct parent' + 'parent=sa-A'", () => {
    const recordB = makeRecord("sa-B", sessionRootId, { parentRecordId: "sa-A", depth: 2, status: "running" });
    store.register(recordB);
    internals.baselines.execNesting.setBaseline(MAIN_PROCESS);

    expect(() => service.chatActions.getRecordForAction("sa-B")).toThrow(/direct parent/);
    expect(() => service.chatActions.getRecordForAction("sa-B")).toThrow(/see \/subagents list, parent=sa-A/);
  });

  it("身份=undefined（主进程）放行顶层 record（parentRecordId=undefined 视为根层）", () => {
    const topRecord = makeRecord("sa-top", sessionRootId, { parentRecordId: undefined, depth: 0, status: "running" });
    store.register(topRecord);
    internals.baselines.execNesting.setBaseline(MAIN_PROCESS);

    expect(service.chatActions.getRecordForAction("sa-top")).toBe(topRecord);
  });

  // ---------- 身份 sa-B（兄弟进程）：拒绝孙级 ----------

  it("身份=sa-B（兄弟进程）拒绝孙级 record B（parentRecordId=sa-A ≠ baseline sa-B）", () => {
    const recordB = makeRecord("sa-B", sessionRootId, { parentRecordId: "sa-A", depth: 2, status: "running" });
    store.register(recordB);
    internals.baselines.execNesting.setBaseline(SIBLING_B);

    expect(() => service.chatActions.getRecordForAction("sa-B")).toThrow(/direct parent/);
    expect(() => service.chatActions.getRecordForAction("sa-B")).toThrow(/see \/subagents list, parent=sa-A/);
  });

  // ---------- 身份缺省语义 + 更深递归 ----------

  it("子进程（baseline=sa-A）拒绝顶层 record（身份缺省视为根层，仅主进程可操作）", () => {
    const topRecord = makeRecord("sa-top", sessionRootId, { parentRecordId: undefined, depth: 0, status: "running" });
    store.register(topRecord);
    internals.baselines.execNesting.setBaseline(PARENT_A);

    expect(() => service.chatActions.getRecordForAction("sa-top")).toThrow(/direct parent/);
  });

  it("P7 场景：主进程拒绝曾孙 record C（parentRecordId=sa-B），错误含 baseline=root + parent=sa-B", () => {
    const recordC = makeRecord("sa-C", sessionRootId, { parentRecordId: "sa-B", depth: 3, status: "running" });
    store.register(recordC);
    internals.baselines.execNesting.setBaseline(MAIN_PROCESS);

    const fn = () => service.chatActions.getRecordForAction("sa-C");
    expect(fn).toThrow(/direct parent/);
    expect(fn).toThrow(/see \/subagents list, parent=sa-B/);
    expect(fn).toThrow(/baseline=\(root\)/);
  });

  it("rootSessionId 不匹配仍优先拒绝（直接父校验在 rootSessionId 校验之后，不绕过归属检查）", () => {
    // 跨 session 树的 record：rootSessionId 不匹配 → 走首个 throw（not found or not owned）
    const foreignRecord = makeRecord("sa-foreign", "other-session", { parentRecordId: "sa-A", depth: 2, status: "running" });
    store.register(foreignRecord);
    internals.baselines.execNesting.setBaseline(PARENT_A);

    expect(() => service.chatActions.getRecordForAction("sa-foreign")).toThrow(/not found or not owned/);
  });
});

// ══════ 来源: subagent-service-model-switch.test.ts ══════

// src/execution/__tests__/subagent-service-model-switch.test.ts
//
// [subagent-model-switch §7.2 目标 5 壳接线] SubagentService.setModel 装配段的
// 行为测试：deps 闭包走真实通道（ModelConfigService 透传 / store.markModelOverride
// 写入 journal 记录原语 / chatRounds.resolveEnginePortForSwitch 引擎路由转发）。编排本体
// （model-switch.ts 纯函数）的分型处置表已由 model-switch.test.ts 全量覆盖，本文件
// 只锚壳装配——两文件互补，不重复证明。
//
// 场景取舍：chat 域两态（无活进程纯记账 / 活进程 + 引擎解析转发）恰好覆盖装配段
// 全部闭包；run 级聚合通道（runAggregate / persistRunOverride）的真实装配由
// workflow-dispatch 侧 U4b 测试承接（workflow-dispatch-override.test.ts）。





// ============================================================
// fixtures（形态对齐 model-switch.test.ts——校验语义真实）
// ============================================================

function makeModel(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: over.id ?? "glm-5.3-flash",
    name: over.name ?? "GLM-5.3-Flash",
    provider: over.provider ?? "zai-coding-cn",
    reasoning: over.reasoning ?? false,
    thinkingLevelMap: over.thinkingLevelMap,
    contextWindow: over.contextWindow,
  };
}

function makeRegistry(
  models: ModelInfo[],
  authed: string[] = models.map((m) => `${m.provider}/${m.id}`),
): ModelRegistryLike {
  const authSet = new Set(authed);
  return {
    getAvailable: () => models,
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    hasConfiguredAuth: (m) => {
      if (!m || typeof m !== "object") return false;
      const mm = m as ModelInfo;
      return authSet.has(`${mm.provider}/${mm.id}`);
    },
  };
}

const TARGET_MODEL = { provider: "zai-coding-cn", modelId: "glm-5.3-flash" } as const;

describe("SubagentService.setModel 壳接线（§7.2 目标 5）", () => {
  let dir: string;
  let service: SubagentService;
  let store: RecordStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-model-switch-"));
    // [session-store-layout-inversion] 生产 store 目录经
    // getSubagentSessionDir(resolveStoreRootSessionId())（env dataDir 兜底）解析——
    // stubEnv 把写删目标收进本 mkdtemp 目录（自建自删红线）。
    process.env["TAIJI_AGENT_DATA_DIR"] = dir;
    const modelService = new ModelConfigService({ agentDir: path.join(dir, "agent"), cwd: dir });
    modelService.initModel({ modelRegistry: makeRegistry([makeModel()]), sessionId: "sess-1" });
    service = new SubagentService({ cwd: path.join(dir, "agent"), modelService });
    // register/markSettled 的 store 目录解析须有分区键（sid = modelService 同一 sessionId）
    service.initSession({ pi: makePi(), sessionId: "sess-1" });
    store = Reflect.get(service, "store") as RecordStore;
  });

  afterEach(() => {
    _resetCoreSpawnedChildrenMirrorForTest();
    service.dispose();
    delete process.env["TAIJI_AGENT_DATA_DIR"];
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeRecord(id: string): ReturnType<typeof createRecord> {
    const record = createRecord(id, {
      agent: "general-purpose",
      model: "zai-coding-cn/glm-5.3",
      thinkingLevel: "high",
      mode: "background",
      task: "shell switch demo",
      slug: "shell-switch",
      startedAt: 1_000,
    });
    store.register(record);
    return record;
  }

  it("无活进程 → 纯记账路径：store 写入 journal 记录原语写 record.modelOverride + 已记账型应答（不携带档位）", async () => {
    const record = makeRecord("sa-shell-switch-1");
    const reply = await service.setModel({ domain: "chat", record }, TARGET_MODEL);
    expect(reply).toEqual({
      scope: "chat",
      reply: { kind: "recorded", notice: "已记录，下次执行生效。" },
    });
    // 写入 journal 记录原语真实生效（内存 record 字段；盖章值 model 不变量 5 不触碰）
    expect(record.modelOverride?.ref).toEqual({ provider: "zai-coding-cn", modelId: "glm-5.3-flash" });
    expect(record.model).toBe("zai-coding-cn/glm-5.3");
  });

  it("活进程 + 引擎解析转发（pi 未注册 → 不可用 stub 的 native 位与方法缺席组合）→ 装配损坏检查抛出，编排写记账 + 错误应答（不虚构生效值）", async () => {
    const record = makeRecord("sa-shell-switch-2");
    // 宿主活进程镜像注册（hasLiveProcessHandle 判真 → 走引擎转发分支）
    registerSpawnedChildForRecord(record.id, { pid: 424242, killed: false } as unknown as ChildProcess);
    const reply = await service.setModel({ domain: "chat", record }, TARGET_MODEL);
    expect(reply.scope).toBe("chat");
    if (reply.scope !== "chat" || reply.reply.kind !== "error") {
      throw new Error(`expected chat error reply, got: ${JSON.stringify(reply)}`);
    }
    expect(reply.reply.message).toMatch(/setModel=native/);
    // 检查路径仍写记账（处置表行 3/7 形态——意图已表达，生效值未知如实报错）
    expect(record.modelOverride?.ref).toEqual({ provider: "zai-coding-cn", modelId: "glm-5.3-flash" });
  });
});
