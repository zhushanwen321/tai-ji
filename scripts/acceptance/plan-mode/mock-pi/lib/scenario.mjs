/**
 * mock pi 场景加载与参数化（场景脚本 = JSON 声明式剧本）。
 *
 * 参数优先级：内置默认 < scenario.params < config.params（active-config）< env 覆盖。
 * env 覆盖键（`TAIJI_` 前缀在 ENV_WHITELIST_PREFIXES 内，可穿透 runtime → pi 子进程）：
 * - TAIJI_MOCK_PI_SELECT_REGISTER_DELAY_MS  select 登记延迟（S3 需 1.5s 构造）
 * - TAIJI_MOCK_PI_ABORT_MODE               dissolve | delayed-dissolve | silent | crash
 *
 * 场景 schema（字段全部 optional，缺省走 DEFAULT_PARAMS）：
 * {
 *   "name": "...", "description": "...",
 *   "params": {
 *     "selectRegisterDelayMs": 0,        // plan-state 落盘 → select 登记之间的延迟（persist→pending 间隙构造）
 *     "abortMode": "dissolve",
 *     "abortDelayMs": 0
 *   },
 *   "onPrompt": {
 *     "planStateEntry": {...},           // prompt 后立即落盘的 plan-state 快照（submit-review persist 模拟）
 *     "assistant": ["..."],              // 依次 message_end 的 assistant 文本
 *     "select": {...},                   // planReviewSelect / uiFormSelect 参数（kind: "plan-review"|"ui-form"）
 *     "rawFrames": [ ...|{"__frame__":"name"} ],  // select 之后追发的原始/边界帧
 *     "agentEnd": false,                 // select 挂起后是否收轮（默认 false = turn 保持打开）
 *     "crash": {"code": 1} | {"signal": "SIGKILL"}   // 注入崩溃
 *   },
 *   "onSelectResponse": {                // extension_ui_response 到达后的动作
 *     "planStateEntry": {...}|null,
 *     "assistant": ["..."],
 *     "select": {...},                   // 第二个挂起 select（F5：approve 后挂执行方式表单）
 *     "rawFrames": [...],
 *     "agentEnd": false
 *   },
 *   "onAbort": {                         // abort 命令到达后的动作（mode 取 params.abortMode）
 *     "planStateEntry": null,            // 现版 cancelled 分支不落盘（F1 复现形态）
 *     "assistant": ["..."],
 *     "agentEnd": true,
 *     "exit": {"code": 1} | {"signal": "SIGKILL"}    // crash 模式的退出方式
 *   }
 * }
 */
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCENARIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');

export const DEFAULT_PARAMS = { // oe-exempt:20261001:test:plan 模式验收 harness 预编译场景词汇，场景脚本接线 wip
  selectRegisterDelayMs: 0,
  abortMode: 'dissolve', // dissolve | delayed-dissolve | silent | crash
  abortDelayMs: 0,
};

export function loadScenario(config) {
  const nameOrPath = config.scenario ?? 'plan-review-pending';
  const scenarioPath = isAbsolute(nameOrPath)
    ? nameOrPath
    : config.scenarioDir
      ? join(config.scenarioDir, `${nameOrPath}.json`)
      : join(SCENARIO_DIR, `${nameOrPath}.json`);
  let scenario;
  try {
    scenario = JSON.parse(readFileSync(scenarioPath, 'utf-8'));
  } catch (error) {
    throw new Error(`mock-pi: scenario load failed: ${scenarioPath}: ${error.message}`);
  }
  const params = resolveParams(scenario.params ?? {}, config.params ?? {});
  return { scenarioPath, scenario, params };
}

export function resolveParams(scenarioParams, configParams) { // oe-exempt:20261001:test:plan 模式验收 harness 预编译场景词汇，场景脚本接线 wip
  const params = { ...DEFAULT_PARAMS, ...scenarioParams, ...configParams };
  const envDelay = Number(process.env.TAIJI_MOCK_PI_SELECT_REGISTER_DELAY_MS);
  if (Number.isFinite(envDelay) && envDelay >= 0) params.selectRegisterDelayMs = envDelay;
  const envAbort = process.env.TAIJI_MOCK_PI_ABORT_MODE;
  if (envAbort) params.abortMode = envAbort;
  return params;
}

/** 读 active config（`--config` argv > TAIJI_MOCK_PI_CONFIG env > 缺省 ~/.taiji-dev/mock-pi/active-config.json）。 */
export function loadConfig(configArg) {
  const path = configArg
    ?? process.env.TAIJI_MOCK_PI_CONFIG
    ?? join(os.homedir(), '.taiji-dev', 'mock-pi', 'active-config.json');
  try {
    return { configPath: path, config: JSON.parse(readFileSync(path, 'utf-8')) };
  } catch {
    // 无配置 = 全缺省场景（plan-review-pending、无延迟）——mock 起停自测与裸跑形态。
    return { configPath: path, config: {} };
  }
}
