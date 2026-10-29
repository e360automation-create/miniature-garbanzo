# Miniature Garbanzo — local-first always-on agent

A local agent that stays running, keeps a durable task log, watches an inbox, and can use Claude as an on-demand reasoning engine. The scheduler and filesystem tools run locally. No Anthropic request is made for startup, heartbeat, status, list, or read commands; Claude is contacted only when a queued task needs reasoning and `ANTHROPIC_API_KEY` is configured.

## Quick start

Requirements: Node.js 20+ and npm. Rust stable is needed only for the optional Rust policy core.

```bash
git clone https://github.com/e360automation-create/miniature-garbanzo.git
cd miniature-garbanzo
npm install
cp .env.example .env
npm run dev
```

Windows PowerShell: use `Copy-Item .env.example .env` instead of `cp`.

Add your key later in `.env`:

```dotenv
ANTHROPIC_API_KEY=your_anthropic_api_key
ANTHROPIC_MODEL=claude-sonnet-4-20250514
AGENT_ALLOW_WRITES=false
```

Do not commit `.env`. It is ignored by Git. Without the key, the agent still runs locally and records AI tasks as `needs-claude`, without sending anything over the network.

## Use it

- Type a task to queue it for processing.
- `/status` — show runtime/config status.
- `/list [relative-path]` — list workspace files locally.
- `/read <relative-path>` — read a workspace file locally.
- `/help` — show commands.
- `/quit` — stop the foreground process.
- `/claude <task>` — queue a task that may use Claude; all ordinary tasks use the same policy and only call Claude when configured.
- Drop a `.txt` or `.md` file into `data/inbox/` to have the background heartbeat pick it up.

The agent persists task state in `data/tasks.jsonl` and confines file tools to `./workspace`. It does not run arbitrary shell commands. File reads are limited by `AGENT_MAX_FILE_BYTES`. File writes are disabled by default; set `AGENT_ALLOW_WRITES=true` only if you want Claude to create/modify files in the workspace. Review changes before using them.

## Checks

```bash
npm run typecheck
npm run rust:check
```

## Safety and current limits

This is a useful local-first starter, not a magical autonomous operating-system administrator. It has a heartbeat, persistent queue, inbox watcher, and bounded Claude tool-use loop. It does not yet install itself as a Windows service or macOS/Linux daemon; keep the process running for continuous operation. Claude calls incur Anthropic usage charges. Do not put credentials or sensitive documents in the workspace unless you accept that relevant task context may be sent to Anthropic when a task is escalated.
