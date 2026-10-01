# Data flow

This page shows how one person's update reaches everyone else during
collaborative editing. It covers today's Gutenberg experiment
(including the WPVIP WebSocket transport, which can stand in for its
polling) and what this plugin proposes.

## The short version

In the Gutenberg experiment, **browsers merge updates and WordPress
is just a relay**. WordPress stores the updates as bytes, but cannot
read them, validate them, sanitize them, or notice that two people
changed the same thing. It sees the updates only when someone saves the
post.

This plugin proposes that **WordPress takes part in every update**. The
server receives each edit, checks who sent it and what it contains,
merges it, and stores the result. Other browsers then receive what the
server accepted. All three engines work this way, and they differ only
in how the merge works. The engine choice and the transport choice are
separate: any engine runs over any transport.

|                                             | Gutenberg experiment                | This plugin                                                                |
| ------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| Who merges                                  | Browsers                            | WordPress (yjs-server: also browsers)                                      |
| What WordPress can read                     | Nothing until the post is saved     | Every edit as it arrives                                                   |
| Markup safety checks (`kses`) on live edits | None                                | Every edit as it arrives                                                   |
| Same-spot conflicts                         | Settled silently                    | Set aside for review (intent-log, de-rtc) or settled silently (yjs-server) |
| How edits travel                            | Short polling, or WPVIP's WebSocket | Short polling, server-sent events, or WebSocket                            |
| Where edits are stored                      | Post meta on a custom post type     | Two custom tables                                                          |

A **room** is one shared document, usually one post. A **row** is one
stored entry in a room's history. Every browser remembers the last row
it has seen, and asks for the rows after it.

## The block editor view

### Gutenberg experiment

Each browser keeps its own copy of the post as a CRDT (Yjs) document.
Browsers send Yjs updates (binary data) to WordPress. WordPress stores
them and relays them to the other browsers, which merge them into their
copy.

```mermaid
sequenceDiagram
    autonumber
    participant A as Alice's editor
    participant WP as WordPress
    participant B as Bob's editor
    Note over A,B: Each browser has its own CRDT document
    A->>A: Compare blocks before and after,<br/>capture edit and apply to Alice's CRDT doc
    A->>WP: Send: binary update
    WP->>WP: Store the bytes as a post meta row
    B->>WP: Anything new?
    WP-->>B: Alice's binary update
    B->>B: Yjs merges them into Bob's CRDT doc
    B->>B: Update the local editor
    Note over A,B: Joining: A new tab loads the CRDT doc saved with the post,<br/>then a peer sends any changes it is missing
    Note over WP: After 50 rows, WordPress asks one browser for a full copy<br/>and deletes older rows, so the history stays small
    A->>WP: Save post (REST)
    WP->>WP: post_content checked and saved,<br/>plus a copy of the CRDT doc in post meta
```

What this means:

-   The server is a relay. It cannot reject unsafe markup, enforce
    per-block rules, or tell a real conflict from a clean merge.
-   Content is checked only when someone saves the post. Until then, a
    user who can edit the post can push any block content into the other
    editors.
-   Two people changing the same thing at once do not see a conflict. Yjs
    merges the changes silently. For single values, one edit wins (chosen
    by client ID, not by time). For text, both people's typing is kept.

**The WPVIP WebSocket transport** works the same way. It replaces only
the WordPress polling provider, through Gutenberg's `sync.providers`
filter. Each browser asks WordPress for a short-lived signed token,
which WordPress issues only if the user can edit the post. The browser
then opens a WebSocket to a separate Node.js server. That server checks
the token and relays Yjs updates and presence between browsers. It
keeps rooms in memory only and stores nothing, so WordPress still sees
the content only when the post is saved, along with the copy of the
CRDT doc saved with it.

### This plugin, intent-log engine

The browser turns each change into a small, readable description, such
as "insert 'x' at position 4 in paragraph 2". Each description records
which point in the history it was made against (base sequence).
WordPress puts edits in order one room at a time. If there are newer
updates, it attempts to adjust the update so that it can be cleanly
merged. If it cannot adjust an edit safely, it sets it aside for a human
to review.

```mermaid
sequenceDiagram
    autonumber
    participant A as Alice's editor
    participant WP as WordPress
    participant DB as Room storage
    participant B as Bob's editor
    A->>A: Compare blocks before and after,<br/>describe the change
    A->>WP: Send: Edit + base sequence
    WP->>WP: Authorize the user
    WP->>WP: Lock the room
    alt Unsafe markup
        WP->>DB: Park edit for human review
    else Conflicts with newer edit
        WP->>DB: Park edit for human review
    else Clean
        WP->>WP: Adjust it for newer edits
        WP->>DB: Store the adjusted edit
    end
    WP-->>A: Adjusted edit
    B->>WP: Anything new?
    WP-->>B: Adjusted and parked edits
    B->>B: Update the local editor
    Note over A,B: Both editors show parked edits in special review UI
    A->>WP: Save post (REST)
```

### This plugin, yjs-server engine

The browser side is the same as the Gutenberg experiment: each browser
maintains a CRDT document and sends binary Yjs updates. The difference
is that WordPress has a full Yjs library, holds its own canonical CRDT
document, and merges every update into it. Because the server can read
the merged result, it can check content.

```mermaid
sequenceDiagram
    autonumber
    participant A as Alice's editor
    participant WP as WordPress
    participant DB as Room storage
    participant B as Bob's editor
    A->>A: Compare blocks before and after,<br/>capture edit and apply to Alice's CRDT doc
    A->>WP: Send: binary update
    WP->>WP: Authorize the user
    WP->>DB: Load the server's CRDT doc
    WP->>WP: Merge the update
    opt Unsafe markup
        WP->>WP: Clean the touched blocks<br/>and add a correcting update
    end
    WP->>DB: Store the update and updated CRDT doc
    B->>WP: Anything new?
    WP-->>B: Updates that Bob doesn't have
    B->>B: Yjs merges them into Bob's CRDT doc
    B->>B: Update the local editor
    Note over A,B: No human review: Yjs settles every conflict
    A->>WP: Save post (REST)
```

### This plugin, de-rtc engine

A save-based merging engine where the browser sends the whole post, plus
its base version, through the ordinary autosave endpoint. WordPress
compares three versions: the base version, the newest version (if it
exists), and the proposed version. It merges them block by block and
announces the new version number. Other browsers then fetch and apply
the new version.

```mermaid
sequenceDiagram
    autonumber
    participant A as Alice's editor
    participant WP as WordPress
    participant DB as Room storage
    participant B as Bob's editor
    A->>WP: Autosave: content + base version
    WP->>WP: Authorize the user
    WP->>WP: Merge block-by-block
    alt Unsafe markup
        WP->>DB: Park block for human review
    end
    alt Conflict with newer version
        WP->>DB: Park block for human review
    end
    WP->>DB: Claim the next version number<br/>(or retry the merge if someone else got it first)
    WP->>DB: Store the merged post and a small notice:<br/>"version N, this content hash"
    WP-->>A: Latest version: N + content hash
    B->>WP: Anything new?
    WP-->>B: Latest version: N + content hash
    B->>WP: Send me version N
    WP-->>B: Version N
    B->>B: Update the local editor
    A->>WP: Save post (REST)
    WP->>WP: Merge as above,<br/>then save post_content
```

### What the engines do with the same situation

|                                                     | Gutenberg experiment      | intent-log             | yjs-server                            | de-rtc                          |
| --------------------------------------------------- | ------------------------- | ---------------------- | ------------------------------------- | ------------------------------- |
| What a browser sends                                | Yjs updates               | Small typed edits      | Yjs updates                           | The whole post, on timer        |
| Who merges                                          | Browsers                  | WordPress              | WordPress and browsers                | WordPress                       |
| Two people change the same spot                     | Merged silently           | Set aside for review   | Merged silently                       | Set aside for review            |
| Unsafe markup from a user without `unfiltered_html` | Reaches peers, vulnerable | Set aside for approval | Cleaned by the server                 | Set aside for approval          |
| Server cost per edit                                | Store and forward         | Lock, adjust, store    | Decode, merge, and re-encode CRDT doc | Merge the whole post            |
| Who writes `post_content`                           | The editor's save         | The editor's save      | The editor's save                     | The editor's save, merged first |
| New room starts from                                | Saved entity              | Saved entity           | Saved entity                          | Saved entity                    |

## Transports

A transport is how updates travel between the server and peers. This
plugin provides multiple transport options. Any engine runs over any
transport.

Short polling also opens an **advisory channel** in each editor tab: a
side channel that carries only presence ("who is here") and "something
changed, go and poll" notices. It never carries content, which always
comes from WordPress. When every tab in a room can reach every other
tab, tabs poll only when told that something changed, so an idle room
makes almost no requests and a change arrives in under a second. A tab
that cannot reach a peer falls back to polling on a timer.

The channel runs over one of two links, chosen on the settings screen:
a direct browser-to-browser WebRTC connection, set up through the
WordPress Heartbeat (the default), or a WebSocket to the plugin's sync
server or to a relay the host runs. Only users who can edit the post
join a room's channel, and the worst a misbehaving peer can do is cause
extra polls or show false presence.

|                     | Gutenberg experiment short polling           | Short-polling                                | SSE                           | WebSocket                                  |
| ------------------- | -------------------------------------------- | -------------------------------------------- | ----------------------------- | ------------------------------------------ |
| Advisory channel    | No                                           | WebRTC or WebSocket                          | Off while the stream is open  | Not used                                   |
| New services to run | None                                         | None                                         | None, Redis optional          | Separate PHP daemon                        |
| Credentials         | Cookie + nonce                               | Cookie + nonce                               | Cookie + nonce                | One-time token + cookie, or a signed token |
| Long-lived process  | No                                           | No                                           | One PHP worker per connection | One long-running process                   |
| Typical latency     | 1 s                                          | <1 s with advisory channel, else 5 s         | <1 s                          | <1 s                                       |
| If it fails         | Retry with backoff, then a disconnect notice | Retry with backoff, then a disconnect notice | Falls back to polling         | Falls back to polling                      |
