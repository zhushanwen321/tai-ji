# CI flaky 测试清查（v0.10.5 发布期观察）

## 背景

2026-09-29 v0.10.5 merge 流程中，CI（同代码树）出现两起一次性的单测失败，归因后重跑均绿。两者共同特征：同代码树前一轮 CI 全绿、本地多次（含 CPU 压力）不可复现、失败点在时序敏感链路上。登记此处跟进根因收敛，防复发骚扰后续 PR/CI。

## 案例 1：renderer `use-btw-tab-data.test.ts` unread 断言

- 失败形态：`expect(text(w, 'unread')).toBe('1')` 实际 '0'（Test (renderer, shard 2/2)，run 36585066332）
- 本地验证：单文件 5 次 + 完整 shard=2/2 同款命令 3 次 + 6 核 CPU 压力 1 次，全绿
- 可疑机制：`useBtwTabData` 的 per-线 unread watch 在拉取 resolve 后创建（`syncThreadWatchers`），baseline = 创建时 `chatStore.getMessages(vid).length`；若 watcher 创建与 `setMessages` 的相对时序在慢机上漂移，delta 计数为 0
- 跟进方向：给该链路补确定性（watcher 建立即刻显式快照 baseline 而非依赖 watch 首评值），或在测试里轮询等待 watcher 就位后再 setMessages

## 案例 2：runtime `idle-pi-reclaim-integration.test.ts`（faux 真进程 L2.5）

- 失败形态：pi prompt 前置鉴权检查抛 `No API key found for the selected model.`（provider === 'unknown' = 该 turn 的模型引用在 pi 进程内解析不到已注册 provider）（Test (runtime, shard 2/2)，run 36586910056）
- 本地验证：stage 1 全量 unit 轨绿（含本文件）
- 可疑机制：restore 路径不传 `--model`，模型靠 session 文件 model_change entry 恢复为 faux/faux-1；若回收杀进程与 restore spawn 之间 faux extension 注册/模型解析存在时序窗（CI 慢机上放大），turn 命中 provider='unknown' 占位模型
- 跟进方向：在 reclaim 前轮询等待 session 文件含 model_change entry（对齐 A8 helper 的轮询先例）；或 restore 后先断言 get_state 生效模型再发 turn

## 完成判据

两案例各自本地复现 ≥1 次并定位到具体时序点，修复后测试确定性成立（无「归因后重试」依赖）。
