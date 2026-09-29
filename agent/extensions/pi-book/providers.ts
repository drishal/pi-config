/**
 * Endpoint and key of a pi provider, read from pi's own files — so pi-book.json
 * can say "litellm/GLM-5.3-Flash" instead of repeating a URL and a key.
 *
 *   base URL  models.json providers.<name>.baseUrl; for the provider that
 *             litellm-auto.ts registers (not in models.json on every machine):
 *             LITELLM_BASE_URL, then ~/.pi/secrets/litellm.url
 *   API       models.json providers.<name>.api (direct calls need an
 *             OpenAI-compatible one)
 *   key       auth.json[<name>] (what `/login` keeps current), then
 *             models.json providers.<name>.apiKey — resolved the way pi does:
 *             `!command` runs it, `$VAR` / `${VAR}` reads the environment,
 *             anything else is literal. Local servers need none.
 *
 * Works inside pi and from the CLI (no model registry needed).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export interface ProviderEndpoint {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
}

const LITELLM = process.env.LITELLM_PROVIDER ?? "litellm";

function readJson(file: string): Record<string, any> | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return undefined;
	}
}

/** Resolve a key field the way pi does; undefined when it cannot. */
export function resolveKeyValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const v = value.trim();
	if (!v) return undefined;
	if (v.startsWith("$$")) return `$${v.slice(2)}`;
	if (v.startsWith("$!")) return `!${v.slice(2)}`;
	if (v.startsWith("!")) {
		try {
			const out = execFileSync(process.env.SHELL || "/bin/sh", ["-c", v.slice(1)], {
				encoding: "utf-8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return out || undefined;
		} catch {
			return undefined;
		}
	}
	const ref = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(v);
	if (ref) return process.env[ref[1]] || undefined;
	return v;
}

export function resolveProvider(agentDir: string, name: string): ProviderEndpoint {
	const entry = readJson(path.join(agentDir, "models.json"))?.providers?.[name] ?? {};
	let baseUrl: string | undefined = typeof entry.baseUrl === "string" ? entry.baseUrl : undefined;
	if (!baseUrl && name === LITELLM) {
		baseUrl = process.env.LITELLM_BASE_URL;
		if (!baseUrl) {
			try {
				baseUrl = fs.readFileSync(path.join(os.homedir(), ".pi", "secrets", "litellm.url"), "utf-8").trim() || undefined;
			} catch {
				// no gateway configured on this machine
			}
		}
	}
	const auth = readJson(path.join(agentDir, "auth.json"))?.[name];
	const authKey = typeof auth === "string" ? auth : (auth?.key ?? auth?.apiKey);
	const apiKey = resolveKeyValue(authKey) ?? resolveKeyValue(entry.apiKey);
	return {
		baseUrl: baseUrl?.replace(/\/+$/, ""),
		api: typeof entry.api === "string" ? entry.api : undefined,
		apiKey,
	};
}

/** "provider/model" → [provider, model]; the model id may itself contain "/". */
export function splitModelRef(ref: string): [string, string] | undefined {
	const at = ref.indexOf("/");
	if (at <= 0 || at === ref.length - 1) return undefined;
	return [ref.slice(0, at), ref.slice(at + 1)];
}

/** How long one provider extension may take to register (discovery is network-bound). */
const PROVIDER_EXTENSION_TIMEOUT_MS = 8_000;

/**
 * Providers that an extension registers — litellm-auto's gateway models,
 * local-llama-autodetect's llama-server — for a pi session built outside pi.
 *
 * Inside pi, microcall borrows the running session's model runtime, where
 * those extensions have already registered their providers. pi-book's CLI
 * (and the benchmarks) build a session from pi's SDK with no extensions, so
 * "litellm/…" would be an unknown model there. This runs only the extensions
 * that call registerProvider, against a stub API whose one live method is
 * registerProvider (everything else — commands, events, UI — is a no-op), and
 * hands each registration to `register`. Returns the provider names added.
 */
export async function loadExtensionProviders(
	agentDir: string,
	register: (name: string, config: unknown) => void,
): Promise<string[]> {
	const dir = path.join(agentDir, "extensions");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files = entries
		.map((e) => (e.isDirectory() ? path.join(dir, e.name, "index.ts") : e.name.endsWith(".ts") ? path.join(dir, e.name) : ""))
		.filter((f) => f && !f.includes(`${path.sep}pi-book${path.sep}`) && fs.existsSync(f))
		.filter((f) => fs.readFileSync(f, "utf-8").includes("registerProvider("));

	const added: string[] = [];
	const stub = new Proxy(
		{},
		{
			get: (_target, prop) =>
				prop === "registerProvider"
					? (name: string, config: unknown) => {
							register(name, config);
							if (!added.includes(name)) added.push(name);
						}
					: () => undefined,
		},
	);
	for (const file of files) {
		try {
			const mod = (await import(pathToFileURL(file).href)) as { default?: (pi: unknown) => unknown };
			if (typeof mod.default !== "function") continue;
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				mod.default(stub),
				new Promise((resolve) => {
					timer = setTimeout(resolve, PROVIDER_EXTENSION_TIMEOUT_MS);
					timer.unref?.();
				}),
			]);
			clearTimeout(timer);
		} catch {
			// An extension that cannot load outside pi simply adds no provider.
		}
	}
	return added;
}
