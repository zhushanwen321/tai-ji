// src/__tests__/spawn-self-destruct.test.ts
//
// spawnEngineChild 形态断言（R9-4②：子进程 stdin 恒为自有 pipe，绝不继承引擎
// stdin fd）+ armEngineSelfDestruct 判据矩阵（主判据 stdio EOF / 辅助判据未 ack
// 计时超时 / 排除面 = 已 ack 与已终结请求）。自灭执行一律注入 killSelf fake，
// 绝不触达缺省的 process.kill（测试红线）。

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEngineChildEnv } from "../env.ts";
import {
  armEngineSelfDestruct,
  DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS,
  ENGINE_HOST_REQUEST_TIMEOUT_ENV,
  spawnEngineChild,
} from "../spawn.ts";

/** fake stdin：EventEmitter 代 ReadableStream（once/removeAllListeners 面足够）。 */
function fakeStdin(): NodeJS.ReadableStream {
  return new EventEmitter() as unknown as NodeJS.ReadableStream;
}

describe("spawnEngineChild", () => {
  // 断言失败路径下可能没有 stdin EOF，残留子进程在此收割
  let spawned: ChildProcess | null = null;
  afterEach(() => {
    spawned?.kill("SIGKILL");
    spawned = null;
  });

  it("形态键（detached/stdio/stdin/windowsHide）出现即抛错——不暴露硬编码契约面", () => {
    const env = buildEngineChildEnv({}, { dataDir: "/d" });
    expect(() => spawnEngineChild({ command: "x", args: [], env, detached: true } as never))
      .toThrow(/detached/);
    expect(() => spawnEngineChild({ command: "x", args: [], env, stdio: "ignore" } as never))
      .toThrow(/stdio/);
    expect(() => spawnEngineChild({ command: "x", args: [], env, stdin: "inherit" } as never))
      .toThrow(/stdin/);
  });

  it("子进程 stdin 是自有 pipe 而非引擎 stdin fd（R9-4②）", async () => {
    const env = buildEngineChildEnv({}, { dataDir: "/d" });
    // 载荷选型：POSIX 用 /bin/sh + builtin test + /bin/cat——原生进程 fork+exec
    // 毫秒级（node -e 载荷是完整 Node 启动，满载下墙钟成本高且无谓）。probe 从
    // 子进程侧断言 stdin 是流式 IPC 端点（-S socket 或 -p FIFO——libuv 'pipe'
    // stdio 在 macOS 走 socketpair、Linux 走 pipe2，两者都是 'pipe' 形态本体；
    // 排除 TTY/文件），/bin/cat 回环验证数据面通路 + EOF 自然退出（与自灭主判据
    // 同源的 EOF 语义）。buildEngineChildEnv 是净化面（无 PATH），一律绝对路径。
    // Windows 无原生端点探测，回落 node -e 原样回显（契约由父侧 fd 断言 + 回环
    // 覆盖）。
    const usePosixProbe = process.platform !== "win32";
    spawned = spawnEngineChild({
      command: usePosixProbe ? "/bin/sh" : process.execPath,
      args: usePosixProbe
        ? ["-c", "{ test -S /dev/stdin || test -p /dev/stdin; } && /bin/cat"]
        : ["-e", "process.stdin.once('data', (d) => process.stdout.write(d))"],
      env,
    });
    // spawn 失败（ENOENT 等）必须快速出声，不能拖成墙钟超时。
    // **事件监听全部在 spawn 后立即注册**——child 的 exit 与 stdout end 相对
    // 顺序不保证（载荷秒退时 exit 常先于 end 到达），若在 await echoed 之后再
    // 注册 once("exit")，late listener 会永久错过已发出的事件 → 用例挂死到超时。
    // 这正是本用例历史 flaky 的真正根因（负载越高 exit/end 交错越随机，暴露率
    // 越高；加大墙钟超时无效——事件已丢失，等多久都不会来）。等待承诺与监听
    // 注册必须分离：先注册、后 await。
    const failure = new Promise<never>((_, reject) => {
      spawned!.once("error", (err) => reject(new Error(`child spawn failed: ${String(err)}`)));
    });
    const exited = new Promise<number | null>((resolve) => {
      spawned!.once("exit", (code) => resolve(code));
    });
    const echoed = new Promise<string>((resolve, reject) => {
      let out = "";
      spawned!.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
      spawned!.stdout!.on("end", () => resolve(out));
      spawned!.stdout!.on("error", reject);
    });

    expect(spawned.stdin).toBeDefined();
    // 父侧 fd 不等：继承形态下子进程 stdin 复用父 fd（0）；自有 pipe 是新分配
    // fd——0 已被父 stdin 持有，新 fd 编号不可能与之相等。注意 Node >= 20 的
    // net.Socket 不再暴露公开 fd（旧版有），_handle.fd 是形态探测源（fd 字段
    // 优先以兼容旧 Node）。
    const stdinSocket = spawned.stdin as unknown as { fd?: number; _handle?: { fd: number } };
    const childStdinFd = stdinSocket.fd ?? stdinSocket._handle?.fd;
    expect(typeof childStdinFd).toBe("number");
    expect(childStdinFd).toBeGreaterThanOrEqual(0);
    expect(childStdinFd).not.toBe(process.stdin.fd);
    expect(spawned.stdio[0]).not.toBe(process.stdin);

    // 输出到达即断言（事件驱动，无固定 sleep）；30s 只是满载兜底上限
    spawned.stdin!.end("ping\n");
    expect(await Promise.race([echoed, failure])).toBe("ping\n");
    const exitCode = await Promise.race([exited, failure]);
    // 0 = 子进程侧 test -S/-p（stdin 是流式端点）通过，且 cat 读到 EOF
    // （child.stdin end）正常退出——EOF 语义下子进程生命周期完整走通
    expect(exitCode).toBe(0);
  }, 30_000);

  it("abort signal → 完整杀链（SIGCONT 前置 + SIGTERM → grace → SIGKILL）：默认行为子进程被 SIGTERM 终止", async () => {
    // 接线用例：锁定 abort → 信号终止主路径（默认 SIGTERM 行为的子进程在 grace
    // 窗内即死，signal 形态 = "SIGTERM"）。SIGKILL 升级语义本体由 kill-chain.test
    // 承载（30s 真实窗口不在进程级测试里等）；SIGCONT 前置无法从父侧观测信号序列，
    // 由 spawn.ts 实装注释 + safeKill 幂等包裹保障。
    const env = buildEngineChildEnv({}, { dataDir: "/d" });
    const usePosix = process.platform !== "win32";
    const controller = new AbortController();
    spawned = spawnEngineChild({
      command: usePosix ? "/bin/sh" : process.execPath,
      args: usePosix ? ["-c", "sleep 30"] : ["-e", "setInterval(() => {}, 1000)"],
      env,
      signal: controller.signal,
    });
    const failure = new Promise<never>((_, reject) => {
      spawned!.once("error", (err) => reject(new Error(`child spawn failed: ${String(err)}`)));
    });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => {
      spawned!.once("exit", (_code, signal) => resolve(signal));
    });
    controller.abort();
    const exitSignal = await Promise.race([exited, failure]);
    expect(exitSignal).toBe("SIGTERM");
  }, 15_000);
});

describe("armEngineSelfDestruct", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("主判据：stdin EOF（end）→ 立即自灭", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    expect(kill).not.toHaveBeenCalled();
    stdin.emit("end");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("主判据：stdin close → 自灭；EOF 后重复事件幂等", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    stdin.emit("close");
    stdin.emit("end");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("辅助判据：未 ack 反向请求超时 → 自灭（缺省 30s）", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    clock.started("req-1");
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS - 1);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("排除面：已 ack 的 host/askUser / executeAndAwait 不计时（R9-2）", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    clock.started("askUser-1");
    clock.acked("askUser-1");
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS * 10);
    expect(kill).not.toHaveBeenCalled();
  });

  it("排除面：已终结（settled）请求不计时", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    clock.started("req-1");
    clock.settled("req-1");
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS * 10);
    expect(kill).not.toHaveBeenCalled();
  });

  it("混合面：未 ack 请求与已 ack 请求并存时，仅未 ack 触发", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    clock.started("acked-early");
    clock.acked("acked-early");
    clock.started("pending-1");
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS + 2_000);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("env 覆盖：TAIJI_ENGINE_HOST_REQUEST_TIMEOUT_MS 生效；非法值回落缺省", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({
      stdin,
      killSelf: kill,
      timeoutEnv: { [ENGINE_HOST_REQUEST_TIMEOUT_ENV]: "1000" },
    });
    clock.started("req-1");
    vi.advanceTimersByTime(2_500);
    expect(kill).toHaveBeenCalledTimes(1);

    const stdin2 = fakeStdin();
    const kill2 = vi.fn();
    const clock2 = armEngineSelfDestruct({
      stdin: stdin2,
      killSelf: kill2,
      timeoutEnv: { [ENGINE_HOST_REQUEST_TIMEOUT_ENV]: "not-a-number" },
    });
    clock2.started("req-1");
    vi.advanceTimersByTime(1_000);
    expect(kill2).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS);
    expect(kill2).toHaveBeenCalledTimes(1);
  });

  it("dispose：正常 shutdown 卸载守卫（EOF 与计时均不再触发）", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    clock.started("req-1");
    clock.dispose();
    stdin.emit("end");
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS * 2);
    expect(kill).not.toHaveBeenCalled();
    // dispose 幂等
    clock.dispose();
  });

  it("自灭后 started 不再进入计时面", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    stdin.emit("end");
    clock.started("late-req");
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS * 2);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
