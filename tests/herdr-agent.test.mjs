import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/herdr-agent.mjs");
const roots = [];

// A stand-in herdr CLI that keeps panes and agents in a JSON file the test can edit.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_HERDR_STATE;
const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { calls: [], agents: {}, workspaces: {} };
const [group, cmd, ...rest] = process.argv.slice(2);
s.calls.push([group, cmd, ...rest]);
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const ok = (result) => { save(); console.log(JSON.stringify({ result })); };
const missing = (name) => { save(); console.error(JSON.stringify({ error: { code: "agent_not_found", message: "agent target " + name + " not found" } })); process.exit(1); };
const opt = (k) => rest[rest.indexOf(k) + 1];
if (group === "workspace" && cmd === "create") {
  const id = "w" + (Object.keys(s.workspaces).length + 1);
  s.workspaces[id] = { cwd: opt("--cwd"), env: rest.filter((_, i) => rest[i - 1] === "--env") };
  ok({ workspace: { workspace_id: id }, root_pane: { pane_id: id + ":p1" } });
} else if (group === "workspace" && cmd === "close") {
  delete s.workspaces[rest[0]];
  ok({ type: "ok" });
} else if (group === "agent" && cmd === "start") {
  s.agents[rest[0]] = { status: "idle", screen: "❭ Ask Devin to build features", args: rest.slice(rest.indexOf("--") + 1), prompts: [], ctrlc: 0 };
  ok({ agent: { name: rest[0] } });
} else if (group === "agent") {
  const a = s.agents[rest[0]];
  if (!a) missing(rest[0]);
  if (cmd === "get") ok({ agent: { agent_status: a.status } });
  else if (cmd === "read") { save(); console.log(a.screen); }
  else if (cmd === "prompt") { a.prompts.push(rest[1]); a.status = "working"; ok({ type: "agent_prompted" }); }
  else if (cmd === "send-keys") { if (++a.ctrlc >= 2) delete s.agents[rest[0]]; ok({ type: "ok" }); }
}
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "herdr-agent-"));
  roots.push(root);
  const repo = join(root, "app");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  const bin = join(root, "herdr");
  writeFileSync(bin, FAKE, { mode: 0o755 });
  const stateFile = join(root, "herdr-state.json");
  const env = { ...process.env, HERDR_ENV: "1", PSTACK_HERDR_BIN: bin, FAKE_HERDR_STATE: stateFile, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", XDG_CONFIG_HOME: join(root, "xdg") };
  const cli = (...args) => {
    const r = spawnSync("node", [script, ...args], { cwd: repo, env, encoding: "utf8" });
    return { code: r.status, json: JSON.parse(r.stdout) };
  };
  const fake = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const edit = (fn) => {
    const s = fake();
    fn(s);
    writeFileSync(stateFile, JSON.stringify(s));
  };
  const brief = join(root, "brief.md");
  writeFileSync(brief, "/poteto-mode build the thing. Use /verify and show me screenshots.\n");
  return { repo, cli, fake, edit, brief, env };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("herdr-agent", () => {
  test("refuses to run outside a Herdr pane", () => {
    const { repo } = setup();
    const r = spawnSync("node", [script, "status", "--name", "x"], { cwd: repo, env: { ...process.env, HERDR_ENV: "" }, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error).toContain("not running inside a Herdr pane");
  });

  test("start gives the agent its own worktree, workspace, Devin session, and a brief with the completion contract", () => {
    const { repo, cli, fake, brief } = setup();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const r = cli("start", "--name", "pr-1-owner", "--brief", brief);
    expect(r.code).toBe(0);
    expect(r.json.branch).toBe("herdr/pr-1-owner");
    expect(r.json.base).toBe(head);
    expect(existsSync(join(r.json.worktree, "a.txt"))).toBe(true);
    const s = fake();
    expect(s.workspaces.w1.cwd).toBe(r.json.worktree);
    expect(s.workspaces.w1.env).toContain(`PSTACK_HERDR_RESULT=${r.json.resultFile}`);
    expect(s.workspaces.w1.env).toContain("GIT_AUTHOR_EMAIL=ada@example.com");
    expect(s.workspaces.w1.env.some((e) => e.startsWith("XDG_CONFIG_HOME="))).toBe(true);
    expect(s.agents["pr-1-owner"].args).toEqual(expect.arrayContaining(["--permission-mode", "accept-edits", "--export", r.json.exportFile]));
    expect(s.agents["pr-1-owner"].prompts[0]).toContain(r.json.briefFile);
    const delivered = readFileSync(r.json.briefFile, "utf8");
    expect(delivered).toContain("/poteto-mode build the thing");
    expect(delivered).toContain(`write one JSON object to ${r.json.resultFile}`);
  });

  test("status reads a dialog off the screen even when Herdr says idle, and only the result file means done", () => {
    const { cli, edit, brief } = setup();
    const { json: agent } = cli("start", "--name", "w", "--brief", brief);
    expect(cli("status", "--name", "w").json.phase).toBe("working");
    edit((s) => Object.assign(s.agents.w, { status: "idle", screen: "❭ Allow  Exec(env X=1 bun)\n↑↓ select · ↵ confirm · esc cancel" }));
    expect(cli("status", "--name", "w").json.phase).toBe("blocked");
    const refused = cli("send", "--name", "w", "--text", "keep going");
    expect(refused.json.ok).toBe(false);
    expect(refused.json.next).toContain("dialog");
    edit((s) => Object.assign(s.agents.w, { screen: "❭ Ask Devin to build features" }));
    expect(cli("status", "--name", "w").json.phase).toBe("idle");
    writeFileSync(agent.resultFile, JSON.stringify({ status: "done", sha: "abc", evidence: ["/tmp/board.png"] }));
    const done = cli("wait", "--name", "w", "--timeout", "5000");
    expect(done.json.phase).toBe("done");
    expect(done.json.result.evidence).toEqual(["/tmp/board.png"]);
  });

  test("wait returns an idle agent after the grace period instead of hanging", () => {
    const { cli, edit, brief } = setup();
    cli("start", "--name", "w", "--brief", brief);
    edit((s) => Object.assign(s.agents.w, { status: "done", screen: "❭ Ask Devin to build features" }));
    const r = cli("wait", "--name", "w", "--idle-grace", "0", "--timeout", "5000");
    expect(r.json.phase).toBe("idle");
    expect(r.json.next).toContain("without a result");
  });

  test("stop ends the session and closes the workspace but keeps the worktree", () => {
    const { cli, fake, brief } = setup();
    const { json: agent } = cli("start", "--name", "w", "--brief", brief);
    const r = cli("stop", "--name", "w");
    expect(r.json.ok).toBe(true);
    expect(fake().agents.w).toBeUndefined();
    expect(fake().workspaces.w1).toBeUndefined();
    expect(existsSync(agent.worktree)).toBe(true);
    expect(cli("status", "--name", "w").json.phase).toBe("gone");
  });

  test("a second start with the same name is refused", () => {
    const { cli, brief } = setup();
    cli("start", "--name", "w", "--brief", brief);
    const again = cli("start", "--name", "w", "--brief", brief);
    expect(again.code).toBe(1);
    expect(again.json.error).toContain("already exists");
  });
});
