{ body = body esc($0) "\\n" }
END {
  note = "On Devin CLI, read " mapping " before using pstack. It maps tools and saved role choices to Devin profiles."
  if (herdr == "1") note = note " This session runs inside Herdr. Read the mapping's Herdr cloud agents section before any dispatch: a request to spawn a cloud agent or hand a task to another agent, and every role upstream gives a cloud agent, starts through " herdr_script ", not run_subagent, and never by doing the task yourself."
  print "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"" body "\\n" esc(note) "\"}}"
}
