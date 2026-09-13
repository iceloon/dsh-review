/**
 * Package version, injected at build time.
 *
 * `tsdown`'s `define` replaces `__DSH_REVIEW_VERSION__` with the `version` field
 * of `package.json`, keeping that file the single source of truth. The
 * `typeof` guard keeps an un-defined build harmless (it reports a clearly-dev
 * marker instead of throwing a ReferenceError).
 *
 * @module dsh-review/version
 */

declare const __DSH_REVIEW_VERSION__: string

/** Version of this plugin, as published. */
export const DSH_REVIEW_VERSION: string =
  typeof __DSH_REVIEW_VERSION__ === 'string' ? __DSH_REVIEW_VERSION__ : '0.0.0-dev'
