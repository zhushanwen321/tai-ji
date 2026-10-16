---
"@zhushanwen/zcode-subagent-cli": patch
---

修复跨引擎翻译目标通道：zai-coding-cn/* 的 zcode 对应通道由 account:bigmodel-individual-coding-plan 修正为 account:zai-individual-coding-plan（bigmodel 与 zai 是两个独立账号家族，原映射把请求落在未登录通道上，实测表现为 app-server 侧 model_request_failed）；package.json manifest 同步声明 modelTranslation 翻译表（远程代理形态翻译面供数源，与代码表对账锁步）。
