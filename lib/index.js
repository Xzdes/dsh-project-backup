/**
 * dsh-project-backup — full project snapshot and rollback.
 *
 * When a new session starts, the plugin asks the user whether to back up the
 * entire project directory. The snapshot is stored outside the project at
 * S:\dsh-backups\<project-name>\<session-id> (configurable). A web button lets
 * the user restore the project to the saved state at any time. The backup is
 * deleted after a successful restore.
 */
import { cp, mkdir, rm, writeFile, readFile, rename } from "node:fs/promises";
import { basename, join, resolve as resolvePath } from "node:path";
import z from "@deepseek-ai/schemastery";

const name = "project-backup";

const inject = ["userQuestions", "connection"];

const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
});

/** In-memory index of backups created by this process. */
const backups = new Map();
/** Sessions the user explicitly chose to skip. */
const skipped = new Set();
/** Projects the user asked to never prompt for again. */
const skippedCwd = new Set();
const skippedProjectsFile = "S:\\dsh-backups\\.skipped-projects.json";

let loadSkippedPromise = loadSkippedProjects();

async function loadSkippedProjects() {
  try {
    const content = await readFile(skippedProjectsFile, "utf8");
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      for (const path of data) {
        if (typeof path === "string") skippedCwd.add(path);
      }
    }
  } catch {
    // ignore missing or malformed file
  }
}

async function saveSkippedProjects() {
  try {
    await mkdir("S:\\dsh-backups", { recursive: true });
    await writeFile(skippedProjectsFile, JSON.stringify([...skippedCwd], null, 2), "utf8");
  } catch (error) {
    console.error("[dsh-project-backup] failed to save skipped projects:", error);
  }
}

function getProjectName(cwd) {
  return basename(cwd || "project").replace(/[\/\\]/g, "_") || "project";
}

function getBackupDir(backupRoot, projectName, sessionId) {
  return join(resolvePath(backupRoot), projectName, String(sessionId));
}

async function saveMeta(backupDir, meta) {
  await writeFile(join(backupDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
}

async function readMetaIfExists(backupDir) {
  try {
    const content = await readFile(join(backupDir, "meta.json"), "utf8");
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

async function copyTree(src, dest) {
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true, force: true });
}

async function createBackup({ backupRoot, cwd, sessionId }) {
  const projectName = getProjectName(cwd);
  const backupDir = getBackupDir(backupRoot, projectName, sessionId);
  const backupPath = join(backupDir, "project");

  await mkdir(backupDir, { recursive: true });
  await copyTree(cwd, backupPath);

  const meta = {
    projectName,
    cwd,
    sessionId: String(sessionId),
    createdAt: Date.now(),
  };
  await saveMeta(backupDir, meta);

  const record = { projectName, cwd, sessionId: String(sessionId), backupDir, backupPath, createdAt: meta.createdAt };
  backups.set(String(sessionId), record);
  return record;
}

async function restoreBackup({ backupRoot, sessionId }) {
  sessionId = String(sessionId);
  let record = backups.get(sessionId);
  if (!record) {
    const meta = await findBackupMeta(backupRoot, sessionId);
    if (!meta) throw new Error(`Backup not found for session ${sessionId}`);
    record = {
      projectName: meta.projectName,
      cwd: meta.cwd,
      sessionId: meta.sessionId,
      backupDir: getBackupDir(backupRoot, meta.projectName, meta.sessionId),
      backupPath: join(getBackupDir(backupRoot, meta.projectName, meta.sessionId), "project"),
      createdAt: meta.createdAt,
    };
  }

  const cwd = record.cwd;
  const cwdOld = `${cwd}.backup-old-${Date.now()}`;

  await rename(cwd, cwdOld);
  try {
    await copyTree(record.backupPath, cwd);
  } catch (error) {
    try {
      await rm(cwd, { recursive: true, force: true });
    } catch {}
    await rename(cwdOld, cwd);
    throw error;
  }

  await rm(cwdOld, { recursive: true, force: true });
  await deleteBackup({ backupRoot, sessionId });
  return { restored: true };
}

async function deleteBackup({ backupRoot, sessionId }) {
  sessionId = String(sessionId);
  const record = backups.get(sessionId);
  if (record) {
    await rm(record.backupDir, { recursive: true, force: true });
    backups.delete(sessionId);
    return { deleted: true };
  }

  const meta = await findBackupMeta(backupRoot, sessionId);
  if (meta) {
    const backupDir = getBackupDir(backupRoot, meta.projectName, meta.sessionId);
    await rm(backupDir, { recursive: true, force: true });
    return { deleted: true };
  }

  return { deleted: false, reason: "not found" };
}

async function findBackupMeta(backupRoot, sessionId) {
  const root = resolvePath(backupRoot);
  try {
    const projects = await readDirNames(root);
    for (const project of projects) {
      const backupDir = join(root, project, String(sessionId));
      const meta = await readMetaIfExists(backupDir);
      if (meta && String(meta.sessionId) === String(sessionId)) return meta;
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function readDirNames(path) {
  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(path, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function listBackups(backupRoot) {
  const items = [];
  const root = resolvePath(backupRoot);
  try {
    const projects = await readDirNames(root);
    for (const project of projects) {
      const projectDir = join(root, project);
      const sessions = await readDirNames(projectDir);
      for (const sessionId of sessions) {
        const backupDir = join(projectDir, sessionId);
        const meta = await readMetaIfExists(backupDir);
        if (meta) {
          items.push({
            projectName: meta.projectName,
            sessionId: meta.sessionId,
            cwd: meta.cwd,
            createdAt: meta.createdAt,
            backupDir,
          });
        }
      }
    }
  } catch {
    // ignore
  }
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

async function promptAndBackup(ctx, backupRoot, agent) {
  const sessionId = agent?.id;
  const cwd = agent?.session?.header?.cwd;
  if (!sessionId || !cwd) return;

  const projectPath = resolvePath(cwd);

  await loadSkippedPromise;
  if (backups.has(String(sessionId)) || skipped.has(String(sessionId))) return;
  if (skippedCwd.has(projectPath)) return;

  try {
    const answer = await ctx.userQuestions.ask({
      questions: [
        {
          id: "backup",
          header: "Резервная копия проекта",
          question: "Сделать полный бэкап проекта перед началом работы с нейросетью?",
          options: [
            { label: "Да, сделать бэкап", description: "Сохранить полную копию проекта" },
            { label: "Нет, пропустить", description: "Не делать бэкап для этой сессии" },
            { label: "Нет, и не спрашивать для этого проекта", description: "Больше не предлагать бэкап в этом проекте" },
          ],
        },
      ],
      agent,
    });

    const item = answer?.answers?.[0];
    const selected = item?.selected?.[0];
    const custom = typeof item?.custom === "string" ? item.custom.trim() : "";
    const yesLabels = ["Да, сделать бэкап"];
    const yesCustom = /^\s*(да|yes|y|сделать|backup|1)\s*$/i;
    const wantsBackup = yesLabels.includes(selected) || yesCustom.test(custom);
    if (wantsBackup) {
      await createBackup({ backupRoot, cwd, sessionId });
    } else if (selected === "Нет, и не спрашивать для этого проекта") {
      skippedCwd.add(projectPath);
      await saveSkippedProjects();
    } else {
      skipped.add(String(sessionId));
    }
  } catch (error) {
    console.error("[dsh-project-backup] backup prompt/creation failed:", error);
  }
}

function registerRoutes(ctx, backupRoot) {
  const disposers = [];

  disposers.push(
    ctx.connection.fetch.register({
      path: "/api/project-backup/list",
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async () => {
        try {
          const items = await listBackups(backupRoot);
          return jsonResponse({ items });
        } catch (error) {
          return errorResponse(error);
        }
      },
    })
  );

  disposers.push(
    ctx.connection.fetch.register({
      path: "/api/project-backup/restore",
      methods: ["POST"],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          const body = await request.json();
          if (!body?.sessionId) throw new Error("sessionId is required");
          const result = await restoreBackup({ backupRoot, sessionId: body.sessionId });
          return jsonResponse(result);
        } catch (error) {
          return errorResponse(error);
        }
      },
    })
  );

  disposers.push(
    ctx.connection.fetch.register({
      path: "/api/project-backup/delete",
      methods: ["POST"],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          const body = await request.json();
          if (!body?.sessionId) throw new Error("sessionId is required");
          const result = await deleteBackup({ backupRoot, sessionId: body.sessionId });
          return jsonResponse(result);
        } catch (error) {
          return errorResponse(error);
        }
      },
    })
  );

  return () => disposers.forEach((d) => d());
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(error) {
  const message = error instanceof Error ? error.message : String(error);
  return new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}

function apply(ctx, config) {
  let disposers = [];
  const backupRoot = "S:\\dsh-backups";

  const sync = () => {
    const enabled = config.enabled.get() !== false;
    if (enabled && disposers.length === 0) {
      const onAgentCreated = ({ agent }) => {
        promptAndBackup(ctx, backupRoot, agent).catch((error) => {
          console.error("[dsh-project-backup] promptAndBackup error:", error);
        });
      };
      const disposeAgentListener = ctx.on("agent/created", onAgentCreated);

      const disposeRoutes = registerRoutes(ctx, backupRoot);

      const onSessionDisposed = (session) => {
        if (!session?.id) return;
        deleteBackup({ backupRoot, sessionId: session.id }).catch(() => {});
      };
      const disposeSessionListener = ctx.on("session/disposed", onSessionDisposed);

      const onSessionStop = (request) => {
        if (!request?.sessionId) return;
        deleteBackup({ backupRoot, sessionId: request.sessionId }).catch(() => {});
      };
      const disposeStopListener = ctx.on("workspace/session-stop", onSessionStop);

      disposers.push(() => {
        disposeAgentListener();
        disposeRoutes();
        disposeSessionListener();
        disposeStopListener();
      });
    } else if (!enabled && disposers.length > 0) {
      for (const dispose of disposers) dispose();
      disposers = [];
    }
  };

  ctx.on("loader/volatile-update", sync);
  sync();
}

const meta = {
  title: {
    en: "Project Backup",
    ru: "Резервная копия проекта",
    zh: "项目备份",
  },
  description: {
    en: "Back up the whole project before a session starts, then restore it with one click if the model's changes go wrong.",
    ru: "Делает полную копию проекта перед началом сессии и восстанавливает состояние до начала работы с нейросетью одной кнопкой.",
    zh: "在会话开始前备份整个项目，需要时一键回滚。",
  },
};

export { Config, apply, inject, meta, name };
