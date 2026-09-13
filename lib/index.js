import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
//#region src/branch.ts
/**
* Resolve the completed-turn boundary a review branch may be cut from.
*
* Mirrors the Host's fork rule exactly: the boundary is the first `turn/end` at
* or after the anchor, so the child keeps whole turns only. An anchor past the end
* of the log means "the newest completed turn", which is the only sensible reading
* when the anchor came from a live view that has since moved on.
*
* @param agent - agent whose session would be forked.
* @param anchorSeq - inclusive seq the review started at, when known.
* @returns the boundary seq, or `undefined` when no completed turn covers it.
*/
function resolveBranchBoundary(agent, anchorSeq) {
	const events = agent.session.snapshotEvents();
	if (anchorSeq === void 0) return events.findLast((event) => event.type === "turn/end")?.seq;
	const atOrAfter = events.find((event) => event.type === "turn/end" && event.seq >= anchorSeq);
	if (atOrAfter !== void 0) return atOrAfter.seq;
	if (anchorSeq > (events.at(-1)?.seq ?? -1)) return events.findLast((event) => event.type === "turn/end")?.seq;
}
//#endregion
//#region src/git.ts
/**
* Quote one argument for POSIX `sh`.
*
* Single quotes are literal in POSIX shell, so wrapping is safe for everything
* except a single quote itself, which is closed, escaped, and reopened. This is
* the standard `'\''` idiom. Windows is out of scope: the review flow's `gh`
* dependency is POSIX-oriented and the plugin documents that.
*/
function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
/**
* Run one command through the session's shell executor.
*
* `ctx.shell.resolve()` applies the implementation's own workdir default and
* timeout cap, so this never invents its own limits. Nonzero exits resolve
* normally, exactly as the `bash` tool sees them.
*/
async function runCommand(ctx, cwd, command, options = {}) {
	const request = {
		command,
		...cwd === void 0 ? {} : { workdir: cwd },
		...options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs },
		...options.signal === void 0 ? {} : { signal: options.signal }
	};
	const result = await ctx.shell.run(ctx.shell.resolve(request));
	return {
		code: result.exitCode,
		stdout: result.stdout.text,
		stderr: result.stderr.text
	};
}
/** Run one argv-style git invocation. */
function git(ctx, cwd, args, options) {
	return runCommand(ctx, cwd, `git ${args.map(shellQuote).join(" ")}`, options);
}
/** Run one argv-style `gh` invocation. */
function gh(ctx, cwd, args, options) {
	return runCommand(ctx, cwd, `gh ${args.map(shellQuote).join(" ")}`, options);
}
/**
* Whether `cwd` is inside a git work tree.
*
* `rev-parse --git-dir` succeeds in a bare repo and in a subdirectory of a work
* tree, which is the check pi used and the right one here: the review flow needs
* a repository, not a specific layout.
*/
async function isGitRepository(ctx, cwd) {
	const { code } = await git(ctx, cwd, ["rev-parse", "--git-dir"]);
	return code === 0;
}
/**
* The merge base between `HEAD` and `branch`.
*
* Tries the branch's upstream first (the PR-style comparison a feature branch
* usually wants) and falls back to the branch name itself. Returns `null` when
* neither resolves — the caller then uses the fallback prompt that asks the
* model to find the merge base, rather than guessing one here.
*/
async function getMergeBase(ctx, cwd, branch, options) {
	const upstream = await git(ctx, cwd, [
		"rev-parse",
		"--abbrev-ref",
		`${branch}@{upstream}`
	], options);
	if (upstream.code === 0 && upstream.stdout.trim() !== "") {
		const mergeBase = await git(ctx, cwd, [
			"merge-base",
			"HEAD",
			upstream.stdout.trim()
		], options);
		if (mergeBase.code === 0 && mergeBase.stdout.trim() !== "") return mergeBase.stdout.trim();
	}
	const direct = await git(ctx, cwd, [
		"merge-base",
		"HEAD",
		branch
	], options);
	if (direct.code === 0 && direct.stdout.trim() !== "") return direct.stdout.trim();
	return null;
}
/** Local branch names, in `git branch` order. Empty when not a repository. */
async function getLocalBranches(ctx, cwd) {
	const { stdout, code } = await git(ctx, cwd, ["branch", "--format=%(refname:short)"]);
	if (code !== 0) return [];
	return stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}
/** Whether the working tree has any change at all, including untracked files. */
async function hasUncommittedChanges(ctx, cwd) {
	const { stdout, code } = await git(ctx, cwd, ["status", "--porcelain"]);
	return code === 0 && stdout.trim() !== "";
}
/**
* Whether tracked files have staged or unstaged changes.
*
* Untracked files do not block a branch switch, so `??` lines are ignored —
* the distinction pi-review drew, and the reason a PR can be checked out over a
* tree that only holds new scratch files.
*/
async function hasPendingChanges(ctx, cwd) {
	const { stdout, code } = await git(ctx, cwd, ["status", "--porcelain"]);
	if (code !== 0) return false;
	return stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "").some((line) => !line.startsWith("??"));
}
/** The current branch name, or `null` on a detached HEAD. */
async function getCurrentBranch(ctx, cwd) {
	const { stdout, code } = await git(ctx, cwd, ["branch", "--show-current"]);
	if (code === 0 && stdout.trim() !== "") return stdout.trim();
	return null;
}
/**
* The repository's default branch.
*
* Prefers `origin/HEAD` — the only source that is right for a repository whose
* default is neither `main` nor `master` — then the two conventional names, then
* `main` as pi-review did.
*/
async function getDefaultBranch(ctx, cwd) {
	const { stdout, code } = await git(ctx, cwd, [
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		"--short"
	]);
	if (code === 0 && stdout.trim() !== "") return stdout.trim().replace(/^origin\//u, "");
	const branches = await getLocalBranches(ctx, cwd);
	if (branches.includes("main")) return "main";
	if (branches.includes("master")) return "master";
	return "main";
}
/**
* Extract a pull-request number from a number or a GitHub PR URL.
*
* Accepts `123`, `https://github.com/owner/repo/pull/123`, and the same URL
* without a scheme, matching pi-review's grammar.
*/
function parsePrReference(reference) {
	const trimmed = reference.trim();
	if (/^\d+$/u.test(trimmed)) {
		const value = Number.parseInt(trimmed, 10);
		return Number.isSafeInteger(value) && value > 0 ? value : null;
	}
	const match = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/u);
	if (match?.[1] !== void 0) {
		const value = Number.parseInt(match[1], 10);
		return Number.isSafeInteger(value) && value > 0 ? value : null;
	}
	return null;
}
/** Whether the GitHub CLI is installed. */
async function hasGithubCli(ctx, cwd) {
	const { code } = await gh(ctx, cwd, ["--version"]);
	return code === 0;
}
/** Whether `gh` holds a usable credential. */
async function isGithubAuthenticated(ctx, cwd) {
	const { code } = await gh(ctx, cwd, ["auth", "status"]);
	return code === 0;
}
/**
* Read one pull request's base branch, title, and head branch.
*
* Returns `null` on any failure — absent PR, no access, malformed JSON — because
* every one of those is reported to the user by the caller as the same
* actionable "could not fetch PR" outcome.
*/
async function getPrInfo(ctx, cwd, prNumber, options) {
	const { stdout, code } = await gh(ctx, cwd, [
		"pr",
		"view",
		String(prNumber),
		"--json",
		"baseRefName,title,headRefName"
	], options);
	if (code !== 0) return null;
	try {
		const data = JSON.parse(stdout);
		if (typeof data !== "object" || data === null) return null;
		const record = data;
		const baseBranch = record["baseRefName"];
		const title = record["title"];
		const headBranch = record["headRefName"];
		if (typeof baseBranch !== "string" || typeof title !== "string" || typeof headBranch !== "string") return null;
		return {
			baseBranch,
			title,
			headBranch
		};
	} catch {
		return null;
	}
}
/** Check out a pull request locally. Returns the failure text on nonzero exit. */
async function checkoutPr(ctx, cwd, prNumber, options) {
	const { stdout, stderr, code } = await gh(ctx, cwd, [
		"pr",
		"checkout",
		String(prNumber)
	], options);
	if (code !== 0) {
		const detail = stderr.trim() !== "" ? stderr : stdout;
		return {
			success: false,
			error: detail.trim() !== "" ? detail.trim() : "Failed to checkout PR"
		};
	}
	return { success: true };
}
/** The commit subject for one sha, or `undefined` when it does not resolve. */
async function getCommitTitle(ctx, cwd, sha, options) {
	const { stdout, code } = await git(ctx, cwd, [
		"log",
		"-1",
		"--format=%s",
		sha
	], options);
	if (code !== 0) return void 0;
	const title = stdout.trim();
	return title === "" ? void 0 : title;
}
//#endregion
//#region src/guidelines.ts
/**
* Project review guidelines and `/review` argument parsing.
*
* Both are ports of pi-review helpers. The guidelines loader keeps pi's search
* rule exactly — walk up from the working directory until a directory containing
* a `.pi` folder is found, and read `REVIEW_GUIDELINES.md` from *that* directory —
* but adds `.dsh` as an equally valid anchor, because a project using this plugin
* has no reason to carry a Pi marker file.
*
* @module dsh-review/guidelines
*/
/** Directories whose presence marks the root that owns the guidelines file. */
const ANCHOR_DIRECTORIES = [".pi", ".dsh"];
/** The guidelines filename, unchanged from pi-review. */
const REVIEW_GUIDELINES_FILENAME = "REVIEW_GUIDELINES.md";
/**
* Find and read the project's review guidelines.
*
* Walks up from `cwd` looking for a directory that holds an anchor directory
* (`.pi` or `.dsh`). The first such directory is treated as the project root, and
* `REVIEW_GUIDELINES.md` is read from it. This mirrors pi-review's rule that the
* guidelines sit *beside* the marker rather than inside it.
*
* Returns `undefined` when no anchor exists, the file is absent, it is empty
* after trimming, or it cannot be read — all of which mean "no project
* guidelines", which is an ordinary state rather than an error.
*
* @param cwd - directory to start from; a relative path resolves against the process cwd.
* @returns the trimmed guidelines text, or `undefined`.
*/
async function loadProjectReviewGuidelines(cwd) {
	let current = path.resolve(cwd);
	for (;;) {
		for (const anchor of ANCHOR_DIRECTORIES) {
			const anchorPath = path.join(current, anchor);
			if ((await stat(anchorPath).catch(() => null))?.isDirectory() !== true) continue;
			const guidelinesPath = path.join(current, REVIEW_GUIDELINES_FILENAME);
			if ((await stat(guidelinesPath).catch(() => null))?.isFile() !== true) return void 0;
			const content = await readFile(guidelinesPath, "utf8").catch(() => void 0);
			if (content === void 0) return void 0;
			const trimmed = content.trim();
			return trimmed === "" ? void 0 : trimmed;
		}
		const parent = path.dirname(current);
		if (parent === current) return void 0;
		current = parent;
	}
}
/**
* Split a command line into tokens, honouring single and double quotes.
*
* A verbatim port of pi-review's tokenizer: whitespace separates tokens, quotes
* group them, and a backslash escapes the next character *inside* quotes. This is
* intentionally not a full shell grammar — `/review` arguments are paths, branch
* names, and prose, not pipelines.
*/
function tokenizeArgs(value) {
	const tokens = [];
	let current = "";
	let quote = null;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char === void 0) break;
		if (quote !== null) {
			if (char === "\\" && index + 1 < value.length) {
				current += value[index + 1];
				index += 1;
				continue;
			}
			if (char === quote) {
				quote = null;
				continue;
			}
			current += char;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/u.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}
/**
* Parse `/review` arguments.
*
* Grammar, unchanged from pi-review:
*
* ```
* /review                                   → menu
* /review uncommitted                       → current changes
* /review branch <name>                     → against a base branch
* /review commit <sha> [title...]           → one commit
* /review pr <number|url>                   → a GitHub pull request
* /review folder <path> [path...]           → snapshot review
* /review <anything> --extra "<text>"       → adds a one-off instruction
* ```
*
* An unrecognized subcommand yields `menu` rather than an error, so a typo opens
* the picker instead of dead-ending — pi-review's behavior.
*/
function parseReviewArgs(rawInput) {
	if (rawInput.trim() === "") return { kind: "menu" };
	const rawParts = tokenizeArgs(rawInput.trim());
	const parts = [];
	let extraInstruction;
	for (let index = 0; index < rawParts.length; index += 1) {
		const part = rawParts[index];
		if (part === void 0) continue;
		if (part === "--extra") {
			const next = rawParts[index + 1];
			if (next === void 0) return {
				kind: "error",
				message: "Missing value for --extra"
			};
			extraInstruction = next;
			index += 1;
			continue;
		}
		if (part.startsWith("--extra=")) {
			extraInstruction = part.slice(8);
			continue;
		}
		parts.push(part);
	}
	const withExtra = (value) => extraInstruction === void 0 ? value : {
		...value,
		extraInstruction
	};
	const [subcommand, ...rest] = parts;
	if (subcommand === void 0) return withExtra({ kind: "menu" });
	switch (subcommand.toLowerCase()) {
		case "uncommitted": return withExtra({
			kind: "target",
			target: { type: "uncommitted" }
		});
		case "branch": {
			const branch = rest[0];
			if (branch === void 0) return withExtra({ kind: "menu" });
			return withExtra({
				kind: "target",
				target: {
					type: "baseBranch",
					branch
				}
			});
		}
		case "commit": {
			const sha = rest[0];
			if (sha === void 0) return withExtra({ kind: "menu" });
			const title = rest.slice(1).join(" ");
			return withExtra({
				kind: "target",
				target: title === "" ? {
					type: "commit",
					sha
				} : {
					type: "commit",
					sha,
					title
				}
			});
		}
		case "folder": {
			const paths = parseReviewPaths(rest.join("\n"));
			if (paths.length === 0) return withExtra({ kind: "menu" });
			return withExtra({
				kind: "target",
				target: {
					type: "folder",
					paths
				}
			});
		}
		case "pr": {
			const reference = rest[0];
			if (reference === void 0) return withExtra({ kind: "menu" });
			return withExtra({
				kind: "pullRequest",
				reference
			});
		}
		default: return withExtra({ kind: "menu" });
	}
}
/**
* Split a folder-review argument into individual paths.
*
* Commas and newlines separate, matching pi-review: users type both `src docs`
* and `src, docs` for the same intent.
*/
function parseReviewPaths(value) {
	return value.split(/[,\n]/u).map((entry) => entry.trim()).filter((entry) => entry !== "");
}
//#endregion
//#region src/prompts.ts
/**
* Review prompts and the review rubric.
*
* Every constant here is a verbatim port of `@earendil-works/pi-review`
* (`review.ts`); only the surrounding module structure changed. Keeping the
* wording byte-identical means a review produced by this plugin is the same
* review the Pi extension would have produced, which is the entire point of the
* port.
*
* @module dsh-review/prompts
*/
/** Review the current working tree: staged, unstaged, and untracked files. */
const UNCOMMITTED_PROMPT = "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";
/** Base-branch review when the merge base is known up front. */
const BASE_BRANCH_PROMPT_WITH_MERGE_BASE = "Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Provide prioritized, actionable findings.";
/**
* Base-branch review when no merge base could be resolved.
*
* The model is asked to derive it itself, including through the branch's
* upstream, because this plugin's own resolution already failed — repeating the
* identical lookup here would fail the same way.
*/
const BASE_BRANCH_PROMPT_FALLBACK = "Review the code changes against the base branch '{branch}'. Start by finding the merge diff between the current branch and {branch}'s upstream e.g. (`git merge-base HEAD \"$(git rev-parse --abbrev-ref \"{branch}@{upstream}\")\"`), then run `git diff` against that SHA to see what changes we would merge into the {branch} branch. Provide prioritized, actionable findings.";
/** Single-commit review, with the commit subject supplied. */
const COMMIT_PROMPT_WITH_TITLE = "Review the code changes introduced by commit {sha} (\"{title}\"). Provide prioritized, actionable findings.";
/** Single-commit review, subject unknown. */
const COMMIT_PROMPT = "Review the code changes introduced by commit {sha}. Provide prioritized, actionable findings.";
/** Pull-request review when the merge base is known up front. */
const PULL_REQUEST_PROMPT = "Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes that would be merged. Provide prioritized, actionable findings.";
/** Pull-request review when no merge base could be resolved. */
const PULL_REQUEST_PROMPT_FALLBACK = "Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. Start by finding the merge base between the current branch and {baseBranch} (e.g., `git merge-base HEAD {baseBranch}`), then run `git diff` against that SHA to see the changes that would be merged. Provide prioritized, actionable findings.";
/**
* Snapshot review of explicit paths.
*
* Deliberately not a diff: the user named paths, not a change set, so the model
* reads the files as they are rather than as a patch.
*/
const FOLDER_REVIEW_PROMPT = "Review the code in the following paths: {paths}. This is a snapshot review (not a diff). Read the files directly in these paths and provide prioritized, actionable findings.";
/**
* The detailed review rubric, ported verbatim from pi-review (itself adapted
* from Codex's `review_prompt.md`).
*
* This is the largest piece of prompt text in the plugin and the reason the port
* keeps the wording byte-identical: it encodes the review standard, and
* paraphrasing it would silently change what gets flagged.
*/
const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.
10. Treat silent local error recovery (especially parsing/IO/network fallbacks) as high-signal review candidates unless there is explicit boundary-level justification.
11. Violate the clean-code guidelines below.
12. Introduce error handling that conflicts with the fail-fast guidelines below.

## Clean-code guidelines

1. Check whether each newly added function duplicates existing functionality elsewhere in the codebase. Flag actual duplication and identify the existing implementation.
2. Flag one-off helper functions that add indirection without improving clarity or reuse (for example, \`isRecord\` or \`asString\`).
3. Flag abstractions introduced without a concrete need in the reviewed change, including wrappers created only for hypothetical future use.
4. Flag defensive checks or fallback behavior that mask programming errors, especially when callers already guarantee the relevant invariants.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Surface critical non-blocking human callouts (migrations, dependency churn, auth/permissions, compatibility, destructive operations) at the end.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Treat back pressure handling as critical to system stability.
4. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
5. Ensure that errors are always checked against codes or stable identifiers, never error messages.

## Fail-fast error handling (strict)

When reviewing added or modified error handling, default to fail-fast behavior.

1. Evaluate every new or changed \`try/catch\`: identify what can fail and why local handling is correct at that exact layer.
2. Prefer propagation over local recovery. If the current scope cannot fully recover while preserving correctness, rethrow (optionally with context) instead of returning fallbacks.
3. Flag catch blocks that hide failure signals (e.g. returning \`null\`/\`[]\`/\`false\`, swallowing JSON parse failures, logging-and-continue, or “best effort” silent recovery).
4. JSON parsing/decoding should fail loudly by default. Quiet fallback parsing is only acceptable with an explicit compatibility requirement and clear tested behavior.
5. Boundary handlers (HTTP routes, CLI entrypoints, supervisors) may translate errors, but must not pretend success or silently degrade.
6. If a catch exists only to satisfy lint/style without real handling, treat it as a bug.
7. When uncertain, prefer crashing fast over silent degradation.

## Required human callouts (non-blocking, at the very end)

After findings/verdict, you MUST append this final section:

## Human Reviewer Callouts (Non-Blocking)

Include only applicable callouts (no yes/no lines):

- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>
- **This change adds or removes feature flags:** <feature flags changed> (call out re-use of dormant feature flags!)
- **This change changes configuration defaults:** <config var changed>

Rules for this section:
1. These are informational callouts for the human reviewer, not fix items.
2. Do not include them in Findings unless there is an independent defect.
3. These callouts alone must not change the verdict.
4. Only include callouts that apply to the reviewed change.
5. Keep each emitted callout bold exactly as written.
6. If none apply, write "- (none)".

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

## Output format

Provide your findings in a clear, structured format:
1. List each finding with its priority tag, file location, and explanation.
2. Findings must reference locations that overlap with the actual diff — don't flag pre-existing code.
3. Keep line references as short as possible (avoid ranges over 5-10 lines; pick the most suitable subrange).
4. Provide an overall verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
5. Ignore trivial style issues unless they obscure meaning or violate documented standards.
6. Do not generate a full PR fix — only flag issues and optionally provide short suggestion blocks.
7. End with the required "Human Reviewer Callouts (Non-Blocking)" section and all applicable bold callouts (no yes/no).

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue. Then append the required non-blocking callouts section.`;
/**
* Handoff instructions for summarizing a review branch on the way back to the
* origin session. Ported verbatim from pi-review.
*/
const REVIEW_SUMMARY_PROMPT = `We are leaving a code-review branch and returning to the main coding branch.
Create a structured handoff that can be used immediately to implement fixes.

You MUST summarize the review that happened in this branch so findings can be acted on.
Do not omit findings: include every actionable issue that was identified.

Required sections (in order):

## Review Scope
- What was reviewed (files/paths, changes, and scope)

## Verdict
- "correct" or "needs attention"

## Findings
For EACH finding, include:
- Priority tag ([P0]..[P3]) and short title
- File location (\`path/to/file.ext:line\`)
- Why it matters (brief)
- What should change (brief, actionable)

## Fix Queue
1. Ordered implementation checklist (highest priority first)

## Constraints & Preferences
- Any constraints or preferences mentioned during review
- Or "(none)"

## Human Reviewer Callouts (Non-Blocking)
Include only applicable callouts (no yes/no lines):
- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>

If none apply, write "- (none)".

These are informational callouts for humans and are not fix items by themselves.

Preserve exact file paths, function names, and error messages where available.`;
/**
* Follow-up prompt that turns a review summary into an implementation task.
* Ported verbatim from pi-review.
*/
const REVIEW_FIX_FINDINGS_PROMPT = `Use the latest review summary in this session and implement the review findings now.

Instructions:
1. Treat the summary's Findings/Fix Queue as a checklist.
2. Fix in priority order: P0, P1, then P2 (include P3 if quick and safe).
3. If a finding is invalid/already fixed/not possible right now, briefly explain why and continue.
4. Treat "Human Reviewer Callouts (Non-Blocking)" as informational only; do not convert them into fix tasks unless there is a separate explicit finding.
5. Follow fail-fast error handling: do not add local catch/fallback recovery unless this scope is an explicit boundary that can safely translate the failure.
6. If you add or keep a \`try/catch\`, explain the expected failure mode and either rethrow with context or return a boundary-safe error response.
7. JSON parsing/decoding should fail loudly by default; avoid silent fallback parsing.
8. Run relevant tests/checks for touched code where practical.
9. End with: fixed items, deferred/skipped items (with reasons), and verification results.`;
//#endregion
//#region src/resolve.ts
/** Guidance shown when `gh` is missing, unchanged from pi-review. */
const GH_SETUP_INSTRUCTIONS = "Install GitHub CLI (`gh`) from https://cli.github.com/ (macOS: `brew install gh`), then sign in with `gh auth login` and verify with `gh auth status`.";
/** Message shown when a PR cannot be checked out over local edits. */
const PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE = "Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.";
/**
* Enrich a directly-parsed target with the git facts its prompt needs.
*
* Only two of the five modes need any lookup: a base-branch review wants the
* merge base so the prompt can name an exact SHA, and a commit review wants the
* subject. Both lookups are optional — their absence selects the fallback
* wording rather than failing, which is what keeps review working in a shallow
* clone or a repository with no upstream.
*/
async function resolveDirectTarget(ctx, cwd, direct, options = {}) {
	switch (direct.type) {
		case "uncommitted": return {
			kind: "ok",
			target: { type: "uncommitted" }
		};
		case "baseBranch": {
			const mergeBaseSha = await getMergeBase(ctx, cwd, direct.branch, options);
			return {
				kind: "ok",
				target: mergeBaseSha === null ? {
					type: "baseBranch",
					branch: direct.branch
				} : {
					type: "baseBranch",
					branch: direct.branch,
					mergeBaseSha
				}
			};
		}
		case "commit": {
			if (direct.title !== void 0) return {
				kind: "ok",
				target: {
					type: "commit",
					sha: direct.sha,
					title: direct.title
				}
			};
			const title = await getCommitTitle(ctx, cwd, direct.sha, options);
			return {
				kind: "ok",
				target: title === void 0 ? {
					type: "commit",
					sha: direct.sha
				} : {
					type: "commit",
					sha: direct.sha,
					title
				}
			};
		}
		case "folder": return {
			kind: "ok",
			target: {
				type: "folder",
				paths: direct.paths
			}
		};
	}
}
/**
* Validate GitHub access and read PR metadata, without checking anything out.
*
* Split from the checkout itself because pi-review asked a different question at
* each point: access and metadata are checked first so a missing `gh` fails
* before the user is asked to confirm anything, and the clean-tree check runs
* again immediately before the checkout, since the first check can be minutes
* old by then.
*/
async function resolvePullRequestInfo(ctx, cwd, reference, options = {}) {
	if (!await hasGithubCli(ctx, cwd)) return {
		kind: "error",
		message: `PR review requires GitHub CLI (\`gh\`). ${GH_SETUP_INSTRUCTIONS}`
	};
	if (!await isGithubAuthenticated(ctx, cwd)) return {
		kind: "error",
		message: "GitHub CLI is installed, but you are not signed in. Run `gh auth login`, then verify with `gh auth status`."
	};
	const prNumber = parsePrReference(reference);
	if (prNumber === null) return {
		kind: "error",
		message: "Invalid PR reference. Enter a number or GitHub PR URL."
	};
	if (await hasPendingChanges(ctx, cwd)) return {
		kind: "blocked",
		message: PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE
	};
	const info = await getPrInfo(ctx, cwd, prNumber, options);
	if (info === null) return {
		kind: "error",
		message: `Could not fetch PR #${prNumber}. Make sure it exists and your GitHub auth has access (check with \`gh auth status\`).`
	};
	const mergeBaseSha = await getMergeBase(ctx, cwd, info.baseBranch, options);
	return {
		kind: "ok",
		info,
		target: mergeBaseSha === null ? {
			type: "pullRequest",
			prNumber,
			baseBranch: info.baseBranch,
			title: info.title
		} : {
			type: "pullRequest",
			prNumber,
			baseBranch: info.baseBranch,
			title: info.title,
			mergeBaseSha
		}
	};
}
/**
* Whether tracked files have changes that would block a PR checkout.
*
* Exposed separately so the caller can re-check immediately before checking out,
* which is the check that actually protects the user's work.
*/
async function prCheckoutBlocked(ctx, cwd) {
	return hasPendingChanges(ctx, cwd);
}
//#endregion
//#region src/targets.ts
/**
* Review targets: what a review is *about*, and the prompt that asks for it.
*
* Ported from pi-review's `ReviewTarget` union, `buildReviewPrompt`, and
* `getUserFacingHint`, with two deliberate changes:
*
* 1. `buildReviewPrompt` is pure here. pi-review called `git` inside it to
*    resolve the merge base; that work now happens while the target is being
*    resolved, so the prompt builder has no I/O and can be tested directly.
* 2. The PR variant carries its base branch and title, which pi-review had
*    already fetched by the time it built the prompt.
*
* @module dsh-review/targets
*/
/** Fill every `{name}` placeholder in one prompt template. */
function fill(template, values) {
	return template.replace(/\{(\w+)\}/gu, (match, key) => values[key] ?? match);
}
/**
* Build the focus prompt for one target.
*
* The merge-base branches are the reason this is a function rather than a table:
* when the merge base is known the prompt hands the model an exact SHA to diff,
* and when it is not the prompt asks the model to derive it. Sending the
* exact-SHA wording without a SHA would produce a prompt that names a commit
* that does not exist.
*/
function buildReviewPrompt(target) {
	switch (target.type) {
		case "uncommitted": return UNCOMMITTED_PROMPT;
		case "baseBranch": return target.mergeBaseSha === void 0 ? fill(BASE_BRANCH_PROMPT_FALLBACK, { branch: target.branch }) : fill(BASE_BRANCH_PROMPT_WITH_MERGE_BASE, {
			baseBranch: target.branch,
			mergeBaseSha: target.mergeBaseSha
		});
		case "commit": return target.title === void 0 ? fill(COMMIT_PROMPT, { sha: target.sha }) : fill(COMMIT_PROMPT_WITH_TITLE, {
			sha: target.sha,
			title: target.title
		});
		case "pullRequest": return target.mergeBaseSha === void 0 ? fill(PULL_REQUEST_PROMPT_FALLBACK, {
			prNumber: String(target.prNumber),
			title: target.title,
			baseBranch: target.baseBranch
		}) : fill(PULL_REQUEST_PROMPT, {
			prNumber: String(target.prNumber),
			title: target.title,
			baseBranch: target.baseBranch,
			mergeBaseSha: target.mergeBaseSha
		});
		case "folder": return fill(FOLDER_REVIEW_PROMPT, { paths: target.paths.join(", ") });
	}
}
/** Short human label for one target, used in notifications and dialogs. */
function describeTarget(target) {
	switch (target.type) {
		case "uncommitted": return "current changes";
		case "baseBranch": return `changes against '${target.branch}'`;
		case "commit": {
			const short = target.sha.slice(0, 7);
			return target.title === void 0 ? `commit ${short}` : `commit ${short}: ${target.title}`;
		}
		case "pullRequest": {
			const title = target.title.length > 30 ? `${target.title.slice(0, 27)}...` : target.title;
			return `PR #${target.prNumber}: ${title}`;
		}
		case "folder": {
			const joined = target.paths.join(", ");
			return joined.length > 40 ? `folders: ${joined.slice(0, 37)}...` : `folders: ${joined}`;
		}
	}
}
/**
* Assemble the complete prompt sent to the model for one review.
*
* The order is pi-review's and matters: the rubric establishes the standard,
* the focus narrows it to this target, then the three optional instruction
* sources layer on top in increasing specificity — shared custom instructions,
* the one-off `--extra`, and finally the project's own guidelines, which the
* rubric explicitly says override it.
*/
function composeReviewMessage(options) {
	let message = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${buildReviewPrompt(options.target)}`;
	if (options.customInstructions !== void 0 && options.customInstructions !== "") message += `\n\nShared custom review instructions (applies to all reviews):\n\n${options.customInstructions}`;
	if (options.extraInstruction !== void 0 && options.extraInstruction.trim() !== "") message += `\n\nAdditional user-provided review instruction:\n\n${options.extraInstruction.trim()}`;
	if (options.projectGuidelines !== void 0 && options.projectGuidelines !== "") message += `\n\nThis project has additional instructions for code reviews:\n\n${options.projectGuidelines}`;
	return message;
}
//#endregion
//#region src/version.ts
/** Version of this plugin, as published. */
const DSH_REVIEW_VERSION = "0.1.0";
//#endregion
//#region src/web.ts
/** Same-origin path serving the review client half's state. */
const DSH_REVIEW_STATUS_PATH = "/dsh-review/status";
/**
* Whether the request is addressed to the loopback interface.
*
* The `Host` header is the check that matters: it is what a DNS-rebinding page
* cannot forge, since its own hostname appears there rather than the loopback
* address it is trying to reach.
*/
function isLoopbackRequest(req) {
	const host = req.headers.host;
	if (host === void 0) return false;
	const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}
/** Write one JSON response. */
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store"
	});
	res.end(payload);
}
/**
* Register the status route.
*
* `webServer` is optional — a headless profile serves no browser — so the caller
* reaches this through `ctx.inject(['webServer'], …)` and nothing breaks when the
* service is absent.
*
* @param ctx - context carrying `webServer`.
* @param readStatus - callback producing the current status document.
* @returns the disposer that unregisters the route.
*/
function registerReviewStatusRoute(ctx, readStatus) {
	return ctx.webServer.register({
		kind: "exact",
		path: DSH_REVIEW_STATUS_PATH,
		handler: (req, res) => {
			if (!isLoopbackRequest(req)) {
				json(res, 403, { error: "forbidden" });
				return;
			}
			if (req.method !== "GET") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			json(res, 200, readStatus());
		}
	});
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "dsh-review";
/**
* Services the review workflow needs.
*
* `commands` and `shell` are hard dependencies: without the registry there is no
* `/review`, and without a shell executor no target can be resolved. Everything
* else — settings, the user-question channel, the session controller, the web
* server — is reached through `ctx.get` or `ctx.inject`, because a headless
* profile legitimately composes none of them and the plugin should degrade
* rather than fail to load.
*/
const inject = ["commands", "shell"];
/** Settings namespace owning the plugin's user-editable configuration. */
const DSH_REVIEW_SETTINGS_NS = "dsh-review";
const Config = z.object({
	customInstructions: z.string().description("Shared review instructions appended to every review (all modes)"),
	branchReview: z.boolean().default(true).description("Run each review in a forked session so /end-review can return to the original conversation")
});
/**
* Active reviews, keyed by the session running them.
*
* Keyed rather than held in one module-level slot (which is what pi-review did).
* Pi ran one conversation per process, so a single slot was correct there; a DSH
* host serves many concurrent sessions, and one slot would let a session's
* `/end-review` clear another session's review.
*/
const activeReviews = /* @__PURE__ */ new Map();
/**
* The session the browser should be displaying, and the token identifying that
* instruction.
*
* The host cannot switch the browser's session — session selection is client
* state — so it publishes the intent here and the client half acts on it. The
* token makes the handoff idempotent: a client that polls twice, or reloads
* mid-review, acts on each instruction exactly once.
*/
let focus;
let focusSeq = 0;
/** Publish a new focus instruction. */
function setFocus(sessionId, reason) {
	focusSeq += 1;
	focus = {
		sessionId: String(sessionId),
		token: focusSeq,
		reason
	};
}
/** Dialog ids, named so answers are matched by label rather than position. */
const MODE_QUESTION_ID = "review-mode";
const END_QUESTION_ID = "end-review-action";
const BRANCH_QUESTION_ID = "review-branch";
const COMMIT_QUESTION_ID = "review-commit";
const PR_QUESTION_ID = "review-pr";
const FOLDER_QUESTION_ID = "review-folder";
/** Option labels. */
const MODE_LABELS = {
	uncommitted: "Review uncommitted changes",
	baseBranch: "Review against a base branch",
	commit: "Review a commit",
	pullRequest: "Review a pull request (GitHub)",
	folder: "Review folders or files (snapshot)"
};
const END_LABELS = {
	returnOnly: "Return only",
	returnAndSummarize: "Return and summarize",
	returnAndFix: "Return and fix findings"
};
/**
* Ask one single-choice question.
*
* A dismissed dialog is an ordinary cancellation; a missing channel is reported
* as such. Any other failure also reads as a dismissal, because a review that
* cannot ask is a review the user did not confirm.
*/
async function askChoice(ctx, agent, question, signal) {
	const service = ctx.get("userQuestions");
	if (service === void 0) return { kind: "unavailable" };
	try {
		const item = (await service.ask({
			questions: [question],
			agent,
			signal
		})).answers.find((entry) => entry.id === question.id);
		if (item === void 0) return { kind: "dismissed" };
		if (item.selected.length > 0) return {
			kind: "answered",
			value: item.selected[0]
		};
		const custom = item.custom?.trim();
		return custom === void 0 || custom === "" ? { kind: "dismissed" } : {
			kind: "answered",
			value: custom
		};
	} catch (error) {
		if (error instanceof UserQuestionError) return { kind: "dismissed" };
		throw error;
	}
}
/**
* Ask for free text.
*
* The user-questions protocol has no dedicated text prompt, so this is a
* single-question request with no options: the UI renders an input, and the
* answer arrives as `custom`.
*/
async function askText(ctx, agent, question, signal) {
	return askChoice(ctx, agent, question, signal);
}
/** Message shown when a command needs a dialog that this profile does not compose. */
const NO_DIALOG_MESSAGE = "This profile has no interactive question channel, so the review picker cannot be shown. Name the target directly instead, for example: /review uncommitted, /review branch main, /review commit HEAD~1, /review pr 123, or /review folder src.";
/** The working directory recorded by one agent's session, when it recorded one. */
function sessionCwd(agent) {
	return agent.session.header.cwd;
}
/**
* Determine which mode the picker should preselect.
*
* pi-review's heuristic, kept exactly: uncommitted changes are the most likely
* intent, a feature branch suggests a base-branch comparison, and otherwise a
* specific commit is the remaining meaningful choice.
*/
async function getSmartDefault(ctx, cwd) {
	if (await hasUncommittedChanges(ctx, cwd)) return "uncommitted";
	const current = await getCurrentBranch(ctx, cwd);
	const fallback = await getDefaultBranch(ctx, cwd);
	if (current !== null && current !== fallback) return "baseBranch";
	return "commit";
}
/**
* Create the review session for one review, or fall back to the current one.
*
* Forking is delegated to the Session Controller because that is the only
* component that composes a child correctly — it resolves the preset, attaches
* the workspace, and seeds the completed-turn prefix. When the controller is
* absent (a headless or minimal profile) the review runs in place rather than
* failing, which is the same behavior as `branchReview: false`.
*
* @returns the session the review runs in, and whether it was forked.
*/
async function createReviewSession(ctx, agent, anchorSeq) {
	const controller = ctx.get("sessionController");
	if (controller === void 0) return {
		sessionId: agent.session.id,
		forked: false
	};
	const boundary = resolveBranchBoundary(agent, anchorSeq);
	if (boundary === void 0) return {
		sessionId: agent.session.id,
		forked: false
	};
	try {
		return {
			sessionId: (await controller.fork({
				sessionId: agent.session.id,
				atSeq: boundary
			})).sessionId,
			forked: true
		};
	} catch (error) {
		ctx.logger?.warn("dsh-review: could not fork a review session; reviewing in place", error);
		return {
			sessionId: agent.session.id,
			forked: false
		};
	}
}
/**
* Deliver one prompt to whichever agent owns the review session.
*
* The invoking agent is passed in rather than looked up: when the review runs in
* place, that agent *is* the review agent, and resolving it again through
* `ctx.agents` would both depend on a service the plugin does not require and
* reject the exact live instance the command handler was already handed. The
* registry is consulted only for a forked session, which is a different agent by
* construction.
*/
function deliverReviewPrompt(ctx, invokingAgent, reviewSessionId, message) {
	const target = reviewSessionId === invokingAgent.session.id ? invokingAgent : ctx.get("agents")?.get(reviewSessionId);
	if (target === void 0) return false;
	target.followup(createUserMessage({
		content: [{
			type: "text",
			text: message
		}],
		source: {
			kind: "plugin",
			plugin: name
		}
	}));
	return true;
}
/** Register `/review`. */
function registerReviewCommand(ctx, config) {
	ctx.commands.register({
		name: "review",
		description: "Review code changes (PR, uncommitted, branch, commit, or folders)",
		input: { hint: "[uncommitted|branch <name>|commit <sha>|pr <number|url>|folder <paths>] [--extra \"text\"]" },
		handler: async (invocation) => {
			const { agent, rawInput, signal } = invocation;
			const cwd = sessionCwd(agent);
			if (!await isGitRepository(ctx, cwd)) return {
				kind: "error",
				text: "Not a git repository. /review needs a Git working tree."
			};
			const parsed = parseReviewArgs(rawInput);
			if (parsed.kind === "error") return {
				kind: "error",
				text: parsed.message
			};
			const settings = config();
			const existing = activeReviews.get(agent.session.id);
			if (existing !== void 0) return {
				kind: "error",
				text: `A review is already active (${existing.label}). Use /end-review to finish it first.`
			};
			for (const review of activeReviews.values()) if (review.reviewSessionId === agent.session.id) return {
				kind: "error",
				text: `This session is the review branch for ${review.label}. Use /end-review to finish it.`
			};
			const extraInstruction = parsed.kind === "menu" ? void 0 : parsed.extraInstruction;
			/** Resolve one directly-named target into a full review target. */
			const fromDirect = async (direct) => {
				const resolved = await resolveDirectTarget(ctx, cwd, direct, { signal });
				return resolved.kind === "error" ? { error: resolved.message } : { target: resolved.target };
			};
			/** Validate GitHub access, confirm a clean tree, and check the PR out. */
			const fromPullRequest = async (reference) => {
				const resolved = await resolvePullRequestInfo(ctx, cwd, reference, { signal });
				if (resolved.kind === "error") return { error: resolved.message };
				if (resolved.kind === "blocked") return { error: resolved.message };
				if (resolved.target.type !== "pullRequest") return { error: "Internal error: the PR target did not resolve." };
				if (await prCheckoutBlocked(ctx, cwd)) return { error: PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE };
				const checkedOut = await checkoutPr(ctx, cwd, resolved.target.prNumber, { signal });
				if (!checkedOut.success) return { error: `Failed to checkout PR: ${checkedOut.error}` };
				return { target: resolved.target };
			};
			let target;
			if (parsed.kind === "target") {
				const outcome = await fromDirect(parsed.target);
				if ("error" in outcome) return {
					kind: "error",
					text: outcome.error
				};
				target = outcome.target;
			} else if (parsed.kind === "pullRequest") {
				const outcome = await fromPullRequest(parsed.reference);
				if ("error" in outcome) return {
					kind: "error",
					text: outcome.error
				};
				target = outcome.target;
			}
			if (target === void 0) {
				const suggested = await getSmartDefault(ctx, cwd);
				const chosen = await askChoice(ctx, agent, {
					id: MODE_QUESTION_ID,
					header: "Code review",
					question: "What should be reviewed?",
					detail: `Suggested: ${MODE_LABELS[suggested]}`,
					options: [
						{ label: MODE_LABELS.uncommitted },
						{
							label: MODE_LABELS.baseBranch,
							description: "Local branch comparison"
						},
						{ label: MODE_LABELS.commit },
						{
							label: MODE_LABELS.pullRequest,
							description: "Checked out locally with gh"
						},
						{
							label: MODE_LABELS.folder,
							description: "Snapshot, not a diff"
						}
					]
				}, signal);
				if (chosen.kind === "unavailable") return {
					kind: "error",
					text: NO_DIALOG_MESSAGE
				};
				if (chosen.kind === "dismissed") return {
					kind: "success",
					text: "Review cancelled."
				};
				if (chosen.value === MODE_LABELS.uncommitted) target = { type: "uncommitted" };
				else if (chosen.value === MODE_LABELS.baseBranch) {
					const branch = await askText(ctx, agent, {
						id: BRANCH_QUESTION_ID,
						header: "Base branch",
						question: "Which branch should the changes be compared against?",
						detail: "For example: main"
					}, signal);
					if (branch.kind === "unavailable") return {
						kind: "error",
						text: NO_DIALOG_MESSAGE
					};
					if (branch.kind === "dismissed") return {
						kind: "success",
						text: "Review cancelled."
					};
					const outcome = await fromDirect({
						type: "baseBranch",
						branch: branch.value
					});
					if ("error" in outcome) return {
						kind: "error",
						text: outcome.error
					};
					target = outcome.target;
				} else if (chosen.value === MODE_LABELS.commit) {
					const sha = await askText(ctx, agent, {
						id: COMMIT_QUESTION_ID,
						header: "Commit",
						question: "Which commit should be reviewed?",
						detail: "A commit SHA, or a ref such as HEAD~1"
					}, signal);
					if (sha.kind === "unavailable") return {
						kind: "error",
						text: NO_DIALOG_MESSAGE
					};
					if (sha.kind === "dismissed") return {
						kind: "success",
						text: "Review cancelled."
					};
					const outcome = await fromDirect({
						type: "commit",
						sha: sha.value
					});
					if ("error" in outcome) return {
						kind: "error",
						text: outcome.error
					};
					target = outcome.target;
				} else if (chosen.value === MODE_LABELS.pullRequest) {
					const reference = await askText(ctx, agent, {
						id: PR_QUESTION_ID,
						header: "Pull request",
						question: "Which pull request should be reviewed?",
						detail: "A number, or a GitHub PR URL"
					}, signal);
					if (reference.kind === "unavailable") return {
						kind: "error",
						text: NO_DIALOG_MESSAGE
					};
					if (reference.kind === "dismissed") return {
						kind: "success",
						text: "Review cancelled."
					};
					const outcome = await fromPullRequest(reference.value);
					if ("error" in outcome) return {
						kind: "error",
						text: outcome.error
					};
					target = outcome.target;
				} else if (chosen.value === MODE_LABELS.folder) {
					const answer = await askText(ctx, agent, {
						id: FOLDER_QUESTION_ID,
						header: "Folders or files",
						question: "Which paths should be reviewed?",
						detail: "Comma-separated. This is a snapshot review, not a diff."
					}, signal);
					if (answer.kind === "unavailable") return {
						kind: "error",
						text: NO_DIALOG_MESSAGE
					};
					if (answer.kind === "dismissed") return {
						kind: "success",
						text: "Review cancelled."
					};
					const paths = answer.value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
					if (paths.length === 0) return {
						kind: "success",
						text: "Review cancelled."
					};
					target = {
						type: "folder",
						paths
					};
				} else return {
					kind: "success",
					text: "Review cancelled."
				};
			}
			const label = describeTarget(target);
			const customInstructions = settings.customInstructions?.trim();
			const projectGuidelines = cwd === void 0 ? void 0 : await loadProjectReviewGuidelines(cwd);
			const message = composeReviewMessage({
				target,
				customInstructions: customInstructions === "" ? void 0 : customInstructions,
				extraInstruction,
				projectGuidelines
			});
			const session = settings.branchReview !== false ? await createReviewSession(ctx, agent, void 0) : {
				sessionId: agent.session.id,
				forked: false
			};
			activeReviews.set(session.sessionId, {
				reviewSessionId: session.sessionId,
				originSessionId: agent.session.id,
				target,
				label
			});
			if (!deliverReviewPrompt(ctx, agent, session.sessionId, message)) {
				activeReviews.delete(session.sessionId);
				return {
					kind: "error",
					text: "The review session could not be started. Try again, or set `branchReview: false` for this plugin to review in place."
				};
			}
			if (session.forked) {
				setFocus(session.sessionId, "review");
				return {
					kind: "success",
					text: [
						`Starting review: ${label}`,
						"A review branch was created and the browser is switching to it.",
						"Finish with /end-review, which returns you to this conversation."
					].join("\n")
				};
			}
			return {
				kind: "success",
				text: [
					`Starting review: ${label}`,
					"Reviewing in this session (session branching is unavailable here).",
					"Use /end-review when it finishes."
				].join("\n")
			};
		}
	});
}
/** Register `/end-review`. */
function registerEndReviewCommand(ctx, config) {
	ctx.commands.register({
		name: "end-review",
		description: "Finish the active review and act on its findings",
		handler: async (invocation) => {
			const { agent, signal } = invocation;
			const review = activeReviews.get(agent.session.id);
			if (review === void 0) return {
				kind: "error",
				text: "No review is active in this session. Start one with /review."
			};
			const choice = await askChoice(ctx, agent, {
				id: END_QUESTION_ID,
				header: "Finish review",
				question: `How should the review of ${review.label} be finished?`,
				options: [
					{
						label: END_LABELS.returnAndSummarize,
						description: "Summarize the findings so they can be acted on."
					},
					{
						label: END_LABELS.returnAndFix,
						description: "Summarize the findings, then queue a follow-up turn that implements them."
					},
					{
						label: END_LABELS.returnOnly,
						description: "Finish the review without summarizing."
					}
				]
			}, signal);
			if (choice.kind === "unavailable") return {
				kind: "error",
				text: NO_DIALOG_MESSAGE
			};
			if (choice.kind === "dismissed") return {
				kind: "success",
				text: "Cancelled. Use /end-review to try again."
			};
			const wantsSummary = choice.value === END_LABELS.returnAndSummarize || choice.value === END_LABELS.returnAndFix;
			if (wantsSummary) {
				deliverReviewPrompt(ctx, agent, review.reviewSessionId, REVIEW_SUMMARY_PROMPT);
				if (choice.value === END_LABELS.returnAndFix) deliverReviewPrompt(ctx, agent, review.reviewSessionId, REVIEW_FIX_FINDINGS_PROMPT);
			}
			activeReviews.delete(agent.session.id);
			const returning = review.reviewSessionId !== review.originSessionId;
			if (returning) setFocus(review.originSessionId, "origin");
			const suffix = wantsSummary ? choice.value === END_LABELS.returnAndFix ? "\nThe findings are being summarized, then implemented in a follow-up turn." : "\nThe findings are being summarized." : "";
			return {
				kind: "success",
				text: returning ? `Review finished (${review.label}).${suffix}\nReturning you to the original conversation; this review session stays in your history.` : `Review finished (${review.label}).${suffix}`
			};
		}
	});
}
/** Current status document for the client half. */
function readStatus() {
	return {
		version: DSH_REVIEW_VERSION,
		active: [...activeReviews.values()].map((review) => ({
			sessionId: String(review.reviewSessionId),
			originSessionId: String(review.originSessionId),
			label: review.label
		})),
		...focus === void 0 ? {} : { focus }
	};
}
/**
* Apply the review plugin.
*
* Registration is intentionally all-or-nothing for the two commands: `inject`
* already guarantees the registries they need, so there is no partial mode to
* reason about. Every other capability is optional and degrades in place.
*/
function apply(ctx, config) {
	let current = () => config;
	ctx.inject(["settings"], (settingsCtx) => {
		const scope = settingsCtx.settings.register(DSH_REVIEW_SETTINGS_NS, Config, { base: config });
		current = () => scope.get();
	});
	ctx.inject(["webServer"], (webCtx) => {
		registerReviewStatusRoute(webCtx, readStatus);
	});
	registerReviewCommand(ctx, current);
	registerEndReviewCommand(ctx, current);
	ctx.effect(() => () => {
		activeReviews.clear();
		focus = void 0;
	}, "dsh-review: clear review state on unload");
}
//#endregion
export { Config, DSH_REVIEW_SETTINGS_NS, apply, inject, name };
