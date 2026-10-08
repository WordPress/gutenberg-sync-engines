# Getting started

Install the Presence API, then this plugin, then open one post in two
browsers. That is enough to see real-time collaboration work with the
defaults. Nothing else needs configuring.

## Requirements

- WordPress 7.0 or newer, PHP 7.4 or newer.
- The [Presence API](https://wordpress.org/plugins/presence-api/)
  plugin, active before this one. This plugin refuses to activate
  without it.
- A database user that may create tables. If it cannot, the plugin
  still works on the slower post-meta storage and shows an admin notice
  with the command to run once the privilege is granted.

## Install

1. Install and activate the Presence API from the plugin directory.
2. Download the latest release zip from
   <https://github.com/WordPress/gutenberg-sync-engines/releases/latest>
   and install it from **Plugins → Add New → Upload Plugin**, or run
   `wp plugin install <path-to-zip> --activate`.
3. Activate it. Activation creates the two storage tables and turns the
   Gutenberg "Real-time collaboration" experiment on. The Gutenberg
   plugin is not a requirement: when it is not active, this plugin
   loads the bundled copy of the Gutenberg code it needs.

On a multisite network, a network-wide activation does this for every
site, and a site added later is set up when it is created.

## Check the settings

Open **Settings → Collaboration**. The defaults are:

- Sync engine: **intent-log**. The server merges edits; when two people
  change the same thing, the change is set aside, and a panel in the
  editor lets someone restore or dismiss it.
- Transport: **Polling with a WebRTC advisory channel**. The editor asks
  WordPress for new changes every few seconds. Browser tabs on the same
  post also open a side link to each other (the advisory channel), so a
  tab asks only when there is something to fetch.
- Unsaved changes: **discarded** when the last editor leaves.

Every setting is described in [settings.md](settings.md). Which engine
to pick is the subject of [engine-comparison.md](engine-comparison.md).
The other transports need a proxy that passes streams through, or a
long-running daemon; [transports.md](transports.md) and
[operations.md](operations.md) cover them.

## See it work

1. Open a post in the editor as one user.
2. Open the same post in a second browser (or a private window) as a
   second user who can edit it.
3. Type in one window. The text appears in the other within a few
   seconds. Each window shows the other person's avatar in the editor
   header; under yjs-server you also see a cursor where they are
   typing.
4. Change the same paragraph in both windows at nearly the same time.
   Under intent-log and de-rtc, one of the changes is set aside and a
   review panel offers to restore or dismiss it.

Up to five editor tabs may join one post, including your own second
tab; a sixth is told the post has too many editors. The limit is the
`sync.pollingProvider.maxClientsPerRoom` JavaScript filter.

What happens to each keystroke on the way is in
[data-flow.md](data-flow.md).

## For developers: try it without a site

The development environment in this repository gives you a site with
both plugins active:

```bash
npm install && composer install
cd gutenberg && npm ci --ignore-scripts && npm run build && cd ..
npm run build
npm run env start
```

Then open <http://localhost:8888/wp-admin/> as `admin` / `password`,
create a second user, and follow the steps above. The Gutenberg build
step takes a minute or two.

A lighter option needs no Docker: `npm run playground` serves the built
checkout on a local WordPress Playground at <http://127.0.0.1:9400>,
already logged in, with a second account (`editor` / `password`). Two
windows on one post collaborate over polling there. The hosted
Playground at playground.wordpress.net can run the public blueprint
(`blueprint.json`), but each hosted tab is its own site, so it shows a
solo session only.

## Turning it off

Deactivating the plugin turns real-time collaboration off (the editor
goes back to the usual lock that lets one person edit a post at a time)
and leaves the storage tables and all shared editing sessions in place. Deleting the plugin drops the tables.
Turning the Gutenberg experiment off on the Experiments screen also
turns collaboration off while the plugin stays active. See
[operations.md](operations.md).
