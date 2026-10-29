# Miniature Garbanzo

A local-first, always-on AI agent built with TypeScript and Rust. It runs its scheduler, task queue, local tools, and policy checks on your machine. Claude is an optional escalation provider: no Claude API request is made unless a task is explicitly escalated or the local agent determines it cannot safely complete a task with configured local capabilities.

## Principles

- **Local by default:** planning, timers, task state, logs, and local tools run on-device.
- **Explicit cloud escalation:** Claude calls are opt-in per task or enabled by policy; disclose the reason and send only the minimum task context.
- **Safe execution:** tool allowlists, approval gates for destructive/external actions, bounded retries, and audit logs.
- **Inspired by agent patterns, not copied code:** use public ideas such as task queues, tool registries, persistent memory, heartbeat loops, and human approval gates. Do not clone proprietary implementations or copy licenses/code without review.

## Architecture

- `apps/agent` — TypeScript orchestration, scheduler, task state, and Claude adapter.
- `crates/agent-core` — Rust local runtime for policy checks and bounded tool execution.
- `data/` — local state (ignored by git).
- Claude integration uses the official Anthropic Messages API only when escalation is requested and `ANTHROPIC_API_KEY` is configured.

## Requirements

- Node.js 20+
- Rust stable toolchain
- Optional: Anthropic API key (only for cloud escalation)

## Quick start

```sh
cp .env.example .env
npm install
npm run dev
```

Without `ANTHROPIC_API_KEY`, the local agent still starts and runs local tasks; Claude escalation returns a clear configuration error. Never commit `.env`.

## Current status

Initial scaffold. Local task persistence, OS-specific service installation, and richer local-model adapters are follow-up milestones. Run only with tools and permissions you understand.
