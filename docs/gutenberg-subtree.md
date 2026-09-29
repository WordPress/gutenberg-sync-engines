# Gutenberg subtree

The plugin includes Gutenberg source in `gutenberg/` as a squashed Git
subtree. This keeps proposed Gutenberg changes visible in plugin reviews.
A separate Gutenberg branch, `try/sync-engines`, holds the framework changes
as commits above upstream trunk. Use that branch for rebases.

The bundled version is `89bea5705f66172e80a7b0c88598052d378595ce`, based on
trunk `0d3eefe596560204e99bb1047df65e2e666a9ad1`. The tag
`sync-engines/pins/89bea5705f66` identifies this version in Gutenberg.

## Clone and build

A normal clone includes the framework source. No submodule setup is needed.

```sh
npm ci
cd gutenberg
npm ci --ignore-scripts
npm run build
cd ..
npm run build
```

The install command skips Gutenberg's Husky hook, which expects its own Git
root. The build generates the required assets. After switching plugin
revisions, rebuild if the bundled framework changed.

## Develop and update

Keep framework changes in the separate Gutenberg development worktree.
Before a rebase, transfer any framework fixes made in this plugin's subtree
to that branch. This prevents a later import from losing those fixes.

Rebase the framework commits onto the chosen Gutenberg trunk version.
Resolve conflicts and remove local changes that upstream now supplies.
Build the result and run its core-data, sync, and conflict-review tests.

From a clean plugin checkout, import the reviewed version:

```sh
git subtree pull --prefix=gutenberg <framework-checkout> <reviewed-framework-commit> --squash
```

Use an exact commit ID to select the tested version. Rebases change commit
IDs, but a squashed subtree import compares source trees. Resolve any import
conflicts and confirm that the resulting `gutenberg/` source tree matches
the selected framework commit. Keep commit signing enabled.

Update the framework and trunk IDs in this guide, `AGENTS.md`, and
`entity-sync-adapter.md`. Rebuild Gutenberg, then run the plugin type check,
JavaScript tests, and browser checks. Review the source diff in this repo
before publishing. Imports from a local framework checkout do not require
that branch to be published first.

The tag preserves a useful reference after rebases, but plugin clones and
CI do not depend on fetching it: the source is stored here.

## Releases

CI builds the committed framework source. The release script copies the
built framework into the plugin ZIP. WordPress users install one ZIP.
Git source archives still need a build before installation.
