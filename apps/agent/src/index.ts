import "dotenv/config";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { askClaudeWithTools, type ToolCall } from "./claude.js";

const ROOT = process.cwd();
const WORKSPACE = resolve(process.env.AGENT_WORKSPACE ?? "./workspace");
const DATA = resolve(process.env.AGENT_DATA_DIR ?? "./data");
const TASK_LOG = resolve(DATA, "tasks.jsonl");
const INBOX = resolve(DATA, "inbox");
const TICK_MS = Math.max(1000, Number(process.env.AGENT_TICK_MS ?? 5000));
const MAX_FILE_BYTES = Math.max(1024, Number(process.env.AGENT_MAX_FILE_BYTES ?? 200_000));
const MAX_STEPS = Math.min(12, Math.max(1, Number(process.env.AGENT_MAX_STEPS ?? 6)));
const apiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);
let busy = false;
let stopping = false;

type Task = { id: string; prompt: string; createdAt: string; status: "queued" | "running" | "done" | "needs-claude" | "error"; result?: string; updatedAt?: string };
async function ensureDirs() {
  await Promise.all([mkdir(WORKSPACE, { recursive: true }), mkdir(DATA, { recursive: true }), mkdir(INBOX, { recursive: true })]);
}
async function record(task: Task) {
  await mkdir(dirname(TASK_LOG), { recursive: true });
  await appendFile(TASK_LOG, JSON.stringify({ ...task, updatedAt: new Date().toISOString() }) + "\n", "utf8");
}
function safePath(input: string): string {
  if (!input || isAbsolute(input)) throw new Error("Use a relative path inside the agent workspace.");
  const target = resolve(WORKSPACE, input);
  const rel = relative(WORKSPACE, target);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("Path escapes the agent workspace.");
  return target;
}
async function localTool(name: string, input: Record<string, unknown>): Promise<string> {
  const path = String(input.path ?? "");
  if (name === "list_files") {
    const dir = safePath(path || ".");
    const entries = await readdir(dir, { withFileTypes: true });
    return JSON.stringify(await Promise.all(entries.map(async entry => {
      const p = resolve(dir, entry.name);
      const info = await stat(p);
      return { name: entry.name, type: entry.isDirectory() ? "directory" : "file", bytes: entry.isFile() ? info.size : undefined };
    })));
  }
  if (name === "read_file") {
    const target = safePath(path);
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("File is not regular or exceeds AGENT_MAX_FILE_BYTES.");
    return await readFile(target, "utf8");
  }
  if (name === "write_file" || name === "append_file") {
    if (process.env.AGENT_ALLOW_WRITES !== "true") throw new Error("File writes are disabled. Set AGENT_ALLOW_WRITES=true in .env to allow writes inside ./workspace.");
    const target = safePath(path);
    const content = String(input.content ?? "");
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("Content exceeds AGENT_MAX_FILE_BYTES.");
    await mkdir(dirname(target), { recursive: true });
    if (name === "append_file") await appendFile(target, content, "utf8");
    else await writeFile(target, content, "utf8");
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${relative(WORKSPACE, target)}`;
  }
  throw new Error(`Tool not allowed: ${name}`);
}
function localCommand(prompt: string): string | null {
  const cmd = prompt.trim();
  if (/^\/?help$/i.test(cmd)) return "Commands: /help, /status, /list [path], /read <path>, /task <description>, /claude <description>, /quit. Tasks are persisted in data/tasks.jsonl. Drop .txt or .md task files into data/inbox for background processing.";
  if (/^\/?status$/i.test(cmd)) return `Agent running. Workspace: ${WORKSPACE}. Claude API: ${apiEnabled() ? "configured (called only for AI tasks)" : "not configured"}. Writes: ${process.env.AGENT_ALLOW_WRITES === "true" ? "enabled" : "disabled"}.`;
  const list = cmd.match(/^\/?list(?:\s+(.*))?$/i);
  if (list) return "Workspace files: " + JSON.stringify(awaitListPlaceholder(list[1] ?? "."));
  return null;
}
function awaitListPlaceholder(path: string) { return { path, note: "Use Claude-assisted /task for file inspection, or the /read command." }; }
async function runTask(task: Task): Promise<void> {
  await record({ ...task, status: "running" });
  console.log(`\n[agent] working on ${task.id}: ${task.prompt}`);
  try {
    if (/^\/?help$/i.test(task.prompt.trim()) || /^\/?status$/i.test(task.prompt.trim())) {
      const result = localCommand(task.prompt) ?? "No local handler.";
      await record({ ...task, status: "done", result }); console.log(result); return;
    }
    if (!apiEnabled()) {
      const result = "Saved locally, but this task needs AI assistance. Add ANTHROPIC_API_KEY to .env to enable Claude escalation. No network request was made.";
      await record({ ...task, status: "needs-claude", result }); console.log("[agent] " + result); return;
    }
    const result = await askClaudeWithTools(task.prompt, async (name, input) => localTool(name, input), MAX_STEPS);
    await record({ ...task, status: "done", result }); console.log(`[agent] result:\n${result}`);
  } catch (error) {
    const result = error instanceof Error ? error.message : String(error);
    await record({ ...task, status: "error", result }); console.error("[agent] task failed:", result);
  }
}
async function readPending(): Promise<Task[]> {
  if (!existsSync(TASK_LOG)) return [];
  const latest = new Map<string, Task>();
  for (const line of (await readFile(TASK_LOG, "utf8")).split("\n").filter(Boolean)) {
    try { const task = JSON.parse(line) as Task; latest.set(task.id, task); } catch { /* tolerate partial final line */ }
  }
  return [...latest.values()].filter(task => task.status === "queued" || task.status === "running").map(task => task.status === "running" ? { ...task, status: "queued" as const } : task);
}
async function scanInbox() {
  for (const name of await readdir(INBOX)) {
    if (!/\.(txt|md)$/i.test(name)) continue;
    const path = resolve(INBOX, name);
    const prompt = (await readFile(path, "utf8")).trim();
    if (!prompt) continue;
    const id = "inbox-" + basename(name, extname(name));
    const pending = await readPending();
    if (pending.some(t => t.id === id)) continue;
    // Record the queued task before moving the inbox file to avoid repeat pickup.
    await record({ id, prompt, createdAt: new Date().toISOString(), status: "queued" });
    await writeFile(path + ".processed", "Queued at " + new Date().toISOString() + "\n", "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(path, path + ".done");
  }
}
async function tick() {
  if (busy || stopping) return;
  busy = true;
  try {
    await scanInbox();
    for (const task of await readPending()) {
      if (stopping) break;
      await runTask(task);
    }
  } catch (error) { console.error("[agent] heartbeat error:", error); }
  finally { busy = false; }
}
async function enqueue(prompt: string) {
  const task: Task = { id: randomUUID(), prompt, createdAt: new Date().toISOString(), status: "queued" };
  await record(task);
  console.log(`[agent] queued ${task.id}`);
  void tick();
}
async function main() {
  await ensureDirs();
  console.log("Miniature Garbanzo — local-first agent");
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Heartbeat: ${TICK_MS}ms | Claude: ${apiEnabled() ? "available on demand" : "not configured"} | writes: ${process.env.AGENT_ALLOW_WRITES === "true" ? "enabled" : "disabled"}`);
  console.log("Type a task, /help, /status, /read <relative-path>, /list [path], or /quit.");
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "agent> " });
  rl.prompt();
  rl.on("line", async line => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === "/quit") { stopping = true; rl.close(); return; }
    if (input === "/help" || input === "/status") { console.log(localCommand(input)); rl.prompt(); return; }
    const read = input.match(/^\/read\s+(.+)$/);
    if (read) {
      try { console.log(await localTool("read_file", { path: read[1] })); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
      rl.prompt(); return;
    }
    const list = input.match(/^\/list(?:\s+(.*))?$/);
    if (list) {
      try { console.log(await localTool("list_files", { path: list[1] ?? "." })); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
      rl.prompt(); return;
    }
    const prompt = input.startsWith("/task ") ? input.slice(6).trim() : input.startsWith("/claude ") ? input.slice(8).trim() : input;
    if (!prompt) { console.log("Please provide a task description."); rl.prompt(); return; }
    await enqueue(prompt);
    rl.prompt();
  });
  rl.on("close", () => { stopping = true; console.log("\n[agent] stopping after the current operation."); });
  const heartbeat = setInterval(() => void tick(), TICK_MS);
  process.on("SIGINT", () => { clearInterval(heartbeat); stopping = true; rl.close(); });
  process.on("SIGTERM", () => { clearInterval(heartbeat); stopping = true; rl.close(); });
  void tick();
}
void main();
