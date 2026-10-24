/**
 * background — compact inline notifications for pi-background-tasks.
 *
 * The default renderer draws every event as a ruled block:
 *
 *   ═══════════════════════════════════════════
 *   ● Background task finished bg-1 · ... · ctrl+o
 *   ═══════════════════════════════════════════
 *
 * That is loud and breaks neat-render's one-row-per-thing transcript. This
 * renderer re-uses the same bullet/verb/subject/fact vocabulary as tool rows.
 * The expanded view keeps the details and a short output tail, just without
 * the heavy border.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type ThemeLike,
	factText,
	failText,
	fit,
	glyph,
	inset,
	liveText,
	noteText,
	plural,
	subjectText,
	verbText,
} from "./style.ts";

const BG_MESSAGE_TYPE = "kendex-background-tasks:event";
const BG_EXPANDED_OUTPUT_LINES = 12;

type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped" | "timed_out";

type BackgroundTaskSnapshot = {
	id: string;
	title: string;
	command: string;
	cwd: string;
	pid: number;
	logFile: string;
	status: BackgroundTaskStatus;
	exitCode: number | null;
	expiresAt?: number | null;
	notifyOnExit: boolean;
	notifyOnOutput: boolean;
	notifyPattern?: string;
	notifyMode?: string;
	dedupeKey?: string;
	terminationReason?: string;
};

type BackgroundTaskEventDetails = {
	eventType: "output" | "exit";
	task: BackgroundTaskSnapshot;
	outputTail: string;
	outputTailTruncated: boolean;
	matchedPattern?: string;
};

function asThemeLike(theme: Theme): ThemeLike {
	return theme as unknown as ThemeLike;
}

function taskDisplayName(task: BackgroundTaskSnapshot): string {
	return (task.title || task.command).replace(/\s+/g, " ").trim();
}

function statusFact(task: BackgroundTaskSnapshot): string {
	const base = task.status;
	if (base === "running") return base;
	const code = task.exitCode ?? "?";
	let text = `${base} (exit ${code})`;
	if (task.terminationReason && task.terminationReason !== "self-exit") {
		text += ` · ${task.terminationReason}`;
	}
	return text;
}

function statusText(task: BackgroundTaskSnapshot, theme: ThemeLike): string {
	const text = statusFact(task);
	if (task.status === "running") return liveText(theme, text);
	if (task.status === "failed" || task.status === "timed_out") return failText(theme, text);
	return factText(theme, text);
}

function wakeups(task: BackgroundTaskSnapshot): string {
	return `exit=${task.notifyOnExit ? "yes" : "no"}, output=${
		task.notifyOnOutput ? (task.notifyPattern ?? "yes") : "no"
	}, mode=${task.notifyMode ?? "always"}${task.dedupeKey ? `, dedupeKey=${task.dedupeKey}` : ""}`;
}


function renderDetails(task: BackgroundTaskSnapshot, theme: ThemeLike, width: number, indent: string): string[] {
	const label = (text: string) => noteText(theme, `${text}:`);
	const value = (text: string) => factText(theme, text);
	const lines = [
		`${indent}${label("Status")} ${statusText(task, theme)} ${value(`· pid ${task.pid}`)}`,
		`${indent}${label("Title")} ${subjectText(theme, taskDisplayName(task))}`,
		`${indent}${label("Command")} ${value(task.command)}`,
		`${indent}${label("Cwd")} ${value(task.cwd)}`,
		`${indent}${label("Log")} ${value(task.logFile)}`,
		`${indent}${label("Wakeups")} ${value(wakeups(task))}`,
	];
	if (task.expiresAt != null && task.status === "running") {
		lines.push(`${indent}${label("Timeout")} ${value(new Date(task.expiresAt).toISOString())}`);
	}
	return lines.map((line) => fit(line, width));
}

export function installBackgroundMessages(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<BackgroundTaskEventDetails>(BG_MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details;
		const task = details?.task;
		if (!task) return undefined;

		const t = asThemeLike(theme);

		return {
			invalidate() {},
			render(width: number): string[] {
				const pad = inset();
				const icon =
					task.status === "running"
						? liveText(t, glyph.bullet)
						: task.status === "failed" || task.status === "timed_out"
							? failText(t, glyph.bullet)
							: factText(t, glyph.bullet);
				const eventWord = details.eventType === "output" ? "output" : statusFact(task);
				const title = taskDisplayName(task);
				const outputLineCount =
					details.eventType === "output" ? details.outputTail.trimEnd().split(/\r?\n/).length : 0;
				const outputLines = outputLineCount > 0 ? factText(t, ` · ${plural(outputLineCount, "line")}`) : "";
				const hint = options.expanded ? "" : factText(t, " · ctrl+o");
				const head = fit(
					`${pad}${icon} ${verbText(t, "Bg")} ${subjectText(t, task.id)} ${factText(t, eventWord)}` +
						`${title ? factText(t, ` · ${title}`) : ""}${outputLines}${hint}`,
					width,
				);

				if (!options.expanded) return [head];

				const indent = pad + "  ";
				const lines: string[] = [head, ""];
				lines.push(...renderDetails(task, t, width, indent));

				if (details.matchedPattern) {
					lines.push(`${indent}${noteText(t, "Pattern:")} ${factText(t, details.matchedPattern)}`);
				}

				const tail = details.outputTail.trimEnd();
				if (tail) {
					lines.push("", `${indent}${verbText(t, "Recent output")}`);
					const rawLines = tail.split(/\r?\n/);
					if (rawLines.length > BG_EXPANDED_OUTPUT_LINES) {
						const hidden = rawLines.length - BG_EXPANDED_OUTPUT_LINES;
						lines.push(`${indent}${noteText(t, `… ${hidden} older line(s)`)}`);
					}
					const outPrefix = `${indent}│ `;
					const budget = Math.max(8, width - visibleWidth(outPrefix));
					for (const rawLine of rawLines.slice(-BG_EXPANDED_OUTPUT_LINES)) {
						for (const wrapped of wrapTextWithAnsi(rawLine, budget)) {
							lines.push(fit(`${outPrefix}${wrapped}`, width));
						}
					}
					lines.push(`${indent}└ ${noteText(t, `Full background log: ${task.logFile}`)}`);
				}

				return lines.map((line) => fit(line, width));
			},
		};
	});
}
