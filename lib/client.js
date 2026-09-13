window.__ModuleLoader__.load({
	id: "dsh-review",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/index.ts
		/** Stable browser-plugin name. */
		const name = "dsh-review-client";
		/**
		* Client services required.
		*
		* `sessions` is the client Session Controller that owns which session is
		* displayed. Declaring it here means cordis activates this plugin only once that
		* controller exists, so `apply` never has to handle its absence.
		*/
		const inject = ["sessions"];
		/** Host route serving the focus instruction. */
		const STATUS_PATH = "/dsh-review/status";
		/** How often to ask the host whether it wants a different session displayed. */
		const POLL_INTERVAL_MS = 1500;
		/**
		* Apply the client half.
		*
		* The body is wrapped so that an API-level breaking change degrades to a console
		* error rather than throwing into the DSH loader and raising the "Failed to load
		* plugins" banner: the review workflow lives entirely on the host, and losing the
		* automatic switch only costs the user one manual click in the session list.
		*/
		function apply(ctx) {
			try {
				const sessions = ctx.get("sessions");
				if (sessions === void 0) return;
				/** The newest focus token this page has already acted on. */
				let actedToken = 0;
				let disposed = false;
				let timer;
				/** Ask the host for the current instruction and act on a new one. */
				const poll = async () => {
					if (disposed) return;
					try {
						const response = await fetch(STATUS_PATH, {
							headers: { Accept: "application/json" },
							cache: "no-store"
						});
						if (!response.ok) return;
						const next = (await response.json()).focus;
						if (next === void 0 || next.token <= actedToken) return;
						if (!sessions.list.getSnapshot().ids.includes(next.sessionId)) return;
						actedToken = next.token;
						sessions.open(next.sessionId);
					} catch {}
				};
				/** Re-arm after each attempt, so a slow host cannot pile up requests. */
				const schedule = () => {
					if (disposed) return;
					timer = setTimeout(() => {
						poll().finally(schedule);
					}, POLL_INTERVAL_MS);
				};
				poll().finally(schedule);
				ctx.effect(() => () => {
					disposed = true;
					if (timer !== void 0) clearTimeout(timer);
				}, "dsh-review-client: focus poller");
			} catch (error) {
				console.error("[dsh-review] client half failed to load (review commands unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
