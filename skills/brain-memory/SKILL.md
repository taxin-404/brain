---
name: brain-memory
description: Use when an agent is connected to a "brain" memory MCP server (brain / brain-propose tools — recall, remember, propose_correction, propose_forget, propose_block_edit, propose_procedure) and must decide what is worth storing now vs relying on automatic capture, when asked to remember or forget something, when the user contradicts stored knowledge, when secrets surface in-session, or when a repeated workflow should become a durable procedure.
---

# brain-memory — judging what the memory stores, and when

Two layers exist; knowing which one you're in prevents almost every mistake.

## Layer 1 — auto (default: take no action)

A capture client records your session as raw events, and the worker's scheduled
pipeline (extraction → consolidation → weekly reflection) promotes **repeated**
patterns into durable facts. Ordinary conversation needs **zero** tool calls:
do not mirror the transcript into `remember` — the pipeline handles it, and
manual duplicates just add noise.

## Layer 2 — instant (call now, verbatim evidence helps)

| Situation | Call | Mechanics |
|---|---|---|
| One durable statement worth keeping now ("we always deploy branches as `tb/`") | `remember(text, session_id?)` | lands as an event; extraction may promote it — for preferences/procedures prefer the tools below |
| User contradicts a stored fact | `recall` to find it → `propose_correction(fact_id, correction, evidence_event_id?)` | with the user's verbatim quote as `evidence_event_id` it can **auto-apply**; without evidence it waits for manual review |
| User asks to erase something — or a secret/key appeared | `propose_forget(target_type, target_id)` | always manual review; never delete silently, never restate secrets' values afterward |
| Identity/preference edits (`get_blocks()` shows the blocks) | `propose_block_edit(key, value, reason?)` | blocks load every session — reserve them for the few things that should; always manual review |
| A workflow has repeated successfully | `propose_procedure(name, steps, trigger?, tools?, success_criteria?, …)` | **owner approval required by design — agents cannot self-approve procedures** |

## What never gets stored

- Secrets, keys, tokens, credentials — if one surfaces: do not `remember` it;
  `propose_forget` any event/fact that captured it and tell the user to rotate.
- Transient session detail: debugging traces, file diffs, throwaway plans.
- Data of people outside the session.

## Dedupe before you write

`recall` / `get_blocks()` **before** proposing: supersede an existing fact
(`propose_correction`) rather than landing a conflicting duplicate. Check the
blocks first — many "new" preferences are already there.

## Decision shortcuts

- Preference → block edit; episodic fact → `remember`; repeated multi-step
  success → `propose_procedure`; conflicting stored knowledge → corrected with
  evidence; ambiguous → `remember` and let extraction weigh it.
- When a propose call replies `"MCP_PROPOSE scope required"`, your token is
  read-only — say so, don't retry.
