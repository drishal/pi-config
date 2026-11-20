/**
 * Structural + budget validation for a parsed router.md. The /build-router
 * apply path and the extension loader both go through here before a policy
 * is activated.
 */
import {
	DEFAULT_MECHANICS,
	isModelId,
	policyBudget,
	type MechanicsConfig,
	type RouterPolicy,
} from "./parse.ts";
import type { BudgetResult } from "./tokens.ts";

export interface ValidationReport {
	ok: boolean;
	errors: string[];
	warnings: string[];
	budget: BudgetResult;
}

export function validatePolicy(
	policy: RouterPolicy,
	mechanics: MechanicsConfig = DEFAULT_MECHANICS,
	registryWindow?: number,
): ValidationReport {
	const errors: string[] = [];
	const warnings: string[] = [];
	const ids = new Set<string>();

	if (!policy.models.length) errors.push("no models listed under ## Models");
	if (!policy.defaults.fallback) errors.push("## Defaults must set fallback: `provider/id`");
	else if (!isModelId(policy.defaults.fallback)) {
		errors.push(`fallback is not a provider/id: ${policy.defaults.fallback}`);
	}

	for (const key of ["direct", "pinFree", "pinHard"] as const) {
		const value = policy.defaults[key];
		if (!value) continue;
		if (!isModelId(value)) errors.push(`${key} is not a provider/id: ${value}`);
	}

	for (const model of policy.models) {
		if (!model.id || !isModelId(model.id)) {
			errors.push(`model is missing a provider/id heading or id field${model.name ? ` (${model.name})` : ""}`);
			continue;
		}
		if (ids.has(model.id)) errors.push(`duplicate model id: ${model.id}`);
		ids.add(model.id);
		if (model.context && !model.contextWindow) {
			warnings.push(`${model.id}: could not parse context ${JSON.stringify(model.context)}`);
		}
	}

	if (policy.defaults.fallback && ids.size && !ids.has(policy.defaults.fallback)) {
		errors.push(`fallback ${policy.defaults.fallback} is not in ## Models`);
	}
	for (const key of ["direct", "pinFree", "pinHard"] as const) {
		const value = policy.defaults[key];
		if (value && ids.size && !ids.has(value)) warnings.push(`${key} ${value} is not in ## Models`);
	}
	for (const id of policy.defaults.order) {
		if (!ids.has(id)) warnings.push(`order lists ${id}, which is not in ## Models`);
	}
	if (!policy.plans.trim()) warnings.push("## Plans is empty — the decider will have no plan/cap notes");

	const budget = policyBudget(policy, mechanics, registryWindow);
	if (!budget.ok) errors.push(budget.message);

	return { ok: errors.length === 0, errors, warnings, budget };
}

export function formatReport(report: ValidationReport): string {
	const lines: string[] = [];
	if (report.ok) lines.push("VALID", report.budget.message);
	else {
		lines.push("INVALID");
		for (const error of report.errors) {
			lines.push(error.includes("\n") ? error : `  error: ${error}`);
		}
	}
	for (const warning of report.warnings) lines.push(`  warning: ${warning}`);
	return lines.join("\n");
}
