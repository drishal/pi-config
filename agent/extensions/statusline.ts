/**
 * statusline — a two-line footer in the spirit of pi-zentui's starship style,
 * with the workspace half drawn by the real starship binary.
 *
 *   deepseek-v4.1-flash · Opencode Go · max · my-session      watchdog:on · MCP …
 *   .pi on  main [!]                    26k/1.0M · ↑26k ↓27 · cache 92% · $0.004
 *
 * Line 1: model · provider · thinking level (· session name), and the other
 *         extensions' ctx.ui.setStatus() texts on the right.
 * Line 2: `starship prompt` for the cwd — directory, git, language versions,
 *         nix-shell, whatever your starship.toml renders — minus its prompt
 *         character; then context (real token counts), tokens in/out,
 *         prompt-cache hit rate, cost, and the last reply's output tokens/s.
 *
 * Context turns warning/error at a percentage OR an absolute token count,
 * whichever comes first (from omp's status line): on a 1M-token window a
 * percentage alone would stay quiet until 700k, long after a session has
 * become slow and expensive.
 *
 * starship never runs inside render(): it is refreshed in the background (session
 * start, before each prompt, after each run, on a git branch change) and the
 * last output is drawn. Without starship on PATH the left side falls back to the
 * directory name and the git branch pi already tracks.
 *
 * Narrow terminals drop whole segments, lowest priority first (tok/s, cache,
 * cost, tokens; statuses before the model line) and truncate starship's text
 * last. Nothing wraps.
 *
 * Config — settings.json (all optional):
 *   "statusline": {
 *     "hide": ["memory"],                  // extension status keys not to show
 *     "contextThresholds": {               // [percent, tokens]: first one reached
 *       "warning": [70, 150000],
 *       "error": [90, 500000]
 *     },
 *     "separator": " · ",
 *     "starship": true                     // false: never call starship
 *   }
 * /statusline toggles it for the session (pi's own footer comes back).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

type Theme = { fg(color: string, text: string): string };
type Tui = { requestRender(): void };
/** [percent, tokens]: the level applies once either is reached. */
type Threshold = [number, number];
type Config = { hide: string[]; warning: Threshold; error: Threshold; separator: string; starship: boolean };

const STARSHIP_TIMEOUT_MS = 5000;

function threshold(value: unknown, fallback: Threshold): Threshold {
	if (!Array.isArray(value)) return fallback;
	const [pct, tokens] = value;
	return [typeof pct === "number" ? pct : fallback[0], typeof tokens === "number" ? tokens : Infinity];
}

function loadConfig(): Config {
	let raw: Record<string, any> = {};
	try {
		raw = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf-8"))?.statusline ?? {};
	} catch {
		// No settings file or no block: defaults.
	}
	const t = raw.contextThresholds ?? {};
	return {
		hide: Array.isArray(raw.hide) ? raw.hide.filter((s: unknown): s is string => typeof s === "string") : [],
		warning: threshold(t.warning, [70, 150_000]),
		error: threshold(t.error, [90, 500_000]),
		separator: typeof raw.separator === "string" ? raw.separator : " · ",
		starship: raw.starship !== false,
	};
}

function reached(tokens: number, pct: number, [p, t]: Threshold): boolean {
	return pct >= p || tokens >= t;
}

function run(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"starship",
			args,
			{
				cwd,
				timeout: STARSHIP_TIMEOUT_MS,
				// An unknown shell makes starship emit plain ANSI, without the
				// %{…%} / \[…\] wrappers a real shell prompt needs.
				env: { ...process.env, STARSHIP_SHELL: "", STARSHIP_LOG: "error" },
			},
			(err, stdout) => (err ? reject(err) : resolve(stdout)),
		);
	});
}

/**
 * Shorter wording for verbose statuses other extensions publish. The match runs
 * on the styled text; the colour codes wrap the whole string, so the words are
 * contiguous. pi-mcp-adapter: "MCP: 7 servers enabled (1 connected) (2 disabled)"
 * → "MCP: 1/7 active, 2 off" (its own "mcpFooterStatus": "compact" setting lives
 * in the per-machine mcp-adapter.json, and drops the words).
 */
function compactStatus(key: string, text: string): string {
	if (key === "mcp") {
		return text.replace(
			/MCP: (\d+) servers? enabled(?: \((\d+) connected\))?(?: \((\d+) disabled\))?/,
			(_m, enabled: string, connected?: string, disabled?: string) =>
				`MCP: ${connected ?? 0}/${enabled} active${disabled ? `, ${disabled} off` : ""}`,
		);
	}
	return text;
}

/** 6600 → 6.6k, 26335 → 26k, 1000000 → 1.0M */
function fmt(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Left text, then right text flush against the edge, never wider than `width`. */
function row(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width);
	const room = width - visibleWidth(right) - 1;
	if (room < 1) return truncateToWidth(right, width);
	const l = truncateToWidth(left, room);
	return l + " ".repeat(Math.max(1, width - visibleWidth(l) - visibleWidth(right))) + right;
}

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let enabled = true;
	let ctx: ExtensionContext | undefined;
	let tui: Tui | undefined;
	let model: { provider: string; id: string } | undefined;
	let width = 120;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	/** Output tokens/s of the last reply (request out → reply done), timed here: pi's messages carry no duration. */
	let rate: number | undefined;
	let replyStart = 0;

	const ship = { text: "", char: undefined as string | undefined, available: true, running: false, again: false };

	async function refreshShip(): Promise<void> {
		const c = ctx;
		if (!c || !config.starship || !ship.available) return;
		if (ship.running) {
			ship.again = true;
			return;
		}
		ship.running = true;
		try {
			// The prompt character ("❯ ") ends the prompt; render it alone once
			// and cut it off, whatever symbol the user's config gives it.
			ship.char ??= (await run(["module", "character"], c.cwd)).trim();
			const out = await run(["prompt", "--path", c.cwd, "--terminal-width", String(width)], c.cwd);
			let text = out.replace(/\s+$/, "");
			const at = ship.char ? text.lastIndexOf(ship.char) : -1;
			if (at >= 0) text = text.slice(0, at);
			ship.text = text.replace(/\r?\n/g, " ").trim();
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") ship.available = false;
			// Otherwise (timeout, git hiccup): keep the last good text.
		} finally {
			ship.running = false;
			tui?.requestRender();
			if (ship.again) {
				ship.again = false;
				void refreshShip();
			}
		}
	}

	function updateUsage(c: ExtensionContext): void {
		Object.assign(usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
		for (const e of c.sessionManager.getBranch()) {
			if (e.type !== "message" || e.message.role !== "assistant") continue;
			const u = (e.message as { usage?: Record<string, any> }).usage;
			if (!u) continue;
			usage.input += u.input ?? 0;
			usage.output += u.output ?? 0;
			usage.cacheRead += u.cacheRead ?? 0;
			usage.cacheWrite += u.cacheWrite ?? 0;
			usage.cost += u.cost?.total ?? 0;
		}
	}

	function lineOne(theme: Theme, statuses: ReadonlyMap<string, string>): string {
		const dot = theme.fg("dim", config.separator);
		const parts: string[] = [];
		if (model) {
			parts.push(theme.fg("accent", model.id));
			const name = ctx?.modelRegistry.getProviderDisplayName(model.provider) ?? model.provider;
			parts.push(theme.fg("muted", name));
		} else {
			parts.push(theme.fg("dim", "no model"));
		}
		const level = pi.getThinkingLevel();
		if (level) parts.push(theme.fg(`thinking${level[0].toUpperCase()}${level.slice(1)}`, level));
		const session = pi.getSessionName();
		if (session) parts.push(theme.fg("muted", session));

		const shown = [...statuses]
			.filter(([key]) => !config.hide.includes(key))
			.map(([key, text]) => compactStatus(key, text).replace(/\s*\r?\n\s*/g, " ").trim())
			.filter(Boolean);
		const right = shown.length ? theme.fg("dim", shown.join(config.separator)) : "";
		const left = parts.join(dot);
		// The model line wins: statuses shrink first, and go if nothing useful fits.
		const room = width - visibleWidth(left) - 2;
		return row(left, room >= 12 ? truncateToWidth(right, room) : "", width);
	}

	function lineTwo(theme: Theme, branch: string | null): string {
		const dot = theme.fg("dim", config.separator);
		const left =
			ship.text ||
			(ctx ? theme.fg("accent", path.basename(ctx.cwd)) : "") +
				(branch ? theme.fg("dim", " on ") + theme.fg("muted", branch) : "");

		// Segments in display order; `p` is priority (lower = kept longer).
		const segs: Array<{ p: number; text: string }> = [];
		const cu = ctx?.getContextUsage();
		if (cu) {
			const pct = cu.percent ?? 0;
			const tok = cu.tokens ?? 0;
			const color = reached(tok, pct, config.error) ? "error" : reached(tok, pct, config.warning) ? "warning" : "muted";
			segs.push({ p: 0, text: theme.fg(color, `${cu.tokens == null ? "?" : fmt(cu.tokens)}/${fmt(cu.contextWindow)}`) });
		}
		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		if (prompt || usage.output) segs.push({ p: 1, text: theme.fg("dim", `↑${fmt(prompt)} ↓${fmt(usage.output)}`) });
		if (usage.cacheRead) segs.push({ p: 3, text: theme.fg("dim", `cache ${Math.round((usage.cacheRead / prompt) * 100)}%`) });
		if (usage.cost > 0) segs.push({ p: 2, text: theme.fg("dim", `$${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}`) });
		if (rate !== undefined) segs.push({ p: 4, text: theme.fg("dim", `${rate < 10 ? rate.toFixed(1) : Math.round(rate)} tok/s`) });

		// Keep the most important segments that fit next to at least a short left side.
		const minLeft = Math.min(visibleWidth(left), 16);
		const keep = new Set<number>();
		for (const s of [...segs].sort((a, b) => a.p - b.p)) {
			const trial = segs.filter((x) => keep.has(x.p) || x === s).map((x) => x.text).join(dot);
			if (visibleWidth(trial) + 1 + minLeft <= width) keep.add(s.p);
		}
		const right = segs.filter((s) => keep.has(s.p)).map((s) => s.text).join(dot);
		return row(left, right, width);
	}

	function install(c: ExtensionContext): void {
		c.ui.setFooter((t, theme, footerData) => {
			tui = t;
			const unsub = footerData.onBranchChange(() => {
				void refreshShip();
				t.requestRender();
			});
			return {
				dispose() {
					unsub();
					tui = undefined;
				},
				invalidate() {},
				render(w: number): string[] {
					if (w !== width) {
						width = w;
						void refreshShip(); // starship lays out modules for the width
					}
					return [
						lineOne(theme as Theme, footerData.getExtensionStatuses()),
						lineTwo(theme as Theme, footerData.getGitBranch()),
					];
				},
			};
		});
	}

	pi.on("session_start", async (_event, c) => {
		config = loadConfig();
		ctx = c;
		model = c.model ? { provider: c.model.provider, id: c.model.id } : undefined;
		ship.text = "";
		updateUsage(c);
		if (c.hasUI && enabled) install(c);
		void refreshShip();
	});
	pi.on("model_select", async (event) => {
		const m = (event as { model?: { provider: string; id: string } }).model;
		if (m) model = { provider: m.provider, id: m.id };
		tui?.requestRender();
	});
	pi.on("thinking_level_select", async () => tui?.requestRender());
	pi.on("session_info_changed", async () => tui?.requestRender());
	pi.on("session_compact", async (_e, c) => {
		updateUsage(c);
		tui?.requestRender();
	});
	// From the request going out, not the first token: the whole reply, wait
	// included, is what a remote model costs you in time (omp measures it so too).
	pi.on("turn_start", async () => {
		replyStart = Date.now();
	});
	pi.on("message_end", async (event) => {
		const m = (event as { message?: { role?: string; usage?: { output?: number } } }).message;
		if (m?.role !== "assistant" || !replyStart) return;
		const secs = (Date.now() - replyStart) / 1000;
		const out = m.usage?.output ?? 0;
		// Ignore tool-call-only blips: too short to say anything about speed.
		if (secs >= 0.2 && out >= 16) rate = out / secs;
		replyStart = 0;
	});
	pi.on("input", async () => void refreshShip());
	pi.on("turn_end", async (_e, c) => {
		updateUsage(c);
		tui?.requestRender();
	});
	pi.on("agent_end", async (_e, c) => {
		updateUsage(c);
		void refreshShip();
	});

	pi.registerCommand("statusline", {
		description: "Toggle the starship statusline for this session",
		handler: async (_args, c) => {
			enabled = !enabled;
			if (enabled) {
				install(c);
				void refreshShip();
			} else {
				c.ui.setFooter(undefined);
			}
			c.ui.notify(`statusline ${enabled ? "on" : "off (pi's footer)"}`, "info");
		},
	});
}
