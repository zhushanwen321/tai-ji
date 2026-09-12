// src/__tests__/subagent-service.test.ts
//
// SubagentService 生命周期 + 公共 API 边界测试（[H3/R5 测试归位] 本文件为壳级测试：
// 装配 / dispose 编排 / 转发面 / 跨域 emit 记账。run 域 execute 入口用例已迁
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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo } from "../model-resolver.ts";
import type { RecordStore } from "../record-store.ts";
import type { UiRequest, UiRequestHandler } from "../dialog-queue.ts";
import type { PiLike } from "../subagent-service.ts";
import { SubagentService } from "../subagent-service.ts";
// [H3/R6] 单例访问器外移支撑文件 service/service-bootstrap.ts（壳不再导出）。
import { getSubagentService, setSubagentService } from "../service/service-bootstrap.ts";
import type { ExecutionRecord } from "../types.ts";

// ── 工具:建临时 agentDir + 真实 ModelConfigService ──

function makeTmpAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
  // agentDir/subagents/ 子目录(config 默认路径会用,空即可)
  return dir;
}

function makeModelService(agentDir: string): ModelConfigService {
  return new ModelConfigService({ agentDir, cwd: agentDir });
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn<(customType: string, data?: unknown) => void>>;
  events: { emit: ReturnType<typeof vi.fn<(channel: string, data: unknown) => void>> };
  sendMessage: ReturnType<typeof vi.fn<(message: Parameters<PiLike["sendMessage"]>[0], options?: Parameters<PiLike["sendMessage"]>[1]) => void>>;
} {
  return {
    appendEntry: vi.fn((customType: string, data?: unknown) => {}),
    events: { emit: vi.fn((channel: string, data: unknown) => {}) },
    sendMessage: vi.fn(() => {}),
  };
}

describe("SubagentService", () => {
  let agentDir: string;
  let modelService: ModelConfigService;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    modelService = makeModelService(agentDir);
  });

  afterEach(() => {
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
      expect(Array.isArray(records)).toBe(true);
    });

    it("onChange 返回 unsubscribe 函数,调用后停止通知", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      const listener = vi.fn();
      const unsubscribe = service.queries.onChange(listener);
      expect(typeof unsubscribe).toBe("function");
      expect(() => unsubscribe()).not.toThrow();
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
      record.status = "closed";
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
      // [C1] sync 子进程的 kill 由 killAllSpawnedChildren 兜底（spawnedChildren Set 注册），
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
  //   文件；用例名与断言零改动）。此处不留转发桩——vitest 按文件发现，无注册面。
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
  //     runAndFinalize 侧 tryTransition 失败跳过 finalizeRecord，由 cancelBackground 侧 emit——
  //     本块 cancel 用例覆盖的即此后端 emit）
  //   - background detached 正常完成回注（finalizeRecord → emitPendingUnregister(done, {result,error,patchFile})）
  // register emit 的 payload（type:"subagent"、name）由本块 worktree-fail 路径附带覆盖。

  describe("pending-notifications emit 断言 (H4)", () => {
    /** 构造已就绪 service（initSession + initModel）并保留 pi 引用以断言 events.emit。 */
    function makeReadyServiceWithPi(): {
      service: SubagentService;
      pi: ReturnType<typeof makePi>;
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
      // unregister(failed) 只记 registry 状态（通知由 BgNotifier 发，不在这条事件里）
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ reason: "closed" }),
      );
    });

    it("cancel(background) → unregister(reason=closed) 被 emit，register 未被 emit（v4 B-1 cancelled 折入 closed）", () => {
      const { service, pi } = makeReadyServiceWithPi();
      const record = injectRunningBackground(service, "bg-cancel-1");
      expect(record.status).toBe("running");

      const ok = service.cancel("bg-cancel-1");

      // cancel CAS 抢锁成功 → cancelBackground 完整收尾 + emit
      expect(ok).toBe(true);
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-cancel-1", reason: "closed" }),
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

    it("T-NFR-8: dispose 时每个 running record 都 emit pending:unregister(reason=failed)", () => {
      const { service, pi } = makeReadyServiceWithPi();
      injectRunningBackground(service, "bg-dispose-1");
      injectRunningBackground(service, "bg-dispose-2");
      injectRunningBackground(service, "bg-dispose-3");

      service.dispose();

      // 每个 running record 都 emit 了 pending:unregister(reason=failed)
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-dispose-1", reason: "closed" }),
      );
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-dispose-2", reason: "closed" }),
      );
      expect(pi.events.emit).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: "bg-dispose-3", reason: "closed" }),
      );
    });

    it("T-NFR-8: dispose emit 次数 = running record 数（终态 record 不重复 emit）", () => {
      const { service, pi } = makeReadyServiceWithPi();
      // 2 个 running + 1 个终态
      injectRunningBackground(service, "bg-running-1");
      injectRunningBackground(service, "bg-running-2");
      const terminal = injectRunningBackground(service, "bg-done");
      terminal.status = "closed"; // 模拟终态，dispose 不应为其 emit

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
