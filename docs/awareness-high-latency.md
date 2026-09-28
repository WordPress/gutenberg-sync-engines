# Slow awareness

Presence for connections that cannot carry live cursors: no WebSocket,
and polling every few seconds or slower. It is turned on from Settings →
Collaboration ("Awareness interval"; 0 keeps the built-in live cursors)
and lives in `src/awareness/` on the client with one small server class in
`includes/awareness/`.

## The problem with live cursors

The built-in awareness describes each peer as a cursor: a position inside
the shared document, refreshed many times a second and drawn as a colored
caret with a name flag. That only works when two things are true: every
editor has the same copy of the document, and updates arrive before the
other person moves on. A slow connection breaks both. If updates only
arrive every 15 seconds, the cursor always shows a spot the other person
has already left. The cursor also does not exist at all under the
intent-log engine, which has no shared document to place a position in.

With awareness and content possibly on different channels, a third problem
appears: a peer can name a block this editor has not received yet. The
rule here is simple: a reference to a block this editor does not hold shows
nothing, and the indicator appears the moment the block lands.

## What a peer sends

One value: the name of the block their selection is in, or nothing when
they have not selected a block. Blocks are usually named by their syncId,
the stable id the intent-log and de-rtc engines give every block
(`metadata.syncId`). Blocks without one are named by the editor's own
block id (the clientId). The yjs-server engine keeps those ids the same in
everyone's browser, so they still point at the same block for every peer.
Nothing else is sent: no cursor position, no history, no timestamps. Who
the peer is (name, avatar) comes with the channel, not with the value.

The value is checked once per interval and sent only when it changed. A
peer who stays in one block sends nothing new. See
`src/awareness/types.ts`.

## Two channels

The value can travel two ways, chosen by "Awareness channel":

- **Sync transport** (default). The value is one more field on the
  framework's awareness state (`gseBlock`), so it travels with the same
  requests as content under polling, SSE, and WebSocket alike.
  No server change. Under short polling the advisory channel carries
  the value straight to every peer it can reach, within a moment, the
  same way it carries who is present; peers it cannot reach get it on
  their next timer poll. Under SSE the parked stream exchange is
  reissued with the new value. Under WebSocket it goes out with the
  transport's periodic awareness message, every 10 seconds.
- **WordPress Heartbeat.** The value travels on WordPress's admin
  Heartbeat request instead, a separate request that repeats on its own
  timer: it rides the same discovery beat the advisory channel already
  sends, so the site needs an advisory channel selected (the default).
  The server keeps each tab's latest value on the tab's presence record
  and answers with every other live tab's value and identity. This is
  what happens when presence and content travel separately: raise the
  site's polling interval and presence arrives well before the content it
  refers to, and shows nothing until that content catches up. Heartbeat
  has its own rules. The interval can be 1 to 3600 seconds. Five seconds
  counts as a temporary "fast" mode, so the plugin sets it again after
  every beat. A tab in the background slows down to once every two
  minutes. The advisory channel also uses Heartbeat to find other tabs,
  so it speeds up or slows down with this setting too.

In both modes the plugin turns off the built-in cursor, so nobody in the
session sees a cursor that jumps every few seconds. Who is in the post
(the header avatars) keeps coming from the framework.

## What a peer sees

- **An outline.** The block the peer is in gets the same colored outline
  Gutenberg draws around a block a collaborator has selected, always
  around the whole block, for text blocks too. Custom blocks and blocks
  with unusual shapes get the same treatment; there is no attempt to
  outline a region inside a block. The outline stays when you select
  that block yourself, so you can see you are sharing it.
- **A badge.** The peer's avatar (or their initials on their color) sits
  above the block's top-left corner, like Gutenberg's own block label.
  Hovering it shows the name.
- **Several peers in one block.** The outline takes the color of the
  peer who entered the block first, and keeps it as long as that peer
  stays, so it does not flicker as others come and go. Every peer's
  avatar sits in one stack above the block, overlapped like the header's
  collaborator avatars, in the order they arrived. Hovering the stack
  spreads it out and shows every name. A peer joining a stack that is
  already there pops in, and a peer other than the first leaving one pops
  out; the first peer on a block appears and disappears plainly. Both
  animations are off under the "reduce motion" system setting.
- **Nothing lingers.** When the peer's next value names another block,
  the old block's outline and badge go at once. There is no trail and no
  countdown.
- **Nothing for blocks you do not have.** A value naming a block this
  editor does not hold matches nothing. The moment the block renders,
  the outline appears on it.

How it is drawn (`src/awareness/ui/`): the public `editor.BlockListBlock`
filter marks the block a peer named with a class, the first peer's color,
and the ids of every peer in it. The badge cannot be added inside the block, because for
text blocks the block element is exactly what people type into, and
anything added there would count as content. So the plugin measures where
each marked block sits and draws the badge separately, on top of the
canvas. The styles are copies of the framework's own outline and avatar
rules under plugin-owned class names, so they work whether or not the
framework's own cursor layer is on the page.

## Known limitations

- The Heartbeat channel's presence records live in short-term storage
  and are not protected against two people saving at the same instant.
  When that happens, one person's entry can overwrite the other's for
  one beat.
- Under the Heartbeat channel, a peer whose tab crashed (no leave notice
  reached the server) can stay marked until their presence record
  expires, up to five minutes.
- This only works in the post editor. Nothing is sent until the editor has
  finished loading and knows which post is open.

## Trying it

1. Settings → Collaboration: set "Awareness interval" to 5.
2. Open one post as two users in two browsers; click blocks in one; watch
   the other. With the advisory channel on, type a character after moving
   to see the value ride the content poll, or set the Transport to plain
   polling first.
3. For the split-channel case, set "Awareness channel" to WordPress
   Heartbeat and "Polling interval" to 20, then insert a block in one
   window: the other shows nothing for it until the content arrives, and
   the outline appears at that moment.
