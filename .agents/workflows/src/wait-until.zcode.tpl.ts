/* zcode-workflow
description: 通用条件等待 workflow：按参数化的一组确定性检查原语（git-ancestor /
  dir-absent / dir-present / file-absent / file-present / file-contains）轮询外部状态，
  全部满足即返回结构化报告，超时（maxRounds 轮）带终态停回。零 subagent：全部判定走
  bash 包装的确定性命令（git / test / grep / sleep，经 `cd "$1" && shift && exec "$@"`
  argv 传参，无注入面），无模型成本。适用：等待其他会话完成 dev-merge 合并落盘、
  worktree/分支清理、文件出现/消失、台账登记落盘等机器可判定条件。
whenToUse: 需要等待另一个会话/进程/后台任务完成落盘动作后再继续时发起（CreateWorkflow
  path 指向本文件 + args）。被等待方是否在等人工裁决不可探测——超时即停回，不猜。
args:
  targetLabel:
    type: string
    description: 等待目标的一句中文描述（进结论文案与进度表标题；必填）
  checks:
    type: json
    description: 检查条件数组（必填）。每项 {"type": "...", ...参数}，原语词表与必填参数：git-ancestor{branch,target,gitDir?}（分支头已并入目标 ref，或分支已随收尾删除均算满足）/ dir-absent{path} / dir-present{path} / file-absent{path} / file-present{path} / file-contains{path,text}（text 为单行固定子串）。gitDir 仅 git-ancestor 支持（bare repo 传 .bare 形态的相对值或绝对路径）
  pollSeconds:
    type: number
    description: 轮询间隔秒数（≥5；默认 900 = 15 分钟）
    default: 900
  maxRounds:
    type: number
    description: 轮询轮数上限（≥1；默认 96，与默认间隔合 = 24 小时）
    default: 96
  cwd:
    type: string
    description: 检查命令的工作目录（可选；相对路径以平台发起环境当前目录为基准，跨 worktree / bare repo 场景建议传绝对路径。缺省 = 平台默认 cwd——zcode 为 workspace 根，pi 为发起进程目录）
*/

// ── 无观测钩子（O 区不适用）：本 workflow 未接入阶段事件观测（零 agent、纯机器轮询，
//    无技能阶段归属），构建器按「无 initObservation 调用点」跳过观测维度检查。──

@@STITCH@@
