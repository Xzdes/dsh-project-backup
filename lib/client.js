/**
 * dsh-project-backup — web client half.
 *
 * Adds a "Restore to session start" button to the composer tool row
 * (conversation.input.right). It talks to the host over a simple fetch API.
 */
window.__ModuleLoader__.load({
	id: "dsh-project-backup",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");

		var inject = ["slots"];

		function extractSessionId() {
			try {
				var pathname = window.location.pathname;
				var m = pathname.match(/\/(?:sessions?|s)\/([^/]+)/);
				if (m) return m[1];
				m = pathname.match(/\/session-id\/([^/]+)/);
				if (m) return m[1];
				var search = new URLSearchParams(window.location.search);
				var fromQuery = search.get("session") || search.get("sessionId");
				if (fromQuery) return fromQuery;
				var hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
				var fromHash = hash.get("session") || hash.get("sessionId");
				if (fromHash) return fromHash;
			} catch (_) { /* ignore */ }
			return undefined;
		}

		async function apiList() {
			var res = await fetch("/api/project-backup/list");
			if (!res.ok) throw new Error("list failed: " + res.status);
			return res.json();
		}

		async function apiRestore(sessionId) {
			var res = await fetch("/api/project-backup/restore", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId }),
			});
			if (!res.ok) {
				var body = await res.json().catch(function () { return {}; });
				throw new Error(body.error || "restore failed: " + res.status);
			}
			return res.json();
		}

		var BASE_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			gap: "4px",
			font: "inherit",
			fontSize: "12px",
			lineHeight: "16px",
			padding: "2px 8px",
			borderRadius: "999px",
			cursor: "pointer",
			color: "inherit",
			whiteSpace: "nowrap",
			maxWidth: "280px",
			overflow: "hidden",
			textOverflow: "ellipsis",
		};

		function RestoreButton() {
			var statePair = React.useState({ phase: "loading", message: "" });
			var state = statePair[0];
			var setState = statePair[1];

			var sessionId = extractSessionId();

			var load = React.useCallback(function () {
				setState({ phase: "loading", message: "" });
				apiList().then(function (data) {
					var items = data.items || [];
					var matched;
					if (sessionId) {
						matched = items.find(function (item) { return String(item.sessionId) === String(sessionId); });
					}
					setState({ phase: "ready", items: items, matched: matched, message: "" });
				}, function (error) {
					setState({ phase: "error", message: String(error.message || error) });
				});
			}, [sessionId]);

			React.useEffect(function () {
				load();
				var id = setInterval(load, 5000);
				return function () { clearInterval(id); };
			}, [load]);

			var handleRestore = React.useCallback(function (targetSessionId) {
				if (!window.confirm("Вернуть проект к состоянию до начала сессии? Все изменения после бэкапа будут потераны.")) return;
				setState(function (prev) { return Object.assign({}, prev, { phase: "restoring" }); });
				apiRestore(targetSessionId).then(function () {
					setState(function (prev) { return Object.assign({}, prev, { phase: "done", message: "Проект восстановлен" }); });
					setTimeout(function () { load(); }, 1500);
				}, function (error) {
					setState(function (prev) { return Object.assign({}, prev, { phase: "error", message: String(error.message || error) }); });
				});
			}, [load]);

			if (state.phase === "loading") return null;

			if (state.phase === "restoring") {
				return React.createElement("span", { style: BASE_STYLE }, "⏳ Восстановление...");
			}

			if (state.phase === "done") {
				return React.createElement("span", { style: Object.assign({}, BASE_STYLE, { opacity: 0.6 }) }, "✓ Восстановлено");
			}

			if (state.phase === "error") {
				return React.createElement("button", {
					type: "button",
					onClick: load,
					style: Object.assign({}, BASE_STYLE, { border: "1px dashed currentColor", background: "transparent", opacity: 0.6 }),
				}, "Backup ✕ " + state.message.slice(0, 40));
			}

			var matched = state.matched;
			var items = state.items || [];

			if (matched) {
				return React.createElement("button", {
					type: "button",
					onClick: function () { handleRestore(matched.sessionId); },
					title: "Восстановить проект до начала сессии",
					style: Object.assign({}, BASE_STYLE, { border: "1px solid currentColor", background: "rgba(255, 99, 99, 0.12)" }),
				}, " Восстановить до начала");
			}

			if (items.length === 0) return null;

			return React.createElement("button", {
				type: "button",
				onClick: function () {
					var list = items.map(function (item, i) {
						return (i + 1) + ". " + item.projectName + " — " + new Date(item.createdAt).toLocaleString();
					}).join("\n");
					var num = window.prompt("Выберите номер бэкапа для восстановления:\n" + list);
					var index = parseInt(num, 10) - 1;
					if (index >= 0 && index < items.length) {
						handleRestore(items[index].sessionId);
					}
				},
				style: Object.assign({}, BASE_STYLE, { border: "1px solid currentColor", background: "transparent" }),
			}, " Бэкапы (" + items.length + ")");
		}

		function apply(ctx) {
			ctx.inject(["slots"], function (scope) {
				var slots = scope.slots;
				slots.inject("conversation.input.right", function () {
					return slots.register({
						name: "conversation.input.right",
						id: "project-backup",
						order: 90,
						label: function () { return "Backup"; },
					}, RestoreButton);
				});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
