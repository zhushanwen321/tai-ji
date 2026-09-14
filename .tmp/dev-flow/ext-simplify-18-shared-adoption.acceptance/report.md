# ext-simplify-18 阶段 5 真机验收报告

- 日期：2026-09-14 | 分支 dev-0.9.21 | 审查清零 commit 98b259a09 之上
- 方式：pi CLI 本地实测（AGENTS.md MANDATORY 路径：`pi -ne --mode rpc --session-dir <tmpdir> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <绝对路径>` + stdin JSONL prompt；全局 pi 0.85.1）
- 结论先行：**V7/V8/V9 真机全 PASS**（A8/A9/A10 三项，L3 脚本化执行）；V1-V6 随单元与阶段 3 闭合。**V5-③ staged 级实测后补闭环（阶段 6 F-1）**：初版报告以管道级模拟替代 staged 级承诺属降级未出声，阶段 6 审查抓出——真跑补验：staged `model-ref.ts` 注释探针 → live pre-commit（core.hooksPath 安装副本）实际拉起档位守卫段，T1/T2/T3 全绿 EXIT=0，探针还原零残留（证据 `v5-staged-hook.log`）。补验同时暴露并修复：live hook 安装副本滞后于 u12 安装源改动（prepare 仅在 pnpm install 时再生），重跑安装器后 model-ref.ts 触发面生效。

## V7 cache-probe（A8）— PASS

- 断言：扩展真机加载、probe entry 落盘正常、无异常日志（D1+D2 迁移面运行时通路）。
- 证据：run EXIT=0，`agent_settled`；会话文件（/tmp/x18-accept/cache-probe-sessions/2026-09-14T14-38-47-160Z_*.jsonl）含 `custom` entry customType=cache-probe，data v:2 seq:1 baseline:true + 全指纹哈希（contextFiles/skills/toolsList/spFull/toolsSent 等 9 项）——fingerprint.ts 的 isRecord 守卫提取链真机全跑通；assistant 回复逐字 `x18-ok`。
- 无 cache-probe 错误日志（cache-probe 仅失败时 stderr；零输出 = 零失败）。stderr 仅无关的 deepseek 模型 pattern warning（宿主 models.json 既有噪音，与本批无关）。

## V9 session-reader（A10）— PASS

- 断言：read/find 工具调用成功（D5 单源化后的家族读取与首行解析通路）。
- 证据：模型自主调用 `session_read` ×2——`{action:"list"}` 返回 20 sessions（含本会话预览：01a0a05d-2078、cwd、首条消息文本）；`{action:"outline"}` 返回 T000/T001 双 turn 摘要 + 2 turns/6 entries/~30 tokens。最终回复「20 sessions found, first 12 chars: 01a0a05d-2078」。
- 首行 header 读取全部经新建 discovery/session-header.ts（list 扫描读 header + preview 读首条 user 消息），单源化路径真机验证。

## V8 permission（A9）— PASS（含一条环境限制登记）

- 断言：D4 迁移面运行时通路 + 交互预选行为正常。
- 证据（管线通路）：permission 扩展真机加载（D2 迁移的 config.ts normalizeClassifierConfig 在载入路径执行），模型调用 bash 工具 `echo x18-permission-ok`，toolResult 原样返回、最终回复正确引用输出、stderr 零异常。
- **环境限制（非失败）**：`/permission model` 交互预选在 `--mode rpc` 结构性不可达——pi rpc 命令集（prompt/steer/abort/get_state/set_model/…）无 TUI command 通道，斜杠命令属 TUI 层。交互预选逻辑由 MPT8 23 用例钉值覆盖（含 "provider/" 微变，设计 §5.1 V2b 归属）；GUI 层交互验证超出本批 extensions 侧范围。

## 一次性/可复用分流

三项均一次性场景（本设计特有迁移面冒烟），未沉淀 e2e spec（无 GUI 交互、回归价值已由各包 23303+ 用例与守卫覆盖）；脚本与产物留本目录（v7/v8/v9-*.jsonl 输出原件）。
