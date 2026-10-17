/**
 * dsh-project-backup — web client half.
 *
 * Shows project backups inside the Workspaces sidebar:
 *  - a 💾 row action on every session row that has a backup
 *    (`sidebar.workspaces.session.row.action`),
 *  - a "Бэкап проекта…" entry in the session context menu
 *    (`sidebar.workspaces.session.menu.item`),
 *  - a compact button in the composer tool row (`conversation.input.right`).
 *
 * All of them open one modal dialog (registered in `shell.overlay`) with
 * "Восстановить" and "Удалить" actions — window.confirm/prompt are not used
 * because Electron webviews block them.
 *
 * Hand-written in the DSH lazy-CJS bundle format; no build step.
 */
window.__ModuleLoader__.load({
	id: "dsh-project-backup",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		/** Host UI primitives (Modal/Button/MenuItemButton/icons); optional. */
		var primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (_) { /* fall back to plain elements */ }

		/** Services this plugin touches — the fiber starts once all are active. */
		var inject = ["slots", "locale"];

		/** UI dictionaries, keyed by locale id. */
		var DICTS = {
			en: {
				title: "Project backup",
				description: "A full copy of the project made before the session started.",
				restore: "Restore",
				delete: "Delete",
				close: "Close",
				cancel: "Cancel",
				confirmRestore: "Restore the project to the backup state? All changes made after the backup will be lost.",
				confirmDelete: "Delete this backup permanently?",
				yesRestore: "Yes, restore",
				yesDelete: "Yes, delete",
				working: "Working…",
				restored: "Project restored",
				deleted: "Backup deleted",
				empty: "No backups yet.",
				errorHint: "Backup error (click to retry)",
				rowTooltip: "Project backup — restore or delete",
				menuItem: "Project backup…",
				composer: "Backups",
				created: "Created",
				session: "Session",
				listTitle: "Project backups",
			},
			ru: {
				title: "Бэкап проекта",
				description: "Полная копия проекта, сделанная перед началом сессии.",
				restore: "Восстановить",
				delete: "Удалить",
				close: "Закрыть",
				cancel: "Отмена",
				confirmRestore: "Вернуть проект к состоянию бэкапа? Все изменения после него будут потеряны.",
				confirmDelete: "Удалить этот бэкап безвозвратно?",
				yesRestore: "Да, восстановить",
				yesDelete: "Да, удалить",
				working: "Выполняется…",
				restored: "Проект восстановлен",
				deleted: "Бэкап удалён",
				empty: "Бэкапов пока нет.",
				errorHint: "Ошибка бэкапа (нажмите, чтобы повторить)",
				rowTooltip: "Бэкап проекта — восстановить или удалить",
				menuItem: "Бэкап проекта…",
				composer: "Бэкапы",
				created: "Создан",
				session: "Сессия",
				listTitle: "Бэкапы проектов",
			},
			zh: {
				title: "项目备份",
				description: "会话开始前创建的项目完整副本。",
				restore: "恢复",
				delete: "删除",
				close: "关闭",
				cancel: "取消",
				confirmRestore: "将项目恢复到备份状态？备份之后的所有更改都将丢失。",
				confirmDelete: "永久删除此备份？",
				yesRestore: "是，恢复",
				yesDelete: "是，删除",
				working: "执行中…",
				restored: "项目已恢复",
				deleted: "备份已删除",
				empty: "还没有备份。",
				errorHint: "备份出错（点击重试）",
				rowTooltip: "项目备份 — 恢复或删除",
				menuItem: "项目备份…",
				composer: "备份",
				created: "创建于",
				session: "会话",
				listTitle: "项目备份",
			},
		};

		// ---------------------------------------------------------------- API

		function apiList() {
			return fetch("/api/project-backup/list").then(function (res) {
				if (!res.ok) throw new Error("list failed: " + res.status);
				return res.json();
			});
		}

		function apiPost(path, sessionId) {
			return fetch(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: sessionId }),
			}).then(function (res) {
				if (!res.ok) {
					return res.json().catch(function () { return {}; }).then(function (body) {
						throw new Error(body.error || "request failed: " + res.status);
					});
				}
				return res.json();
			});
		}

		function apiRestore(sessionId) { return apiPost("/api/project-backup/restore", sessionId); }
		function apiDelete(sessionId) { return apiPost("/api/project-backup/delete", sessionId); }

		// -------------------------------------------------- shared state stores

		function createStore(initial) {
			return { state: initial, listeners: new Set() };
		}
		function storeSet(store, next) {
			store.state = next;
			store.listeners.forEach(function (fn) {
				try { fn(); } catch (_) { /* listener errors are isolated */ }
			});
		}
		function storeSubscribe(store, fn) {
			store.listeners.add(fn);
			return function () { store.listeners.delete(fn); };
		}
		function useStore(store) {
			return React.useSyncExternalStore(
				function (fn) { return storeSubscribe(store, fn); },
				function () { return store.state; }
			);
		}

		/** Backup list, refreshed on a shared poller started in apply(). */
		var backupsStore = createStore({ phase: "loading", items: [], message: "" });

		function refreshBackups() {
			return apiList().then(function (data) {
				storeSet(backupsStore, { phase: "ready", items: data.items || [], message: "" });
			}, function (error) {
				storeSet(backupsStore, {
					phase: "error",
					items: backupsStore.state.items,
					message: String((error && error.message) || error),
				});
			});
		}

		function findBackup(items, sessionId) {
			if (!sessionId) return undefined;
			return items.find(function (item) { return String(item.sessionId) === String(sessionId); });
		}

		/** Dialog visibility: which session's backup the dialog shows (null = list). */
		var dialogStore = createStore({ open: false, sessionId: null });
		function openDialog(sessionId) {
			storeSet(dialogStore, { open: true, sessionId: sessionId || null });
		}
		function closeDialog() {
			storeSet(dialogStore, { open: false, sessionId: null });
		}

		// -------------------------------------------------------------- helpers

		function icon(name, size, fallback) {
			var C = primitives && primitives[name];
			if (C) return h(C, { size: size || 14 });
			return h("span", { "aria-hidden": "true" }, fallback);
		}

		function formatDate(ts) {
			try { return new Date(ts).toLocaleString(); } catch (_) { return String(ts); }
		}

		function shortId(id) {
			var s = String(id || "");
			return s.length > 10 ? s.slice(0, 10) + "…" : s;
		}

		/** Standalone modal fallback when ui-primitives is unavailable. */
		function FallbackModal(props) {
			React.useEffect(function () {
				if (!props.open) return undefined;
				var onKey = function (e) { if (e.key === "Escape") props.onClose(); };
				document.addEventListener("keydown", onKey);
				return function () { document.removeEventListener("keydown", onKey); };
			}, [props.open, props.onClose]);
			if (!props.open) return null;
			return h("div", {
				style: {
					position: "fixed", inset: 0, zIndex: 10000,
					background: "rgba(0,0,0,0.45)",
					display: "flex", alignItems: "center", justifyContent: "center",
				},
				onClick: props.onClose,
			}, h("div", {
				role: "dialog",
				"aria-modal": "true",
				"aria-label": props.title,
				style: {
					background: "var(--dsw-alias-bg-module-platform, #1e1f24)",
					color: "inherit",
					borderRadius: "12px",
					padding: "16px 20px",
					minWidth: "340px",
					maxWidth: "520px",
					boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
				},
				onClick: function (e) { e.stopPropagation(); },
			}, [
				h("h2", { key: "t", style: { margin: "0 0 8px", fontSize: "15px" } }, props.title),
				h("div", { key: "b" }, props.children),
				props.footer ? h("div", {
					key: "f",
					style: { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "16px" },
				}, props.footer) : null,
			]));
		}

		var ModalComponent = (primitives && primitives.Modal) || FallbackModal;

		var BTN = {
			font: "inherit",
			fontSize: "12px",
			lineHeight: "18px",
			padding: "4px 12px",
			borderRadius: "8px",
			cursor: "pointer",
			color: "inherit",
			border: "1px solid rgba(127,127,127,0.4)",
			background: "transparent",
		};
		var BTN_PRIMARY = Object.assign({}, BTN, {
			border: "1px solid transparent",
			background: "rgba(99, 140, 255, 0.3)",
		});
		var BTN_DANGER = Object.assign({}, BTN, {
			border: "1px solid rgba(255, 99, 99, 0.6)",
			background: "rgba(255, 99, 99, 0.15)",
		});

		// ------------------------------------------------------ dialog contents

		/**
		 * One backup row with two-step Restore / Delete actions.
		 * Local confirm state avoids window.confirm (blocked in Electron).
		 */
		function BackupRow(props) {
			var item = props.item;
			var t = props.t;
			var pair = React.useState(null); // null | "restore" | "delete" | "busy"
			var confirm = pair[0];
			var setConfirm = pair[1];
			var errPair = React.useState("");
			var error = errPair[0];
			var setError = errPair[1];

			function run(action) {
				setConfirm("busy");
				setError("");
				var call = action === "restore" ? apiRestore(item.sessionId) : apiDelete(item.sessionId);
				call.then(function () {
					setConfirm(null);
					refreshBackups();
					if (props.onDone) props.onDone(action);
				}, function (e) {
					setConfirm(null);
					setError(String((e && e.message) || e));
				});
			}

			var children = [
				h("div", { key: "info", style: { minWidth: 0, flex: 1 } }, [
					h("div", { key: "n", style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
						item.projectName || "?"),
					h("div", { key: "d", style: { opacity: 0.65, fontSize: "12px" } },
						t("created") + ": " + formatDate(item.createdAt)),
					h("div", { key: "s", style: { opacity: 0.45, fontSize: "11px", fontFamily: "monospace" } },
						t("session") + ": " + shortId(item.sessionId)),
				]),
			];

			if (confirm === null) {
				children.push(h("div", { key: "actions", style: { display: "flex", gap: "6px", flexShrink: 0 } }, [
					h("button", {
						key: "r", type: "button", style: BTN_PRIMARY,
						onClick: function () { setConfirm("restore"); },
					}, t("restore")),
					h("button", {
						key: "d", type: "button", style: BTN_DANGER,
						onClick: function () { setConfirm("delete"); },
					}, t("delete")),
				]));
			} else if (confirm === "busy") {
				children.push(h("span", { key: "busy", style: { opacity: 0.7 } }, t("working")));
			} else {
				children.push(h("div", { key: "confirm", style: { display: "flex", gap: "6px", flexShrink: 0, alignItems: "center" } }, [
					h("button", {
						key: "yes", type: "button",
						style: confirm === "restore" ? BTN_PRIMARY : BTN_DANGER,
						"data-modal-autofocus": true,
						onClick: function () { run(confirm); },
					}, confirm === "restore" ? t("yesRestore") : t("yesDelete")),
					h("button", {
						key: "no", type: "button", style: BTN,
						onClick: function () { setConfirm(null); },
					}, t("cancel")),
				]));
			}

			return h("div", {
				style: {
					display: "flex", gap: "12px", alignItems: "center",
					padding: "8px 0",
					borderTop: "1px solid rgba(127,127,127,0.15)",
					flexWrap: "wrap",
				},
			}, [
				h("div", { key: "wrap", style: { display: "flex", gap: "12px", alignItems: "center", width: "100%" } }, children),
				error ? h("div", { key: "err", style: { width: "100%", color: "#ff7b72", fontSize: "12px" } }, error) : null,
				confirm === "restore" ? h("div", { key: "warn", style: { width: "100%", opacity: 0.75, fontSize: "12px" } }, t("confirmRestore")) : null,
				confirm === "delete" ? h("div", { key: "warn", style: { width: "100%", opacity: 0.75, fontSize: "12px" } }, t("confirmDelete")) : null,
			]);
		}

		/** The shell.overlay entry: renders the backup dialog when open. */
		function BackupDialogHost(props) {
			var t = props.t;
			var dialog = useStore(dialogStore);
			var backups = useStore(backupsStore);
			var notePair = React.useState("");
			var notice = notePair[0];
			var setNotice = notePair[1];

			React.useEffect(function () {
				if (!notice) return undefined;
				var id = setTimeout(function () { setNotice(""); }, 2500);
				return function () { clearTimeout(id); };
			}, [notice, setNotice]);

			if (!dialog.open) return null;

			var items = backups.items || [];
			var focused = findBackup(items, dialog.sessionId);
			var list = focused ? [focused] : items;

			var body;
			if (backups.phase === "error") {
				body = h("div", null, [
					h("div", { key: "e", style: { color: "#ff7b72", marginBottom: "8px" } }, backups.message),
					h("button", {
						key: "retry", type: "button", style: BTN,
						onClick: function () { refreshBackups(); },
					}, "↻"),
				]);
			} else if (list.length === 0) {
				body = h("div", { style: { opacity: 0.7 } }, t("empty"));
			} else {
				body = h("div", null, list.map(function (item) {
					return h(BackupRow, {
						key: String(item.sessionId),
						item: item,
						t: t,
						onDone: function (action) {
							setNotice(action === "restore" ? t("restored") : t("deleted"));
							if (action === "restore") closeDialog();
						},
					});
				}));
			}

			return h(ModalComponent, {
				open: true,
				onClose: closeDialog,
				title: focused ? t("title") : t("listTitle"),
				closeLabel: t("close"),
				description: focused ? t("description") : undefined,
				footer: h("button", { type: "button", style: BTN, onClick: closeDialog }, t("close")),
			}, [
				notice ? h("div", { key: "ok", style: { color: "#7ee787", marginBottom: "8px" } }, "✓ " + notice) : null,
				body,
			]);
		}

		// ----------------------------------------------------- slot entry points

		/** Session row action in the Workspaces sidebar (only when a backup exists). */
		function BackupRowAction(props) {
			var t = props.t;
			var backups = useStore(backupsStore);
			var backup = findBackup(backups.items, props.sessionId);
			if (!backup) return null;

			var button = h("button", {
				type: "button",
				"aria-label": t("rowTooltip"),
				onClick: function (e) {
					e.stopPropagation();
					openDialog(props.sessionId);
				},
				style: {
					display: "inline-flex", alignItems: "center", justifyContent: "center",
					width: "24px", height: "24px", padding: 0,
					border: "none", borderRadius: "6px",
					background: "transparent", color: "inherit",
					cursor: "pointer", opacity: 0.75,
				},
			}, icon("IconDatabaseOutlineRegular", 14, "💾"));

			if (primitives && primitives.Tooltip) {
				return h(primitives.Tooltip, { label: t("rowTooltip"), side: "bottom", align: "end", delayMs: 500 }, button);
			}
			return h("span", { title: t("rowTooltip") }, button);
		}

		function useNoopMenuState() { return React.useState(false); }

		/** Session "..." menu entry in the Workspaces sidebar. */
		function BackupMenuItem(props) {
			var t = props.t;
			var backups = useStore(backupsStore);
			var backup = findBackup(backups.items, props.sessionId);
			var menuState = (props.useMenuOpenState || useNoopMenuState)();
			var setMenuOpen = menuState[1];
			if (!backup) return null;

			var onSelect = function () {
				setMenuOpen(false);
				openDialog(props.sessionId);
			};

			if (primitives && primitives.MenuItemButton) {
				return h(primitives.MenuItemButton, {
					icon: icon("IconDatabaseOutlineRegular", 14, "💾"),
					onSelect: onSelect,
				}, t("menuItem"));
			}
			return h("button", { type: "button", onClick: onSelect }, t("menuItem"));
		}

		/** Composer tool row button: opens the dialog with the full backup list. */
		function BackupComposerButton(props) {
			var t = props.t;
			var backups = useStore(backupsStore);

			if (backups.phase === "loading") return null;

			if (backups.phase === "error") {
				return h("button", {
					type: "button",
					title: t("errorHint") + ": " + backups.message,
					onClick: function () { refreshBackups(); },
					style: {
						font: "inherit", fontSize: "12px", lineHeight: "16px",
						padding: "2px 8px", borderRadius: "999px", cursor: "pointer",
						color: "inherit", whiteSpace: "nowrap",
						border: "1px dashed currentColor", background: "transparent", opacity: 0.6,
					},
				}, "💾 ✕ " + backups.message.slice(0, 40));
			}

			var count = (backups.items || []).length;
			if (count === 0) return null;

			return h("button", {
				type: "button",
				title: t("rowTooltip"),
				onClick: function () { openDialog(null); },
				style: {
					font: "inherit", fontSize: "12px", lineHeight: "16px",
					padding: "2px 8px", borderRadius: "999px", cursor: "pointer",
					color: "inherit", whiteSpace: "nowrap",
					border: "1px solid currentColor", background: "transparent",
				},
			}, "💾 " + t("composer") + " (" + count + ")");
		}

		// ----------------------------------------------------------------- apply

		function apply(ctx) {
			var slots = ctx.get("slots");
			var locale = ctx.get("locale");
			if (!slots) return;

			if (locale) {
				ctx.effect(function () {
					return locale.register("projectBackup", DICTS);
				}, "project-backup: dictionaries");
			}
			var t = locale
				? locale.bind("projectBackup")
				: function (key) { return DICTS.en[key] || key; };

			// Shared backup-list poller for every component this plugin renders.
			ctx.effect(function () {
				refreshBackups();
				var timer = setInterval(refreshBackups, 4000);
				return function () { clearInterval(timer); };
			}, "project-backup: backup list polling");

			ctx.slots.inject("sidebar.workspaces.session.row.action", function () {
				return ctx.slots.register({
					name: "sidebar.workspaces.session.row.action",
					id: "project-backup",
					order: 50,
					label: function () { return t("title"); },
				}, function (props) { return h(BackupRowAction, Object.assign({}, props, { t: t })); });
			});

			ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
				return ctx.slots.register({
					name: "sidebar.workspaces.session.menu.item",
					id: "project-backup",
					order: 500,
					label: function () { return t("menuItem"); },
				}, function (props) { return h(BackupMenuItem, Object.assign({}, props, { t: t })); });
			});

			ctx.slots.inject("conversation.input.right", function () {
				return ctx.slots.register({
					name: "conversation.input.right",
					id: "project-backup",
					order: 90,
					label: function () { return t("composer"); },
				}, function (props) { return h(BackupComposerButton, Object.assign({}, props, { t: t })); });
			});

			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register({
					name: "shell.overlay",
					id: "project-backup",
					order: 100,
					label: function () { return t("title"); },
				}, function (props) { return h(BackupDialogHost, Object.assign({}, props, { t: t })); });
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
