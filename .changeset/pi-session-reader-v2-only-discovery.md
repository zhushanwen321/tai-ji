---
"@zhushanwen/pi-session-reader": minor
---

workflow run 发现链收敛为单档：只识别 workflow-record v2 注册条目（recordPath 锚点指向 record 流），v1 全量快照条目与旧 workflow-state-link 指针条目不再被识别——历史格式 run 从读取面静默消失（不拒读、不报错；ADR-0095 裁决：项目未上线无历史数据，不迁移不兼容）。zcode 锚同步只认 v2 终态条，v1 快照形态不再命中。
