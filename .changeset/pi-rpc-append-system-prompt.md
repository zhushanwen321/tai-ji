---
'@zhushanwen/pi-rpc': patch
---

Spawn args gain an `appendSystemPrompt` option that mirrors `systemPrompt` and emits `--append-system-prompt`, and inline values for both prompt flags now get a leading newline. The prefix constructively distinguishes literal prompt text from pi's argument resolution: pi treats a prompt flag value matching an existing relative path (relative to the session cwd, i.e. the user's project dir) as a file and injects the file's whole content as the prompt, so a mode prompt that happens to equal `AGENTS.md` or `.env` would otherwise be silently replaced by that file — UI shows the intended text while the file content (potentially carrying secrets) is what reaches the model.
