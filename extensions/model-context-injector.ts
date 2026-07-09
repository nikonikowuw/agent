import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────

interface SystemBlock {
  type: string;
  text: string;
}

interface Rule {
  enabled?: boolean;
  name?: string;
  provider: string;
  models: string[];
  context?: string;
  system?: string | SystemBlock[];
}

interface Config {
  rules: Rule[];
}

// ── Constants ──────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".pi", "agent", "model-context-rules.json");

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Escape regex special characters, leaving `*` for glob handling.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a simple glob pattern (supporting `*`) to a RegExp.
 * Splits on `*`, escapes each segment, joins with `.*`.
 */
function globToRegex(pattern: string): RegExp {
  const regexStr = "^" + pattern.split("*").map(escapeRegex).join(".*") + "$";
  return new RegExp(regexStr, "i");
}

/**
 * Test whether `value` matches the glob `pattern`.
 */
function matchesGlob(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  return globToRegex(pattern).test(value);
}

/**
 * Load and parse the JSON config file.
 * Returns `null` on any error — never throws.
 */
function loadConfig(): Config | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.rules)) {
      console.warn("[model-context-injector] Config missing 'rules' array, skipping");
      return null;
    }
    return parsed as Config;
  } catch (err) {
    console.warn(`[model-context-injector] Failed to load config: ${err}`);
    return null;
  }
}

/**
 * Collect enabled rules whose provider and at least one model pattern match.
 */
function getMatchingRules(
  config: Config,
  provider: string,
  modelId: string,
): Rule[] {
  return config.rules.filter((rule) => {
    if (rule.enabled === false) return false;
    if (!rule.provider || !matchesGlob(provider, rule.provider)) return false;
    if (!rule.models || rule.models.length === 0) return false;
    return rule.models.some((p) => matchesGlob(modelId, p));
  });
}

/**
 * Extract the effective text from a rule's `system` field.
 * Supports both string and text-block array forms.
 * Returns empty string if field is absent, empty, or invalid.
 */
function extractSystemText(system: Rule["system"]): string {
  if (!system) return "";

  if (typeof system === "string") {
    return system.trim();
  }

  if (Array.isArray(system)) {
    return system
      .filter(
        (block): block is SystemBlock =>
          block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
      )
      .map((block) => block.text.trim())
      .join("\n");
  }

  return "";
}

/**
 * Build the injection preamble from matching rules.
 * Returns the full preamble string, or an empty string if nothing to inject.
 */
function buildInjectionPreamble(matching: Rule[]): string {
  const systemParts: string[] = [];
  const contextParts: string[] = [];

  for (const rule of matching) {
    // Extract system text
    const sysText = extractSystemText(rule.system);
    if (sysText) systemParts.push(sysText);

    // Extract context text
    const ctxText = rule.context?.trim() ?? "";
    if (ctxText) contextParts.push(ctxText);
  }

  const blocks: string[] = [];

  if (systemParts.length > 0) {
    blocks.push("## Model System Injection");
    blocks.push("");
    blocks.push(systemParts.join("\n\n"));
    blocks.push("---");
  }

  if (contextParts.length > 0) {
    blocks.push("## Model Context Injection");
    blocks.push("");
    blocks.push(contextParts.join("\n\n"));
    blocks.push("---");
  }

  if (blocks.length === 0) return "";

  return blocks.join("\n");
}

// ── Extension ──────────────────────────────────────────────────────

export default function modelContextInjector(pi: ExtensionAPI) {
  // ── Context injection ──────────────────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    const model = ctx.model;
    if (!model) return;

    const config = loadConfig();
    if (!config) return;

    const matching = getMatchingRules(config, model.provider, model.id);
    if (matching.length === 0) return;

    const preamble = buildInjectionPreamble(matching);
    if (!preamble) return;

    return {
      systemPrompt: `${preamble}\n\n${event.systemPrompt}`,
    };
  });

  // ── Status command ─────────────────────────────────────────
  pi.registerCommand("model-context-status", {
    description: "Show current model context injection status",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      const modelLabel = model
        ? `${model.provider}/${model.id}`
        : "none (no model selected)";

      const lines: string[] = [];
      lines.push(`Current model: ${modelLabel}`);
      lines.push(`Config path : ${CONFIG_PATH}`);

      const config = loadConfig();
      if (!config) {
        lines.push("Status       : config not loaded or invalid");
      } else {
        const total = config.rules.length;
        const enabled = config.rules.filter((r) => r.enabled !== false).length;
        lines.push(`Total rules  : ${total}`);
        lines.push(`Enabled rules: ${enabled}`);

        if (model) {
          const matching = getMatchingRules(config, model.provider, model.id);
          if (matching.length === 0) {
            lines.push("Matched rules: none");
          } else {
            const withSystem = matching.filter((r) => r.system != null);
            lines.push(`Matched rules: ${matching.length}`);

            for (const rule of matching) {
              const name = rule.name ?? `${rule.provider}/${rule.models.join(",")}`;
              const tag = rule.system != null ? " [system]" : "";
              lines.push(`  - ${name}${tag}`);
            }

            if (withSystem.length > 0) {
              lines.push(
                `System inject: ${withSystem.length} matched rule(s) contain system overrides`,
              );
            }
          }
        }
      }

      const output = lines.join("\n");
      console.log(output);
      ctx.ui.notify(`model-context-status: ${modelLabel}`, "info");
    },
  });
}
