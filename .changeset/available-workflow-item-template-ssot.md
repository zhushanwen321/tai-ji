'@zhushanwen/subagent-core': minor
'@zhushanwen/pi-subagent-workflow': patch
---

Make the available-workflow list item template single-sourced: core's formatAvailableWorkflowRefs gains two boolean options (includeLocation, includeSource — defaults keep the run-rejection format byte-identical) and the two hand-rolled forks in the workflow-script tool now consume it. Deliberate LLM-visible changes: the lint not-found suggestions list now includes the location line (aligned with the run-rejection self-recovery guidance), and the actionList items switch from "[source] name — desc" to "- [source] name: desc" (separator unified to ":"). actionList's LLM-visible output goes from zero coverage to black-box tested (full text, empty state, details/GUI projection), and the formatter itself gains table-driven direct tests over both option axes plus the available filter.
