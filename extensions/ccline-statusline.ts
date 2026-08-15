import { homedir } from "node:os";
import { basename, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * A small, self-contained CCometixLine-style footer for Pi.
 *
 * The extension intentionally uses only Pi's public extension APIs and the
 * bundled pi-tui helpers. Git is queried asynchronously and cached so footer
 * rendering never waits for a process.
 */

const GIT_REFRESH_INTERVAL_MS = 15_000;
const GIT_REFRESH_DEBOUNCE_MS = 250;
const GIT_COMMAND_TIMEOUT_MS = 1_500;
const RAINBOW_ANIMATION_INTERVAL_MS = 75;
const RAINBOW_PHASE_STEP = 6;
const RAINBOW_PHASE_CYCLE = 360;

const ANSI_ESCAPE = /\x1b\](?:[^\x07]|\x07)*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;

const PI_LOGO = [
	"██████  ",
	"██  ██  ",
	"████  ██",
	"██    ██",
] as const;

type SegmentColor =
	| "accent"
	| "success"
	| "warning"
	| "error"
	| "dim"
	| "muted"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "rainbow";

type Segment = {
	name: string;
	text: string;
	color: SegmentColor;
	/** Higher-priority segments survive narrow terminal widths. */
	priority: number;
};

interface GitStatus {
	branch?: string;
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	untracked: number;
	conflicts: number;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface RuntimeState {
	turnCount: number;
	thinkingLevel: string;
	rainbowPhase: number;
	isStreaming: boolean;
	activeTools: Map<string, number>;
	gitStatus?: GitStatus;
	gitStatusKnown: boolean;
	gitStatusAvailable: boolean;
}

export default function cclineStatusline(pi: ExtensionAPI): void {
	let enabled = true;
	let activeContext: ExtensionContext | undefined;
	let activeSessionManager: ExtensionContext["sessionManager"] | undefined;
	let activeCwd: string | undefined;
	let sessionGeneration = 0;
	let footerInstalled = false;
	let requestRender: (() => void) | undefined;
	let gitRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let gitRefreshInterval: ReturnType<typeof setInterval> | undefined;
	let rainbowAnimationTimer: ReturnType<typeof setInterval> | undefined;
	let gitRefreshInFlight = false;
	let pendingGitRefresh: { cwd: string; generation: number; requestId: number } | undefined;
	let gitRequestId = 0;

	const runtime: RuntimeState = {
		turnCount: 0,
		thinkingLevel: "off",
		rainbowPhase: 0,
		isStreaming: false,
		activeTools: new Map(),
		gitStatusKnown: false,
		gitStatusAvailable: false,
	};

	const render = () => requestRender?.();
	const ownsContext = (ctx: ExtensionContext) =>
		ctx.sessionManager === activeSessionManager && ctx.cwd === activeCwd;

	const clearRainbowAnimation = () => {
		if (rainbowAnimationTimer) {
			clearInterval(rainbowAnimationTimer);
			rainbowAnimationTimer = undefined;
		}
		runtime.rainbowPhase = 0;
	};

	const syncRainbowAnimation = () => {
		if (!footerInstalled || runtime.thinkingLevel !== "max") {
			clearRainbowAnimation();
			return;
		}
		if (rainbowAnimationTimer) return;

		rainbowAnimationTimer = setInterval(() => {
			runtime.rainbowPhase = (runtime.rainbowPhase + RAINBOW_PHASE_STEP) % RAINBOW_PHASE_CYCLE;
			render();
		}, RAINBOW_ANIMATION_INTERVAL_MS);
	};

	const clearGitTimers = () => {
		if (gitRefreshTimer) {
			clearTimeout(gitRefreshTimer);
			gitRefreshTimer = undefined;
		}
		if (gitRefreshInterval) {
			clearInterval(gitRefreshInterval);
			gitRefreshInterval = undefined;
		}
		pendingGitRefresh = undefined;
		gitRequestId += 1;
	};

	const disposeFooter = () => {
		if (footerInstalled) {
			activeContext?.ui.setFooter(undefined);
			footerInstalled = false;
		}
		clearGitTimers();
		clearRainbowAnimation();
		requestRender = undefined;
	};

	const isCurrentGitRequest = (cwd: string, generation: number, requestId: number) =>
		footerInstalled &&
		activeCwd === cwd &&
		generation === sessionGeneration &&
		requestId === gitRequestId;

	const refreshGitStatus = (cwd: string, generation: number) => {
		if (!footerInstalled || activeCwd !== cwd || generation !== sessionGeneration) return;

		const requestId = ++gitRequestId;
		if (gitRefreshInFlight) {
			pendingGitRefresh = { cwd, generation, requestId };
			return;
		}

		gitRefreshInFlight = true;
		void pi
			.exec("git", ["status", "--porcelain=v1", "-b", "--ahead-behind"], {
				cwd,
				timeout: GIT_COMMAND_TIMEOUT_MS,
			})
			.then((result) => {
				if (!isCurrentGitRequest(cwd, generation, requestId)) return;
				const next = result.code === 0 ? parseGitStatus(result.stdout) : undefined;
				const available = next !== undefined;
				const changed =
					!gitStatusEqual(runtime.gitStatus, next) ||
					!runtime.gitStatusKnown ||
					runtime.gitStatusAvailable !== available;
				runtime.gitStatus = next;
				runtime.gitStatusKnown = true;
				runtime.gitStatusAvailable = available;
				if (changed) render();
			})
			.catch(() => {
				if (!isCurrentGitRequest(cwd, generation, requestId)) return;
				const changed = runtime.gitStatus !== undefined || !runtime.gitStatusKnown || runtime.gitStatusAvailable;
				runtime.gitStatus = undefined;
				runtime.gitStatusKnown = true;
				runtime.gitStatusAvailable = false;
				if (changed) render();
			})
			.finally(() => {
				gitRefreshInFlight = false;
				const pending = pendingGitRefresh;
				pendingGitRefresh = undefined;
				if (pending) refreshGitStatus(pending.cwd, pending.generation);
			});
	};

	const scheduleGitRefresh = (ctx: ExtensionContext) => {
		if (!ownsContext(ctx) || !footerInstalled) return;
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		const generation = sessionGeneration;
		gitRefreshTimer = setTimeout(() => {
			gitRefreshTimer = undefined;
			refreshGitStatus(ctx.cwd, generation);
		}, GIT_REFRESH_DEBOUNCE_MS);
	};

	const installHeader = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				return renderPiHeader(width, ctx, theme);
			},
			invalidate() {},
		}));
	};

	const installFooter = (ctx: ExtensionContext, resetRuntime: boolean) => {
		if (ctx.mode !== "tui" || !enabled) return;

		disposeFooter();
		activeContext = ctx;
		activeSessionManager = ctx.sessionManager;
		activeCwd = ctx.cwd;
		sessionGeneration += 1;
		const generation = sessionGeneration;

		if (resetRuntime) {
			runtime.turnCount = 0;
			runtime.thinkingLevel = pi.getThinkingLevel();
			runtime.rainbowPhase = 0;
			runtime.isStreaming = false;
			runtime.activeTools.clear();
			runtime.gitStatus = undefined;
			runtime.gitStatusKnown = false;
			runtime.gitStatusAvailable = false;
		}

		footerInstalled = true;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			syncRainbowAnimation();

			const unsubscribeBranch = footerData.onBranchChange(() => {
				runtime.gitStatus = undefined;
				runtime.gitStatusKnown = false;
				runtime.gitStatusAvailable = false;
				render();
				refreshGitStatus(ctx.cwd, generation);
			});
			gitRefreshInterval = setInterval(() => {
				refreshGitStatus(ctx.cwd, generation);
				tui.requestRender();
			}, GIT_REFRESH_INTERVAL_MS);

			refreshGitStatus(ctx.cwd, generation);

			return {
				dispose() {
					unsubscribeBranch();
					clearGitTimers();
					clearRainbowAnimation();
					if (generation === sessionGeneration) {
						requestRender = undefined;
						footerInstalled = false;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					return [renderStatusline(width, ctx, footerData, theme, runtime)];
				},
			};
		});
	};

	const setEnabled = (next: boolean, ctx: ExtensionContext) => {
		enabled = next;
		if (enabled) {
			installFooter(ctx, false);
			ctx.ui.notify("CCometix 状态栏已开启", "info");
		} else {
			disposeFooter();
			ctx.ui.notify("CCometix 状态栏已关闭", "info");
		}
	};

	pi.registerCommand("ccline", {
		description: "Toggle the local CCometix-style statusline",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "status") {
				ctx.ui.notify(
					`CCometix 状态栏：${enabled ? "开启" : "关闭"}；命令：/ccline on|off|toggle|status`,
					"info",
				);
				return;
			}
			if (command !== "" && command !== "on" && command !== "off" && command !== "toggle") {
				ctx.ui.notify("用法：/ccline [on|off|toggle|status]", "warning");
				return;
			}
			const next = command === "on" ? true : command === "off" ? false : !enabled;
			setEnabled(next, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		activeSessionManager = ctx.sessionManager;
		activeCwd = ctx.cwd;
		installHeader(ctx);
		installFooter(ctx, true);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		runtime.gitStatus = undefined;
		runtime.gitStatusKnown = false;
		runtime.gitStatusAvailable = false;
		scheduleGitRefresh(ctx);
		render();
	});

	pi.on("session_compact", (_event, ctx) => {
		if (ownsContext(ctx)) render();
	});

	pi.on("model_select", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		syncRainbowAnimation();
		render();
	});

	pi.on("thinking_level_select", (event, ctx) => {
		if (!ownsContext(ctx)) return;
		runtime.thinkingLevel = event.level;
		syncRainbowAnimation();
		render();
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		runtime.isStreaming = true;
		render();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		runtime.activeTools.clear();
		scheduleGitRefresh(ctx);
		render();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		runtime.isStreaming = false;
		runtime.activeTools.clear();
		render();
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		runtime.turnCount += 1;
		runtime.isStreaming = true;
		render();
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		scheduleGitRefresh(ctx);
		render();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!ownsContext(ctx)) return;
		runtime.activeTools.set(event.toolName, (runtime.activeTools.get(event.toolName) ?? 0) + 1);
		runtime.isStreaming = true;
		render();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!ownsContext(ctx)) return;
		const count = runtime.activeTools.get(event.toolName) ?? 0;
		if (count <= 1) runtime.activeTools.delete(event.toolName);
		else runtime.activeTools.set(event.toolName, count - 1);
		scheduleGitRefresh(ctx);
		render();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		disposeFooter();
		activeContext = undefined;
		activeSessionManager = undefined;
		activeCwd = undefined;
		sessionGeneration += 1;
	});
}

function renderPiHeader(width: number, ctx: ExtensionContext, theme: Theme): string[] {
	if (width <= 0) return [];

	const model = cleanText(ctx.model?.name || ctx.model?.id || "no-model");
	const provider = cleanText(ctx.model?.provider || "no-provider");
	const details = [
		theme.fg("accent", `pi v${VERSION}`),
		theme.fg("muted", `${model} · ${provider}`),
		theme.fg("dim", formatHeaderPath(ctx.cwd)),
	];
	const gap = "  ";

	return PI_LOGO.map((logoLine, index) => {
		const logo = theme.fg("accent", logoLine);
		const detail = details[index];
		if (!detail) return truncateToWidth(logo, width, "");

		const detailWidth = width - visibleWidth(logo) - visibleWidth(gap);
		if (detailWidth <= 0) return truncateToWidth(logo, width, "");

		return truncateToWidth(
			`${logo}${gap}${truncateToWidth(detail, detailWidth, "")}`,
			width,
			"",
		);
	});
}

function formatHeaderPath(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	return cwd.startsWith(`${home}${sep}`) ? `~${sep}${cwd.slice(home.length + sep.length)}` : cwd;
}

function renderStatusline(
	width: number,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	theme: Theme,
	runtime: RuntimeState,
): string {
	if (width <= 0) return "";

	const usage = summarizeUsage(ctx.sessionManager.getEntries());
	const contextUsage = ctx.getContextUsage();
	const segments: Segment[] = [];

	const model = cleanText(ctx.model?.name || ctx.model?.id || "no-model");
	segments.push({ name: "model", text: `🤖 ${model}`, color: "accent", priority: 100 });
	segments.push({
		name: "thinking",
		text: `🧠 ${cleanText(runtime.thinkingLevel)}`,
		color: thinkingColor(runtime.thinkingLevel),
		priority: 45,
	});

	const directory = cleanText(basename(ctx.cwd) || ctx.cwd);
	segments.push({ name: "directory", text: `📁 ${directory}`, color: "accent", priority: 80 });

	const branch = cleanText(footerData.getGitBranch() ?? runtime.gitStatus?.branch ?? "");
	if (branch || runtime.gitStatus) {
		const git = runtime.gitStatus;
		const statusKnown = runtime.gitStatusKnown && runtime.gitStatusAvailable;
		const dirty = git ? git.staged + git.modified + git.untracked : 0;
		const statusText = !statusKnown
			? "?"
			: git?.conflicts
				? `⚠${git.conflicts}`
				: dirty > 0
					? `●${dirty}`
					: "✓";
		const counts = statusKnown && git
			? `${git.ahead > 0 ? ` ↑${git.ahead}` : ""}${git.behind > 0 ? ` ↓${git.behind}` : ""}` +
					`${git.staged > 0 ? ` +${git.staged}` : ""}${git.modified > 0 ? ` ~${git.modified}` : ""}${git.untracked > 0 ? ` ?${git.untracked}` : ""}`
			: "";
		segments.push({
			name: "git",
			text: `🌿 ${branch || "detached"} ${statusText}${counts}`,
			color: !statusKnown ? "dim" : git?.conflicts ? "error" : dirty > 0 ? "warning" : "success",
			priority: 90,
		});
	}

	const percent = contextUsage?.percent;
	const percentText = percent === null || percent === undefined ? "?" : `${percent.toFixed(1)}%`;
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	segments.push({
		name: "context",
		text: `🪟 ctx ${percentText}/${formatCount(contextWindow)}`,
		color: contextColor(percent),
		priority: 95,
	});

	const activity = formatActivity(runtime);
	if (activity) {
		segments.push({ name: "activity", text: activity, color: "accent", priority: 60 });
	}

	if (usage.input > 0 || usage.output > 0) {
		segments.push({
			name: "tokens",
			text: `↑${formatCount(usage.input)} ↓${formatCount(usage.output)}`,
			color: "muted",
			priority: 30,
		});
	}
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
		segments.push({
			name: "cache",
			text: `📦 R${formatCount(usage.cacheRead)} W${formatCount(usage.cacheWrite)}`,
			color: "muted",
			priority: 25,
		});
	}
	if (usage.input > 0 || usage.output > 0 || usage.cost > 0) {
		segments.push({
			name: "cost",
			text: `💸 $${formatCost(usage.cost)}`,
			color: "muted",
			priority: 20,
		});
	}

	segments.push({ name: "time", text: `🕒 ${formatTime()}`, color: "dim", priority: 10 });

	return fitSegments(segments, width, theme, runtime.rainbowPhase);
}

function fitSegments(segments: Segment[], width: number, theme: Theme, rainbowPhase: number): string {
	let fitted = [...segments];
	while (fitted.length > 1) {
		const rendered = joinSegments(fitted, theme, rainbowPhase);
		if (visibleWidth(rendered) <= width) return rendered;

		let removeIndex = 0;
		for (let index = 1; index < fitted.length; index += 1) {
			if (fitted[index]!.priority < fitted[removeIndex]!.priority) removeIndex = index;
		}
		fitted.splice(removeIndex, 1);
	}

	return truncateToWidth(joinSegments(fitted, theme, rainbowPhase), Math.max(1, width), "");
}

function joinSegments(segments: Segment[], theme: Theme, rainbowPhase: number): string {
	const separator = theme.fg("dim", " │ ");
	return segments.map((segment) => renderSegment(segment, theme, rainbowPhase)).join(separator);
}

function renderSegment(segment: Segment, theme: Theme, rainbowPhase: number): string {
	if (segment.color === "rainbow") return rainbowText(segment.text, theme, rainbowPhase);
	return theme.fg(segment.color, segment.text);
}

function rainbowText(text: string, theme: Theme, phase: number): string {
	let colorIndex = 0;
	return [...text]
		.map((character) => {
			if (/\s/.test(character)) return character;
			const hue = phase + colorIndex * 48;
			const [red, green, blue] = hsvToRgb(hue, 0.95, 1);
			colorIndex += 1;
			return `${foregroundAnsi(theme, red, green, blue)}${character}\x1b[39m`;
		})
		.join("");
}

function hsvToRgb(hue: number, saturation: number, value: number): [number, number, number] {
	const normalizedHue = ((hue % 360) + 360) % 360;
	const chroma = value * saturation;
	const sector = normalizedHue / 60;
	const x = chroma * (1 - Math.abs((sector % 2) - 1));
	const match = value - chroma;
	let red = 0;
	let green = 0;
	let blue = 0;

	if (sector < 1) {
		red = chroma;
		green = x;
	} else if (sector < 2) {
		red = x;
		green = chroma;
	} else if (sector < 3) {
		green = chroma;
		blue = x;
	} else if (sector < 4) {
		green = x;
		blue = chroma;
	} else if (sector < 5) {
		red = x;
		blue = chroma;
	} else {
		red = chroma;
		blue = x;
	}

	return [
		Math.round((red + match) * 255),
		Math.round((green + match) * 255),
		Math.round((blue + match) * 255),
	];
}

function foregroundAnsi(theme: Theme, red: number, green: number, blue: number): string {
	if (theme.getColorMode() === "truecolor") return `\x1b[38;2;${red};${green};${blue}m`;
	return `\x1b[38;5;${rgbToAnsi256(red, green, blue)}m`;
}

function rgbToAnsi256(red: number, green: number, blue: number): number {
	const cubeRed = Math.round((red / 255) * 5);
	const cubeGreen = Math.round((green / 255) * 5);
	const cubeBlue = Math.round((blue / 255) * 5);
	const cubeColor = 16 + 36 * cubeRed + 6 * cubeGreen + cubeBlue;
	const cubeDistance = Math.hypot(red - cubeRed * 51, green - cubeGreen * 51, blue - cubeBlue * 51);

	const gray = Math.round((red + green + blue) / 3);
	const grayLevel = Math.max(0, Math.min(23, Math.round((gray - 8) / 10)));
	const grayColor = 232 + grayLevel;
	const grayValue = 8 + grayLevel * 10;
	const grayDistance = Math.hypot(red - grayValue, green - grayValue, blue - grayValue);

	return cubeDistance <= grayDistance ? cubeColor : grayColor;
}

function parseGitStatus(output: string): GitStatus | undefined {
	const lines = output.split(/\r?\n/).filter(Boolean);
	const header = lines.find((line) => line.startsWith("## "));
	if (!header) return undefined;

	const status: GitStatus = {
		branch: parseBranch(header),
		ahead: parseCount(header, /ahead (\d+)/),
		behind: parseCount(header, /behind (\d+)/),
		staged: 0,
		modified: 0,
		untracked: 0,
		conflicts: 0,
	};

	for (const line of lines) {
		if (line.startsWith("## ") || line.length < 2) continue;
		const code = line.slice(0, 2);
		if (code === "??") {
			status.untracked += 1;
			continue;
		}
		if (code.includes("U") || code === "AA" || code === "DD") status.conflicts += 1;
		if (code[0] !== " " && code[0] !== ".") status.staged += 1;
		if (code[1] !== " " && code[1] !== ".") status.modified += 1;
	}

	return status;
}

function parseBranch(header: string): string | undefined {
	let value = header.slice(3).trim();
	if (value.startsWith("No commits yet on ")) value = value.slice("No commits yet on ".length);
	if (value === "HEAD (no branch)") return "detached";
	const tracking = value.indexOf("...");
	if (tracking >= 0) value = value.slice(0, tracking);
	const details = value.indexOf(" [");
	if (details >= 0) value = value.slice(0, details);
	return cleanText(value) || undefined;
}

function parseCount(value: string, pattern: RegExp): number {
	const match = pattern.exec(value);
	return match ? Number(match[1]) : 0;
}

function gitStatusEqual(left: GitStatus | undefined, right: GitStatus | undefined): boolean {
	if (!left || !right) return left === right;
	return (
		left.branch === right.branch &&
		left.ahead === right.ahead &&
		left.behind === right.behind &&
		left.staged === right.staged &&
		left.modified === right.modified &&
		left.untracked === right.untracked &&
		left.conflicts === right.conflicts
	);
}

function summarizeUsage(entries: readonly unknown[]): UsageTotals {
	const total: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		addUsage(total, entry.usage);
		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		addUsage(total, entry.message.usage);
	}
	return total;
}

function addUsage(total: UsageTotals, value: unknown): void {
	if (!isRecord(value)) return;
	total.input += numberValue(value.input);
	total.output += numberValue(value.output);
	total.cacheRead += numberValue(value.cacheRead);
	total.cacheWrite += numberValue(value.cacheWrite);
	if (isRecord(value.cost)) total.cost += numberValue(value.cost.total);
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatActivity(runtime: RuntimeState): string | undefined {
	const active = [...runtime.activeTools.entries()];
	if (active.length > 0) {
		const [name, count] = active[0]!;
		const extra = count > 1 ? `×${count}` : active.length > 1 ? `+${active.length - 1}` : "";
		return `⚙ ${cleanText(name)}${extra}`;
	}
	return runtime.isStreaming ? "💭 thinking" : undefined;
}

function thinkingColor(level: string): SegmentColor {
	switch (level) {
		case "off":
			return "thinkingOff";
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "rainbow";
		default:
			return "accent";
	}
}

function contextColor(percent: number | null | undefined): SegmentColor {
	if (percent === null || percent === undefined) return "dim";
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

function formatCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "?";
	if (value < 1_000) return `${Math.round(value)}`;
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatCost(value: number): string {
	if (!Number.isFinite(value)) return "?";
	return value < 1 ? value.toFixed(3) : value.toFixed(2);
}

function formatTime(): string {
	const now = new Date();
	return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function cleanText(value: string): string {
	return value
		.replace(ANSI_ESCAPE, "")
		.replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
