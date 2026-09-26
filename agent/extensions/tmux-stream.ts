/**
 * tmux-stream — live reasoning + tool-call streaming for pi's one-shot CLI mode.
 *
 * WHY: in `pi -p` (print mode) there is no TUI, so reasoning and tool calls are
 * invisible until the run finishes — and if it hangs or is killed, you get nothing
 * at all. This mirrors both, live, into a tmux pane you can attach to.
 *
 * ENABLE:  automatic whenever there is no TUI (ctx.hasUI === false).
 *          PI_TMUX_STREAM=0  force off      PI_TMUX_STREAM=1  force on (even in TUI)
 *          PI_TMUX_SESSION=<name>           default: pi-stream
 *          PI_TMUX_MAX_RESULT=<bytes>       default: 4000 (per tool result)
 *
 * WATCH:   tmux attach -r -t pi-stream
 * LOG:     ~/.pi/agent/stream/<session>.log   (survives the run; nothing is deleted)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const C = {
  rst: "\x1b[0m", dim: "\x1b[2m", b: "\x1b[1m",
  gry: "\x1b[38;5;245m", mag: "\x1b[38;5;176m", cyn: "\x1b[38;5;80m",
  grn: "\x1b[38;5;114m", yel: "\x1b[38;5;180m", red: "\x1b[38;5;174m",
};

const MAX_RESULT = Number(process.env.PI_TMUX_MAX_RESULT ?? 4000);
const SESSION = process.env.PI_TMUX_SESSION ?? "pi-stream";

let logPath = "";
let enabled = false;
let ready = false;
const emitted = new Map<string, number>();   // messageId -> chars of thinking already streamed
const toolT0 = new Map<string, number>();    // toolCallId -> start ms
const toolNm = new Map<string, string>();    // toolCallId -> tool name
const updSeen = new Map<string, number>();   // toolCallId -> progress lines already shown
let mode: "thinking" | "answer" | null = null;
let t0 = Date.now();

const el = (): string => {
  const s = (Date.now() - t0) / 1000;
  return `${C.gry}[${s.toFixed(1).padStart(6)}s]${C.rst}`;
};

function raw(s: string): void {
  if (!enabled || !logPath) return;
  try { appendFileSync(logPath, s); } catch { /* never break the agent */ }
}
function line(s: string): void { raw(s + "\n"); }

/** Start (or reuse) a detached tmux session tailing the log. Never throws. */
function ensureTmux(): void {
  if (ready) return;
  ready = true;
  try {
    const has = spawnSync("tmux", ["has-session", "-t", SESSION], { stdio: "ignore" });
    if (has.status !== 0) {
      spawnSync("tmux", ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50",
                         `tail -F '${logPath}'`], { stdio: "ignore" });
      spawnSync("tmux", ["set-option", "-t", SESSION, "history-limit", "200000"], { stdio: "ignore" });
      spawnSync("tmux", ["set-option", "-t", SESSION, "status", "off"], { stdio: "ignore" });
    }
  } catch { enabled = false; }   // tmux missing -> log file only
}

/** Pull text out of a content block whatever the field is named. */
const blockText = (b: any): string =>
  typeof b?.text === "string" ? b.text
  : typeof b?.thinking === "string" ? b.thinking
  : typeof b?.content === "string" ? b.content : "";

const clip = (s: string, n = MAX_RESULT): string =>
  s.length <= n ? s : `${s.slice(0, n)}\n${C.red}… [clipped ${s.length - n} of ${s.length} chars]${C.rst}`;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx: any) => {
    const forced = process.env.PI_TMUX_STREAM;
    const noTui = ctx?.hasUI === false;
    enabled = forced === "1" ? true : forced === "0" ? false : noTui;
    if (!enabled) return;

    const dir = join(homedir(), ".pi", "agent", "stream");
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    logPath = join(dir, `${SESSION}.log`);
    t0 = Date.now();
    ensureTmux();

    line("");
    line(`${C.b}${C.cyn}════════ pi run ${new Date().toLocaleTimeString()} ════════${C.rst}`);
    line(`${C.gry}cwd ${ctx?.cwd ?? "?"}${C.rst}`);
    line(`${C.gry}watch: tmux attach -r -t ${SESSION}   ·  log: ${logPath}${C.rst}`);
  });

  pi.on("turn_start", async (e: any) => line(`\n${el()} ${C.b}${C.cyn}── turn ${e?.turnIndex ?? "?"} ──${C.rst}`));

  // token-by-token: stream thinking as it arrives, mark the switch to the answer
  pi.on("message_update", async (e: any) => {
    if (!enabled) return;
    const m = e?.message;
    if (!m || m.role !== "assistant") return;
    const id = String(m.id ?? m.messageId ?? "cur");
    const blocks = Array.isArray(m.content) ? m.content : [];

    const think = blocks.filter((b: any) => b?.type === "thinking").map(blockText).join("");
    const seen = emitted.get(id) ?? 0;
    if (think.length > seen) {
      if (mode !== "thinking") { raw(`\n${el()} ${C.mag}┄┄ thinking ┄┄${C.rst}\n`); mode = "thinking"; }
      raw(`${C.dim}${think.slice(seen)}${C.rst}`);
      emitted.set(id, think.length);
    }

    const answer = blocks.filter((b: any) => b?.type === "text").map(blockText).join("");
    const akey = id + ":a";
    const aseen = emitted.get(akey) ?? 0;
    if (answer.length > aseen) {
      if (mode !== "answer") { raw(`\n${el()} ${C.grn}▶ answer${C.rst}\n`); mode = "answer"; }
      raw(answer.slice(aseen));
      emitted.set(akey, answer.length);
    }
  });

  pi.on("tool_call", async (e: any) => {
    if (!enabled) return;
    mode = null;
    const id = String(e?.toolCallId ?? "");
    toolT0.set(id, Date.now());
    toolNm.set(id, String(e?.toolName ?? ""));
    const args = (() => { try { return JSON.stringify(e?.input); } catch { return String(e?.input); } })();
    line(`\n${el()} ${C.yel}🔧 ${C.b}${e?.toolName}${C.rst} ${C.gry}${clip(args ?? "", 600)}${C.rst}`);
  });

  // long-running tools (the 2.5-min bash gaps) emit progress here
  pi.on("tool_execution_update", async (e: any) => {
    if (!enabled) return;
    const id = String(e?.toolCallId ?? "");
    const started = toolT0.get(id);
    const secs = started ? ((Date.now() - started) / 1000).toFixed(1) : "?";
    const parts = Array.isArray(e?.content) ? e.content : [];
    const txt = parts.map(blockText).join("").trim();
    const n = (updSeen.get(id) ?? 0) + 1;
    updSeen.set(id, n);
    const head = `${el()} ${C.gry}   … ${toolNm.get(id) ?? "tool"} running ${secs}s (update ${n})${C.rst}`;
    line(txt ? `${head}\n${C.dim}${clip(txt, 800)}${C.rst}` : head);
  });

  pi.on("tool_result", async (e: any) => {
    if (!enabled) return;
    const parts = Array.isArray(e?.content) ? e.content : [];
    const txt = parts.map(blockText).join("").trim();
    const id = String(e?.toolCallId ?? "");
    const started = toolT0.get(id);
    const dur = started ? `${((Date.now() - started) / 1000).toFixed(1)}s` : "?";
    const slow = started && Date.now() - started > 20000 ? `  ${C.red}${C.b}⟵ SLOW${C.rst}` : "";
    const tag = e?.isError ? `${C.red}✗ error${C.rst}` : `${C.grn}✓${C.rst}`;
    line(`${el()} ${tag} ${C.gry}${e?.toolName ?? ""} · ${dur}${C.rst}${slow}`);
    toolT0.delete(id); toolNm.delete(id); updSeen.delete(id);
    if (txt) line(`${C.dim}${clip(txt)}${C.rst}`);
  });

  pi.on("turn_end", async (e: any) => {
    if (!enabled) return;
    const n = Array.isArray(e?.toolResults) ? e.toolResults.length : 0;
    line(`${el()} ${C.gry}turn ${e?.turnIndex ?? "?"} end · ${n} tool result(s)${C.rst}`);
  });

  pi.on("agent_settled", async () => {
    if (!enabled) return;
    line(`\n${el()} ${C.b}${C.grn}■ settled${C.rst}`);
  });

  pi.on("session_shutdown", async () => {
    if (!enabled) return;
    line(`${el()} ${C.b}${C.cyn}════════ end ════════${C.rst}`);
    line(`${C.gry}(pane kept for scrollback — kill with: tmux kill-session -t ${SESSION})${C.rst}`);
  });
}
