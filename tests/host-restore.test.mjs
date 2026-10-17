// Extended functional tests for dsh-project-backup host logic (lib/index.js).
// Covers: full-tree restore fidelity, .git, unicode names, restore via meta.json
// (simulating a process restart), delete route, prompt answer variants,
// persistent "never ask for this project" list.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN = pathToFileURL("S:/dsh-project-backup/lib/index.js").href;
const SKIPPED_FILE = "S:/dsh-backups/.skipped-projects.json";
const skippedBackup = existsSync(SKIPPED_FILE) ? readFileSync(SKIPPED_FILE, "utf8") : null;

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) failures++;
}

/** Wire the plugin with a mock ctx; returns {routes, listeners, setAnswers}. */
async function wire(answers) {
  const plugin = await import(PLUGIN + "?t=" + Date.now() + Math.random());
  const routes = new Map();
  const listeners = new Map();
  const ctx = {
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); },
    userQuestions: { async ask() { return { answers: [{ selected: answers }] }; } },
    connection: { fetch: { register(r) { routes.set(r.methods[0] + " " + r.path, r.fetch); return () => {}; } } },
  };
  plugin.apply(ctx, { enabled: { get: () => true } });
  return { routes, listeners };
}

async function listItems(routes) {
  const res = await routes.get("GET /api/project-backup/list")();
  return (await res.json()).items;
}
function post(routes, path, body) {
  return routes.get("POST " + path)(new Request("http://local" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  return undefined;
}
function snapshotTree(dir) {
  const out = {};
  (function walk(d, rel) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name); const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(p, r);
      else out[r] = readFileSync(p, "utf8");
    }
  })(dir, "");
  return out;
}
function treesEqual(a, b) {
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => b[k] === a[k]);
}

/** Build a project tree that resembles a real one (src, .git, unicode, deep nesting). */
function buildProject(dir) {
  mkdirSync(join(dir, "src", "deep", "deeper"), { recursive: true });
  mkdirSync(join(dir, ".git", "objects", "ab"), { recursive: true });
  mkdirSync(join(dir, "данные"), { recursive: true });
  writeFileSync(join(dir, "src", "main.js"), "console.log('v1')\n");
  writeFileSync(join(dir, "src", "deep", "deeper", "leaf.txt"), "leaf-v1");
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "objects", "ab", "cdef"), "fake-object-1");
  writeFileSync(join(dir, "данные", "файл.txt"), "привет-мир");
  writeFileSync(join(dir, "untracked.log"), "log-v1");
  writeFileSync(join(dir, "package.json"), '{"name":"demo","version":"1.0.0"}');
}

const root = mkdtempSync(join(tmpdir(), "dsh-pb-ext-"));

// ============================================================ 1. full restore
{
  const project = join(root, "proj-a");
  buildProject(project);
  const before = snapshotTree(project);

  const { routes, listeners } = await wire(["Да, сделать бэкап"]);
  const sid = "ext-full-" + Date.now();
  listeners.get("agent/created")({ agent: { id: sid, session: { header: { cwd: project } } } });
  const mine = await waitFor(async () => (await listItems(routes)).find((i) => i.sessionId === sid));
  check("1.1 backup created", !!mine);
  check("1.2 backup tree identical to original", !!mine && treesEqual(before, snapshotTree(join(mine.backupDir, "project"))));

  // heavy mutation: edit, add, delete, delete a dir, touch .git
  writeFileSync(join(project, "src", "main.js"), "console.log('v2-BROKEN')\n");
  writeFileSync(join(project, "src", "added.js"), "new file");
  rmSync(join(project, "src", "deep"), { recursive: true });
  rmSync(join(project, "данные", "файл.txt"));
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/other\n");
  rmSync(join(project, "untracked.log"));

  const res = await post(routes, "/api/project-backup/restore", { sessionId: sid });
  check("1.3 restore returns ok", res.status === 200 && (await res.json()).restored === true);
  check("1.4 restored tree identical to original", treesEqual(before, snapshotTree(project)));
  check("1.5 unicode file content intact", readFileSync(join(project, "данные", "файл.txt"), "utf8") === "привет-мир");
  check("1.6 .git/HEAD restored", readFileSync(join(project, ".git", "HEAD"), "utf8") === "ref: refs/heads/main\n");
  check("1.7 no leftover .backup-old dirs", !readdirSync(root).some((n) => n.includes(".backup-old")));
  check("1.8 backup removed after restore", !(await listItems(routes)).some((i) => i.sessionId === sid));
}

// ================================== 2. restore after "process restart" (meta.json)
{
  const project = join(root, "proj-b");
  buildProject(project);
  const { routes, listeners } = await wire(["Да, сделать бэкап"]);
  const sid = "ext-restart-" + Date.now();
  listeners.get("agent/created")({ agent: { id: sid, session: { header: { cwd: project } } } });
  const mine = await waitFor(async () => (await listItems(routes)).find((i) => i.sessionId === sid));
  check("2.1 backup created", !!mine);

  // Simulate a DSH restart: fresh module instance -> empty in-memory `backups` map.
  const fresh = await wire(["Да, сделать бэкап"]);
  writeFileSync(join(project, "src", "main.js"), "broken after restart");
  const res = await post(fresh.routes, "/api/project-backup/restore", { sessionId: sid });
  check("2.2 restore from meta.json works after restart", res.status === 200);
  check("2.3 content restored after restart", readFileSync(join(project, "src", "main.js"), "utf8") === "console.log('v1')\n");
}

// ============================================================ 3. delete route
{
  const project = join(root, "proj-c");
  buildProject(project);
  const { routes, listeners } = await wire(["Да, сделать бэкап"]);
  const sid = "ext-delete-" + Date.now();
  listeners.get("agent/created")({ agent: { id: sid, session: { header: { cwd: project } } } });
  const mine = await waitFor(async () => (await listItems(routes)).find((i) => i.sessionId === sid));
  check("3.1 backup created", !!mine);
  const res = await post(routes, "/api/project-backup/delete", { sessionId: sid });
  check("3.2 delete returns deleted:true", res.status === 200 && (await res.json()).deleted === true);
  check("3.3 backup dir removed from disk", !existsSync(mine.backupDir));
  check("3.4 project untouched by delete", treesEqual(snapshotTree(project), snapshotTree(project)) && existsSync(join(project, "src", "main.js")));
}

// ============================================================ 4. prompt answers
{
  const project = join(root, "proj-d");
  buildProject(project);
  // "Нет, пропустить"
  const skip = await wire(["Нет, пропустить"]);
  const sidSkip = "ext-skip-" + Date.now();
  skip.listeners.get("agent/created")({ agent: { id: sidSkip, session: { header: { cwd: project } } } });
  await new Promise((r) => setTimeout(r, 600));
  check("4.1 'Нет, пропустить' -> no backup", !(await listItems(skip.routes)).some((i) => i.sessionId === sidSkip));

  // "Нет, и не спрашивать для этого проекта" -> persisted; new process never prompts
  let asked = 0;
  const plugin = await import(PLUGIN + "?never=" + Date.now());
  const routes = new Map(); const listeners = new Map();
  const ctx = {
    on(e, f) { listeners.set(e, f); return () => {}; },
    userQuestions: { async ask() { asked++; return { answers: [{ selected: ["Нет, и не спрашивать для этого проекта"] }] }; } },
    connection: { fetch: { register(r) { routes.set(r.methods[0] + " " + r.path, r.fetch); return () => {}; } } },
  };
  plugin.apply(ctx, { enabled: { get: () => true } });
  const p2 = join(root, "proj-never");
  buildProject(p2);
  const sidNever = "ext-never-" + Date.now();
  listeners.get("agent/created")({ agent: { id: sidNever, session: { header: { cwd: p2 } } } });
  await new Promise((r) => setTimeout(r, 600));
  check("4.2 first run asked once", asked === 1);
  check("4.3 project persisted to skipped file", existsSync(SKIPPED_FILE) && readFileSync(SKIPPED_FILE, "utf8").includes("proj-never"));

  // fresh module instance (restart): must NOT ask again
  let asked2 = 0;
  const plugin2 = await import(PLUGIN + "?never2=" + Date.now());
  const listeners2 = new Map();
  const ctx2 = {
    on(e, f) { listeners2.set(e, f); return () => {}; },
    userQuestions: { async ask() { asked2++; return { answers: [{ selected: ["Да, сделать бэкап"] }] }; } },
    connection: { fetch: { register() { return () => {}; } } },
  };
  plugin2.apply(ctx2, { enabled: { get: () => true } });
  listeners2.get("agent/created")({ agent: { id: sidNever + "-2", session: { header: { cwd: p2 } } } });
  await new Promise((r) => setTimeout(r, 600));
  check("4.4 after restart project is not asked again", asked2 === 0);
}

// ============================================ 5. multiple sessions, one project
{
  const project = join(root, "proj-e");
  buildProject(project);
  const { routes, listeners } = await wire(["Да, сделать бэкап"]);
  const s1 = "ext-multi-1-" + Date.now();
  const s2 = "ext-multi-2-" + Date.now();
  listeners.get("agent/created")({ agent: { id: s1, session: { header: { cwd: project } } } });
  listeners.get("agent/created")({ agent: { id: s2, session: { header: { cwd: project } } } });
  await waitFor(async () => (await listItems(routes)).filter((i) => i.sessionId === s1 || i.sessionId === s2).length === 2 ? true : undefined);
  const items = await listItems(routes);
  check("5.1 two sessions of one project -> two backups",
    items.some((i) => i.sessionId === s1) && items.some((i) => i.sessionId === s2));
  // cleanup
  await post(routes, "/api/project-backup/delete", { sessionId: s1 });
  await post(routes, "/api/project-backup/delete", { sessionId: s2 });
}

// missing sessionId validation
{
  const { routes } = await wire(["Нет, пропустить"]);
  const res = await post(routes, "/api/project-backup/restore", {});
  check("6.1 restore without sessionId -> 500", res.status === 500 && /sessionId is required/.test((await res.json()).error));
}

// restore skipped-projects file to its prior content
if (skippedBackup !== null) writeFileSync(SKIPPED_FILE, skippedBackup);

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
