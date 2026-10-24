# e2e 真机链路：宿主全局 settings 的 npm 版 pi-subagent-workflow 同进程双载

状态：待用户裁决（2026-10-24 登记；A11 第三轮批次 S3b 失败根因已核实为下述双载——实证仅 S3b 一条，s1/WRR-A6 的同族归因为推断级未核实，见现象节分档）。

## 现象

- **实证（S3b，`batch-s3-partial-failfast`）**：真 LLM e2e（`TAIJI_PI_LIVE=1` 批次）S3b 断言「`subagent_message` 对 fan-out 成员续聊三类拒绝」失败：真机对 origin=workflow 的成员（registered 条目在盘可证）续聊返回 `delivered:true` 并成功 round 2（轮应答通知为证）；而源码 messageHandler、单测（54 用例绿）、staged bundle 三方均有该拒绝。
- **同族疑似（推断级，未核实）**：同批次 s1（`batch-s1-basic-chain`：wf-done 300s 未达、journal 卡 1/2 agent-settled + uiRequestHandler 60s 周期重试抛错，两轮同形态）与 WRR-A6（`batch-window-reuse-recovery`：三轮三个不同失败点，全为成员执行层间歇卡滞）与本问题的同族归因是推断——成员 ask 执行层卡滞与双载污染的关联未经探针核实，仅见于 A11 工作流产物区 runlog；不得作为已证实范围引用，待双载问题修复后复跑归因。

## 根因（已核实）

用户全局 `~/.pi/agent/settings.json` 的 packages 清单含 `npm:@zhushanwen/pi-subagent-workflow`（旧构建，无 workflow-origin 域边界检查）。e2e 的 pi 进程共享宿主 HOME → npm 版扩展与内置 staged 版**同进程双载**，同名 handler 被旧版抢占。与根 AGENTS.md「`-ne` 必带 [HISTORICAL]」登记的 settings 清单双载事故同族（jiti 模块独立但 `Symbol.for` 单例槽跨实例共享）。

## 恢复动作（二选一，待裁决）

1. 用户侧：全局清单移除该 npm 条目（本地开发期由 dev-link/staged 版承载）。
2. 仓库侧：e2e 真机启动链为 pi 进程隔离 settings packages 清单（如 `PI_SETTINGS_*` 覆写或独立 PI_CODING_AGENT_DIR 播种），使真机批次不依赖宿主全局环境。

## 现场与证据

- spec 现场目录：`/var/folders/.../taiji-batch-s3-Us9Jfu`（临时目录，可能已被系统清理）。
- 第三轮重跑记录：`~/.agents/skill-data/dev-flow/<slug>/a11-e2e-runlog.md` 第三轮批次节。
