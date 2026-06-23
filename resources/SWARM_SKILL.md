# Swarm Skills

## Messaging — swarm-msg

Send a message to a peer:
  swarm-msg send <peer> -m "text"
  echo "long body" | swarm-msg send <peer>

List peers:
  swarm-msg peers

Peek at waiting messages (without consuming):
  swarm-msg peek

Read and archive your inbox:
  swarm-msg read

When a peer sends you something, the orchestrator delivers this nudge:
  [ultraswarm] new message from <sender> — run: swarm-msg read

Your only response to the nudge is to run `swarm-msg read` — it prints
the full message and archives it. Do not open inbox files manually.

## Shared plan — swarm-plan

Read the current plan:
  swarm-plan read

Add an item:
  swarm-plan add "implement login endpoint"

Mark item N done / undone:
  swarm-plan done 2
  swarm-plan undone 2

Remove item N:
  swarm-plan remove 3

Replace entire plan (coordinator):
  swarm-plan set "# Plan\n\n- [ ] step 1\n- [ ] step 2"

When any agent updates the plan, all agents receive:
  [plan updated]
  <new plan content>

## Where to write files — two locations, don't mix them

**1. Deliverables → the project repo (your shell's cwd, also `$CCSWARM_PROJECT`).**
Anything the user actually wants to read or keep lives in the repo directory you
were launched in — NOT in the shared workspace. This includes:
  - finished reports
  - a running status file of current findings / vulnerabilities / progress
  - summaries, write-ups, patches, anything "done"

Put them in a tidy place inside the repo, e.g. a `swarm/` subfolder
(`swarm/reports/`, `swarm/FINDINGS.md`) or a single top-level file like
`FINDINGS.md`. Keep the status file continuously updated so the user can open
the repo and see the current state at any time.

**2. Coordination scratch → the shared workspace (`$CCSWARM_SHARED`).**
Inter-agent handoffs, raw tool dumps, intermediate artifacts that other agents
read but the user does not care about. This lives OUTSIDE the repo and is
per-run scratch. Never put final deliverables here — the user won't find them.

Rule of thumb: if a human would want to read it, it goes in the repo. If it's
only a machine-to-machine handoff, it goes in `$CCSWARM_SHARED`.

Your inbox / outbox paths are in $CCSWARM_INBOX and $CCSWARM_OUTBOX.
