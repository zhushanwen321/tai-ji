// thinkinglevel-probe.js — E2E 探针 workflow：agent() 传 thinkingLevel=high 做最小任务。
//
// 用途：e2e/workflow-thinkinglevel-real.spec.ts 的 TC1/TC2/TC3 用它验证
// agent() 的 thinkingLevel 参数端到端真实生效。断言表面全部是 pi 自己写的
// 文件（零 taiji 代码介入）：
//   - workflow state JSONL 的 calls[0].opts（扩展持久化的脚本请求值，TC1）
//   - 子进程 session JSONL 的 thinking_level_change entry（pi 真实生效值，TC2）
//
// 注意：本文件是 repo 内 fixture 资产。实际运行发现路径是 user 级
// <dataDir>/agent/workflows/（makePresetDataDir 复制到此），因 sample-project
// 的祖先 .bare 导致 findWorkspaceRoot 跳转到 <workspace>/，project 级
// .pi/workflows/ 不会被 workflow registry 扫描（详见 spec 文件注释）。
//
// model（L2.5 faux 翻轨，2026-09-15）：faux-1-reasoning 演员（reasoning:true，
// 档位 ['off','minimal','low','medium','high'] 含 high）——thinkingLevel=high
// 不被钳制；:high 后缀由 session-runner 拼进 spawn --model（TC2 断言拆字段后落盘）。
// 主对话模型 = faux/faux-1（settings 预置），响应队列经 model-keyed faux 脚本分配。
//
// [2026-09-15 修复] 补 @pi-meta 块——config-loader toCachedMeta 仅认 @pi-meta 新格式
// （旧 const meta / 无 meta 一律 available=false → registry not found）。原 fixture
// 从未带 meta，此前真实轨从未跑通 workflow run（被 flaky skip 容忍掩盖）。
//
// ⚠️ lintScript 约束（本脚本已遵守）：
//   - 含 agent() 入口
//   - 禁止 bare IIFE（用 top-level await）
//   - 禁止用 result 作变量名（用 outcome）

/* @pi-meta
name: thinkinglevel-probe
description: thinkingLevel 端到端探针：agent() 传 thinkingLevel=high 做最小回复任务
phases: [probe]
*/

phase("probe");

const outcome = await agent({
  prompt: "Reply with exactly: PROBE-OK",
  model: "faux/faux-1-reasoning",
  thinkingLevel: "high",
  description: "thinkinglevel-probe",
});

return outcome;
