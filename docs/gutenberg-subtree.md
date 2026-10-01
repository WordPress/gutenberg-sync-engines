# Gutenberg subtree

The plugin includes Gutenberg source in `gutenberg/` as a squashed Git
subtree. This keeps proposed Gutenberg changes visible in plugin reviews.
A separate Gutenberg branch, `try/sync-engines`, holds the framework changes
as commits above upstream trunk. Use that branch for rebases.

`gutenberg-pin.json` at the repository root records the bundled version.
It is the only place that names it:

- `commit`: the framework commit on `branch` that `gutenberg/` matches.
- `trunk`: the upstream trunk commit that the framework commits sit on.
- `tree`: the Git tree ID of that commit's source. It must equal
  `git rev-parse HEAD:gutenberg`, so you can check the pin without a
  Gutenberg checkout.

Other docs point to this file instead of repeating the IDs.

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

Update `gutenberg-pin.json`: set `commit` and `trunk`, and set `tree` to
the output of `git rev-parse HEAD:gutenberg`. Rebuild Gutenberg, then run the plugin type check,
JavaScript tests, and browser checks. Review the source diff in this repo
before publishing. Imports from a local framework checkout do not require
that branch to be published first.

Rebases change framework commit IDs. To keep a reference to the pinned
commit, you can tag it in Gutenberg (for example,
`sync-engines/pins/<short-id>`). Plugin clones and CI do not depend on that
tag: the source is stored here.

## Releases

CI builds the committed framework source. The release script copies the
built framework into the plugin ZIP. WordPress users install one ZIP.
Git source archives still need a build before installation.
