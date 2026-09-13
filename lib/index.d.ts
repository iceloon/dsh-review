import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "dsh-review";
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
declare const inject: string[];
/** Settings namespace owning the plugin's user-editable configuration. */
declare const DSH_REVIEW_SETTINGS_NS: SettingsNamespace;
/** Plugin configuration. */
interface Config {
  /**
   * Shared review instructions appended to every review, in every mode.
   *
   * Equivalent to pi-review's "custom review instructions", which it persisted as
   * a session entry; here it is a setting, so it survives across sessions and is
   * editable in the normal Settings UI.
   */
  customInstructions?: string;
  /**
   * Whether `/review` runs in a forked review session rather than in place.
   *
   * On by default, matching pi-review's "fresh session" mode: the review gets a
   * clean branch and `/end-review` can hand findings back to the original
   * conversation. Off makes `/review` queue the review prompt into the current
   * session instead — useful when a user wants one continuous transcript.
   */
  branchReview?: boolean;
}
declare const Config: z<Config>;
/**
 * Apply the review plugin.
 *
 * Registration is intentionally all-or-nothing for the two commands: `inject`
 * already guarantees the registries they need, so there is no partial mode to
 * reason about. Every other capability is optional and degrades in place.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, DSH_REVIEW_SETTINGS_NS, apply, inject, name };