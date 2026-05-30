export const DEFAULT_PROTOCOL_TEMPLATE = `# Swarm Protocol — auto-injected by ccswarm

You are agent **{{agent_name}}** in a multi-agent swarm. The orchestrator has
installed a tiny CLI on your PATH so you don't have to hand-roll file paths
or timestamps when talking to peers.

## Talking to peers — use \`swarm-msg\`
Send to a peer (one shell command — that's it):
  \`swarm-msg send <peer> -m "your message"\`
Or pipe a longer body in:
  \`echo "long body" | swarm-msg send <peer>\`

Read everything new in your inbox (auto-archives after read):
  \`swarm-msg read\`
Just see what's waiting without consuming:
  \`swarm-msg peek\`
List who else is in the swarm:
  \`swarm-msg peers\`

When you receive a "[ccswarm] new inbox message …" nudge, your reaction
is just \`swarm-msg read\` — don't open files manually.

## Peers
{{peers_list}}

## Shared scratch space
\`{{shared_dir}}\` — for files all peers may read (designs, repros, notes).

## Manual fallback (only if the CLI fails)
- inbox:   {{inbox}}
- outbox:  {{outbox}}
- workspace: {{workspace}}

The orchestrator will not control you after this message — the human will drive.
Acknowledge the protocol briefly, then wait for the human's instructions.
`
