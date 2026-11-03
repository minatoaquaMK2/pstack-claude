#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

const HELP = `herdr-agent: run a pstack role as a separate Devin session in Herdr, the way upstream runs a cloud agent.
Every command prints JSON. Run it from a Devin session inside Herdr (HERDR_ENV=1).

  start --name N --brief FILE [--repo DIR] [--base REF] [--worktree DIR] [--model UID] [--permission-mode MODE]
        new git worktree and Herdr workspace, Devin started there, brief delivered
  status --name N          phase: working | idle | blocked | done | gone
  wait --name N [--timeout MS] [--idle-grace MS]
                           returns at done, blocked, gone, or idle that lasted --idle-grace (default 30000)
  read --name N [--lines N]
  send --name N --text T   follow-up prompt; refused while a dialog is on screen
  stop --name N            ends the session and closes its workspace; keeps the worktree`;

const HERDR = process.env.PSTACK_HERDR_BIN ?? "herdr";
// Herdr can classify a Devin approval or question dialog as idle; every Devin dialog footer ends with this.
const DIALOG = /esc cancel/i;

class CliError extends Error {
  constructor(message, next) {
    super(message);
    this.next = next;
  }
}

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  if (r.error) throw new CliError(`${cmd} failed to start: ${r.error.message}`, `install ${cmd} or check PATH`);
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function herdr(...args) {
  const r = run(HERDR, args);
  if (r.code !== 0) {
    let error;
    try {
      error = JSON.parse(r.err).error;
    } catch {}
    const e = new CliError(`herdr ${args.slice(0, 2).join(" ")}: ${error?.message ?? (r.err || r.out)}`, "run `herdr status` and check the session");
    e.code = error?.code;
    throw e;
  }
  return r.out.startsWith("{") ? JSON.parse(r.out).result : r.out;
}

function git(cwd, ...args) {
  const r = run("git", args, { cwd });
  if (r.code !== 0) throw new CliError(`git ${args.join(" ")}: ${r.err}`, "check the repository and the base ref");
  return r.out;
}

function flags(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new CliError(`unexpected argument ${argv[i]}`, "run with --help");
    o[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  return o;
}

function stateDir(repo) {
  const common = resolve(repo, git(repo, "rev-parse", "--git-common-dir"));
  const dir = join(common, "pstack-herdr");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function load(dir, name) {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) throw new CliError(`no herdr agent named ${name} in this repository`, "start one with `herdr-agent start`");
  return JSON.parse(readFileSync(file, "utf8"));
}

function event(dir, name, kind, detail = {}) {
  appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ t: new Date().toISOString(), name, event: kind, ...detail })}\n`);
}

function observe(agent) {
  if (existsSync(agent.resultFile)) {
    let result;
    try {
      result = JSON.parse(readFileSync(agent.resultFile, "utf8"));
    } catch (error) {
      result = { status: "failed", summary: `unparseable result file: ${error.message}` };
    }
    return { phase: "done", result };
  }
  let status;
  try {
    status = herdr("agent", "get", agent.name).agent.agent_status;
  } catch (error) {
    if (error.code === "agent_not_found") return { phase: "gone" };
    throw error;
  }
  if (status === "blocked") return { phase: "blocked", screen: screen(agent) };
  if (status !== "idle" && status !== "done") return { phase: "working", herdr: status };
  const bottom = screen(agent);
  return DIALOG.test(bottom) ? { phase: "blocked", screen: bottom, herdr: status } : { phase: "idle", herdr: status };
}

function screen(agent) {
  return String(herdr("agent", "read", agent.name, "--source", "detection", "--format", "text"));
}

const CONTRACT = (resultFile) => `

## Completion contract

You run as a separate agent session that a coordinator started through Herdr. When the task is finished, blocked on a person, or failed, write one JSON object to ${resultFile} and end your turn:

{"status": "done" | "blocked" | "failed", "branch": "<branch>", "sha": "<commit>", "summary": "<what changed and how you verified it>", "evidence": ["<absolute path of each screenshot, video, or log>"], "questions": ["<only when blocked>"]}

Commit your work on your branch before you write the file. The coordinator reads only this file to decide that you finished.`;

const commands = {
  start(o) {
    if (!o.name || !/^[a-z][a-z0-9_-]{0,31}$/.test(o.name)) throw new CliError("--name must match [a-z][a-z0-9_-]{0,31}", "pick a short unique name such as pr-12-owner");
    if (!o.brief || !existsSync(o.brief)) throw new CliError("--brief must name an existing file", "write the brief to a file first");
    const repo = git(resolve(o.repo ?? "."), "rev-parse", "--show-toplevel");
    const dir = stateDir(repo);
    if (existsSync(join(dir, `${o.name}.json`))) throw new CliError(`agent ${o.name} already exists`, "use status, wait, or stop, or pick another name");
    const branch = `herdr/${o.name}`;
    const base = git(repo, "rev-parse", "--verify", `${o.base ?? "HEAD"}^{commit}`);
    const worktree = resolve(o.worktree ?? join(dirname(repo), `${basename(repo)}-worktrees`, o.name));
    git(repo, "worktree", "add", "-b", branch, worktree, base);
    const agent = { name: o.name, repo, branch, base, worktree, resultFile: join(dir, `${o.name}.result.json`), briefFile: join(dir, `${o.name}.brief.md`), exportFile: join(dir, `${o.name}.export.json`) };
    writeFileSync(agent.briefFile, readFileSync(o.brief, "utf8") + CONTRACT(agent.resultFile));
    const passthrough = ["XDG_CONFIG_HOME", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"].filter((k) => process.env[k]);
    const env = [`PSTACK_HERDR_AGENT=${o.name}`, `PSTACK_HERDR_RESULT=${agent.resultFile}`, ...passthrough.map((k) => `${k}=${process.env[k]}`)];
    const ws = herdr("workspace", "create", "--cwd", worktree, "--label", o.name, "--no-focus", ...env.flatMap((e) => ["--env", e]));
    Object.assign(agent, { workspace: ws.workspace.workspace_id, pane: ws.root_pane.pane_id, startedAt: new Date().toISOString() });
    writeFileSync(join(dir, `${o.name}.json`), JSON.stringify(agent, null, 2));
    const devinArgs = ["--permission-mode", o["permission-mode"] ?? "accept-edits", "--respect-workspace-trust", "false", "--export", agent.exportFile, ...(o.model ? ["--model", o.model] : [])];
    try {
      herdr("agent", "start", o.name, "--kind", "devin", "--pane", agent.pane, "--timeout", "60000", "--", ...devinArgs);
    } catch (error) {
      if (error.code !== "agent_not_ready") throw error;
    }
    const now = observe(agent);
    if (now.phase === "blocked") {
      event(dir, o.name, "blocked", { at: "startup" });
      return { ok: false, ...agent, ...now, next: "a dialog is on screen at startup; tell the user, then run `send` after it is answered" };
    }
    herdr("agent", "prompt", o.name, `Invoke the poteto-mode skill. Then read ${agent.briefFile} and do that task as the owner of its playbook. Finish with the completion contract at the end of that file.`);
    event(dir, o.name, "started", { workspace: agent.workspace, branch, base });
    return { ok: true, ...agent };
  },
  status(o, dir) {
    const agent = load(dir, o.name);
    return { ok: true, name: agent.name, workspace: agent.workspace, worktree: agent.worktree, branch: agent.branch, ...observe(agent) };
  },
  async wait(o, dir) {
    const agent = load(dir, o.name);
    const deadline = Date.now() + Number(o.timeout ?? 3600000);
    const grace = Number(o["idle-grace"] ?? 30000);
    let idleSince = null;
    for (;;) {
      const now = observe(agent);
      idleSince = now.phase === "idle" ? (idleSince ?? Date.now()) : null;
      if (now.phase === "done" || now.phase === "blocked" || now.phase === "gone" || (idleSince && Date.now() - idleSince >= grace)) {
        event(dir, agent.name, now.phase, now.phase === "done" ? { status: now.result?.status } : {});
        return { ok: now.phase === "done", name: agent.name, ...now, ...(now.phase === "idle" ? { next: "the agent ended a turn without a result; `read` it, then `send` an answer or a nudge" } : {}) };
      }
      if (Date.now() > deadline) return { ok: false, name: agent.name, ...now, next: "still running; wait again or `read` it" };
      await new Promise((r) => setTimeout(r, 3000));
    }
  },
  read(o, dir) {
    const agent = load(dir, o.name);
    return { ok: true, name: agent.name, text: String(herdr("agent", "read", agent.name, "--source", "recent-unwrapped", "--lines", String(o.lines ?? 80))) };
  },
  send(o, dir) {
    const agent = load(dir, o.name);
    if (!o.text) throw new CliError("--text is required", "pass the follow-up prompt");
    const now = observe(agent);
    if (now.phase === "blocked") return { ok: false, name: agent.name, ...now, next: "a dialog is on screen; the user must answer it in Herdr first" };
    if (now.phase === "gone") return { ok: false, name: agent.name, ...now, next: "the session exited; start a fresh agent with the consolidated brief" };
    herdr("agent", "prompt", agent.name, o.text);
    event(dir, agent.name, "sent");
    return { ok: true, name: agent.name };
  },
  async stop(o, dir) {
    const agent = load(dir, o.name);
    for (let i = 0; i < 10 && observe(agent).phase !== "gone"; i++) {
      for (const _ of [0, 1]) {
        try {
          herdr("agent", "send-keys", agent.name, "ctrl+c");
        } catch {}
        await new Promise((r) => setTimeout(r, 400));
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (observe(agent).phase !== "gone" && !existsSync(agent.resultFile)) return { ok: false, name: agent.name, next: "the session did not exit; check it in Herdr" };
    try {
      herdr("workspace", "close", agent.workspace);
    } catch {}
    event(dir, agent.name, "stopped");
    return { ok: true, name: agent.name, worktree: agent.worktree, branch: agent.branch };
  },
};

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || !commands[cmd]) return console.log(HELP);
  if (process.env.HERDR_ENV !== "1") throw new CliError("not running inside a Herdr pane (HERDR_ENV is not 1)", "start this Devin session inside Herdr, or use run_subagent");
  const o = flags(rest);
  const dir = cmd === "start" ? null : stateDir(git(resolve(o.repo ?? "."), "rev-parse", "--show-toplevel"));
  if (cmd !== "start" && !o.name) throw new CliError("--name is required", "pass the name used with start");
  console.log(JSON.stringify(await commands[cmd](o, dir), null, 2));
}

main(process.argv.slice(2)).catch((error) => {
  console.log(JSON.stringify({ ok: false, error: error.message, next: error.next ?? "run with --help" }, null, 2));
  process.exitCode = 1;
});
