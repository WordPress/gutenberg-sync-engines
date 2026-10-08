# Vendored libraries and frozen cores

Four pieces of code in this repo are imported or kept identical to a
source elsewhere, and are not edited casually. This page says where each
came from, what local changes it carries, and how each is checked.

| What | Where | Source | Checked by |
| --- | --- | --- | --- |
| y-php, a PHP port of Yjs | `includes/lib/y-php/` | <https://github.com/alecgeatches/y-php> | its own conformance suite |
| automerge-php, a PHP port of Automerge | `includes/lib/automerge-php/` | the Gutenberg `chriszarate/refreshed-de-rtc` branch | its own conformance suite |
| The de-rtc merge core | `includes/engines/de-rtc/merge-core.php` | wordpress-develop `add/distributed-editing` | the de-rtc PHPUnit tests |
| The intent-log core | `src/engines/intent-log/` and its PHP twin | this repo | Jest, PHPUnit, and shared JSON vectors |

None of them is linted by this repo's PHPCS or Prettier; the excludes in
`phpcs.xml.dist` and `.prettierignore` are by design.

## y-php

A PHP port of Yjs 13.6.31, imported verbatim; the upstream commit is
recorded in the import commit. Its contract is byte-for-byte agreement
with JavaScript Yjs, enforced by translated upstream tests and fixtures
generated from the real JavaScript implementation.

Two deliberate local changes. Preserve both when re-vendoring:

- `composer.json` pins `config.platform.php` to 7.4, with the lock file
  resolved for it, so the suite installs on the PHP versions WordPress
  supports.
- `includes/lib/y-php/src/Lib0/StringDecoder.php` is rewritten to read forward through the
  data once. The direct port re-walked the buffer from the start on
  every read, so decoding slowed down sharply as documents grew (PR
  #29; the file's header explains the change). This is the change
  listed in [plan/wontfix.md](plan/wontfix.md) as worth sending
  upstream.

Run its suite without WordPress (about four seconds):

```bash
composer --working-dir=includes/lib/y-php install
composer --working-dir=includes/lib/y-php test
```

The plugin loads it without a Composer autoloader through
`includes/lib/y-php-loader.php`, a lazy PSR-4 loader plus the
equivalents of Composer's `files` entries.

## automerge-php

A native PHP port of Automerge, imported verbatim from the Gutenberg
`chriszarate/refreshed-de-rtc` branch (originally wordpress-develop
`add/distributed-editing`, PR WordPress/wordpress-develop#12334). MIT
licensed, PHP 8.2 or newer with mbstring, namespace
`WordPress\DistributedEditing\Automerge`, no WordPress dependency.
`includes/lib/automerge-php-loader.php` is its lazy loader, and
`gutenberg_sync_engines_automerge_php_is_supported()` is the PHP and
mbstring gate.

**The shipping de-rtc merge never calls it.** The merge core's shipping
path (`native-automerge-blocks-v1`) is hand-written PHP; this library
backs only the unused whole-text path and external repair. It is
vendored for fidelity to the upstream design and for future use. Whether
it should do real work is issue #44.

Run its suite without WordPress (under a second, 680 mapped upstream
tests):

```bash
php includes/lib/automerge-php/tests/run.php
```

Two things to know before blaming the library for a failure:

- **Full parity needs PCRE2 10.43 or newer.** That is a property of the
  PCRE2 library PHP links, not of the PHP version. PHP 8.4 bundles
  10.44. Distribution builds link the system PCRE2 10.42 instead:
  Ubuntu 24.04 packages, and since 2026-09-03 setup-php's PHP 8.4 on
  GitHub runners. Under 10.42, two adjacent emoji sequences joined by a
  zero-width joiner count as one character, and exactly 2 of the 680
  tests fail (grapheme cursor tracking and a UTF-16 boundary splice).
  CI therefore runs this step in the official `php:8.4-cli` Docker
  image, behind a guard that fails with the cause when PCRE2 is too
  old. Locally, check `php -r 'echo PCRE_VERSION;'` first.
- **The runner leaves `PORTING_STATUS.json` alone by default.** Upstream
  rewrote it, timestamp included, on every run, which dirtied the tree;
  a marked `DELTA` in `includes/lib/automerge-php/tests/run.php` skips that. Set
  `AUTOMERGE_PHP_UPDATE_STATUS=1` to refresh it on purpose.

The 11 upstream fixture files the runner reads live under
`includes/lib/automerge-php/upstream/automerge/`, fetched from
automerge/automerge; the pin is in `VENDORED_FROM_COMMIT.txt` beside
them, because the source branches referenced a submodule that was never
committed.

## The de-rtc merge core

`includes/engines/de-rtc/merge-core.php` is ported verbatim from the
Gutenberg `chriszarate/refreshed-de-rtc` branch's `de-rtc.php`, itself a
verbatim port of wordpress-develop `add/distributed-editing`. It is the
exact set of functions (113) that the engine's entry points call: the
three-way merges over serialized blocks and block identities, the
rich-text merge model, update construction and validation, version
snapshots, sync-meta parsing and formatting, and canonicalization and
hashing.

It is frozen like the intent-log core. The only differences from the
source are how it finds and loads the vendored library, each marked
`DELTA` in place. The whole file is loaded behind a
`function_exists( 'wp_de_rtc_get_reason_codes' )` guard, so when a Core
or Gutenberg build ships Distributed Editing itself, the built-in
version is used instead.

## The intent-log core

`src/engines/intent-log/` is the engine's planning and merge core,
kept identical in two languages: these JavaScript modules and their
PHP twins in `includes/engines/intent-log/`
(`class-wp-intent-log-planner.php`, `class-wp-intent-log-document.php`,
`class-wp-intent-log-rich-text.php`). JSON test vectors generated from
one side are replayed against both, so a change on one side without the
other fails the build. Its vocabulary is in
[`SPEC.md`](../src/engines/intent-log/SPEC.md) beside the modules.

How it is typed and tested:

- The modules are plain JavaScript, so they run under Node with no build
  step; the simulator sweep and the vector generators import them
  directly. They are type-checked through JSDoc against the shared
  interfaces in `engine-types.d.ts`: `tsconfig.json` sets `checkJs`, so
  `npm run typecheck` checks the core and TypeScript consumers get their
  types from the JSDoc itself. There are no per-module `.d.ts` files;
  they drifted and were removed. A JSDoc edit is the one non-behavioral
  change the core routinely takes.
- Prettier does not touch it; ESLint runs with relaxed rules.
- The Jest harness is `tests/js/engines/intent-log/`. It also holds two
  Node-only pieces that are not shipped: the deterministic simulator
  (`simulator.js`, the reference the spec is checked against) and the
  JavaScript
  reference for genesis block ids (`genesis-sync-id.js`, on
  `node:crypto`). The editor never mints genesis ids; the server and the
  build-free stamper `includes/shared/sync-id.js` do.
- The vectors exist as two deliberate copies,
  `tests/js/engines/intent-log/test-vectors/` (replayed by Jest) and
  `tests/phpunit/test-vectors/` (replayed by PHPUnit), kept
  byte-identical by `tests/js/engines/intent-log/vector-parity.test.js`.
  Regenerate them with the `tests/tools/` generators and always update
  both.
- One module is client-only: `client.js` (the client's copy: the queue
  of unsent edits, redoing the plan when news arrives, and log
  trimming) has no PHP twin and no vector coverage, because the server
  plans with the planner directly. It is
  still frozen by default; changes there are additive and covered by
  `tests/js/engines/intent-log/client.test.js`.

The first check for any change to the planner or merge behavior is the
simulator sweep, which needs no WordPress:

```bash
node tests/tools/sweep.js [seeds] [steps] [clients]   # defaults 60/400/3
```

It fails loudly when a rule is broken and prints how each edit ended
up, so drift is visible.
