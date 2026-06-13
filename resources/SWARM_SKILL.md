# Swarm Skills

## Messaging — swarm-msg

Send a message to a peer:
  swarm-msg send <peer> -m "text"
  echo "long body" | swarm-msg send <peer>

List peers:
  swarm-msg peers

Peek at waiting messages (without consuming):
  swarm-msg peek

Messages from peers arrive directly in your prompt:
  [inbox → you] from: <sender>
  <body>
  (to reply: swarm-msg send <sender> -m "...")

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

## Shared workspace

All agents can read/write files here:
  $CCSWARM_SHARED

Your inbox / outbox paths are in $CCSWARM_INBOX and $CCSWARM_OUTBOX.
