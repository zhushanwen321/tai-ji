# pi 重启响应丢失：命令条目按未执行终局的误判窗口

状态：已知限制（误判窗口）显式接受（pi1-disposition-chat-flow 设计 D14①b / 裁决 Q9 方向 a / U1⑧ 修法已实装，2026-10-04 登记）。

- 现状：命令条目的终局凭据单一锚定 prompt 响应的 disposition=handled——pi 进程重启（runtime 存活）时该响应丢失，命令条目既不确认也不重投，若无兜底将永挂。防永挂修法已实装：sweepInFlight 对账扫描对「无投递标记且命中命令清单」的条目按响应丢失处理，超宽限（10s）静默终局 + 日志，不重投（重投会重复执行命令）。该判据同时承接第二成因——命令识别假阳性（命令清单快照命中、pi 侧实时注册集 miss，凭据链同形断裂），日志按双成因记录：`command entry finalized without receipt (cause: pi restart response loss OR stale command list false-positive)`（`packages/runtime/src/services/session/session-delivery-registry.ts:1008`），排障时以 pi 侧日志/进程记录区分实际成因，避免按单一「响应丢失」误导排查方向。
- 影响面：存在「实际已执行却按未执行终局」的误判窗口——pi 在宽限边缘完成命令执行后才重启时，界面显示未执行而实际已执行；runtime 日志留痕可人工核对。
- 恢复通道：核对 runtime 日志双成因记录与 pi 侧进程日志确认实际执行状态；重发命令前先人工核对。
- 重审触发：pi 重启后出现界面与实际执行状态不符、且用户因此误操作时，重审命令回执持久化对账通道（与「命令终局凭据不留盘」登记同族）。
