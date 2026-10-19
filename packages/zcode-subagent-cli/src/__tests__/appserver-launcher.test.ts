// appserver-launcher.test.ts —— wrapper fs 拦截语义 + 落盘幂等/覆盖 + exit 面。
//
// 防线背景：wrapper 的失效模式是静默的（曾出过首调走未赋值 __origReadFileSync
// 导致拦截整体失效的 bug——56a49ad4c），本文件用「落盘产物 + 探针 fake CLI」的
// 真进程集成形态锚定核心语义：v2 注入优先合并、existsSync 拦截（GUI-only 宿主）、
// encoding 归一、no-patch 分支、透传不受影响、D3 换轨的 provider_config merge
// 拦截（含双实装对账——launcher 内嵌 JS × preparer TS 逐字节锁步）。

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
import { mergePersonalProviderConfig } from "../preparer.ts";

// 探针 fake CLI：以 wrapper 注入后的 fs 形态读取 CONFIG_PATH / 真实
// provider_config.json（D3 换轨拦截路径）的各种调用形态并落盘 state（wrapper 对它
// import() 启动——与真实 zcode.cjs 同入口形态）

/** CLI bundle 源码补丁探针（2026-10-16）：把补丁锚点以注释形态内置（锚点判定是纯
 * 文本匹配），自读 __filename 经 wrapper 拦截 → 记录补丁产物，供两处新改写断言
 * （standalone 注入 / 认证头端口注入）。 */

/** 变体形态 CLI 源码（模拟 ZCode 其它版本：minified 名不同、无 create 调用点、变量名不同）
 * ——验证锚点的版本鲁棒性（① 导出名 + 函数定义默认参数法 ② registry 变量动态提取）。 */
const CLI_VARIANT_PROBE_SOURCE = `'use strict';
const fs = require('node:fs');
const STATE = process.env.ZCODE_PROBE_STATE;
// function aBc(e,t={}){let s=t.standalone?t.standalone.credentialStore:void 0;return {runtime:{registryService:null}}}
// startProcessProviderRegistryRuntime:()=>aBc,
// zcodeBuiltinProviders.entries()  ...zhipu-account... new Uk({access:new I3({entitled:!1})})
// createZCodeApp:r(function(ut){return {args:[Rt.runtime.registryService],extra:1}}),"createZCodeApp"),cwd
const self = fs.readFileSync(process.env.ZCODE_ENG_CLI_PATH, 'utf8');
fs.writeFileSync(STATE, JSON.stringify({ self }));
`;

const CLI_PATCH_PROBE_SOURCE = `'use strict';
const fs = require('node:fs');
const STATE = process.env.ZCODE_PROBE_STATE;
// 补丁锚点 fixture（文本匹配用，非执行路径）：
// startProcessProviderRegistryRuntime:()=>xCt,
// create:r(()=>xCt(z),"create")
// createZCodeApp:r((
// Fe.runtime.registryService
// }),"createZCodeApp")
const self = fs.readFileSync(process.env.ZCODE_ENG_CLI_PATH, 'utf8');
fs.writeFileSync(STATE, JSON.stringify({ self }));
`;

/** 仅端口锚命中的 CLI 源码（无 ①/② 锚）：验证 portInjected 单独命中时补丁产物
 * 仍被交付（曾只按 entitled/standalone 交付 → 端口补丁静默丢弃）与门标志分离。 */
const CLI_PORT_ONLY_PROBE_SOURCE = `'use strict';
const fs = require('node:fs');
const STATE = process.env.ZCODE_PROBE_STATE;
// createZCodeApp:r((
// Fe.runtime.registryService
// }),"createZCodeApp")
const self = fs.readFileSync(process.env.ZCODE_ENG_CLI_PATH, 'utf8');
fs.writeFileSync(STATE, JSON.stringify({ self }));
`;

/** ③ 锚缺失形态（①/② 锚仍在）：门须报 header-port=off（标志驱动，产物子串判定
 * 在真实 bundle 上恒真——既有 8 处 'providerRuntimeHeadersPort:'）。 */
const CLI_NO_HEADER_ANCHOR_PROBE_SOURCE = `'use strict';
const fs = require('node:fs');
const STATE = process.env.ZCODE_PROBE_STATE;
// startProcessProviderRegistryRuntime:()=>xCt,
// create:r(()=>xCt(z),"create")
// 既有同名属性（模拟真实 bundle 的 8 处预存 occurrence——子串判定恒真）
// return {providerRuntimeHeadersPort:e.providerRuntimeHeadersPort}
const self = fs.readFileSync(process.env.ZCODE_ENG_CLI_PATH, 'utf8');
fs.writeFileSync(STATE, JSON.stringify({ self }));
`;

/** 长 minified 名形态（> 11 字符）：旧 `{0,10}` 上限会静默截断 → 取错函数名。 */
const CLI_LONG_NAME_PROBE_SOURCE = `'use strict';
const fs = require('node:fs');
const STATE = process.env.ZCODE_PROBE_STATE;
// function aVeryLongMinifiedName(e,t={}){let s=t.standalone;return {runtime:{registryService:null}}}
// startProcessProviderRegistryRuntime:()=>aVeryLongMinifiedName,
const self = fs.readFileSync(process.env.ZCODE_ENG_CLI_PATH, 'utf8');
fs.writeFileSync(STATE, JSON.stringify({ self }));
`;

/** 多缺省参数形态（`e,t={},o={}`）：定义默认参数法不唯一 → 回退调用点锚，
 * 不得把 standalone 注入到错误参数。 */
const CLI_MULTI_DEFAULT_PROBE_SOURCE = `'use strict';
const fs = require('node:fs');
const STATE = process.env.ZCODE_PROBE_STATE;
// function aBc(e,t={},o={}){let s=t.standalone;return {runtime:{registryService:null}}}
// startProcessProviderRegistryRuntime:()=>aBc,
// create:r(()=>aBc(z),"create")
const self = fs.readFileSync(process.env.ZCODE_ENG_CLI_PATH, 'utf8');
fs.writeFileSync(STATE, JSON.stringify({ self }));
`;

/** 同名定义歧义形态（两处 `function xCt(`，无调用点）：定义锚无法确定导出对象
 * 指向哪个实现 → 必须放弃本锚、不得改写任何一处（MF-1-5 回归：曾取首个文本命中）。 */
const CLI_DECOY_DEF_PROBE_SOURCE = `'use strict';
const fs = require('node:fs');
const STATE = process.env.ZCODE_PROBE_STATE;
// function xCt(e,t={}){let s=t.standalone;return {runtime:{registryService:null}}}
// function xCt(e,t={}){let s=t.standalone;return {runtime:{registryService:null}}}
// startProcessProviderRegistryRuntime:()=>xCt,
const self = fs.readFileSync(process.env.ZCODE_ENG_CLI_PATH, 'utf8');
fs.writeFileSync(STATE, JSON.stringify({ self }));
`;

/** 首参缺省形态（`function aBc(e={},t)`）：`={}` 不在第二参 → 不得改写定义，
 * 回退调用点把 standalone 作为**第二实参**传入（MF-1-5 回归）。 */
const CLI_FIRST_PARAM_DEFAULT_PROBE_SOURCE = `'use strict';
const fs = require('node:fs');
const STATE = process.env.ZCODE_PROBE_STATE;
// function aBc(e={},t){let s=t.standalone;return {runtime:{registryService:null}}}
// startProcessProviderRegistryRuntime:()=>aBc,
// create:r(()=>aBc(z),"create")
const self = fs.readFileSync(process.env.ZCODE_ENG_CLI_PATH, 'utf8');
fs.writeFileSync(STATE, JSON.stringify({ self }));
`;

/** 实参内联串含 ')' 形态：调用点括号配平必须跳过字面量，注入落在外层调用末尾
 * （MF-1-5 回归：旧实现首个 ')' 落在字符串内 → 注入错位进内层调用）。 */
const CLI_STRING_ARG_PROBE_SOURCE = `'use strict';
const fs = require('node:fs');
const STATE = process.env.ZCODE_PROBE_STATE;
// startProcessProviderRegistryRuntime:()=>aBc,
// create:r(()=>aBc(get("x)y")),"create")
const self = fs.readFileSync(process.env.ZCODE_ENG_CLI_PATH, 'utf8');
fs.writeFileSync(STATE, JSON.stringify({ self }));
`;

/** 端口注入行为探针（可执行形态）：createZCodeApp 选项对象里的调用方端口在
 * registry 无本地端口时必须保留（host 回落），有本地端口时被覆盖（standalone）。
 * 旧实现无条件尾插 `<reg>.providerRuntimeHeadersPort`（undefined）→ host 端口被
 * shadow 抹除（S-4 行为回归）。 */
const CLI_PORT_BEHAVIOUR_SOURCE = `'use strict';
const fs = require('node:fs');
const STATE = process.env.ZCODE_PROBE_STATE;
function INn(o) { return o; }
function r(fn) { return fn; }
const Fe = { runtime: { registryService: { name: 'reg' } } };
if (process.env.ZCODE_PROBE_REG_PORT) Fe.providerRuntimeHeadersPort = { kind: process.env.ZCODE_PROBE_REG_PORT };
const callerPort = { kind: 'caller-host-port' };
const deps = { createZCodeApp:r((ut={})=>INn({providerRuntimeHeadersPort:callerPort, registry:Fe.runtime.registryService}),"createZCodeApp"), cwd: 1 };
const app = deps.createZCodeApp();
const self = fs.readFileSync(process.env.ZCODE_ENG_CLI_PATH, 'utf8');
fs.writeFileSync(STATE, JSON.stringify({ self, port: app.providerRuntimeHeadersPort }));
`;

const PROBE_SOURCE = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const CONFIG = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
const PC = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
const CATALOG = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || null;
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
  out.pcExists = fs.existsSync(PC);
  const tries = (label, fn) => {
    try { out[label] = grab(fn()); } catch (err) { out[label] = { kind: 'error', code: err && err.code }; }
  };
  tries('syncUtf8', () => fs.readFileSync(CONFIG, 'utf8'));
  tries('syncUtf8Dash', () => fs.readFileSync(CONFIG, 'utf-8'));
  tries('syncUtf8Obj', () => fs.readFileSync(CONFIG, { encoding: 'utf-8' }));
  tries('syncNoEnc', () => fs.readFileSync(CONFIG));
  tries('syncOther', () => fs.readFileSync(OTHER, 'utf8'));
  tries('pcSyncUtf8Dash', () => fs.readFileSync(PC, 'utf-8'));
  tries('pcSyncNoEnc', () => fs.readFileSync(PC));
  out.promiseUtf8Dash = await fs.promises.readFile(CONFIG, 'utf-8').then(
    (v) => grab(v), (err) => ({ kind: 'error', code: err && err.code }));
  out.pcPromiseUtf8 = await fs.promises.readFile(PC, 'utf8').then(
    (v) => grab(v), (err) => ({ kind: 'error', code: err && err.code }));
  if (CATALOG) {
    // 内建目录读取（endswith('zcode-builtin.json') 拦截分支——wrapper 安装补丁层后
    // 应返回 entitled:true 的补丁视图；未安装时原文透出）
    tries('catalogUtf8', () => fs.readFileSync(CATALOG, 'utf8'));
  }
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
  /** 真实 provider_config.json 的 existsSync 结果（D3 拦截分支） */
  pcExists: boolean;
  syncUtf8: { kind: string; text?: string; code?: string };
  syncUtf8Dash: { kind: string; text?: string; code?: string };
  syncUtf8Obj: { kind: string; text?: string; code?: string };
  syncNoEnc: { kind: string; text?: string; code?: string };
  syncOther: { kind: string; text?: string; code?: string };
  pcSyncUtf8Dash: { kind: string; text?: string; code?: string };
  pcSyncNoEnc: { kind: string; text?: string; code?: string };
  promiseUtf8Dash: { kind: string; text?: string; code?: string };
  pcPromiseUtf8: { kind: string; text?: string; code?: string };
  /** 内建目录读取（catalogUtf8：ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向的 zcode-builtin.json；env 未设时字段缺省） */
  catalogUtf8?: { kind: string; text?: string; code?: string };
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
  /** provider_config.json 对象形态（D3 顺带发现 6 补注入源 + D3 换轨拦截的真实侧）；undefined = 不布置 */
  providerConfig?: unknown;
  /** provider_config.json 原文（与 providerConfig 互斥——D3 拦截零变化断言的字节级锚点） */
  providerConfigRaw?: string;
  /** taiji 同步副本对象形态（D3 换轨：env 指向 engineDataDir 下独立副本路径） */
  syncedCopy?: unknown;
  /** 副本原文（损坏形态；与 syncedCopy 互斥） */
  syncedCopyRaw?: string;
  /**
   * ZCODE_ENG_PROVIDER_CONFIG 显式值：undefined = 缺省（布置了副本 → 副本路径，
   * 否则真实 provider_config 路径——既有补注入行为）；null = 不设该 env
   *（D3 拦截分支不激活态）。
   */
  providerConfigEnv?: string | null;
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
  const providerConfigPath = path.join(home, ".zcode", "v2", "provider_config.json");
  if (spec.providerConfigRaw !== undefined) {
    fs.mkdirSync(path.dirname(providerConfigPath), { recursive: true });
    fs.writeFileSync(providerConfigPath, spec.providerConfigRaw);
  } else if (spec.providerConfig !== undefined) {
    fs.mkdirSync(path.dirname(providerConfigPath), { recursive: true });
    fs.writeFileSync(providerConfigPath, JSON.stringify(spec.providerConfig, null, 2));
  }
  // taiji 同步副本：与真实 provider_config 分置两路径（D3 换轨语义收窄——env 指
  // 副本，真实路径由 wrapper 按 homedir 推导独立拦截）
  const copyPath = path.join(engineDataDir, "engines", "zcode", "pi-synced-provider-config.json");
  if (spec.syncedCopyRaw !== undefined || spec.syncedCopy !== undefined) {
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    if (spec.syncedCopyRaw !== undefined) fs.writeFileSync(copyPath, spec.syncedCopyRaw);
    else fs.writeFileSync(copyPath, JSON.stringify(spec.syncedCopy, null, 2));
  }
  const providerConfigEnv = spec.providerConfigEnv !== undefined
    ? spec.providerConfigEnv
    : (spec.syncedCopy !== undefined || spec.syncedCopyRaw !== undefined)
      ? copyPath
      : providerConfigPath;
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
          ...(providerConfigEnv === null ? {} : { ZCODE_ENG_PROVIDER_CONFIG: providerConfigEnv }),
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
  it("补丁锚点版本鲁棒性：minified 名变化 + 无 create 调用点 → 定义默认参数法独立生效；registry 变量动态提取", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-var-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-var-"));
    fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
    const cliPath = path.join(tmpRoot, "variant-cli.cjs");
    fs.writeFileSync(cliPath, CLI_VARIANT_PROBE_SOURCE);
    const launcher = ensureAppServerLauncher(engineDataDir);
    const statePath = path.join(tmpRoot, "state-var.json");
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      encoding: "utf8",
      env: { ...process.env, ZCODE_ENG_CLI_PATH: cliPath, ZCODE_PROBE_STATE: statePath, HOME: home, TAIJI_AGENT_DATA_DIR: engineDataDir },
    });
    expect(res.status).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(statePath, "utf8")) as { self: string };
    // 定义默认参数法（锚点 A）：t={} → t={standalone:{}}
    expect(recorded.self).toContain("function aBc(e,t={standalone:{}}){");
    // registry 变量动态提取（Rt 而非 Fe）
    expect(recorded.self).toContain(",...(Rt.providerRuntimeHeadersPort?{providerRuntimeHeadersPort:Rt.providerRuntimeHeadersPort}:{})");
    expect(res.stderr).toContain("standalone-account=armed");
    expect(res.stderr).toContain("header-port=armed");
  });

  it("standalone 账号元数据键幂等供给：缺键时从 host 态 key 名派生 identity + oauth 认证来源；二次运行不动文件（2026-10-16 真机修复回归）", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-meta-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-meta-"));
    const v2 = path.join(home, ".zcode", "v2");
    fs.mkdirSync(v2, { recursive: true });
    const credPath = path.join(v2, "credentials.json");
    const PID = "account:bigmodel-individual-coding-plan";
    fs.writeFileSync(credPath, JSON.stringify({
      "oauth:bigmodel:access_token": "enc:v1:fake-oauth-token",
      [`account-provider:coding-plan:${PID}:account:test-identity-0001:api-key`]: "enc:v1:fake-plan-key",
    }, null, 2));
    // 内建目录 fixture（zhipu-account 规则 → plan provider 清单来源）
    const catalogDir = path.join(tmpRoot, "catalog-meta");
    fs.mkdirSync(catalogDir, { recursive: true });
    const catalogPath = path.join(catalogDir, "zcode-builtin.json");
    fs.writeFileSync(catalogPath, JSON.stringify({
      config: { providerConfigRules: { providerRules: [{ providerId: PID, config: { access: { type: "zhipu-account" } } }] } },
    }));
    const launcher = ensureAppServerLauncher(engineDataDir);
    const cliPath = path.join(tmpRoot, "probe-meta.cjs");
    // 带 standalone 锚的 CLI 源码：元数据供给现仅在安装门确认 standalone 已武装时
    // 执行（无消费方的版本不写共享凭据库）
    fs.writeFileSync(cliPath, CLI_PATCH_PROBE_SOURCE);
    const statePath = path.join(tmpRoot, "state-meta.json");
    const env = {
      ...process.env,
      ZCODE_ENG_CLI_PATH: cliPath,
      ZCODE_PROBE_STATE: statePath,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: catalogPath,
      HOME: home,
      TAIJI_AGENT_DATA_DIR: engineDataDir,
    };
    const first = childProcess.spawnSync(process.execPath, [launcher], { encoding: "utf8", env });
    expect(first.status).toBe(0);
    expect(first.stderr).toContain("account metadata provisioned");
    const after = JSON.parse(fs.readFileSync(credPath, "utf8")) as Record<string, string>;
    expect(after[`account-provider:${PID}:identity`]).toBe("test-identity-0001");
    expect(after[`account-provider:${PID}:auth-source`]).toBe("oauth");
    // 既有键未被动
    expect(after["oauth:bigmodel:access_token"]).toBe("enc:v1:fake-oauth-token");
    // 幂等：二次运行不重写（无 provisioned 行、文件内容等同）
    const before = fs.readFileSync(credPath, "utf8");
    const second = childProcess.spawnSync(process.execPath, [launcher], { encoding: "utf8", env });
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain("account metadata provisioned");
    expect(fs.readFileSync(credPath, "utf8")).toBe(before);
  });

  it("元数据键存在性守卫：有凭据支撑的既有 identity/auth-source 不被派生值覆写；空串按缺失态兜底填充 + 原子写保留文件 mode（ADR-0143 契约回归）", () => {
    const PID = "account:bigmodel-individual-coding-plan";
    const catalogDir = path.join(tmpRoot, "catalog-meta-guard");
    fs.mkdirSync(catalogDir, { recursive: true });
    const catalogPath = path.join(catalogDir, "zcode-builtin.json");
    fs.writeFileSync(catalogPath, JSON.stringify({
      config: { providerConfigRules: { providerRules: [{ providerId: PID, config: { access: { type: "zhipu-account" } } }] } },
    }));
    const launcher = ensureAppServerLauncher(fs.mkdtempSync(path.join(tmpRoot, "eng-meta-guard-")));
    const cliPath = path.join(tmpRoot, "probe-meta-guard.cjs");
    fs.writeFileSync(cliPath, CLI_PATCH_PROBE_SOURCE);
    const runLauncher = (home: string, statePath: string) =>
      childProcess.spawnSync(process.execPath, [launcher], {
        encoding: "utf8",
        env: {
          ...process.env,
          ZCODE_ENG_CLI_PATH: cliPath,
          ZCODE_PROBE_STATE: statePath,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: catalogPath,
          HOME: home,
        },
      });

    // 场景①：既有非空 identity 有 api-key 支撑、auth-source=manual（GUI/登录流程
    // 权威写入）→ 原样保留，零写入。auth-source 旧实现会把 manual 无差别覆写为
    // 派生值 oauth（违反有凭据值不覆写契约）；identity 旧实现永远不校验收敛。
    const homeKeep = fs.mkdtempSync(path.join(tmpRoot, "home-meta-guard-keep-"));
    fs.mkdirSync(path.join(homeKeep, ".zcode", "v2"), { recursive: true });
    const credKeep = path.join(homeKeep, ".zcode", "v2", "credentials.json");
    fs.writeFileSync(credKeep, JSON.stringify({
      "oauth:bigmodel:access_token": "enc:v1:fake-oauth-token",
      [`account-provider:coding-plan:${PID}:account:host-identity-9:api-key`]: "enc:v1:fake-plan-key",
      [`account-provider:${PID}:identity`]: "host-identity-9",
      [`account-provider:${PID}:auth-source`]: "manual",
    }, null, 2));
    const resKeep = runLauncher(homeKeep, path.join(tmpRoot, "state-meta-guard-keep.json"));
    expect(resKeep.status).toBe(0);
    expect(resKeep.stderr).not.toContain("account metadata provisioned");
    const afterKeep = JSON.parse(fs.readFileSync(credKeep, "utf8")) as Record<string, string>;
    expect(afterKeep[`account-provider:${PID}:identity`]).toBe("host-identity-9");
    expect(afterKeep[`account-provider:${PID}:auth-source`]).toBe("manual");

    // 场景②：空串 identity（缺失态）→ 从 host 态 key 名派生填充；auth-source 缺失 →
    // 派生 oauth；写回保留既有文件 mode（rename 换 inode 不放宽权限）。
    const homeFill = fs.mkdtempSync(path.join(tmpRoot, "home-meta-guard-fill-"));
    fs.mkdirSync(path.join(homeFill, ".zcode", "v2"), { recursive: true });
    const credFill = path.join(homeFill, ".zcode", "v2", "credentials.json");
    fs.writeFileSync(credFill, JSON.stringify({
      "oauth:bigmodel:access_token": "enc:v1:fake-oauth-token",
      [`account-provider:coding-plan:${PID}:account:host-identity-9:api-key`]: "enc:v1:fake-plan-key",
      [`account-provider:${PID}:identity`]: "",
    }, null, 2), { mode: 0o600 });
    const resFill = runLauncher(homeFill, path.join(tmpRoot, "state-meta-guard-fill.json"));
    expect(resFill.status).toBe(0);
    expect(resFill.stderr).toContain("account metadata provisioned");
    const afterFill = JSON.parse(fs.readFileSync(credFill, "utf8")) as Record<string, string>;
    expect(afterFill[`account-provider:${PID}:identity`]).toBe("host-identity-9");
    expect(afterFill[`account-provider:${PID}:auth-source`]).toBe("oauth");
    expect(fs.statSync(credFill).mode & 0o777).toBe(0o600);
  });

  it("元数据键孤儿值矫正：oauth 撤销 / plan key 轮换后 identity 与 auth-source 收敛到当前事实（MF-1-1 回归）", () => {
    const PID = "account:bigmodel-individual-coding-plan";
    const catalogDir = path.join(tmpRoot, "catalog-meta-reconcile");
    fs.mkdirSync(catalogDir, { recursive: true });
    const catalogPath = path.join(catalogDir, "zcode-builtin.json");
    fs.writeFileSync(catalogPath, JSON.stringify({
      config: { providerConfigRules: { providerRules: [{ providerId: PID, config: { access: { type: "zhipu-account" } } }] } },
    }));
    const launcher = ensureAppServerLauncher(fs.mkdtempSync(path.join(tmpRoot, "eng-meta-reconcile-")));
    const cliPath = path.join(tmpRoot, "probe-meta-reconcile.cjs");
    fs.writeFileSync(cliPath, CLI_PATCH_PROBE_SOURCE);
    const runLauncher = (home: string, statePath: string) =>
      childProcess.spawnSync(process.execPath, [launcher], {
        encoding: "utf8",
        env: {
          ...process.env,
          ZCODE_ENG_CLI_PATH: cliPath,
          ZCODE_PROBE_STATE: statePath,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: catalogPath,
          HOME: home,
        },
      });

    // 场景①：oauth 撤销（auth-source=oauth 但家族 access_token 已不存在）→ 回落
    // manual；identity 有 api-key 支撑 → 不改写（不回退成缺失态猜测）。
    const homeRevoked = fs.mkdtempSync(path.join(tmpRoot, "home-meta-reconcile-revoked-"));
    fs.mkdirSync(path.join(homeRevoked, ".zcode", "v2"), { recursive: true });
    const credRevoked = path.join(homeRevoked, ".zcode", "v2", "credentials.json");
    fs.writeFileSync(credRevoked, JSON.stringify({
      [`account-provider:coding-plan:${PID}:account:host-identity-9:api-key`]: "enc:v1:fake-plan-key",
      [`account-provider:${PID}:identity`]: "host-identity-9",
      [`account-provider:${PID}:auth-source`]: "oauth",
    }, null, 2));
    const resRevoked = runLauncher(homeRevoked, path.join(tmpRoot, "state-meta-reconcile-revoked.json"));
    expect(resRevoked.status).toBe(0);
    expect(resRevoked.stderr).toContain("account metadata reconciled");
    const afterRevoked = JSON.parse(fs.readFileSync(credRevoked, "utf8")) as Record<string, string>;
    expect(afterRevoked[`account-provider:${PID}:identity`]).toBe("host-identity-9");
    expect(afterRevoked[`account-provider:${PID}:auth-source`]).toBe("manual");
    expect(afterRevoked[`account-provider:coding-plan:${PID}:account:host-identity-9:api-key`])
      .toBe("enc:v1:fake-plan-key");

    // 场景②：reviewer 原始 repro——run1 写入 identity=key-AAAA / auth-source=oauth，
    // 删除 oauth token 并轮换 plan key 后，旧值无任何凭据支撑 → 两个键均收敛到当前
    // 事实（key-BBBB / manual），provider 自愈（旧实现永远不动文件）。
    const homeRotated = fs.mkdtempSync(path.join(tmpRoot, "home-meta-reconcile-rotated-"));
    fs.mkdirSync(path.join(homeRotated, ".zcode", "v2"), { recursive: true });
    const credRotated = path.join(homeRotated, ".zcode", "v2", "credentials.json");
    fs.writeFileSync(credRotated, JSON.stringify({
      [`account-provider:coding-plan:${PID}:account:key-BBBB:api-key`]: "enc:v1:rotated-plan-key",
      [`account-provider:${PID}:identity`]: "key-AAAA",
      [`account-provider:${PID}:auth-source`]: "oauth",
    }, null, 2));
    const resRotated = runLauncher(homeRotated, path.join(tmpRoot, "state-meta-reconcile-rotated.json"));
    expect(resRotated.status).toBe(0);
    expect(resRotated.stderr).toContain("account metadata reconciled");
    const afterRotated = JSON.parse(fs.readFileSync(credRotated, "utf8")) as Record<string, string>;
    expect(afterRotated[`account-provider:${PID}:identity`]).toBe("key-BBBB");
    expect(afterRotated[`account-provider:${PID}:auth-source`]).toBe("manual");
    expect(afterRotated[`account-provider:coding-plan:${PID}:account:key-BBBB:api-key`])
      .toBe("enc:v1:rotated-plan-key");
  });

  it("CLI 源码补丁：standalone 选项注入 + 认证头端口注入（2026-10-16 真机修复的回归守卫）", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-patch-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-patch-"));
    fs.mkdirSync(path.join(home, ".zcode", "cli"), { recursive: true });
    fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
    const cliPath = path.join(tmpRoot, "patchable-cli.cjs");
    fs.writeFileSync(cliPath, CLI_PATCH_PROBE_SOURCE);
    const launcher = ensureAppServerLauncher(engineDataDir);
    const statePath = path.join(tmpRoot, "state-patch.json");
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      encoding: "utf8",
      env: {
        ...process.env,
        ZCODE_ENG_CLI_PATH: cliPath,
        ZCODE_PROBE_STATE: statePath,
        HOME: home,
        TAIJI_AGENT_DATA_DIR: engineDataDir,
      },
    });
    expect(res.status).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(statePath, "utf8")) as { self: string };
    // ② standalone 注入：`create:r(()=><fn>(` 调用点尾插 {standalone:{}}
    expect(recorded.self).toContain(',{standalone:{}}');
    // ③ 认证头端口注入：app 创建选项对象尾插条件 spread（仅本地端口存在时覆盖，
    // 保留上游 kEt 传入的宿主端口回落——S-4）
    expect(recorded.self).toContain(',...(Fe.providerRuntimeHeadersPort?{providerRuntimeHeadersPort:Fe.providerRuntimeHeadersPort}:{})');
    // 安装门出声（补丁可观测）
    expect(res.stderr).toContain("standalone-account=armed");
    expect(res.stderr).toContain("header-port=armed");
  });

  it("端口锚单独命中即交付（portInjected 纳入交付条件）+ 门标志分离：standalone-account=off", () => {
    // 回归：曾按 entitledApplied||standaloneApplied 交付，端口补丁单独命中时产物被
    // 静默丢弃（③ 形同虚设、无任何信号）
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-portonly-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-portonly-"));
    const cliPath = path.join(tmpRoot, "portonly-cli.cjs");
    fs.writeFileSync(cliPath, CLI_PORT_ONLY_PROBE_SOURCE);
    const launcher = ensureAppServerLauncher(engineDataDir);
    const statePath = path.join(tmpRoot, "state-portonly.json");
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      encoding: "utf8",
      env: { ...process.env, ZCODE_ENG_CLI_PATH: cliPath, ZCODE_PROBE_STATE: statePath, HOME: home, TAIJI_AGENT_DATA_DIR: engineDataDir },
    });
    expect(res.status).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(statePath, "utf8")) as { self: string };
    // 交付证据：探针自读 bundle 源码（经 wrapper 拦截）看到注入后的端口
    expect(recorded.self).toContain(',...(Fe.providerRuntimeHeadersPort?{providerRuntimeHeadersPort:Fe.providerRuntimeHeadersPort}:{})');
    expect(res.stderr).toContain("cli-source-bypass=armed");
    expect(res.stderr).toContain("header-port=armed");
    expect(res.stderr).toContain("standalone-account=off");
  });

  it("③ 锚缺失 → header-port=off（标志驱动；既有同名属性子串不得再冒充已武装）", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-noheader-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-noheader-"));
    const cliPath = path.join(tmpRoot, "noheader-cli.cjs");
    // fixture 内含 1 处预存 'providerRuntimeHeadersPort:'（真实 3.15.3 bundle 8 处）：
    // 旧子串判定在此形态下必报 armed，标志驱动才能如实报 off
    fs.writeFileSync(cliPath, CLI_NO_HEADER_ANCHOR_PROBE_SOURCE);
    const launcher = ensureAppServerLauncher(engineDataDir);
    const statePath = path.join(tmpRoot, "state-noheader.json");
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      encoding: "utf8",
      env: { ...process.env, ZCODE_ENG_CLI_PATH: cliPath, ZCODE_PROBE_STATE: statePath, HOME: home, TAIJI_AGENT_DATA_DIR: engineDataDir },
    });
    expect(res.status).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(statePath, "utf8")) as { self: string };
    expect(recorded.self).not.toContain(",...(Fe.providerRuntimeHeadersPort?{providerRuntimeHeadersPort:Fe.providerRuntimeHeadersPort}:{})");
    expect(res.stderr).toContain("standalone-account=armed");
    expect(res.stderr).toContain("header-port=off");
    expect(res.stderr).toContain("header-port injection anchor not found");
  });

  it("长 minified 名（>11 字符）不被截断：函数定义默认参数法仍命中（{0,10} 上限回归）", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-longname-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-longname-"));
    const cliPath = path.join(tmpRoot, "longname-cli.cjs");
    fs.writeFileSync(cliPath, CLI_LONG_NAME_PROBE_SOURCE);
    const launcher = ensureAppServerLauncher(engineDataDir);
    const statePath = path.join(tmpRoot, "state-longname.json");
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      encoding: "utf8",
      env: { ...process.env, ZCODE_ENG_CLI_PATH: cliPath, ZCODE_PROBE_STATE: statePath, HOME: home, TAIJI_AGENT_DATA_DIR: engineDataDir },
    });
    expect(res.status).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(statePath, "utf8")) as { self: string };
    expect(recorded.self).toContain("function aVeryLongMinifiedName(e,t={standalone:{}}){");
  });

  it("多缺省参数 → 回退调用点锚（不把 standalone 注入错误参数）", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-multidefault-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-multidefault-"));
    const cliPath = path.join(tmpRoot, "multidefault-cli.cjs");
    fs.writeFileSync(cliPath, CLI_MULTI_DEFAULT_PROBE_SOURCE);
    const launcher = ensureAppServerLauncher(engineDataDir);
    const statePath = path.join(tmpRoot, "state-multidefault.json");
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      encoding: "utf8",
      env: { ...process.env, ZCODE_ENG_CLI_PATH: cliPath, ZCODE_PROBE_STATE: statePath, HOME: home, TAIJI_AGENT_DATA_DIR: engineDataDir },
    });
    expect(res.status).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(statePath, "utf8")) as { self: string };
    // 定义处保持原样（曾 split/join 全量替换，t/o 两个缺省参数都会被改写）
    expect(recorded.self).toContain("function aBc(e,t={},o={}){");
    // 调用点回退锚：第二参注入 standalone
    expect(recorded.self).toContain("create:r(()=>aBc(z,{standalone:{}})");
    expect(res.stderr).toContain("standalone-account=armed");
  });

  it("同名定义歧义（两处 `function xCt(`）→ 定义锚放弃、不改写任何一处（MF-1-5 回归：曾取首个文本命中）", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-decoy-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-decoy-"));
    // 内建目录 fixture：让安装门进入「已安装」分支（六项矩阵输出）
    const catalogDir = path.join(tmpRoot, "catalog-decoy");
    fs.mkdirSync(catalogDir, { recursive: true });
    const catalogPath = path.join(catalogDir, "zcode-builtin.json");
    fs.writeFileSync(catalogPath, JSON.stringify({
      config: { providerConfigRules: { providerRules: [{ providerId: "account:bigmodel-individual-coding-plan", config: { access: { type: "zhipu-account" } } }] } },
    }));
    const cliPath = path.join(tmpRoot, "decoy-cli.cjs");
    fs.writeFileSync(cliPath, CLI_DECOY_DEF_PROBE_SOURCE);
    const launcher = ensureAppServerLauncher(engineDataDir);
    const statePath = path.join(tmpRoot, "state-decoy.json");
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      encoding: "utf8",
      env: { ...process.env, ZCODE_ENG_CLI_PATH: cliPath, ZCODE_PROBE_STATE: statePath, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: catalogPath, HOME: home, TAIJI_AGENT_DATA_DIR: engineDataDir },
    });
    expect(res.status).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(statePath, "utf8")) as { self: string };
    // 两处定义均保持原样（无法确定导出对象指向哪个实现 → 宁可 not armed）
    expect(recorded.self).not.toContain("{standalone:{}}");
    expect(res.stderr).toContain("standalone-account=off");
    expect(res.stderr).toContain("standalone account: CLI bundle anchor not found");
  });

  it("首参缺省形态（`function aBc(e={},t)`）→ 定义不改写、调用点以第二实参注入（MF-1-5 回归）", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-firstdefault-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-firstdefault-"));
    const cliPath = path.join(tmpRoot, "firstdefault-cli.cjs");
    fs.writeFileSync(cliPath, CLI_FIRST_PARAM_DEFAULT_PROBE_SOURCE);
    const launcher = ensureAppServerLauncher(engineDataDir);
    const statePath = path.join(tmpRoot, "state-firstdefault.json");
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      encoding: "utf8",
      env: { ...process.env, ZCODE_ENG_CLI_PATH: cliPath, ZCODE_PROBE_STATE: statePath, HOME: home, TAIJI_AGENT_DATA_DIR: engineDataDir },
    });
    expect(res.status).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(statePath, "utf8")) as { self: string };
    // 第一参的 ={} 不得被当成 standalone 注入点（语法合法但语义错误，自检无法发现）
    expect(recorded.self).toContain("function aBc(e={},t){");
    expect(recorded.self).not.toContain("function aBc(e={standalone:{}},t)");
    // 回退调用点：把 standalone 作为**第二实参**传入，语义等价
    expect(recorded.self).toContain("create:r(()=>aBc(z,{standalone:{}})");
  });

  it("调用点实参含内联 ')' → 括号配平跳过字面量，注入落在外层末尾（MF-1-5 回归）", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-stringarg-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-stringarg-"));
    const cliPath = path.join(tmpRoot, "stringarg-cli.cjs");
    fs.writeFileSync(cliPath, CLI_STRING_ARG_PROBE_SOURCE);
    const launcher = ensureAppServerLauncher(engineDataDir);
    const statePath = path.join(tmpRoot, "state-stringarg.json");
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      encoding: "utf8",
      env: { ...process.env, ZCODE_ENG_CLI_PATH: cliPath, ZCODE_PROBE_STATE: statePath, HOME: home, TAIJI_AGENT_DATA_DIR: engineDataDir },
    });
    expect(res.status).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(statePath, "utf8")) as { self: string };
    expect(recorded.self).toContain('create:r(()=>aBc(get("x)y"),{standalone:{}})');
    expect(res.stderr).toContain("standalone-account=armed");
  });

  it("端口注入条件 spread：host 形态保留调用方端口，standalone 形态本地端口覆盖（S-4 行为回归）", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-portbehaviour-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-portbehaviour-"));
    const cliPathRaw = path.join(tmpRoot, "portbehaviour-cli.cjs");
    fs.writeFileSync(cliPathRaw, CLI_PORT_BEHAVIOUR_SOURCE);
    // realpath：wrapper 的 .js 扩展处理器按 filename 字面量命中 CLI_PATH，macOS
    // tmpdir 的 /var → /private/var 符号链会让字面量比对落空（执行未打补丁源码），
    // 行为断言必须走真实路径
    const cliPath = fs.realpathSync(cliPathRaw);
    const launcher = ensureAppServerLauncher(engineDataDir);
    const run = (label: string, regPort?: string) => {
      const statePath = path.join(tmpRoot, `state-portbehaviour-${label}.json`);
      const res = childProcess.spawnSync(process.execPath, [launcher], {
        encoding: "utf8",
        env: {
          ...process.env,
          ZCODE_ENG_CLI_PATH: cliPath,
          ZCODE_PROBE_STATE: statePath,
          HOME: home,
          TAIJI_AGENT_DATA_DIR: engineDataDir,
          ...(regPort ? { ZCODE_PROBE_REG_PORT: regPort } : {}),
        },
      });
      expect(res.status).toBe(0);
      return JSON.parse(fs.readFileSync(statePath, "utf8")) as { self: string; port: unknown };
    };
    // registry 无本地端口（host 形态）：无条件尾插会以 undefined shadow 掉上游
    // kEt 传入的宿主端口 → 调用方端口必须保留
    const host = run("host");
    expect(host.port).toEqual({ kind: "caller-host-port" });
    // standalone 形态：registry 本地端口存在 → 覆盖调用方值（账号认证头走本地）
    const standalone = run("standalone", "local-standalone-port");
    expect(standalone.port).toEqual({ kind: "local-standalone-port" });
  });

  it("standalone 补丁未武装 → 不写共享凭据库（上游漂移版本上元数据键无消费方）", () => {
    const PID = "account:bigmodel-individual-coding-plan";
    const catalogDir = path.join(tmpRoot, "catalog-meta-miss");
    fs.mkdirSync(catalogDir, { recursive: true });
    const catalogPath = path.join(catalogDir, "zcode-builtin.json");
    fs.writeFileSync(catalogPath, JSON.stringify({
      config: { providerConfigRules: { providerRules: [{ providerId: PID, config: { access: { type: "zhipu-account" } } }] } },
    }));
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-meta-miss-"));
    fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
    const credPath = path.join(home, ".zcode", "v2", "credentials.json");
    const initial = JSON.stringify({
      "oauth:bigmodel:access_token": "enc:v1:fake-oauth-token",
      [`account-provider:coding-plan:${PID}:account:test-identity-0001:api-key`]: "enc:v1:fake-plan-key",
    }, null, 2);
    fs.writeFileSync(credPath, initial);
    const launcher = ensureAppServerLauncher(fs.mkdtempSync(path.join(tmpRoot, "eng-meta-miss-")));
    const cliPath = path.join(tmpRoot, "probe-meta-miss.cjs");
    // 无补丁锚的 CLI 源码 = 上游形态漂移（补丁链失败）形态
    fs.writeFileSync(cliPath, PROBE_SOURCE);
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      encoding: "utf8",
      env: {
        ...process.env,
        ZCODE_ENG_CLI_PATH: cliPath,
        ZCODE_PROBE_STATE: path.join(tmpRoot, "state-meta-miss.json"),
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: catalogPath,
        HOME: home,
      },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("header-port=off");
    expect(res.stderr).not.toContain("account metadata provisioned");
    expect(fs.readFileSync(credPath, "utf8")).toBe(initial);
  });

  it("standalone 武装但 header-port 锤点漂移 → 不写共享凭据库（S-3 回归：账号链仍不可用时不增写入风险）", () => {
    const PID = "account:bigmodel-individual-coding-plan";
    const catalogDir = path.join(tmpRoot, "catalog-meta-noheader");
    fs.mkdirSync(catalogDir, { recursive: true });
    const catalogPath = path.join(catalogDir, "zcode-builtin.json");
    fs.writeFileSync(catalogPath, JSON.stringify({
      config: { providerConfigRules: { providerRules: [{ providerId: PID, config: { access: { type: "zhipu-account" } } }] } },
    }));
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-meta-noheader-"));
    fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
    const credPath = path.join(home, ".zcode", "v2", "credentials.json");
    const initial = JSON.stringify({
      "oauth:bigmodel:access_token": "enc:v1:fake-oauth-token",
      [`account-provider:coding-plan:${PID}:account:test-identity-0001:api-key`]: "enc:v1:fake-plan-key",
    }, null, 2);
    fs.writeFileSync(credPath, initial);
    const launcher = ensureAppServerLauncher(fs.mkdtempSync(path.join(tmpRoot, "eng-meta-noheader-")));
    const cliPath = path.join(tmpRoot, "probe-meta-noheader.cjs");
    // ② 锚在（standalone 可武装）、③ 锚缺（header-port 锤点漂移）形态
    fs.writeFileSync(cliPath, CLI_NO_HEADER_ANCHOR_PROBE_SOURCE);
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      encoding: "utf8",
      env: {
        ...process.env,
        ZCODE_ENG_CLI_PATH: cliPath,
        ZCODE_PROBE_STATE: path.join(tmpRoot, "state-meta-noheader.json"),
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: catalogPath,
        HOME: home,
      },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("standalone-account=armed");
    expect(res.stderr).toContain("header-port=off");
    expect(res.stderr).not.toContain("account metadata provisioned");
    expect(fs.readFileSync(credPath, "utf8")).toBe(initial);
  });

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

  it("real 与 v2 均无 model.main 时不伪造（缺省解析归 CLI——plan 家族 id 已不可用）", () => {
    const h = setupHome({
      v2: { provider: { p1: providerEntry("k1") } },
      real: { provider: { p2: providerEntry("k2") } },
    });
    const res = h.run();
    expect(res.status).toBe(0);
    const cfg = JSON.parse(h.state().syncUtf8.text as string);
    expect(cfg.model).toBeUndefined();
  });

  it("real 无 model.main 而 v2.model.main 存在时透传注入", () => {
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

describe("provider_config 补注入（D3 顺带发现 6：引擎校验源个人 provider 合成）", () => {
  it("仅存在于 providerRules 的个人 provider（v2 字典缺失）→ 合成 cli-config 条目（name/kind/options/models 带 contextWindow limit；禁用模型不进）", () => {
    const h = setupHome({
      v2: { provider: { "p-in-v2": providerEntry("v2-key") } },
      real: {},
      providerConfig: {
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "new-provider",
                providerName: "StepFun",
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: "sk-fixture" },
                  api: { baseUrl: "https://api.stepfun.test/v1" },
                  personalModelIds: ["step-5-preview"],
                  modelOrder: ["step-5-preview"],
                },
              },
              {
                // 无 baseUrl（endpoint 由模板提供）→ 不合成
                providerId: "template-only",
                providerName: "TemplateOnly",
                config: { access: { type: "api-key", apiKey: "sk-t" }, modelOrder: ["m1"] },
              },
            ],
          },
          modelConfigRules: {
            providerModelRules: [
              { modelId: "step-5-preview", config: { enabled: true, properties: { contextWindow: 1000000 } }, providerId: "new-provider" },
              { modelId: "step-disabled", config: { enabled: false }, providerId: "new-provider" },
            ],
          },
        },
      },
    });
    const run1 = h.run();
    expect(run1.status).toBe(0);
    const injected = JSON.parse(h.state().syncUtf8.text!) as { provider: Record<string, { name: string; kind: string; options: { apiKey: string; baseURL: string }; source: string; models: Record<string, unknown> }> };
    // 合成条目：形状照抄现网个人条目；modelRules 的 contextWindow 进 limit；禁用模型不进
    const synth = injected.provider["new-provider"];
    expect(synth).toEqual({
      name: "StepFun",
      kind: "openai-compatible",
      options: { apiKey: "sk-fixture", baseURL: "https://api.stepfun.test/v1" },
      source: "custom",
      models: { "step-5-preview": { limit: { context: 1000000 } } },
    });
    // 无 baseUrl rule 不合成
    expect(injected.provider["template-only"]).toBeUndefined();
    // v2 既有条目原样保留（整条优先语义不受合成影响）
    expect(injected.provider["p-in-v2"]).toEqual(providerEntry("v2-key"));
  });

  it("kind 按条目 api.type 派生（D3）：anthropic-messages → anthropic，openai-chat-completions → openai-compatible（透传真实条目同受派生）", () => {
    // 检查语义：合成 CLI 条目的协议形态必须与 providerRules 条目 api.type 一致
    // （v2 config.json kind 两值形态）——anthropic 协议条目落 openai-compatible 即
    // 注册表协议错配（请求期才暴露）。透传真实条目（provider_config.json 既有
    // anthropic 协议条目）同受派生 = D3 波及面登记的行为变化（错配顺带修正）。
    const rule = (id: string, name: string, apiType: string) => ({
      providerId: id,
      providerName: name,
      config: {
        group: "standard-personal",
        access: { type: "api-key", apiKey: `sk-${id}` },
        api: { type: apiType, baseUrl: `https://${id}.test/v1` },
        modelOrder: ["m1"],
      },
    });
    const h = setupHome({
      v2: { provider: { "p-in-v2": providerEntry("v2-key") } },
      real: {},
      providerConfig: {
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              rule("anthropic-real", "AnthropicRelay", "anthropic-messages"),
              rule("openai-real", "OpenaiRelay", "openai-chat-completions"),
            ],
          },
          modelConfigRules: { providerModelRules: [] },
        },
      },
    });
    const res = h.run();
    expect(res.status).toBe(0);
    const injected = JSON.parse(h.state().syncUtf8.text!) as {
      provider: Record<string, { name: string; kind: string; options: { apiKey: string; baseURL: string }; source: string; models: Record<string, unknown> }>;
    };
    // 两种协议各得其所
    expect(injected.provider["anthropic-real"].kind).toBe("anthropic");
    expect(injected.provider["openai-real"].kind).toBe("openai-compatible");
    // anthropic 条目全形状：除 kind 派生外合成形状与 openai 条目同构
    expect(injected.provider["anthropic-real"]).toEqual({
      name: "AnthropicRelay",
      kind: "anthropic",
      options: { apiKey: "sk-anthropic-real", baseURL: "https://anthropic-real.test/v1" },
      source: "custom",
      models: { m1: {} },
    });
  });

  it("providerRules 与 v2 同 id → 不重复合成（v2 整条优先）；provider_config 缺失 → 静默降级（v2 注入不受影响）", () => {
    const rule = {
      providerId: "shared-p",
      providerName: "Shared",
      config: {
        access: { type: "api-key", apiKey: "rule-key" },
        api: { baseUrl: "https://rule.test/v1" },
        modelOrder: ["m1"],
      },
    };
    const h1 = setupHome({
      v2: { provider: { "shared-p": providerEntry("v2-key") } },
      real: {},
      providerConfig: { config: { providerConfigRules: { providerRules: [rule] }, modelConfigRules: { providerModelRules: [] } } },
    });
    const r1 = h1.run();
    expect(r1.status).toBe(0);
    const injected1 = JSON.parse(h1.state().syncUtf8.text!) as { provider: Record<string, { options: { apiKey: string } }> };
    expect(injected1.provider["shared-p"]).toEqual(providerEntry("v2-key"));

    const h2 = setupHome({ v2: { provider: { "v2-only": providerEntry("k") } }, real: {} });
    const r2 = h2.run();
    expect(r2.status).toBe(0);
    const injected2 = JSON.parse(h2.state().syncUtf8.text!) as { provider: Record<string, unknown> };
    expect(injected2.provider["v2-only"]).toEqual(providerEntry("k"));
  });
});

describe("provider_config 拦截（D3 换轨：Registry 直读路径 → merge 视图）", () => {
  const pcRule = (id: string, key: string, models: string[]) => ({
    providerId: id,
    providerName: id,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: key },
      api: { baseUrl: `https://${id}.test/v1` },
      personalModelIds: models,
    },
  });

  it("命中路径返回 merge 产物：真实条目优先（同名副本让位）+ 副本独有追加 + order 去重保序 + 其余字段取真实", () => {
    const h = setupHome({
      v2: { provider: { p1: providerEntry("k1") } },
      real: {},
      providerConfig: {
        schemaVersion: 7,
        topReal: "keep",
        config: {
          providerOrder: ["real-a", "real-b"],
          otherCfg: 1,
          providerConfigRules: {
            otherPcr: true,
            providerRules: [pcRule("real-a", "key-a", ["m-a"]), pcRule("real-b", "key-b", ["m-b"])],
          },
        },
      },
      syncedCopy: {
        schemaVersion: 9,
        config: {
          // copy-c 在前 + real-b 交错 + copy-d——合并后应 = 真实现值序前缀 + 副本独有追加
          providerOrder: ["copy-c", "real-b", "copy-d"],
          providerConfigRules: {
            providerRules: [
              pcRule("real-b", "copy-key-b", ["copy-m-b"]),
              pcRule("copy-c", "key-c", ["m-c"]),
              pcRule("copy-d", "key-d", ["m-d"]),
            ],
          },
        },
      },
    });
    const res = h.run();
    expect(res.status).toBe(0);
    const st = h.state();
    expect(st.pcExists).toBe(true);
    expect(JSON.parse(st.pcSyncUtf8Dash.text as string)).toEqual({
      schemaVersion: 7,
      topReal: "keep",
      config: {
        providerOrder: ["real-a", "real-b", "copy-c", "copy-d"],
        otherCfg: 1,
        providerConfigRules: {
          otherPcr: true,
          providerRules: [
            pcRule("real-a", "key-a", ["m-a"]),
            pcRule("real-b", "key-b", ["m-b"]),
            pcRule("copy-c", "key-c", ["m-c"]),
            pcRule("copy-d", "key-d", ["m-d"]),
          ],
        },
      },
    });
  });

  it("真实缺失而副本存在 → existsSync true + 副本独有条目为全集（整体返回副本内容）", () => {
    const copy = {
      schemaVersion: 1,
      config: {
        providerOrder: ["copy-c"],
        providerConfigRules: { providerRules: [pcRule("copy-c", "key-c", ["m-c"])] },
      },
    };
    // providerConfig 不布置 → 真实 provider_config.json 缺失
    const h = setupHome({ v2: { provider: { p1: providerEntry("k1") } }, real: {}, syncedCopy: copy });
    const res = h.run();
    expect(res.status).toBe(0);
    const st = h.state();
    expect(st.pcExists).toBe(true);
    expect(JSON.parse(st.pcSyncUtf8Dash.text as string)).toEqual(copy);
  });

  it("env 未设 → 分支不激活（零行为变化）：真实文件原字节透传；真实缺失时 existsSync 原生 false + ENOENT", () => {
    const raw = '{"schemaVersion":1,"config":{"providerOrder":["x"],"providerConfigRules":{"providerRules":[]}}}';
    const h1 = setupHome({
      v2: { provider: { p1: providerEntry("k1") } },
      real: {},
      providerConfigRaw: raw,
      providerConfigEnv: null,
    });
    const r1 = h1.run();
    expect(r1.status).toBe(0);
    const st1 = h1.state();
    expect(st1.pcSyncUtf8Dash.text).toBe(raw);
    expect(st1.pcExists).toBe(true);

    const h2 = setupHome({ v2: { provider: { p1: providerEntry("k1") } }, real: {}, providerConfigEnv: null });
    const r2 = h2.run();
    expect(r2.status).toBe(0);
    const st2 = h2.state();
    expect(st2.pcExists).toBe(false);
    expect(st2.pcSyncUtf8Dash.code).toBe("ENOENT");
  });

  it("副本缺失（env 指向不存在路径）→ 短路回原文件（零行为变化，原字节透传）", () => {
    const raw = '{"schemaVersion":1,"config":{"providerOrder":["x"]}}';
    const h = setupHome({
      v2: { provider: { p1: providerEntry("k1") } },
      real: {},
      providerConfigRaw: raw,
      providerConfigEnv: path.join(tmpRoot, "absent-copy.json"),
    });
    const res = h.run();
    expect(res.status).toBe(0);
    const st = h.state();
    expect(st.pcSyncUtf8Dash.text).toBe(raw);
    expect(st.pcExists).toBe(true);
  });

  it("副本损坏（JSON 不可解析）→ 同副本缺失语义：短路回原文件字节", () => {
    const raw = '{"schemaVersion":1,"config":{"providerOrder":["x"]}}';
    const h = setupHome({
      v2: { provider: { p1: providerEntry("k1") } },
      real: {},
      providerConfigRaw: raw,
      syncedCopyRaw: "{broken-json",
    });
    const res = h.run();
    expect(res.status).toBe(0);
    expect(h.state().pcSyncUtf8Dash.text).toBe(raw);
  });

  it("PC 读取 encoding 归一（同 CONFIG_PATH 语义）：utf-8 → string、无 encoding → Buffer（内容一致）、promises 同则", () => {
    const real = { schemaVersion: 1, config: { providerOrder: ["real-a"], providerConfigRules: { providerRules: [pcRule("real-a", "key-a", ["m-a"])] } } };
    const copy = { schemaVersion: 1, config: { providerOrder: ["copy-c"], providerConfigRules: { providerRules: [pcRule("copy-c", "key-c", ["m-c"])] } } };
    const h = setupHome({ v2: { provider: { p1: providerEntry("k1") } }, real: {}, providerConfig: real, syncedCopy: copy });
    const res = h.run();
    expect(res.status).toBe(0);
    const st = h.state();
    expect(st.pcSyncUtf8Dash.kind).toBe("string");
    expect(st.pcPromiseUtf8.kind).toBe("string");
    expect(st.pcSyncNoEnc.kind).toBe("buffer");
    expect(JSON.parse(st.pcSyncNoEnc.text as string)).toEqual(JSON.parse(st.pcSyncUtf8Dash.text as string));
  });
});

describe("merge 对账（launcher 内嵌 JS × preparer TS——D3 双实装逐字节锁步）", () => {
  /** 从落盘 launcher 产物按标记截取内嵌 mergeProviderConfig 并 eval（真实执行内嵌
   * 函数本体，非复制源——launcher 改动漏同步 preparer 时此处红灯）。 */
  function loadLauncherMerge(): (real: unknown, copy: unknown) => unknown {
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-"));
    const src = fs.readFileSync(ensureAppServerLauncher(engineDataDir), "utf8");
    const start = src.indexOf("// [merge-fn-start]");
    const end = src.indexOf("// [merge-fn-end]");
    expect(start, "launcher 产物含 [merge-fn-start] 标记").toBeGreaterThanOrEqual(0);
    expect(end, "launcher 产物含 [merge-fn-end] 标记").toBeGreaterThan(start);
    return new Function(`${src.slice(start, end)}\nreturn mergeProviderConfig;`)() as (real: unknown, copy: unknown) => unknown;
  }

  const rule = (id: string, key: string) => ({
    providerId: id,
    providerName: id,
    config: { access: { type: "api-key", apiKey: key }, personalModelIds: [`${id}-m`] },
  });
  const conf = (ids: string[], order: string[]) => ({
    schemaVersion: 1,
    config: { providerOrder: order, providerConfigRules: { providerRules: ids.map((id) => rule(id, `key-${id}`)) } },
  });

  it("组合矩阵（双全/真实缺/副本缺/同名冲突/order 交错/非对象标量）：输出 JSON 逐字节相等", () => {
    const jsMerge = loadLauncherMerge();
    const cases: Array<{ name: string; real: unknown; copy: unknown }> = [
      { name: "双全", real: conf(["a", "b"], ["a", "b"]), copy: conf(["c", "d"], ["c", "d"]) },
      { name: "真实缺（ENOENT/损坏态）", real: undefined, copy: conf(["c"], ["c"]) },
      { name: "副本缺（非对象）", real: conf(["a"], ["a"]), copy: undefined },
      { name: "同名冲突", real: conf(["a", "b"], ["a", "b"]), copy: conf(["b", "y"], ["y", "b"]) },
      { name: "order 交错", real: conf(["a", "b"], ["a", "b"]), copy: conf(["b", "c", "a"], ["b", "c", "a"]) },
      { name: "真实为非对象标量", real: 42, copy: conf(["c"], ["c"]) },
      { name: "副本为非对象标量", real: conf(["a"], ["a"]), copy: "garbage" },
    ];
    for (const c of cases) {
      expect(JSON.stringify(jsMerge(c.real, c.copy)), c.name).toBe(JSON.stringify(mergePersonalProviderConfig(c.real, c.copy)));
    }
  });

  it("规则锚定（防双实装同错）：同名真实优先/order 前缀追加去重/其余字段取真实/真实缺返回副本整体", () => {
    const real = { schemaVersion: 7, topReal: "r", config: { providerOrder: ["a", "b"], otherCfg: 1, providerConfigRules: { otherPcr: true, providerRules: [rule("a", "ra"), rule("b", "rb")] } } };
    const copy = { schemaVersion: 9, config: { providerOrder: ["c", "b", "a"], providerConfigRules: { providerRules: [rule("b", "cb"), rule("c", "cc"), { noId: true }] } } };
    expect(mergePersonalProviderConfig(real, copy)).toEqual({
      schemaVersion: 7,
      topReal: "r",
      config: {
        providerOrder: ["a", "b", "c"],
        otherCfg: 1,
        providerConfigRules: { otherPcr: true, providerRules: [rule("a", "ra"), rule("b", "rb"), rule("c", "cc")] },
      },
    });
    // 真实缺 → 副本整体（schemaVersion 等顶层字段随副本）
    expect(mergePersonalProviderConfig(undefined, copy)).toEqual(copy);
  });
});

describe("入口锚（argv[1] 改写）", () => {
  it("CLI 内看到的 argv[1] = 真实 CLI 路径（ZCODE_ENG_CLI_PATH），wrapper 路径不泄漏回 argv[1]", () => {
    // 检查语义：上游 provider bootstrap 以 argv[1] 为入口锚，从该路径邻近定位 CLI
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

describe("安装门（catalog 定位先于门判定——纯 account 宿主回归锁定）", () => {
  /** zhipu-account 内建目录 fixture（entitled 形态可参数化）。 */
  function writeAccountCatalog(entitled: boolean): { path: string; patched: unknown } {
    const access = { type: "zhipu-account", entitled };
    const catalog = {
      config: {
        providerConfigRules: {
          providerRules: [{ providerId: "zhipu", providerName: "Zhipu", config: { access } }],
        },
      },
    };
    const p = path.join(tmpRoot, `catalog-${entitled}`, "zcode-builtin.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(catalog));
    // wrapper 补丁视图：catalogPatchText 原地翻转后重序列化（同形状，entitled:true）
    const patched = {
      config: {
        providerConfigRules: {
          providerRules: [{ providerId: "zhipu", providerName: "Zhipu", config: { access: { ...access, entitled: true } } }],
        },
      },
    };
    return { path: p, patched };
  }

  it("text=null（v2 无凭据）而目录有 zhipu-account 条目 → 补丁层仍安装：目录读取返回 entitled:true + 安装决策出声", () => {
    // 纯 account 宿主形态：v2 不布置 → injectedConfigText() === null。回归前安装门
    // 退化为 text!==null（catalogPatchText 无参调用恒 null）→ 补丁层静默不安装、
    // entitled 原样透出、plan 家族「不存在 Model」且零日志
    const cat = writeAccountCatalog(false);
    const h = setupHome({ builtinProviderEnv: cat.path });
    const res = h.run();
    expect(res.status).toBe(0);
    const st = h.state();
    expect(st.catalogUtf8!.kind).toBe("string");
    expect(JSON.parse(st.catalogUtf8!.text!)).toEqual(cat.patched);
    expect(res.stderr).toContain("补丁层已安装");
    expect(res.stderr).toContain("cli-config-inject=off");
    expect(res.stderr).toContain("catalog-entitled=on");
  });

  it("text=null 且目录未定位 → 跳过决策出声（为何跳过可见），原生行为透出", () => {
    // 无 v2、无 runtime 目录、无显式 env —— 跳过不再静默（决策日志留痕）
    const h = setupHome({});
    const res = h.run();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("补丁层未安装");
    expect(res.stderr).toContain("内建目录未定位");
    expect(res.stderr).not.toContain("补丁层已安装");
    expect(h.state().syncUtf8.code).toBe("ENOENT");
  });

  it("text=null 且目录已定位但无 zhipu-account 条目 → 跳过（原因=无条目需补），目录读取原生透出", () => {
    const p = path.join(tmpRoot, "no-account", "zcode-builtin.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{}");
    const h = setupHome({ builtinProviderEnv: p });
    const res = h.run();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("补丁层未安装");
    expect(res.stderr).toContain("无 zhipu-account 条目");
    expect(h.state().catalogUtf8!.text).toBe("{}");
  });

  it("catalog JSON 损坏 → 跳过原因标「读取/解析失败」而非「无条目」（排障不误导）", () => {
    // 2026-10 审查补：损坏态与无条目态同归 null，日志不分会让排障往「目录没装账号」
    // 方向查而错过文件本身的问题
    const p = path.join(tmpRoot, "corrupt-catalog", "zcode-builtin.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not json");
    const h = setupHome({ builtinProviderEnv: p });
    const res = h.run();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("补丁层未安装");
    expect(res.stderr).toContain("读取/解析失败");
    expect(res.stderr).not.toContain("无 zhipu-account 条目");
  });

  it("text 非 null（v2 有凭据）→ 安装日志标明 cli-config-inject=on（决策可见性）", () => {
    const h = setupHome({ v2: { provider: { p1: providerEntry("k1") } }, real: {} });
    const res = h.run();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("补丁层已安装");
    expect(res.stderr).toContain("cli-config-inject=on");
    expect(res.stderr).toContain("catalog-entitled=off");
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
