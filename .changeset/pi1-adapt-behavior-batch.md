---
"@zhushanwen/extension-protocol": minor
"@zhushanwen/pi-rpc": minor
"@zhushanwen/pi-subagent-cli": minor
"@zhushanwen/session-delivery": minor
"@zhushanwen/subagent-core": minor
"@zhushanwen/subagent-engine-sdk": minor
"@zhushanwen/session-core": minor
"@zhushanwen/zcode-subagent-cli": minor
---

pi 1.0.0 adaptation batch: extension-protocol adds the subagent journal push-channel wire types (marker/report/ack); pi-rpc, subagent-core, session-delivery and zcode-subagent-cli retire the defensive timeout/backoff/retry timer families (finality is now event-driven per ADR-0112/ADR-0122, and session-delivery drops the dead sendAttempts field); pi-subagent-cli passes images and output text through to the subagent drawer projection; subagent-engine-sdk removes the crash-rebuild backoff defense from its surface; session-core accepts pi 1.0.0's four-value message roles so system messages are no longer silently dropped.
