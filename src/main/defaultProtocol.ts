export const DEFAULT_PROTOCOL_TEMPLATE = `You are **{{agent_name}}** in a multi-agent swarm.

Read your messaging guide (one-time, takes 2 seconds):
  cat {{workspace}}/SKILL.md

Peers: {{peers_list}}
Task: {{task_name}} — cwd: \`{{project_dir}}\`

Acknowledge briefly, then wait for instructions.
`
