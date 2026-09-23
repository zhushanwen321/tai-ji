// appserver-launcher.test.ts —— wrapper fs 拦截语义 + 落盘幂等/覆盖 + exit 面。
//
// 防线背景：wrapper 的失效模式是静默的（曾出过首调走未赋值 __origReadFileSync
// 导致拦截整体失效的 bug——56a49ad4c），本文件用「落盘产物 + 探针 fake CLI」的
// 真进程集成形态锚定核心语义：v2 注入优先合并、existsSync 拦截（GUI-only 宿主）、
// encoding 归一、no-patch 分支、透传不受影响。

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APPSERVER_LAUNCHER_SOURCE,
  ZCODE_APPSERVER_LAUNCHER_NAME,
  ensureAppServerLauncher,
} from "../appserver-launcher.ts";

// 探针 fake CLI：以 wrapper 注入后的 fs 形态读取 CONFIG_PATH 的各种调用形态并
// 落盘 state（wrapper 对它 import() 启动——与真实 zcode.cjs 同入口形态）
const PROBE_SOURCE = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const CONFIG = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
const OTHER = path.join(os.homedir(), '.probe-other.txt');
const STATE = process.env.ZCODE_PROBE_STATE;
function grab(v) {
  if (Buffer.isBuffer(v)) return { kind: 'buffer', text: v.toString('utf8') };
  return { kind: typeof v, text: String(v) };
}
async function main() {
  const out = {};
  out.argv1 = process.argv[1] || null;
  out.builtinProviderEnv = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || null;
  out.existsConfig = fs.existsSync(CONFIG);
  out.existsMissing = fs.existsSync(path.join(os.homedir(), '.no-such-file'));
  out.existsOther = fs.existsSync(OTHER);
  const tries = (label, fn) => {
    try { out[label] = grab(fn()); } catch (err) { out[label] = { kind: 'error', code: err && err.code }; }
  };
  tries('syncUtf8', () => fs.readFileSync(CONFIG, 'utf8'));
  tries('syncUtf8Dash', () => fs.readFileSync(CONFIG, 'utf-8'));
  tries('syncUtf8Obj', () => fs.readFileSync(CONFIG, { encoding: 'utf-8' }));
  tries('syncNoEnc', () => fs.readFileSync(CONFIG));
  tries('syncOther', () => fs.readFileSync(OTHER, 'utf8'));
  out.promiseUtf8Dash = await fs.promises.readFile(CONFIG, 'utf-8').then(
    (v) => grab(v), (err) => ({ kind: 'error', code: err && err.code }));
  fs.writeFileSync(STATE, JSON.stringify(out));
}
main().then(() => process.exit(0), (err) => {
  process.stderr.write('probe failed: ' + (err && err.stack || err));
  process.exit(9);
});
`;

interface ProbeState {
  /** CLI 内看到的入口锚（wrapper 修复后应 = 真实 CLI 路径） */
  argv1: string | null;
  /** CLI 内看到的内建 provider 配置定位键（未设 = null，wrapper 缺席不设键语义） */
  builtinProviderEnv: string | null;
  existsConfig: boolean;
  existsMissing: boolean;
  existsOther: boolean;
  syncUtf8: { kind: string; text?: string; code?: string };
  syncUtf8Dash: { kind: string; text?: string; code?: string };
  syncUtf8Obj: { kind: string; text?: string; code?: string };
  syncNoEnc: { kind: string; text?: string; code?: string };
  syncOther: { kind: string; text?: string; code?: string };
  promiseUtf8Dash: { kind: string; text?: string; code?: string };
  [k: string]: unknown;
}

let tmpRoot: string;

interface HomeSpec {
  /** v2 config 原文（与 v2 字段互斥，用于损坏/缺失场景） */
  v2Raw?: string;
  /** v2 config 对象形态 */
  v2?: unknown;
  /** cli config 原文（与 real 字段互斥） */
  realRaw?: string;
  /** cli config 对象形态；undefined = 不布置该文件（GUI-only 宿主） */
  real?: unknown;
  /** 显式预设 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE；缺省 = spawn env 不设该键 */
  builtinProviderEnv?: string;
}

function setupHome(spec: HomeSpec): {
  run: () => childProcess.SpawnSyncReturns<string>;
  state: () => ProbeState;
  /** 探针 fake CLI 路径（= spawn env 的 ZCODE_ENG_CLI_PATH） */
  cliPath: string;
  /** fixture HOME（wrapper / probe 内 os.homedir() 读到该值） */
  home: string;
} {
  const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
  const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-"));
  const cliDir = path.join(home, ".zcode", "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(home, ".probe-other.txt"), "OTHER-CONTENT");
  const v2Path = path.join(home, ".zcode", "v2", "config.json");
  fs.mkdirSync(path.dirname(v2Path), { recursive: true });
  if (spec.v2Raw !== undefined) fs.writeFileSync(v2Path, spec.v2Raw);
  else if (spec.v2 !== undefined) fs.writeFileSync(v2Path, JSON.stringify(spec.v2, null, 2));
  const cliConfig = path.join(cliDir, "config.json");
  if (spec.realRaw !== undefined) fs.writeFileSync(cliConfig, spec.realRaw);
  else if (spec.real !== undefined) fs.writeFileSync(cliConfig, JSON.stringify(spec.real, null, 2));

  const probePath = path.join(tmpRoot, `probe-${path.basename(home)}.cjs`);
  fs.writeFileSync(probePath, PROBE_SOURCE);
  const launcher = ensureAppServerLauncher(engineDataDir);
  const statePath = path.join(tmpRoot, `state-${path.basename(home)}.json`);

  return {
    cliPath: probePath,
    home,
    run: () => {
      // 密封性：剔除宿主链路 ambient 的 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE（taiji
      // 链下跑测试会被误判为「显式传入」短路派生分支），该键由用例经 spec 显式决定
      const { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: _ambient, ...cleanEnv } = process.env;
      const explicit = spec.builtinProviderEnv === undefined
        ? {}
        : { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: spec.builtinProviderEnv };
      return childProcess.spawnSync(process.execPath, [launcher], {
        env: {
          ...cleanEnv,
          HOME: home,
          ZCODE_ENG_CLI_PATH: probePath,
          ZCODE_ENG_V2_CONFIG: v2Path,
          ZCODE_PROBE_STATE: statePath,
          ...explicit,
        } as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 15_000,
      });
    },
    state: () => JSON.parse(fs.readFileSync(statePath, "utf8")) as ProbeState,
  };
}

const providerEntry = (apiKey: string) => ({ options: { apiKey, baseURL: "https://example.test/v1" } });

/** 在 fixture HOME 下布置 v2 runtime provider 目录树（每版本两个 endpoint 各含 zcode-builtin.json）。 */
function plantRuntimeProvider(home: string, versions: string[]): void {
  const platDir = path.join(
    home, ".zcode", "v2", "runtime", "provider", `${process.platform}-${process.arch}`,
  );
  for (const ver of versions) {
    for (const ep of ["endpoint-test1", "endpoint-test2"]) {
      const file = path.join(platDir, ver, ep, "zcode-builtin.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{}");
    }
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-launcher-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("wrapper 合并语义（v2 注入优先）", () => {
  it("同 id 时 v2 条目整条优先于真实文件（等价复刻 GUI 直传：v2 权威），real 独有条目保留", () => {
    const h = setupHome({
      v2: { provider: { shared: providerEntry("v2-new-key") } },
      real: {
        provider: { shared: providerEntry("real-stale-key"), realOnly: providerEntry("real-key") },
        model: { main: "shared/model-a" },
      },
    });
    const res = h.run();
    expect(res.status).toBe(0);
    const cfg = JSON.parse(h.state().syncUtf8.text as string);
    expect(cfg.provider.shared.options.apiKey).toBe("v2-new-key");
    expect(cfg.provider.realOnly.options.apiKey).toBe("real-key");
    expect(cfg.model.main).toBe("shared/model-a");
  });

  it("real 无 model.main 时以 v2.model.main / FALLBACK 兜底注入", () => {
    const h = setupHome({
      v2: { provider: { p1: providerEntry("k1") } },
      real: { provider: { p2: providerEntry("k2") } },
    });
    const res = h.run();
    expect(res.status).toBe(0);
    const cfg = JSON.parse(h.state().syncUtf8.text as string);
    expect(cfg.model.main).toBe("builtin:bigmodel-coding-plan/GLM-5.3");
  });

  it("v2.model.main 存在时优先于 FALLBACK", () => {
    const h = setupHome({
      v2: { provider: { p1: providerEntry("k1") }, model: { main: "p1/model-x" } },
      real: {},
    });
    const res = h.run();
    expect(res.status).toBe(0);
    const cfg = JSON.parse(h.state().syncUtf8.text as string);
    expect(cfg.model.main).toBe("p1/model-x");
  });
});

describe("入口锚（argv[1] 改写）", () => {
  it("CLI 内看到的 argv[1] = 真实 CLI 路径（ZCODE_ENG_CLI_PATH），wrapper 路径不泄漏回 argv[1]", () => {
    // 守卫语义：上游 provider bootstrap 以 argv[1] 为入口锚，从该路径邻近定位 CLI
    // 内建 provider 配置——wrapper 路径泄漏回 argv[1] 即启动期 provider 配置定位
    // 失败（真机事故形态：报「无法定位 CLI ZCode Built-in Provider Config」即退）。
    const h = setupHome({ v2: { provider: { p1: providerEntry("k1") } }, real: {} });
    const res = h.run();
    expect(res.status).toBe(0);
    expect(h.state().argv1).toBe(h.cliPath);
  });
});

describe("内建 provider 配置定位（env 补齐）", () => {
  it("显式传入优先：spawn env 已设该键时 wrapper 原样保留，不做目录派生", () => {
    const explicit = path.join(tmpRoot, "explicit-provider", "zcode-builtin.json");
    // HOME 无 v2 runtime 目录 → 派生分支必然落空，键值仍为显式传入即「优先」实证
    const h = setupHome({
      v2: { provider: { p1: providerEntry("k1") } },
      real: {},
      builtinProviderEnv: explicit,
    });
    const res = h.run();
    expect(res.status).toBe(0);
    expect(h.state().builtinProviderEnv).toBe(explicit);
  });

  it("派生（真实桌面布局）：无显式键时扫平台前缀目录（Rust arch 命名 darwin-aarch64）取版本号最大目录的 endpoint-*/zcode-builtin.json", () => {
    // 钉住真实桌面布局：桌面 app 建的平台目录用 Rust arch 命名（darwin-aarch64），
    // 非 Node 的 process.arch 形态（darwin-arm64）——曾因按单一精确形态派生漏测此
    // 变体，readdirSync ENOENT 被静默 catch、键未设、CLI 启动失败。不经 helper：
    // helper 布的是 Node 精确形态（下一个用例的职责），本用例布 Rust 变体形态
    const h = setupHome({ v2: { provider: { p1: providerEntry("k1") } }, real: {} });
    const platDir = path.join(h.home, ".zcode", "v2", "runtime", "provider", "darwin-aarch64");
    for (const ver of ["3.12.1", "3.12.3"]) {
      for (const ep of ["endpoint-test1", "endpoint-test2"]) {
        const file = path.join(platDir, ver, ep, "zcode-builtin.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "{}");
      }
    }
    const res = h.run();
    expect(res.status).toBe(0);
    expect(h.state().builtinProviderEnv).toBe(
      path.join(
        h.home, ".zcode", "v2", "runtime", "provider",
        "darwin-aarch64", "3.12.3", "endpoint-test1", "zcode-builtin.json",
      ),
    );
  });

  it("派生（精确形态）：fixture 仅含 <plat>-<arch>（Node 形态）平台目录时同样命中（扫描法不破坏自建布局）", () => {
    const h = setupHome({ v2: { provider: { p1: providerEntry("k1") } }, real: {} });
    plantRuntimeProvider(h.home, ["3.12.1", "3.12.3"]);
    const res = h.run();
    expect(res.status).toBe(0);
    expect(h.state().builtinProviderEnv).toBe(
      path.join(
        h.home, ".zcode", "v2", "runtime", "provider",
        `${process.platform}-${process.arch}`, "3.12.3", "endpoint-test1", "zcode-builtin.json",
      ),
    );
  });

  it("缺席不设键：HOME 无 runtime 目录且 env 无该键时保持未设（原生报错透出）", () => {
    const h = setupHome({ v2: { provider: { p1: providerEntry("k1") } }, real: {} });
    const res = h.run();
    expect(res.status).toBe(0);
    expect(h.state().builtinProviderEnv).toBe(null);
  });
});

describe("existsSync 拦截（GUI-only 宿主：cli config 不存在）", () => {
  it("真实文件缺失时 existsSync 返回 true 且读取拿到注入配置（短路门不复 exist = 注入不可见）", () => {
    const h = setupHome({
      v2: { provider: { p1: providerEntry("k1") } },
      // real 不布置 → cli/config.json 不存在
    });
    const res = h.run();
    expect(res.status).toBe(0);
    const st = h.state();
    expect(st.existsConfig).toBe(true);
    const cfg = JSON.parse(st.syncUtf8.text as string);
    expect(cfg.provider.p1.options.apiKey).toBe("k1");
  });
});

describe("no-patch 分支（无凭据可注入 → 原生行为透出）", () => {
  it("v2 无带 apiKey 的 provider：不 patch，读原始内容、existsSync 原生", () => {
    const h = setupHome({
      v2: { provider: { p1: { options: { apiKey: "" } } } },
      realRaw: '{"provider":{"r1":{"options":{"apiKey":"real"}}}}',
    });
    const res = h.run();
    expect(res.status).toBe(0);
    const st = h.state();
    expect(st.syncUtf8.text).toBe('{"provider":{"r1":{"options":{"apiKey":"real"}}}}');
    expect(st.existsConfig).toBe(true);
  });

  it("v2 文件缺失（ENOENT，未登录）：静默 no-patch，stderr 无 v2 读取失败", () => {
    const h = setupHome({ realRaw: '{"provider":{}}' });
    const res = h.run();
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("v2 config 读取失败");
    const st = h.state();
    expect(st.syncUtf8.text).toBe('{"provider":{}}');
  });

  it("v2 损坏（非 ENOENT）：no-patch 且 stderr 出声（与「未登录」区分）", () => {
    const h = setupHome({ v2Raw: "{broken-json", realRaw: '{"provider":{}}' });
    const res = h.run();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("v2 config 读取失败");
    expect(h.state().syncUtf8.text).toBe('{"provider":{}}');
  });

  it("no-patch 且真实文件不存在：existsSync 原生 false、读取 ENOENT（原生报错透出）", () => {
    const h = setupHome({ v2Raw: "{broken" });
    const res = h.run();
    expect(res.status).toBe(0);
    const st = h.state();
    expect(st.existsConfig).toBe(false);
    expect(st.syncUtf8.code).toBe("ENOENT");
  });
});

describe("调用形态（encoding 归一与透传）", () => {
  const base = { v2: { provider: { p1: providerEntry("k1") } }, real: {} };

  it("'utf8' / 'utf-8' / {encoding:'utf-8'} 均返回 string；无 encoding 返回 Buffer（内容一致）", () => {
    const h = setupHome(base);
    const res = h.run();
    expect(res.status).toBe(0);
    const st = h.state();
    for (const key of ["syncUtf8", "syncUtf8Dash", "syncUtf8Obj", "promiseUtf8Dash"] as const) {
      expect(st[key].kind, key).toBe("string");
    }
    expect(st.syncNoEnc.kind).toBe("buffer");
    const merged = JSON.parse(st.syncUtf8.text as string);
    expect(JSON.parse(st.syncNoEnc.text as string)).toEqual(merged);
  });

  it("非 CONFIG_PATH 读取与 existsSync 穿透不受影响", () => {
    const h = setupHome(base);
    const res = h.run();
    expect(res.status).toBe(0);
    const st = h.state();
    expect(st.syncOther.text).toBe("OTHER-CONTENT");
    expect(st.existsOther).toBe(true);
    expect(st.existsMissing).toBe(false);
  });
});

describe("exit 面", () => {
  it("ZCODE_ENG_CLI_PATH 缺失：exit 2 + stderr 含恢复指引", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-"));
    const launcher = ensureAppServerLauncher(engineDataDir);
    // 密封性：本测试自身可能跑在 app-server 宿主链路下（env 带 ZCODE_ENG_CLI_PATH），
    // 不剥掉则「缺失」前置不成立，launcher 会拿到真 CLI 走正常启动路径（exit 1）而非配置错误 exit 2
    const { ZCODE_ENG_CLI_PATH: _ambient, ...hermeticEnv } = process.env;
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      env: { ...hermeticEnv, HOME: home, ZCODE_ENG_V2_CONFIG: path.join(home, "v2.json") },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("ZCODE_ENG_CLI_PATH");
  });

  it("CLI_PATH 指向不存在文件：exit 3 + stderr 加载失败", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-"));
    const launcher = ensureAppServerLauncher(engineDataDir);
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      env: {
        ...process.env,
        HOME: home,
        ZCODE_ENG_CLI_PATH: path.join(tmpRoot, "no-such-cli.cjs"),
        ZCODE_ENG_V2_CONFIG: path.join(home, "v2.json"),
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("加载失败");
  });
});

describe("落盘端（ensureAppServerLauncher）", () => {
  it("首调落盘产物内容与 APPSERVER_LAUNCHER_SOURCE 一致，路径含 engines/zcode/", () => {
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-"));
    const file = ensureAppServerLauncher(engineDataDir);
    expect(path.basename(file)).toBe(ZCODE_APPSERVER_LAUNCHER_NAME);
    expect(file).toContain(path.join("engines", "zcode"));
    expect(fs.readFileSync(file, "utf8")).toBe(APPSERVER_LAUNCHER_SOURCE);
  });

  it("重复调用幂等：返回同一路径，内容不变", () => {
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-"));
    const a = ensureAppServerLauncher(engineDataDir);
    const b = ensureAppServerLauncher(engineDataDir);
    expect(b).toBe(a);
    expect(fs.readFileSync(b, "utf8")).toBe(APPSERVER_LAUNCHER_SOURCE);
  });

  it("陈旧内容（升级后旧 wrapper）被覆盖刷新", () => {
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-"));
    const dir = path.join(engineDataDir, "engines", "zcode");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ZCODE_APPSERVER_LAUNCHER_NAME), "// stale old wrapper");
    const file = ensureAppServerLauncher(engineDataDir);
    expect(fs.readFileSync(file, "utf8")).toBe(APPSERVER_LAUNCHER_SOURCE);
  });

  it("落盘失败包装为含恢复动作的错误（目录只读）", () => {
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-"));
    // 预置同名目录占位目标文件路径，使 renameSync 前的 writeFileSync 落在
    // 目录形态上失败（EISDIR）——覆盖 recovery 文案分支
    const dir = path.join(engineDataDir, "engines", "zcode");
    fs.mkdirSync(path.join(dir, ZCODE_APPSERVER_LAUNCHER_NAME), { recursive: true });
    expect(() => ensureAppServerLauncher(engineDataDir)).toThrow(/落盘失败[\s\S]*恢复/);
  });
});
