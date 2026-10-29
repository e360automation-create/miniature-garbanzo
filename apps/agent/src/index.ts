import "dotenv/config";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { askClaude } from "./claude.js";

const root = process.cwd();
const dataDir = resolve(root, "data");
const tasksFile = resolve(dataDir, "tasks.jsonl");
const tickMs = Math.max(1000, Number(process.env.AGENT_TICK_MS ?? 5000));
const escalationEnabled = process.env.AGENT_ALLOW_CLAUDE_ESCALATION === "true";

type Task = { id: string; prompt: string; createdAt: string; status: "queued" | "done" | "needs-cloud" | "error"; escalate?: boolean; result?: string };
let busy = false;
let stopping = false;

async function record(task: Task): Promise<void> {
  await mkdir(dirname(tasksFile), { recursive: true });
  await appendFile(tasksFile, JSON.stringify(task) + "\n", "utf8");
}

async function loadPending(): Promise<Task[]> {
  if (!existsSync(tasksFile)) return [];
  const lines = (await readFile(tasksFile, "utf8")).split("\n").filter(Boolean);
  const latest = new Map<string, Task>();
  for (const line of lines) {
    try { const task = JSON.parse(line) as Task; latest.set(task.id, task); } catch { /* ignore incomplete/corrupt log lines */ }
  }
  return [...latest.values()].filter(t => t.status === "queued");
}

async function processTask(task: Task): Promise<void> {
  console.log(`[agent] task ${task.id}: ${task.prompt}`);
  // The local agent is intentionally conservative: it can classify and log tasks without sending data off-device.
  // Cloud escalation requires BOTH task-level intent and an explicit global opt-in.
  if (task.escalate && escalationEnabled) {
    try {
      const result = await askClaude(task.prompt);
      await record({ ...task, status: "done", result });
      console.log(`[agent] Claude-assisted result for ${task.id}:\n${result}`);
    } catch (error) {
      await record({ ...task, status: "error", result: error instanceof Error ? error.message : String(error) });
      console.error("[agent] escalation failed:", error);
    }
  } else {
    const result = task.escalate
      ? "Cloud escalation was requested, but is disabled. Set AGENT_ALLOW_CLAUDE_ESCALATION=true and configure ANTHROPIC_API_KEY to permit it."
      : "Handled locally: task captured and logged. No cloud API was contacted. Add a local tool/handler for this task type or explicitly request Claude escalation.";
    await record({ ...task, status: task.escalate ? "needs-cloud" : "done", result });
    console.log(`[agent] ${result}`);
  }
}

async function tick(): Promise<void> {
  if (busy || stopping) return;
  busy = true;
  try {
    const tasks = await loadPending();
    for (const task of tasks) await processTask(task);
  } catch (error) {
    console.error("[agent] heartbeat error:", error);
  } finally { busy = false; }
}

async function enqueuePrompt(prompt: string, escalate = false): Promise<void> {
  const task: Task = { id: crypto.randomUUID(), prompt, createdAt: new Date().toISOString(), status: "queued", escalate };
  await record(task);
  console.log(`[agent] queued ${task.id}`);
  await tick();
}

async function main(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  console.log("[agent] local-first heartbeat started");
  console.log(`[agent] heartbeat every ${tickMs}ms; Claude escalation ${escalationEnabled ? "enabled by policy" : "disabled"}`);
  console.log("[agent] commands: type a task; prefix with /claude to explicitly request cloud help; /quit exits.");
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "agent> " });
  rl.prompt();
  rl.on("line", async (line) => {
    const input = line.trim();
    if (input === "/quit") { stopping = true; rl.close(); return; }
    if (!input) { rl.prompt(); return; }
    const escalate = input.startsWith("/claude ");
    const prompt = escalate ? input.slice(8).trim() : input;
    if (!prompt) { console.log("Provide a task after /claude."); rl.prompt(); return; }
    await enqueuePrompt(prompt, escalate);
    rl.prompt();
  });
  rl.on("close", () => { stopping = true; console.log("[agent] stopped"); process.exitCode = 0; });
  const heartbeat = setInterval(() => void tick(), tickMs);
  process.on("SIGINT", () => { clearInterval(heartbeat); stopping = true; rl.close(); });
}
void main();
