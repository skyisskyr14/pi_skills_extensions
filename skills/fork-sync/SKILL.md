---
name: fork-sync
description: Sync context from a forked pi session back to the parent. Use when you completed work in a /fork branch, used /tree to return to the parent, and need the parent to know what the fork changed — files modified, decisions made, key findings. Reads the fork's session JSONL, extracts the latest compaction summary or recent messages, and appends a structured sync entry to the project's sync log.
---

# Fork Sync

When you finish work in a fork and return to the parent via `/tree`, use this
skill to bring the fork's context back. It supports **multi-level forks**:
a fork can sync sub-forks, then the parent can sync the fork and automatically
inherit all sub-fork changes through cascading merge.

## Multi-Level Fork Scenario

```
root
 ├── Fork A ────→ Fork A1 ────→ Fork A1a   (deepest, completed work)
 │     ↑ sync        ↑ sync        │
 │     A1→A         A1a→A1        │
 └── Fork B
```

**Workflow:**

1. In Fork A1a: complete work → `/skill:fork-sync <A1a-session>` → writes
   sync-log entry tagged with `parent: <A1-session-id>`.
2. `/tree` back to Fork A1.
3. In Fork A1: `/skill:fork-sync <A1a-session>`. This reads both A1a's
   session AND sync-log entries where `parent: <A1a-session-id>`. Merges
   them. Writes a new sync-log entry tagged with `parent: <A1-session-id>`.
4. `/tree` back to Fork A.
5. In Fork A: `/skill:fork-sync <A1-session>`. This reads A1's session AND
   sync-log entries where `parent: <A1-session-id>` (which already contain
   A1a's merged changes). Writes entry tagged with `parent: <A-session-id>`.
6. `/tree` back to root.
7. In root: `/skill:fork-sync <A-session>`. Root now sees the entire A
   subtree's work in one merged entry.

**The cascading works because each sync entry carries a `parent` session ID,
and each parent's sync reads entries tagged with the child's session ID.**

## Usage (Same for Any Level)

1. **In the fork you're syncing FROM**, run `/session` and copy the path
   or session ID (e.g. `019f21fc-d34d`).

2. **Use `/tree`** to navigate back to the parent session.

3. **Run the skill**:

   ```
   /skill:fork-sync 019f21fc
   ```

## What It Does

1. Locates the fork's session JSONL file. Search order:
   - `.pi/sessions/` (project-local, if `sessionDir` is configured)
   - `~/.pi/agent/sessions/<encoded-cwd>/` (global fallback)
   - Use partial ID matching against filenames
2. Reads the fork's session and extracts:
   - The most recent **compaction summary** (structured: goal, progress,
     decisions, next-steps). This is the primary source.
   - If no compaction exists, reads the **last ~60 messages**, looking for
     user instructions (what was asked), assistant responses with concrete
     changes (file paths, code snippets), and tool call results.
3. **Cascading merge**: Also reads `.pi/sync-log.md` in the project root.
   Finds all entries whose `### Parent Session` field matches the fork's
   session ID. These are sub-forks that were previously synced into this
   fork. Their `Direct Changes` and `Key Decisions` are merged into the
   current sync entry under `### Merged from Sub-Forks`.
4. Writes a new timestamped entry to `.pi/sync-log.md` (creates if
   missing) using the format below.
5. Prints the merged summary in the current conversation.

## Sync Log Entry Format

```markdown
## [2026-07-02 14:30] Fork: <fork-session-id>
### Parent Session: <current-session-id>
### Direct Changes
- path/to/file1.c — what was changed
- path/to/file2.h — what was added
(If no direct changes, write: "No direct changes in this fork — only merged
sub-forks.")

### Merged from Sub-Forks
- [sub-fork-id-1] Changed X in file.c
- [sub-fork-id-2] Added Y in other.c
(If no sub-forks, omit this section or write "None".)

### Key Decisions
- Decision 1: rationale
- Decision 2: rationale

### Status
- Done: completed items
- Todo: remaining items

---
```

## Extraction Rules for Reading Session JSONL

Each line in a session JSONL is a JSON object. Focus on these fields:

- `type`: `"user"`, `"assistant"`, `"tool_call"`, `"tool_result"`,
  `"compaction"`
- `content` / `message.content`: the actual text
- For tool calls: look at `tool` field and `input` for file paths

**If a compaction entry exists,** its `summary` field is the best source.
Read it in full, then summarize into the sync entry format.

**If no compaction exists,** scan the last ~60 lines. Identify:
- User messages that request changes → these define the goal.
- Tool calls with `tool: "write"` or `tool: "edit"` → these have file paths
  in their input.
- Assistant messages that explain decisions → extract key rationale.
- Tool calls with `tool: "bash"` involving git → note commit messages.

## Locating the Session File

search both locations:

Project-local (if configured):
```bash
ls .pi/sessions/*<partial-id>*.jsonl
```

Global:
```bash
ls ~/.pi/agent/sessions/*<partial-id>*.jsonl
```

On Windows, use equivalent PowerShell or Python glob.

## After Sync

- The current parent session now knows the fork's changes.
- `.pi/sync-log.md` serves as a permanent record that any future session
  (fork or not) can read via `@.pi/sync-log.md`.
- If the fork itself had sub-forks synced into it, those are now merged
  into the current entry and will cascade upward on the next sync.

## ⚠️ Note on Session Relocation

If project sessions are moved or shared via git (e.g. after
`/skill:project-sessions sync`), the `parentSession` field in fork session
files **must point to the correct local path** for `/resume` to display
fork hierarchy. See the `project-sessions` skill for the automated fix.
