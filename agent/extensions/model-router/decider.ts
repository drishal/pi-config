/**
 * Helpers for the configurable router decider (`routerModel` in router.json).
 * Pure — no pi imports — so unit tests can cover aliasing, picker parsing,
 * and chat-model answer extraction.
 */
import { isJevModelId, splitSpec } from "./tokens.ts";

export type DeciderKind = "jev-http" | "classifier" | "chat" | "missing";

export interface CatalogEntry {
	/** `provider/id` */
	spec: string;
	kind: "classifier" | "chat";
	contextWindow: number;
	name?: string;
	/** True for router/auto and other virtual models that must not be deciders. */
	virtual?: boolean;
}

export const JEV_CANONICAL = "command-code/typesafe/jev";
export const JEV_REGISTERED = "command-code-jev/typesafe/jev";

export function jevAliases(spec: string): string[] {
	const trimmed = spec.trim();
	if (!isJevModelId(trimmed)) return [trimmed];
	return [...new Set([JEV_CANONICAL, JEV_REGISTERED, "typesafe/jev", trimmed])];
}

export function specsMatch(a: string, b: string): boolean {
	if (a === b) return true;
	if (isJevModelId(a) && isJevModelId(b)) return true;
	return false;
}

export function findCatalog(spec: string, catalog: readonly CatalogEntry[]): CatalogEntry | undefined {
	const exact = catalog.find((e) => e.spec === spec && !e.virtual);
	if (exact) return exact;
	if (isJevModelId(spec)) {
		return catalog.find((e) => isJevModelId(e.spec) && !e.virtual);
	}
	const parts = splitSpec(spec);
	if (!parts) return undefined;
	return catalog.find((e) => {
		if (e.virtual) return false;
		const p = splitSpec(e.spec);
		return p?.provider === parts.provider && p?.id === parts.id;
	});
}

export function resolveDeciderKind(spec: string, catalog: readonly CatalogEntry[]): DeciderKind {
	const entry = findCatalog(spec, catalog);
	if (isJevModelId(spec) || (entry && isJevModelId(entry.spec))) {
		// Official Command Code provider does not register Jev or /systemone.
		// Always use the documented Provider API HTTP path for this id.
		return "jev-http";
	}
	if (!entry) return "missing";
	if (entry.kind === "classifier") return "classifier";
	return "chat";
}

export function validateRouterModel(
	spec: string,
	catalog: readonly CatalogEntry[],
): { ok: true; spec: string; kind: DeciderKind; contextWindow: number; entry?: CatalogEntry } | { ok: false; error: string } {
	const trimmed = spec.trim();
	if (!trimmed || !trimmed.includes("/")) {
		return { ok: false, error: `expected a pi provider/id (got ${JSON.stringify(spec)})` };
	}
	const kind = resolveDeciderKind(trimmed, catalog);
	if (kind === "missing" && !isJevModelId(trimmed)) {
		const close = catalog
			.filter((e) => !e.virtual && (e.spec.includes(trimmed) || trimmed.includes(e.spec.split("/")[1] ?? "")))
			.slice(0, 5)
			.map((e) => e.spec);
		const hint = close.length ? ` Did you mean: ${close.join(", ")}?` : " Use /router model to pick from the registry.";
		return { ok: false, error: `${trimmed} is not in pi's model registry.${hint}` };
	}
	const entry = findCatalog(trimmed, catalog);
	const contextWindow = entry?.contextWindow && entry.contextWindow > 0 ? entry.contextWindow : 0;
	const canonical = isJevModelId(trimmed) ? JEV_CANONICAL : trimmed;
	return { ok: true, spec: canonical, kind: kind === "missing" ? "jev-http" : kind, contextWindow, entry };
}

export function formatPickerOption(entry: CatalogEntry): string {
	const bits = [entry.kind, entry.contextWindow > 0 ? `${entry.contextWindow} ctx` : undefined, entry.name].filter(Boolean);
	return `${entry.spec}  — ${bits.join(" · ")}`;
}

export function parsePickerOption(selected: string): string {
	const line = selected.trim();
	const cut = line.split(/\s+—\s+|\s+--\s+/)[0]?.trim() ?? line;
	return cut.split(/\s+/)[0] ?? cut;
}

/** Build picker rows from the registry: Jev first, then other classifiers, then chat models. */
export function pickerEntries(catalog: readonly CatalogEntry[]): CatalogEntry[] {
	const real = catalog.filter((e) => !e.virtual);
	const seen = new Set<string>();
	const out: CatalogEntry[] = [];
	const push = (e: CatalogEntry) => {
		if (seen.has(e.spec)) return;
		seen.add(e.spec);
		out.push(e);
	};
	const jev = real.find((e) => isJevModelId(e.spec));
	if (jev) {
		push({ ...jev, spec: JEV_CANONICAL, name: jev.name ?? "Jev (Command Code)", contextWindow: jev.contextWindow || 32_768 });
	} else {
		push({
			spec: JEV_CANONICAL,
			kind: "classifier",
			contextWindow: 32_768,
			name: "Jev (Command Code)",
		});
	}
	for (const e of real.filter((e) => e.kind === "classifier" && !isJevModelId(e.spec))) push(e);
	for (const e of real.filter((e) => e.kind === "chat").sort((a, b) => a.spec.localeCompare(b.spec))) push(e);
	return out;
}

/**
 * Extract a candidate id from a chat-model reply. Accepts strict JSON
 * `{"choice":"<id>"}` (also `model` / `id` keys), a bare id on its own line,
 * or a unique id substring. Undefined = fail open.
 */
export function parseDeciderText(text: string, candidates: readonly string[]): string | undefined {
	if (!text || !candidates.length) return undefined;
	const allow = new Set(candidates);
	const unfenced = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```\s*$/i, "")
		.trim();
	const tryJson = (raw: string): string | undefined => {
		try {
			const json = JSON.parse(raw) as Record<string, unknown>;
			const choice = json.choice ?? json.model ?? json.id;
			if (typeof choice === "string" && allow.has(choice)) return choice;
			if (typeof choice === "string") {
				const hit = candidates.find((id) => id === choice || id.endsWith(`/${choice}`));
				if (hit) return hit;
			}
		} catch {
			// not JSON
		}
		return undefined;
	};
	const fromJson = tryJson(unfenced);
	if (fromJson) return fromJson;
	const embedded = unfenced.match(/\{[\s\S]*\}/);
	if (embedded) {
		const fromEmbed = tryJson(embedded[0]);
		if (fromEmbed) return fromEmbed;
	}
	for (const line of unfenced.split("\n")) {
		const s = line.trim().replace(/^["'`]+|["'`]+$/g, "");
		if (allow.has(s)) return s;
	}
	const hits = candidates.filter((id) => unfenced.includes(id));
	if (hits.length === 1) return hits[0];
	return undefined;
}

export function buildChatPrompt(policyText: string, userPrompt: string, candidates: readonly string[], criteria: Record<string, string>): string {
	const list = candidates.map((id) => `- ${id}: ${criteria[id] ?? ""}`).join("\n");
	return [
		"You are a model router. Given the policy and the user prompt, pick exactly one candidate model id.",
		"Honour plan notes (peak windows, promo dates, caps). Prefer free or high-limit models when quality is adequate.",
		"Never pick an id that is not in the candidate list.",
		"",
		"Policy:",
		policyText.trim(),
		"",
		"User prompt:",
		userPrompt,
		"",
		"Candidates:",
		list,
		"",
		'Reply with ONLY valid JSON: {"choice":"<exact candidate id>"}. No markdown, no explanation.',
	].join("\n");
}
