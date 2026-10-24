/**
 * chrome — pi's own furniture, drawn in the transcript's voice.
 *
 * Two things pi draws itself still sat outside neat-render's grammar: the
 * full-width DynamicBorder rules (package updates, the changelog, warnings) and
 * the tinted [compaction]/[branch] summary boxes. Both are exported components,
 * so they are patched here the same way the tool rows are: a rule becomes the
 * transcript's dim border colour, and a collapsed summary becomes one row in
 * the bullet/verb/fact shape of a call. A custom renderer that draws its own
 * layout (pi-book's Memory row) is left alone.
 */

import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	DynamicBorder,
	keyText,
} from "@earendil-works/pi-coding-agent";
import {
	type Patchable,
	type RenderFn,
	type ThemeLike,
	factText,
	fit,
	glyph,
	inset,
	markText,
	noteText,
	paint,
	state,
	subjectText,
	verbText,
} from "./style.ts";

export const BORDER_PATCH = Symbol.for("dr.pi.neatRender.border.v1");
const SUMMARY_RENDER = Symbol.for("dr.pi.neatRender.summary.render.v1");
const SUMMARY_MOUSE = Symbol.for("dr.pi.neatRender.summary.mouse.v1");

type Summary = {
	expanded?: boolean;
	message?: { tokensBefore?: number; summary?: string };
	setExpanded?(expanded: boolean): void;
};
type MouseEvent = { type?: string; button?: string };
type SummaryProto = Patchable &
	Summary & {
		handleMouse?: (event: MouseEvent) => unknown;
	};

/** A horizontal rule in the transcript's border colour, whatever pi asked for. */
export function installBorder(): Patchable | undefined {
	const proto = DynamicBorder?.prototype as unknown as Patchable | undefined;
	if (!proto || typeof proto.render !== "function" || proto[BORDER_PATCH]) return undefined;
	const original = proto.render;
	proto.render = function (width: number): string[] {
		const theme = state.theme;
		if (!theme) return original.call(this, width);
		return [fit(paint(theme, "rule", "─".repeat(Math.max(1, width))), width)];
	} as RenderFn;
	proto[BORDER_PATCH] = original;
	return proto;
}

/** One collapsed summary, in the same shape as a tool row. */
function summaryRow(comp: Summary, theme: ThemeLike, width: number, kind: "compaction" | "branch"): string[] {
	const pad = inset();
	const sep = factText(theme, " · ");
	const parts: string[] = [];
	if (kind === "compaction") {
		parts.push(verbText(theme, "Compaction"));
		const before = comp.message?.tokensBefore;
		if (typeof before === "number") parts.push(factText(theme, `${before.toLocaleString()} tokens`));
	} else {
		parts.push(verbText(theme, "Branch"), subjectText(theme, "summary"));
	}
	// A keybinding manager is not always present (a harness, a headless run);
	// only print the hint when there is a key to name.
	const key = keyText("app.tools.expand");
	if (key) parts.push(noteText(theme, `${key} expand`));
	return [fit(`${pad}${markText(theme, glyph.bullet)} ${parts.join(sep)}`, width)];
}

function installSummary(
	component: { prototype?: unknown } | undefined,
	kind: "compaction" | "branch",
): Patchable | undefined {
	const proto = component?.prototype as SummaryProto | undefined;
	if (!proto || typeof proto.render !== "function" || proto[SUMMARY_RENDER]) return undefined;
	const originalRender = proto.render;
	const originalMouse = proto.handleMouse;

	proto.render = function (width: number): string[] {
		const theme = state.theme;
		// Expanded is pi's own detail box: the full summary with its markdown.
		if (!theme || (this as Summary).expanded) return originalRender.call(this, width);
		return summaryRow(this as Summary, theme, width, kind);
	} as RenderFn;

	// The compact row does not render the component's MouseRegion, so its own
	// click handler has no layout to hit. Toggle here instead.
	proto.handleMouse = function (event: MouseEvent) {
		if (event?.type !== "click" || event.button !== "left") return originalMouse?.call(this, event);
		const self = this as Summary;
		if (typeof self.setExpanded === "function") self.setExpanded(!self.expanded);
		else self.expanded = !self.expanded;
		state.renderer?.requestRender?.();
		return { handled: true };
	};

	proto[SUMMARY_RENDER] = originalRender;
	proto[SUMMARY_MOUSE] = originalMouse;
	return proto;
}

export function installSummaries(): void {
	installSummary(CompactionSummaryMessageComponent, "compaction");
	installSummary(BranchSummaryMessageComponent, "branch");
}

export function uninstallSummaries(): void {
	for (const component of [CompactionSummaryMessageComponent, BranchSummaryMessageComponent]) {
		const proto = component?.prototype as unknown as SummaryProto | undefined;
		if (!proto) continue;
		const render = proto[SUMMARY_RENDER];
		if (typeof render === "function") proto.render = render as RenderFn;
		const mouse = proto[SUMMARY_MOUSE];
		if (typeof mouse === "function") proto.handleMouse = mouse as SummaryProto["handleMouse"];
		else delete proto.handleMouse;
		delete proto[SUMMARY_RENDER];
		delete proto[SUMMARY_MOUSE];
	}
}
