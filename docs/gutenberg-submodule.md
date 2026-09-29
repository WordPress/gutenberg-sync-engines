# Gutenberg submodule

The plugin pins one commit of the Gutenberg framework at `gutenberg/`.
Framework changes are maintained in a separate branch above upstream trunk.
The plugin repository records the selected commit, not copies of its files.

## Clone and build

```sh
git submodule update --init --recursive
npm ci
cd gutenberg
npm ci --ignore-scripts
npm run build
cd ..
npm run build
```

For a new clone, `git clone --recurse-submodules` initializes the framework.
Each new plugin worktree needs its own submodule checkout. After switching
plugin branches or revisions, save any framework edits, run the update
command above, and rebuild when the pin has changed.

An ordinary submodule update checks out the recorded commit. Do not use
`git submodule update --remote` in setup or CI: that selects a remote branch
tip instead of the version reviewed with the plugin.

## Develop and update

Use the separate Gutenberg development worktree for framework edits. A
submodule checkout normally has a detached HEAD; if editing inside it,
first create or switch to a development branch.

Keep the framework changes in a short series of commits. To update them,
fetch WordPress Gutenberg trunk into that development repository and rebase
the framework branch onto the chosen trunk commit. Resolve conflicts and
remove local changes that upstream now provides.

Before selecting the result here, build it and run its core-data, sync, and
conflict-review tests. Then update this checkout to the reviewed commit:

```sh
git -C gutenberg fetch origin
git -C gutenberg checkout --detach <reviewed-framework-commit>
```

Rebuild the submodule, then run the plugin's type check, JavaScript tests,
and browser checks against it. Stage `gutenberg` with any matching plugin
changes and make a signed commit. That commit records the new pin.

Rebasing changes framework commit IDs. Preserve every published pin with a
permanent tag in the framework repository. The commit and its permanent
reference must be available at the URL in `.gitmodules` before publishing
the plugin commit that uses it. Local framework commits alone cannot be
fetched by CI or other developers. Publishing is a separate action.

## Releases

CI initializes the submodule before dependency installation and builds its
source. The release script copies the built framework into the plugin ZIP.
WordPress users still install one ZIP and do not need Git or a submodule
checkout. Git source archives are not a substitute for the built release ZIP.

The migration preserves the former subtree under `_trash/gutenberg-subtree`
in the local checkout. This recovery copy is ignored by Git and code checks
and is not included in release ZIPs.
