// appserver-launcher.test.ts —— wrapper fs 拦截语义 + 落盘幂等/覆盖 + exit 面。
//
// 防线背景：wrapper 的失效模式是静默的（曾出过首调走未赋值 __origReadFileSync
// 导致拦截整体失效的 bug——56a49ad4c）。本文件两层形态锚定核心语义（v2 注入
// 优先合并、existsSync 拦截、encoding 归一、no-patch 分支、D3 切换 merge 视图、
// CLI 源码补丁三锚、账号元数据供给）：
//
// 1. 真进程主链（describe「真进程主链」）：跨进程组合行为——落盘产物被 node 真实
//    执行、fs patch 在子进程内安装、探针 CLI 经 patch 后的 fs 读到注入视图。
//    spawnSync 同步返回 = 确定性完成信号，单条亚秒级（2026-10-22 单测层极端测试
//    整治：原 19 处 spawnSync 的 env/fixture 矩阵收敛为 5 条主链 + 纯函数矩阵）。
// 2. 纯函数矩阵（其余 describe）：从落盘产物提取 wrapper 内嵌函数本体，测试进程内
//    eval 执行（同源——非平行实现；beforeAll 锚定提取源 ARTIFACT ===
//    APPSERVER_LAUNCHER_SOURCE，段截取自产物文本，CLI_PATCH_SECTION /
//    ACCOUNT_METADATA_SECTION 断言逐字节内嵌于产物）。fixture 均为 tmp 下小文件，
//    全同步毫秒级。
//
// 不改被测源码的前提下，wrapper 内嵌函数的提取锚 = 产物内的既有标记
// （[merge-fn-start]/[merge-fn-end]、函数声明行、补丁段常量边界）。

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as vm from "node:vm";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPSERVER_LAUNCHER_SOURCE,
  ZCODE_APPSERVER_LAUNCHER_NAME,
  ensureAppServerLauncher,
} from "../appserver-launcher.ts";
import { ACCOUNT_METADATA_SECTION, CLI_PATCH_SECTION } from "../appserver-launcher-patches.ts";
import { mergePersonalProviderConfig } from "../preparer.ts";

// ---------- fixture 源码 ----------

// 探针 fake CLI（真进程主链用）：以 wrapper 注入后的 fs 形态读取 CONFIG_PATH /
// 真实 provider_config.json（D3 切换拦截路径）的各种调用形态并落盘 state（wrapper
// 对它 import() 启动——与真实 zcode.cjs 同入口形态）

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
  out.pcPromiseUtf8 = await fs.promises.readFile(PC, 'utf-8').then(
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

// 主链③ 专用探针：自读 bundle 源码（经 wrapper 的 CLI_PATH 拦截 = 补丁产物）+
// 读内建目录（经 endsWith('zcode-builtin.json') 拦截 = entitled 补丁视图）。
// 补丁锚点 fixture 以注释形态内置（锚点判定是纯文本匹配）。无 process.exit——
// 仅真进程 spawn 用，但保持可静态检查。
const CLI_MAINLINE_SOURCE = `'use strict';
const fs = require('node:fs');
const STATE = process.env.ZCODE_PROBE_STATE;
// startProcessProviderRegistryRuntime:()=>xCt,
// create:r(()=>xCt(z),"create")
// createZCodeApp:r((
// Fe.runtime.registryService
// }),"createZCodeApp")
const out = {};
out.self = fs.readFileSync(process.env.ZCODE_ENG_CLI_PATH, 'utf8');
if (process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
  out.catalog = fs.readFileSync(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, 'utf8');
}
fs.writeFileSync(STATE, JSON.stringify(out));
`;

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

/** 长 minified 名形态（> 11 字符）：旧 \`{0,10}\` 上限会静默截断 → 取错函数名。 */
const CLI_LONG_NAME_PROBE_SOURCE = `'use strict';
const fs = require('node:fs');
const STATE = process.env.ZCODE_PROBE_STATE;
// function aVeryLongMinifiedName(e,t={}){let s=t.standalone;return {runtime:{registryService:null}}}
// startProcessProviderRegistryRuntime:()=>aVeryLongMinifiedName,
const self = fs.readFileSync(process.env.ZCODE_ENG_CLI_PATH, 'utf8');
fs.writeFileSync(STATE, JSON.stringify({ self }));
`;

/** 多缺省参数形态（\`e,t={},o={}\`）：定义默认参数法不唯一 → 回退调用点锚，
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

/** 同名定义歧义形态（两处 \`function xCt(\`，无调用点）：定义锚无法确定导出对象
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

/** 首参缺省形态（\`function aBc(e={},t)\`）：\`={}\` 不在第二参 → 不得改写定义，
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
 * 旧实现无条件尾插 \`<reg>.providerRuntimeHeadersPort\`（undefined）→ host 端口被
 * shadow 抹除（S-4 行为回归）。无 process.exit——可同进程执行。 */
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

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-launcher-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// ---------- 同源提取基建（纯函数矩阵的执行载体） ----------
//
// 提取源 = ensureAppServerLauncher 的落盘产物；beforeAll 锚定产物 ===
// APPSERVER_LAUNCHER_SOURCE（内容即版本）。此后所有 eval 的函数文本都截取自该
// 产物——与真进程主链执行的是同一段代码（同源，非平行实现）。

let ARTIFACT = "";

/**
 * 真实 fs 模块（vi.importActual）：vitest 的 fs-guard 对 node:fs 做了模块 mock，
 * 访问 mock 命名空间上未定义的导出属性（如内嵌函数体探测用的 `fs.__origReadFileSync`）
 * 会直接抛错进 catch——注入执行必须用真实模块（与 wrapper 子进程内的真实 fs 同形态）。
 * 测试自身的 fixture 布置仍用 import fs（guard 白名单内 tmp 读写不受影响）。
 */
let realFs: typeof fs = fs;

beforeAll(async () => {
  realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-launcher-artifact-"));
  try {
    ARTIFACT = fs.readFileSync(ensureAppServerLauncher(dir), "utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
  // 同源锚：提取源必须是落盘产物本体（落盘端 describe 另有幂等/覆盖断言）
  expect(ARTIFACT).toBe(APPSERVER_LAUNCHER_SOURCE);
});

/** 从产物文本按起止锚截取函数段（锚缺失 = 产物结构漂移，红灯而非静默）。 */
function sliceArtifact(startMarker: string, endMarker: string, what: string): string {
  const s = ARTIFACT.indexOf(startMarker);
  expect(s, `落盘产物含「${what}」起始锚`).toBeGreaterThanOrEqual(0);
  const e = ARTIFACT.indexOf(endMarker, s + startMarker.length);
  expect(e, `落盘产物含「${what}」终止锚`).toBeGreaterThan(s);
  return ARTIFACT.slice(s, e);
}

/** 进程替身：只承接内嵌函数的 process.stderr.write，收集行供断言。 */
function stderrStub(): { process: { stderr: { write: (s: string) => boolean } }; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    process: { stderr: { write: (s: string) => { lines.push(s); return true; } } },
  };
}

/** CLI 补丁三锚的应用态标志（产物内 __cliPatchStatus 的镜像形状）。 */
interface CliPatchFlags {
  entitled: boolean;
  standalone: boolean;
  headerPort: boolean;
}

interface CliPatchApi {
  patched: (p: string) => string | null;
  flags: (p: string) => CliPatchFlags | undefined;
  stderr: string[];
}

let fixtureSeq = 0;

/** fixture CLI 源码落盘为小文件（产物内嵌函数按路径读真实文件）。 */
function writeCliFixture(source: string): string {
  const p = path.join(tmpRoot, `cli-fixture-${fixtureSeq++}.cjs`);
  fs.writeFileSync(p, source);
  return p;
}

/** 提取产物内嵌 patchedCliSource（CLI_PATCH_SECTION 断言逐字节内嵌于产物后 eval）。 */
function loadCliPatch(): CliPatchApi {
  expect(ARTIFACT.indexOf(CLI_PATCH_SECTION), "CLI 补丁段逐字节内嵌于落盘产物").toBeGreaterThanOrEqual(0);
  const { lines, process: proc } = stderrStub();
  const api = new Function(
    "fs", "process",
    `${CLI_PATCH_SECTION}\nreturn { patched: patchedCliSource, flags: (p) => __cliPatchStatus.get(p) };`,
  )(realFs, proc) as Omit<CliPatchApi, "stderr">;
  return { patched: api.patched, flags: api.flags, stderr: lines };
}

/** 落盘 fixture 并跑产物内嵌 patchedCliSource，返回补丁产物 + 应用态标志 + warn。 */
function runCliPatch(source: string): { self: string | null; flags: CliPatchFlags | undefined; stderr: string[] } {
  const cliPath = writeCliFixture(source);
  const api = loadCliPatch();
  return { self: api.patched(cliPath), flags: api.flags(cliPath), stderr: api.stderr };
}

/** 提取产物内嵌 ensureAccountMetadata（os.homedir 注入 fixture HOME，真实 fs 读写）。 */
function loadAccountMetadata(home: string, catalogPath: string | null): { run: () => void; stderr: string[] } {
  expect(ARTIFACT.indexOf(ACCOUNT_METADATA_SECTION), "账号元数据段逐字节内嵌于落盘产物").toBeGreaterThanOrEqual(0);
  const { lines, process: proc } = stderrStub();
  const fn = new Function(
    "fs", "path", "os", "process", "CATALOG_PATH",
    `${ACCOUNT_METADATA_SECTION}\nreturn ensureAccountMetadata;`,
  )(realFs, path, { homedir: () => home }, proc, catalogPath) as () => void;
  return { run: fn, stderr: lines };
}

interface ConfigSpec {
  v2Raw?: string;
  v2?: unknown;
  realRaw?: string;
  real?: unknown;
  providerConfig?: unknown;
  providerConfigRaw?: string;
}

/** 布置 v2 config / cli config / provider_config 三文件（undefined = 不布置）。 */
function writeConfigFixture(spec: ConfigSpec): { configPath: string; v2Path: string; pcPath: string } {
  const home = fs.mkdtempSync(path.join(tmpRoot, "cfg-"));
  fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
  fs.mkdirSync(path.join(home, ".zcode", "cli"), { recursive: true });
  const v2Path = path.join(home, ".zcode", "v2", "config.json");
  const pcPath = path.join(home, ".zcode", "v2", "provider_config.json");
  const configPath = path.join(home, ".zcode", "cli", "config.json");
  if (spec.v2Raw !== undefined) fs.writeFileSync(v2Path, spec.v2Raw);
  else if (spec.v2 !== undefined) fs.writeFileSync(v2Path, JSON.stringify(spec.v2, null, 2));
  if (spec.providerConfigRaw !== undefined) fs.writeFileSync(pcPath, spec.providerConfigRaw);
  else if (spec.providerConfig !== undefined) fs.writeFileSync(pcPath, JSON.stringify(spec.providerConfig, null, 2));
  if (spec.realRaw !== undefined) fs.writeFileSync(configPath, spec.realRaw);
  else if (spec.real !== undefined) fs.writeFileSync(configPath, JSON.stringify(spec.real, null, 2));
  return { configPath, v2Path, pcPath };
}

/** 提取产物内嵌 injectedConfigText 并对 fixture 三文件求值（同步纯逻辑）。 */
function runInjectedConfigText(spec: ConfigSpec): { text: string | null; stderr: string[] } {
  const files = writeConfigFixture(spec);
  const slice = sliceArtifact("function injectedConfigText() {", "\n// [merge-fn-start]", "injectedConfigText");
  const { lines, process: proc } = stderrStub();
  const fn = new Function(
    "fs", "process", "CONFIG_PATH", "V2_PATH", "PROVIDER_CONFIG_PATH",
    `${slice}\nreturn injectedConfigText;`,
  )(realFs, proc, files.configPath, files.v2Path, files.pcPath) as () => string | null;
  return { text: fn(), stderr: lines };
}

/** 从产物按 [merge-fn-start]/[merge-fn-end] 标记提取 mergeProviderConfig（真实执行
 * 内嵌函数本体，非复制源——launcher 改动漏同步 preparer 时对账红灯）。 */
function loadLauncherMerge(): (real: unknown, copy: unknown) => unknown {
  const start = ARTIFACT.indexOf("// [merge-fn-start]");
  const end = ARTIFACT.indexOf("// [merge-fn-end]");
  expect(start, "launcher 产物含 [merge-fn-start] 标记").toBeGreaterThanOrEqual(0);
  expect(end, "launcher 产物含 [merge-fn-end] 标记").toBeGreaterThan(start);
  return new Function(`${ARTIFACT.slice(start, end)}\nreturn mergeProviderConfig;`)() as (real: unknown, copy: unknown) => unknown;
}

/** 提取产物内嵌 mergedProviderConfigText，对 fixture（副本/真实两路径）求值。 */
function runMergedProviderConfigText(piSynced: string, realPc: string): string | null {
  const slice = sliceArtifact("function mergedProviderConfigText() {", "\nif (!CLI_PATH)", "mergedProviderConfigText");
  const fn = new Function(
    "fs", "PI_SYNCED_PATH", "REAL_PROVIDER_CONFIG_PATH", "mergeProviderConfig",
    `${slice}\nreturn mergedProviderConfigText;`,
  )(realFs, piSynced, realPc, loadLauncherMerge()) as () => string | null;
  return fn();
}

/** 提取产物内嵌 catalogPatchText（缓存/状态 Map 以参数注入新实例，隔离用例）。 */
function loadCatalogPatch(): { patch: (p: string) => string | null; statusOf: (p: string) => string | undefined } {
  const sectionStart = ARTIFACT.indexOf(CLI_PATCH_SECTION);
  expect(sectionStart, "CLI 补丁段在产物内（兼作 catalogPatchText 截取终止锚）").toBeGreaterThanOrEqual(0);
  const s = ARTIFACT.indexOf("function catalogPatchText(path) {");
  expect(s, "产物含 catalogPatchText 定义").toBeGreaterThanOrEqual(0);
  expect(sectionStart, "CLI 补丁段位于 catalogPatchText 之后").toBeGreaterThan(s);
  const caches = new Map<string, string | null>();
  const statuses = new Map<string, string>();
  return new Function(
    "fs", "__catalogPatchCache", "__catalogPatchStatus",
    `${ARTIFACT.slice(s, sectionStart)}\nreturn { patch: catalogPatchText, statusOf: (p) => __catalogPatchStatus.get(p) };`,
  )(realFs, caches, statuses) as { patch: (p: string) => string | null; statusOf: (p: string) => string | undefined };
}

/** 同进程执行 CJS fixture（vm 包装注入 require/__filename）——补丁产物的行为验证
 * 无需子进程（fixture 均无 process.exit，确定性同步完成）。 */
const nodeRequire = createRequire(import.meta.url);
function execCjsInProcess(file: string): void {
  const src = fs.readFileSync(file, "utf8");
  const wrapper = vm.runInThisContext(
    `(function (require, __filename) {\n${src}\n})`,
    { filename: file },
  ) as (require: NodeJS.Require, __filename: string) => void;
  wrapper(nodeRequire, file);
}

// ---------- 真进程主链公用 ----------

const providerEntry = (apiKey: string) => ({ options: { apiKey, baseURL: "https://example.test/v1" } });

interface HomeSpec {
  /** v2 config 原文（与 v2 字段互斥，用于损坏/缺失场景） */
  v2Raw?: string;
  /** v2 config 对象形态 */
  v2?: unknown;
  /** cli config 原文（与 real 字段互斥） */
  realRaw?: string;
  /** cli config 对象形态；undefined = 不布置该文件（GUI-only 宿主） */
  real?: unknown;
  /** provider_config.json 对象形态（D3 顺带发现 6 补注入源 + D3 切换拦截的真实侧）；undefined = 不布置 */
  providerConfig?: unknown;
  /** provider_config.json 原文（与 providerConfig 互斥——D3 拦截零变化断言的字节级锚点） */
  providerConfigRaw?: string;
  /** taiji 同步副本对象形态（D3 切换：env 指向 engineDataDir 下独立副本路径） */
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
  // taiji 同步副本：与真实 provider_config 分置两路径（D3 切换语义收窄——env 指
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

// ---------- 真进程主链（wrapper 跨进程组合行为） ----------

describe("真进程主链（落盘产物被 node 真实执行；spawnSync 同步返回，单条亚秒级）", () => {
  it("主链① v2 凭据注入全链：v2 整条优先/real 独有保留/model.main 透传 + encoding 归一 + 透传不受影响 + GUI-only existsSync 拦截 + argv 锚 + 显式 env 优先 + 安装门 on", () => {
    const explicit = path.join(tmpRoot, "explicit-provider", "zcode-builtin.json");
    const h = setupHome({
      v2: { provider: { shared: providerEntry("v2-new-key") } },
      real: {
        provider: { shared: providerEntry("real-stale-key"), realOnly: providerEntry("real-key") },
        model: { main: "shared/model-a" },
      },
      builtinProviderEnv: explicit,
    });
    const res = h.run();
    expect(res.status).toBe(0);
    const st = h.state();
    // 合并语义：同 id 时 v2 条目整条优先（GUI 直传等价复刻），real 独有条目保留
    const cfg = JSON.parse(st.syncUtf8.text as string);
    expect(cfg.provider.shared.options.apiKey).toBe("v2-new-key");
    expect(cfg.provider.realOnly.options.apiKey).toBe("real-key");
    expect(cfg.model.main).toBe("shared/model-a");
    // encoding 归一：'utf8'/'utf-8'/{encoding} 均返回 string，无 encoding 返回 Buffer（内容一致）
    for (const key of ["syncUtf8", "syncUtf8Dash", "syncUtf8Obj", "promiseUtf8Dash"] as const) {
      expect(st[key].kind, key).toBe("string");
    }
    expect(st.syncNoEnc.kind).toBe("buffer");
    expect(JSON.parse(st.syncNoEnc.text as string)).toEqual(cfg);
    // 非 CONFIG_PATH 读取与 existsSync 穿透不受影响
    expect(st.syncOther.text).toBe("OTHER-CONTENT");
    expect(st.existsOther).toBe(true);
    expect(st.existsMissing).toBe(false);
    // GUI-only 宿主（real 不布置）existsSync 拦截返回 true 且读取拿到注入配置
    expect(st.existsConfig).toBe(true);
    // 入口锚：CLI 内 argv[1] = 真实 CLI 路径，wrapper 路径不泄漏（上游 provider
    // bootstrap 以 argv[1] 定位内建配置——泄漏即启动即退）
    expect(st.argv1).toBe(h.cliPath);
    // 显式传入优先：spawn env 已设该键时原样保留，不做目录派生
    expect(st.builtinProviderEnv).toBe(explicit);
    // D3 副本缺失（env 指向不存在路径）→ 短路回原文件：真实文件未布置 → 原生 ENOENT
    expect(st.pcSyncUtf8Dash.code).toBe("ENOENT");
    // 安装门：v2 有凭据 → 安装 + 决策出声
    expect(res.stderr).toContain("补丁层已安装");
    expect(res.stderr).toContain("cli-config-inject=on");
    expect(res.stderr).toContain("catalog-entitled=off");
  });

  it("主链② D3 provider_config 拦截：命中路径返回 merge 视图 + PC encoding 归一；真实缺失 + 副本存在 → existsSync true + 副本整体（缺席不设定位键）", () => {
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
    // 形态 A：真实 + 副本双全 → Registry 直读真实路径拿到 merge 产物
    const h1 = setupHome({
      v2: { provider: { p1: providerEntry("k1") } },
      real: {},
      providerConfig: {
        schemaVersion: 1,
        config: { providerOrder: ["real-a"], providerConfigRules: { providerRules: [pcRule("real-a", "key-a", ["m-a"])] } },
      },
      syncedCopy: {
        schemaVersion: 1,
        config: { providerOrder: ["copy-c"], providerConfigRules: { providerRules: [pcRule("copy-c", "key-c", ["m-c"])] } },
      },
    });
    const r1 = h1.run();
    expect(r1.status).toBe(0);
    const st1 = h1.state();
    expect(st1.pcExists).toBe(true);
    expect(st1.pcSyncUtf8Dash.kind).toBe("string");
    expect(st1.pcPromiseUtf8.kind).toBe("string");
    expect(st1.pcSyncNoEnc.kind).toBe("buffer");
    const merged = JSON.parse(st1.pcSyncUtf8Dash.text as string) as {
      config: { providerOrder: string[]; providerConfigRules: { providerRules: Array<{ providerId: string }> } };
    };
    // 真实条目在前 + 副本独有追加（order 去重保序；结构级断言在 merge 视图 describe）
    expect(merged.config.providerOrder).toEqual(["real-a", "copy-c"]);
    expect(merged.config.providerConfigRules.providerRules.map((r) => r.providerId)).toEqual(["real-a", "copy-c"]);
    expect(JSON.parse(st1.pcSyncNoEnc.text as string)).toEqual(merged);
    // HOME 无 runtime 目录且 env 无定位键 → 保持未设（原生报错透出）
    expect(st1.builtinProviderEnv).toBe(null);

    // 形态 B：真实缺失 + 副本存在 → existsSync true（不得拦掉 merge 视图读取）+ 副本独有条目为全集
    const copy = {
      schemaVersion: 1,
      config: { providerOrder: ["copy-c"], providerConfigRules: { providerRules: [pcRule("copy-c", "key-c", ["m-c"])] } },
    };
    const h2 = setupHome({ v2: { provider: { p1: providerEntry("k1") } }, real: {}, syncedCopy: copy });
    const r2 = h2.run();
    expect(r2.status).toBe(0);
    const st2 = h2.state();
    expect(st2.pcExists).toBe(true);
    expect(JSON.parse(st2.pcSyncUtf8Dash.text as string)).toEqual(copy);
  });

  it("主链③ CLI 源码补丁武装 + 安装门六项矩阵 + catalog entitled 拦截 + 账号元数据供给（纯 account 宿主形态——v2 无凭据）", () => {
    const PID = "account:bigmodel-individual-coding-plan";
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-main3-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-main3-"));
    const v2Dir = path.join(home, ".zcode", "v2");
    fs.mkdirSync(v2Dir, { recursive: true });
    const credPath = path.join(v2Dir, "credentials.json");
    fs.writeFileSync(credPath, JSON.stringify({
      "oauth:bigmodel:access_token": "enc:v1:fake-oauth-token",
      [`account-provider:coding-plan:${PID}:account:test-identity-0001:api-key`]: "enc:v1:fake-plan-key",
    }, null, 2));
    const catalogDir = path.join(tmpRoot, "catalog-main3");
    fs.mkdirSync(catalogDir, { recursive: true });
    const catalogPath = path.join(catalogDir, "zcode-builtin.json");
    fs.writeFileSync(catalogPath, JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            { providerId: "zhipu", providerName: "Zhipu", config: { access: { type: "zhipu-account", entitled: false } } },
            { providerId: PID, config: { access: { type: "zhipu-account" } } },
          ],
        },
      },
    }));
    const cliPath = writeCliFixture(CLI_MAINLINE_SOURCE);
    const statePath = path.join(tmpRoot, "state-main3.json");
    const launcher = ensureAppServerLauncher(engineDataDir);
    // 密封性：剥 ambient 注入键后显式重建（v2 路径不布置 → text=null 纯 account 宿主）
    const {
      ZCODE_ENG_CLI_PATH: _c1, ZCODE_ENG_V2_CONFIG: _c2, ZCODE_ENG_PROVIDER_CONFIG: _c3,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: _c4, ...cleanEnv
    } = process.env;
    const res = childProcess.spawnSync(process.execPath, [launcher], {
      env: {
        ...cleanEnv,
        HOME: home,
        ZCODE_ENG_CLI_PATH: cliPath,
        ZCODE_ENG_V2_CONFIG: path.join(v2Dir, "config.json"),
        ZCODE_PROBE_STATE: statePath,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: catalogPath,
      } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(statePath, "utf8")) as { self: string; catalog: string };
    // CLI 源码补丁：② standalone 调用点注入 + ③ 认证头端口条件 spread
    expect(recorded.self).toContain(",{standalone:{}}");
    expect(recorded.self).toContain(",...(Fe.providerRuntimeHeadersPort?{providerRuntimeHeadersPort:Fe.providerRuntimeHeadersPort}:{})");
    // catalog entitled 拦截：目录读取返回 entitled:true 补丁视图（patch 只发生在读取返回值）
    const patchedCatalog = JSON.parse(recorded.catalog) as {
      config: { providerConfigRules: { providerRules: Array<{ config: { access: { entitled?: boolean } } }> } };
    };
    expect(patchedCatalog.config.providerConfigRules.providerRules.map((r) => r.config.access.entitled)).toEqual([true, true]);
    // 安装门六项矩阵：text=null（v2 无凭据）但 catalog/CLI 补丁可用 → 仍安装，逐项出声
    expect(res.stderr).toContain("补丁层已安装");
    expect(res.stderr).toContain("cli-config-inject=off");
    expect(res.stderr).toContain("catalog-entitled=on");
    expect(res.stderr).toContain("provider-merge=off");
    expect(res.stderr).toContain("cli-source-bypass=armed");
    expect(res.stderr).toContain("standalone-account=armed");
    expect(res.stderr).toContain("header-port=armed");
    // 双锚武装 → 账号元数据供给（缺键派生 identity + oauth 来源；ADR-0143）
    expect(res.stderr).toContain("account metadata provisioned");
    const after = JSON.parse(fs.readFileSync(credPath, "utf8")) as Record<string, string>;
    expect(after[`account-provider:${PID}:identity`]).toBe("test-identity-0001");
    expect(after[`account-provider:${PID}:auth-source`]).toBe("oauth");
    expect(after["oauth:bigmodel:access_token"]).toBe("enc:v1:fake-oauth-token");
  });

  it("主链④ 内建目录派生：Rust arch 变体命中 semver 最大；exact 形态优先于字典序；跳过决策出声 + no-patch 原生透出", () => {
    // 形态 A：仅 Rust arch 命名（真实桌面布局 darwin-aarch64）→ 版本号最大目录的
    // endpoint-* 字典序最前命中（曾因按单一精确形态派生漏测此变体，readdirSync
    // ENOENT 被静默 catch、键未设、CLI 启动失败）
    const h1 = setupHome({});
    const rustDir = path.join(h1.home, ".zcode", "v2", "runtime", "provider", "darwin-aarch64");
    for (const ver of ["3.12.1", "3.12.3"]) {
      for (const ep of ["endpoint-test1", "endpoint-test2"]) {
        const file = path.join(rustDir, ver, ep, "zcode-builtin.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "{}");
      }
    }
    const r1 = h1.run();
    expect(r1.status).toBe(0);
    const st1 = h1.state();
    expect(st1.builtinProviderEnv).toBe(path.join(
      h1.home, ".zcode", "v2", "runtime", "provider", "darwin-aarch64", "3.12.3", "endpoint-test1", "zcode-builtin.json",
    ));
    // 目录内容无 zhipu-account 条目 → 跳过出声（原因=无条目需补），目录读取原生透出
    expect(r1.stderr).toContain("补丁层未安装");
    expect(r1.stderr).toContain("无 zhipu-account 条目需补");
    expect(st1.catalogUtf8!.text).toBe("{}");
    // no-patch 分支（v2 ENOENT 未登录）：existsSync 原生 false、读取 ENOENT（原生报错透出）
    expect(st1.existsConfig).toBe(false);
    expect(st1.syncUtf8.code).toBe("ENOENT");
    expect(st1.pcSyncUtf8Dash.code).toBe("ENOENT");

    // 形态 B：Node exact（darwin-arm64，低版本 3.12.1）与 Rust 变体（3.12.3）并存
    // → exact 形态排序优先先扫（字典序 aarch64 < arm64，无优先级会命中 Rust 侧）
    const h2 = setupHome({});
    plantRuntimeProvider(h2.home, ["3.12.1"]);
    const rustDir2 = path.join(h2.home, ".zcode", "v2", "runtime", "provider", "darwin-aarch64");
    for (const ep of ["endpoint-test1", "endpoint-test2"]) {
      const file = path.join(rustDir2, "3.12.3", ep, "zcode-builtin.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{}");
    }
    const r2 = h2.run();
    expect(r2.status).toBe(0);
    expect(h2.state().builtinProviderEnv).toBe(path.join(
      h2.home, ".zcode", "v2", "runtime", "provider", `${process.platform}-${process.arch}`, "3.12.1", "endpoint-test1", "zcode-builtin.json",
    ));
  });

  it("主链⑤ exit 面：CLI_PATH 缺失 exit 2（含恢复指引）；加载失败 exit 3（附「内建目录未定位」跳过日志）", () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-exit-"));
    const engineDataDir = fs.mkdtempSync(path.join(tmpRoot, "eng-exit-"));
    const launcher = ensureAppServerLauncher(engineDataDir);
    // 密封性：本测试自身可能跑在 app-server 宿主链路下（env 带 ZCODE_ENG_CLI_PATH），
    // 不剥掉则「缺失」前置不成立，launcher 会拿到真 CLI 走正常启动路径（exit 1）而非配置错误 exit 2
    const {
      ZCODE_ENG_CLI_PATH: _c1, ZCODE_ENG_V2_CONFIG: _c2, ZCODE_ENG_PROVIDER_CONFIG: _c3,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: _c4, ...hermeticEnv
    } = process.env;
    const r1 = childProcess.spawnSync(process.execPath, [launcher], {
      env: { ...hermeticEnv, HOME: home, ZCODE_ENG_V2_CONFIG: path.join(home, "v2.json") },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(r1.status).toBe(2);
    expect(r1.stderr).toContain("ZCODE_ENG_CLI_PATH");

    const r2 = childProcess.spawnSync(process.execPath, [launcher], {
      env: {
        ...hermeticEnv,
        HOME: home,
        ZCODE_ENG_CLI_PATH: path.join(tmpRoot, "no-such-cli.cjs"),
        ZCODE_ENG_V2_CONFIG: path.join(home, "v2.json"),
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(r2.status).toBe(3);
    expect(r2.stderr).toContain("加载失败");
    // 空 HOME：无 v2、无 runtime 目录 → 跳过原因标「内建目录未定位」（为何跳过可见）
    expect(r2.stderr).toContain("补丁层未安装");
    expect(r2.stderr).toContain("内建目录未定位");
  });
});

// ---------- CLI 源码补丁锚点（产物内嵌 patchedCliSource 同进程执行——纯文本变换逻辑） ----------

describe("CLI 源码补丁锚点（产物内嵌 patchedCliSource 同进程执行）", () => {
  it("补丁锚点版本鲁棒性：minified 名变化 + 无 create 调用点 → 定义默认参数法独立生效；registry 变量动态提取", () => {
    const { self, flags } = runCliPatch(CLI_VARIANT_PROBE_SOURCE);
    expect(self).not.toBeNull();
    // 定义默认参数法（锚点 A）：t={} → t={standalone:{}}
    expect(self).toContain("function aBc(e,t={standalone:{}}){");
    // registry 变量动态提取（Rt 而非 Fe）
    expect(self).toContain(",...(Rt.providerRuntimeHeadersPort?{providerRuntimeHeadersPort:Rt.providerRuntimeHeadersPort}:{})");
    expect(flags).toMatchObject({ standalone: true, headerPort: true });
  });

  it("CLI 源码补丁：standalone 选项注入 + 认证头端口注入（2026-10-16 真机修复的回归守卫）", () => {
    const { self, flags } = runCliPatch(CLI_PATCH_PROBE_SOURCE);
    expect(self).not.toBeNull();
    // ② standalone 注入：`create:r(()=><fn>(` 调用点尾插 {standalone:{}}
    expect(self).toContain(",{standalone:{}}");
    // ③ 认证头端口注入：app 创建选项对象尾插条件 spread（仅本地端口存在时覆盖，
    // 保留上游 kEt 传入的宿主端口回落——S-4）
    expect(self).toContain(",...(Fe.providerRuntimeHeadersPort?{providerRuntimeHeadersPort:Fe.providerRuntimeHeadersPort}:{})");
    expect(flags).toMatchObject({ standalone: true, headerPort: true });
  });

  it("端口锚单独命中即交付（portInjected 纳入交付条件）+ 门标志分离：standalone=off", () => {
    // 回归：曾按 entitledApplied||standaloneApplied 交付，端口补丁单独命中时产物被
    // 静默丢弃（③ 形同虚设、无任何信号）
    const { self, flags } = runCliPatch(CLI_PORT_ONLY_PROBE_SOURCE);
    expect(self).not.toBeNull();
    expect(self).toContain(",...(Fe.providerRuntimeHeadersPort?{providerRuntimeHeadersPort:Fe.providerRuntimeHeadersPort}:{})");
    expect(flags).toEqual({ entitled: false, standalone: false, headerPort: true });
  });

  it("③ 锚缺失 → header-port=off（标志驱动；既有同名属性子串不得再冒充已武装）", () => {
    // fixture 内含 1 处预存 'providerRuntimeHeadersPort:'（真实 3.15.3 bundle 8 处）：
    // 旧子串判定在此形态下必报 armed，标志驱动才能如实报 off
    const { self, flags, stderr } = runCliPatch(CLI_NO_HEADER_ANCHOR_PROBE_SOURCE);
    expect(self).not.toBeNull();
    expect(self).not.toContain(",...(Fe.providerRuntimeHeadersPort?{providerRuntimeHeadersPort:Fe.providerRuntimeHeadersPort}:{})");
    expect(flags).toMatchObject({ standalone: true, headerPort: false });
    expect(stderr.join("")).toContain("header-port injection anchor not found");
  });

  it("长 minified 名（>11 字符）不被截断：函数定义默认参数法仍命中（{0,10} 上限回归）", () => {
    const { self, flags } = runCliPatch(CLI_LONG_NAME_PROBE_SOURCE);
    expect(self).not.toBeNull();
    expect(self).toContain("function aVeryLongMinifiedName(e,t={standalone:{}}){");
    expect(flags).toMatchObject({ standalone: true });
  });

  it("多缺省参数 → 回退调用点锚（不把 standalone 注入错误参数）", () => {
    const { self, flags } = runCliPatch(CLI_MULTI_DEFAULT_PROBE_SOURCE);
    expect(self).not.toBeNull();
    // 定义处保持原样（曾 split/join 全量替换，t/o 两个缺省参数都会被改写）
    expect(self).toContain("function aBc(e,t={},o={}){");
    // 调用点回退锚：第二参注入 standalone
    expect(self).toContain("create:r(()=>aBc(z,{standalone:{}})");
    expect(flags).toMatchObject({ standalone: true });
  });

  it("同名定义歧义（两处 `function xCt(`）→ 定义锚放弃、不改写任何一处（MF-1-5 回归：曾取首个文本命中）", () => {
    // 三锚全 miss（entitled/standalone 定义锚放弃、无 ③ 锚）→ 不交付产物（null）
    const { self, flags, stderr } = runCliPatch(CLI_DECOY_DEF_PROBE_SOURCE);
    expect(self).toBeNull();
    expect(flags).toEqual({ entitled: false, standalone: false, headerPort: false });
    expect(stderr.join("")).toContain("standalone account: CLI bundle anchor not found");
  });

  it("首参缺省形态（`function aBc(e={},t)`）→ 定义不改写、调用点以第二实参注入（MF-1-5 回归）", () => {
    const { self } = runCliPatch(CLI_FIRST_PARAM_DEFAULT_PROBE_SOURCE);
    expect(self).not.toBeNull();
    // 第一参的 ={} 不得被当成 standalone 注入点（语法合法但语义错误，自检无法发现）
    expect(self).toContain("function aBc(e={},t){");
    expect(self).not.toContain("function aBc(e={standalone:{}},t)");
    // 回退调用点：把 standalone 作为**第二实参**传入，语义等价
    expect(self).toContain("create:r(()=>aBc(z,{standalone:{}})");
  });

  it("调用点实参含内联 ')' → 括号配平跳过字面量，注入落在外层末尾（MF-1-5 回归）", () => {
    const { self, flags } = runCliPatch(CLI_STRING_ARG_PROBE_SOURCE);
    expect(self).not.toBeNull();
    expect(self).toContain('create:r(()=>aBc(get("x)y"),{standalone:{}})');
    expect(flags).toMatchObject({ standalone: true });
  });

  it("端口注入条件 spread 行为：host 形态保留调用方端口，standalone 形态本地端口覆盖（S-4 行为回归，同进程执行补丁产物）", () => {
    const api = loadCliPatch();
    const rawPath = writeCliFixture(CLI_PORT_BEHAVIOUR_SOURCE);
    const patched = api.patched(rawPath);
    expect(patched, "端口行为探针可补丁（③ 锚命中）").not.toBeNull();
    expect(api.flags(rawPath)).toMatchObject({ headerPort: true });
    const ports: unknown[] = [];
    const envKeys = ["ZCODE_ENG_CLI_PATH", "ZCODE_PROBE_STATE", "ZCODE_PROBE_REG_PORT"] as const;
    const saved = envKeys.map((k) => process.env[k]);
    try {
      for (const [label, regPort] of [["host", undefined], ["standalone", "local-standalone-port"]] as const) {
        const patchedPath = path.join(tmpRoot, `portbehaviour-patched-${label}.cjs`);
        fs.writeFileSync(patchedPath, patched!);
        const statePath = path.join(tmpRoot, `state-portbehaviour-${label}.json`);
        process.env.ZCODE_ENG_CLI_PATH = rawPath;
        process.env.ZCODE_PROBE_STATE = statePath;
        if (regPort === undefined) delete process.env.ZCODE_PROBE_REG_PORT;
        else process.env.ZCODE_PROBE_REG_PORT = regPort;
        execCjsInProcess(patchedPath);
        ports.push((JSON.parse(fs.readFileSync(statePath, "utf8")) as { port: unknown }).port);
      }
    } finally {
      envKeys.forEach((k, i) => {
        const v = saved[i];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    }
    // registry 无本地端口（host 形态）：无条件尾插会以 undefined shadow 掉上游
    // kEt 传入的宿主端口 → 调用方端口必须保留
    expect(ports[0]).toEqual({ kind: "caller-host-port" });
    // standalone 形态：registry 本地端口存在 → 覆盖调用方值（账号认证头走本地）
    expect(ports[1]).toEqual({ kind: "local-standalone-port" });
  });
});

// ---------- standalone 账号元数据（产物内嵌 ensureAccountMetadata 同进程执行） ----------

describe("standalone 账号元数据（产物内嵌 ensureAccountMetadata 同进程执行）", () => {
  /** 布置 credentials.json（fixture HOME）并返回读取器。 */
  const plantCreds = (home: string, creds: Record<string, string>, mode?: number): string => {
    const credPath = path.join(home, ".zcode", "v2", "credentials.json");
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(credPath, JSON.stringify(creds, null, 2), mode ? { mode } : undefined);
    return credPath;
  };
  const writeCatalog = (name: string): string => {
    const dir = path.join(tmpRoot, `catalog-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "zcode-builtin.json");
    fs.writeFileSync(p, JSON.stringify({
      config: { providerConfigRules: { providerRules: [{ providerId: "account:bigmodel-individual-coding-plan", config: { access: { type: "zhipu-account" } } }] } },
    }));
    return p;
  };

  it("幂等供给：缺键时从 host 态 key 名派生 identity + oauth 认证来源；二次运行不动文件（2026-10-16 真机修复回归）", () => {
    const PID = "account:bigmodel-individual-coding-plan";
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-meta-"));
    const credPath = plantCreds(home, {
      "oauth:bigmodel:access_token": "enc:v1:fake-oauth-token",
      [`account-provider:coding-plan:${PID}:account:test-identity-0001:api-key`]: "enc:v1:fake-plan-key",
    });
    const catalogPath = writeCatalog("meta");
    const mod = loadAccountMetadata(home, catalogPath);
    mod.run();
    expect(mod.stderr.join("")).toContain("account metadata provisioned");
    const after = JSON.parse(fs.readFileSync(credPath, "utf8")) as Record<string, string>;
    expect(after[`account-provider:${PID}:identity`]).toBe("test-identity-0001");
    expect(after[`account-provider:${PID}:auth-source`]).toBe("oauth");
    // 既有键未被动
    expect(after["oauth:bigmodel:access_token"]).toBe("enc:v1:fake-oauth-token");
    // 幂等：二次运行不重写（无 provisioned 行、文件内容等同）
    const before = fs.readFileSync(credPath, "utf8");
    const second = loadAccountMetadata(home, catalogPath);
    second.run();
    expect(second.stderr.join("")).not.toContain("account metadata provisioned");
    expect(fs.readFileSync(credPath, "utf8")).toBe(before);
  });

  it("存在性守卫：有凭据支撑的既有 identity/auth-source 不被派生值覆写；空串按缺失态兜底填充 + 原子写保留文件 mode（ADR-0143 契约回归）", () => {
    const PID = "account:bigmodel-individual-coding-plan";
    const catalogPath = writeCatalog("meta-guard");
    // 场景①：既有非空 identity 有 api-key 支撑、auth-source=manual（GUI/登录流程
    // 权威写入）→ 原样保留，零写入。auth-source 旧实现会把 manual 无差别覆写为
    // 派生值 oauth（违反有凭据值不覆写契约）；identity 旧实现永远不校验收敛。
    const homeKeep = fs.mkdtempSync(path.join(tmpRoot, "home-meta-guard-keep-"));
    plantCreds(homeKeep, {
      "oauth:bigmodel:access_token": "enc:v1:fake-oauth-token",
      [`account-provider:coding-plan:${PID}:account:host-identity-9:api-key`]: "enc:v1:fake-plan-key",
      [`account-provider:${PID}:identity`]: "host-identity-9",
      [`account-provider:${PID}:auth-source`]: "manual",
    });
    const keep = loadAccountMetadata(homeKeep, catalogPath);
    keep.run();
    expect(keep.stderr.join("")).not.toContain("account metadata provisioned");
    const afterKeep = JSON.parse(fs.readFileSync(path.join(homeKeep, ".zcode", "v2", "credentials.json"), "utf8")) as Record<string, string>;
    expect(afterKeep[`account-provider:${PID}:identity`]).toBe("host-identity-9");
    expect(afterKeep[`account-provider:${PID}:auth-source`]).toBe("manual");

    // 场景②：空串 identity（缺失态）→ 从 host 态 key 名派生填充；auth-source 缺失 →
    // 派生 oauth；写回保留既有文件 mode（rename 换 inode 不放宽权限）。
    const homeFill = fs.mkdtempSync(path.join(tmpRoot, "home-meta-guard-fill-"));
    const credFill = plantCreds(homeFill, {
      "oauth:bigmodel:access_token": "enc:v1:fake-oauth-token",
      [`account-provider:coding-plan:${PID}:account:host-identity-9:api-key`]: "enc:v1:fake-plan-key",
      [`account-provider:${PID}:identity`]: "",
    }, 0o600);
    const fill = loadAccountMetadata(homeFill, catalogPath);
    fill.run();
    expect(fill.stderr.join("")).toContain("account metadata provisioned");
    const afterFill = JSON.parse(fs.readFileSync(credFill, "utf8")) as Record<string, string>;
    expect(afterFill[`account-provider:${PID}:identity`]).toBe("host-identity-9");
    expect(afterFill[`account-provider:${PID}:auth-source`]).toBe("oauth");
    expect(fs.statSync(credFill).mode & 0o777).toBe(0o600);
  });

  it("孤儿值矫正：oauth 撤销 / plan key 轮换后 identity 与 auth-source 收敛到当前事实（MF-1-1 回归）", () => {
    const PID = "account:bigmodel-individual-coding-plan";
    const catalogPath = writeCatalog("meta-reconcile");
    // 场景①：oauth 撤销（auth-source=oauth 但家族 access_token 已不存在）→ 回落
    // manual；identity 有 api-key 支撑 → 不改写（不回退成缺失态猜测）。
    const homeRevoked = fs.mkdtempSync(path.join(tmpRoot, "home-meta-reconcile-revoked-"));
    plantCreds(homeRevoked, {
      [`account-provider:coding-plan:${PID}:account:host-identity-9:api-key`]: "enc:v1:fake-plan-key",
      [`account-provider:${PID}:identity`]: "host-identity-9",
      [`account-provider:${PID}:auth-source`]: "oauth",
    });
    const revoked = loadAccountMetadata(homeRevoked, catalogPath);
    revoked.run();
    expect(revoked.stderr.join("")).toContain("account metadata reconciled");
    const afterRevoked = JSON.parse(fs.readFileSync(path.join(homeRevoked, ".zcode", "v2", "credentials.json"), "utf8")) as Record<string, string>;
    expect(afterRevoked[`account-provider:${PID}:identity`]).toBe("host-identity-9");
    expect(afterRevoked[`account-provider:${PID}:auth-source`]).toBe("manual");
    expect(afterRevoked[`account-provider:coding-plan:${PID}:account:host-identity-9:api-key`]).toBe("enc:v1:fake-plan-key");

    // 场景②：reviewer 原始 repro——run1 写入 identity=key-AAAA / auth-source=oauth，
    // 删除 oauth token 并轮换 plan key 后，旧值无任何凭据支撑 → 两个键均收敛到当前
    // 事实（key-BBBB / manual），provider 自愈（旧实现永远不动文件）。
    const homeRotated = fs.mkdtempSync(path.join(tmpRoot, "home-meta-reconcile-rotated-"));
    plantCreds(homeRotated, {
      [`account-provider:coding-plan:${PID}:account:key-BBBB:api-key`]: "enc:v1:rotated-plan-key",
      [`account-provider:${PID}:identity`]: "key-AAAA",
      [`account-provider:${PID}:auth-source`]: "oauth",
    });
    const rotated = loadAccountMetadata(homeRotated, catalogPath);
    rotated.run();
    expect(rotated.stderr.join("")).toContain("account metadata reconciled");
    const afterRotated = JSON.parse(fs.readFileSync(path.join(homeRotated, ".zcode", "v2", "credentials.json"), "utf8")) as Record<string, string>;
    expect(afterRotated[`account-provider:${PID}:identity`]).toBe("key-BBBB");
    expect(afterRotated[`account-provider:${PID}:auth-source`]).toBe("manual");
    expect(afterRotated[`account-provider:coding-plan:${PID}:account:key-BBBB:api-key`]).toBe("enc:v1:rotated-plan-key");
  });
});

// ---------- v2 注入合并（产物内嵌 injectedConfigText 同进程执行） ----------

describe("v2 注入合并（产物内嵌 injectedConfigText 同进程执行）", () => {
  it("同 id 时 v2 条目整条优先于真实文件（等价复刻 GUI 直传：v2 权威），real 独有条目保留；real 缺 model.main 而 v2.model.main 存在时透传注入", () => {
    const { text } = runInjectedConfigText({
      v2: { provider: { shared: providerEntry("v2-new-key"), p1: providerEntry("k1") }, model: { main: "p1/model-x" } },
      real: {
        provider: { shared: providerEntry("real-stale-key"), realOnly: providerEntry("real-key") },
        model: { main: "shared/model-a" },
      },
    });
    expect(text).not.toBeNull();
    const cfg = JSON.parse(text!) as { provider: Record<string, { options: { apiKey: string } }>; model?: { main?: string } };
    expect(cfg.provider.shared.options.apiKey).toBe("v2-new-key");
    expect(cfg.provider.realOnly.options.apiKey).toBe("real-key");
    expect(cfg.model!.main).toBe("shared/model-a");
    // real 有 model.main 时不透传改写——单独构造 real 无 main 的形态
    const t2 = runInjectedConfigText({
      v2: { provider: { p1: providerEntry("k1") }, model: { main: "p1/model-x" } },
      real: {},
    }).text;
    expect((JSON.parse(t2!) as { model: { main: string } }).model.main).toBe("p1/model-x");
  });

  it("real 与 v2 均无 model.main 时不伪造（缺省解析归 CLI——plan 家族 id 已不可用）", () => {
    const { text } = runInjectedConfigText({
      v2: { provider: { p1: providerEntry("k1") } },
      real: { provider: { p2: providerEntry("k2") } },
    });
    expect(text).not.toBeNull();
    expect((JSON.parse(text!) as { model?: unknown }).model).toBeUndefined();
  });

  it("仅存在于 providerRules 的个人 provider（v2 字典缺失）→ 合成 cli-config 条目（name/kind/options/models 带 contextWindow limit；禁用模型不进）", () => {
    const { text } = runInjectedConfigText({
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
    expect(text).not.toBeNull();
    const injected = JSON.parse(text!) as { provider: Record<string, { name: string; kind: string; options: { apiKey: string; baseURL: string }; source: string; models: Record<string, unknown> }> };
    // 合成条目：形状照抄现网个人条目；modelRules 的 contextWindow 进 limit；禁用模型不进
    expect(injected.provider["new-provider"]).toEqual({
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
    const { text } = runInjectedConfigText({
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
    expect(text).not.toBeNull();
    const injected = JSON.parse(text!) as {
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
    const t1 = runInjectedConfigText({
      v2: { provider: { "shared-p": providerEntry("v2-key") } },
      real: {},
      providerConfig: { config: { providerConfigRules: { providerRules: [rule] }, modelConfigRules: { providerModelRules: [] } } },
    }).text;
    expect(t1).not.toBeNull();
    const injected1 = JSON.parse(t1!) as { provider: Record<string, { options: { apiKey: string } }> };
    expect(injected1.provider["shared-p"]).toEqual(providerEntry("v2-key"));

    const t2 = runInjectedConfigText({ v2: { provider: { "v2-only": providerEntry("k") } }, real: {} }).text;
    expect(t2).not.toBeNull();
    const injected2 = JSON.parse(t2!) as { provider: Record<string, unknown> };
    expect(injected2.provider["v2-only"]).toEqual(providerEntry("k"));
  });

  it("no-patch 三态：v2 无带 apiKey 的 provider → null；v2 缺失（ENOENT 未登录）→ null 且 stderr 静默；v2 损坏 → null 且 stderr 出声（与「未登录」区分）", () => {
    const none = runInjectedConfigText({
      v2: { provider: { p1: { options: { apiKey: "" } } } },
      realRaw: '{"provider":{"r1":{"options":{"apiKey":"real"}}}}',
    });
    expect(none.text).toBeNull();

    const enoent = runInjectedConfigText({ realRaw: '{"provider":{}}' });
    expect(enoent.text).toBeNull();
    expect(enoent.stderr.join("")).not.toContain("v2 config 读取失败");

    const broken = runInjectedConfigText({ v2Raw: "{broken-json", realRaw: '{"provider":{}}' });
    expect(broken.text).toBeNull();
    expect(broken.stderr.join("")).toContain("v2 config 读取失败");
  });
});

// ---------- provider_config merge 视图（产物内嵌 mergeProviderConfig / mergedProviderConfigText） ----------

describe("provider_config merge 视图（launcher 内嵌 JS × preparer TS 双实装对账 + mergedProviderConfigText 分支矩阵）", () => {
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

  it("mergedProviderConfigText 分支矩阵：双全 → merge 产物；真实缺失 → 副本整体；副本缺失/损坏/env 未设 → null（短路回原文件，零行为变化）", () => {
    const realPc = path.join(tmpRoot, "pc-real.json");
    const copyPc = path.join(tmpRoot, "pc-copy.json");
    fs.writeFileSync(realPc, JSON.stringify(conf(["a"], ["a"])));
    fs.writeFileSync(copyPc, JSON.stringify(conf(["c"], ["c"])));
    // 双全 → merge 产物（真实在前 + 副本独有追加）
    expect(JSON.parse(runMergedProviderConfigText(copyPc, realPc!)!)).toEqual(conf(["a", "c"], ["a", "c"]));
    // 真实缺失（文件不存在）→ 副本独有条目为全集（整体返回副本内容）
    expect(JSON.parse(runMergedProviderConfigText(copyPc, path.join(tmpRoot, "pc-absent.json"))!)).toEqual(conf(["c"], ["c"]));
    // 副本缺失（env 指向不存在路径）→ null = 调用方短路回原文件
    expect(runMergedProviderConfigText(path.join(tmpRoot, "copy-absent.json"), realPc)).toBeNull();
    // 副本损坏（JSON 不可解析）→ 同副本缺失语义
    const brokenCopy = path.join(tmpRoot, "pc-broken.json");
    fs.writeFileSync(brokenCopy, "{broken-json");
    expect(runMergedProviderConfigText(brokenCopy, realPc)).toBeNull();
    // env 未设（PI_SYNCED_PATH=''）→ 分支不激活
    expect(runMergedProviderConfigText("", realPc)).toBeNull();
  });
});

// ---------- catalog entitled 补丁（产物内嵌 catalogPatchText 同进程执行） ----------

describe("catalog entitled 补丁（产物内嵌 catalogPatchText 同进程执行）", () => {
  it("zhipu-account 条目 entitled !== true → 返回 entitled:true 补丁视图（patch 只发生在读取返回值，磁盘零触碰）", () => {
    const p = path.join(tmpRoot, "catalog-entitled", "zcode-builtin.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const raw = JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            { providerId: "zhipu", providerName: "Zhipu", config: { access: { type: "zhipu-account", entitled: false } } },
            { providerId: "other", config: { access: { type: "api-key", apiKey: "k" } } },
          ],
        },
      },
    });
    fs.writeFileSync(p, raw);
    const { patch } = loadCatalogPatch();
    const out = patch(p);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!) as {
      config: { providerConfigRules: { providerRules: Array<{ providerId: string; config: { access: { entitled?: boolean } } }> } };
    };
    expect(parsed.config.providerConfigRules.providerRules[0].config.access.entitled).toBe(true);
    // 非 zhipu-account 条目不动
    expect(parsed.config.providerConfigRules.providerRules[1].config.access.entitled).toBeUndefined();
    // 磁盘文件零触碰
    expect(fs.readFileSync(p, "utf8")).toBe(raw);
  });

  it("无条目 → null + 状态 no-entries；损坏 → null + 状态 unreadable（跳过归因区分，排障不误导）", () => {
    const empty = path.join(tmpRoot, "catalog-empty", "zcode-builtin.json");
    fs.mkdirSync(path.dirname(empty), { recursive: true });
    fs.writeFileSync(empty, JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: "x", config: { access: { type: "api-key", apiKey: "k" } } }] } } }));
    const corrupt = path.join(tmpRoot, "catalog-corrupt", "zcode-builtin.json");
    fs.mkdirSync(path.dirname(corrupt), { recursive: true });
    fs.writeFileSync(corrupt, "{ not json");
    const { patch, statusOf } = loadCatalogPatch();
    expect(patch(empty)).toBeNull();
    expect(statusOf(empty)).toBe("no-entries");
    expect(patch(corrupt)).toBeNull();
    expect(statusOf(corrupt)).toBe("unreadable");
  });
});

// ---------- 落盘端（ensureAppServerLauncher：纯 fs，无子进程） ----------

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
