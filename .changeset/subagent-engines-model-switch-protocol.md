---
"@zhushanwen/subagent-core": minor
"@zhushanwen/subagent-engine-sdk": minor
"@zhushanwen/pi-rpc": minor
"@zhushanwen/pi-subagent-cli": minor
"@zhushanwen/zcode-subagent-cli": minor
---

Add a runtime model-switch (setModel) protocol across the subagent engine stack. subagent-engine-sdk grows the engine contract: a `setModel` forward method, an optional `capabilities.setModel` flag ("native" | "unsupported"), a dedicated error-code vocabulary (`engine_model_not_in_snapshot`, `engine_credential_missing`, `engine_state_readback_failed`) plus the `engine_run_not_active` not-active code. pi-rpc adds `buildSetModelCommandFrame` for the pi `set_model` RPC command; pi-subagent-cli implements the pi-side control channel (control responses, engine setModel path, stdin writer). zcode-subagent-cli wires the same method through its app-server launcher. subagent-core orchestrates per-record and run-level switches (chat + workflow re-dispatch, override persistence and aggregate replies) and exports the new switch services and types from its barrel.
