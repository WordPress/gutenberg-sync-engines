# Test tools

Node and PHP scripts used by the test suites and by hand. Each script has
a usage block in its header.

- `sweep.js` — the intent-log simulator sweep, the first check for any
  change to the intent-log planner or merge behavior
  (`node tests/tools/sweep.js [seeds] [steps] [clients]`, defaults
  60/400/3; no WordPress needed).
- `observe-two-tab-sync.mjs` — the manual two-tab observer against a
  live environment: prints each tab's block store, canvas, and console
  errors for a scripted scenario.
- `generate-planner-vectors.js`, `generate-rich-text-vectors.js`,
  `generate-sync-id-vectors.js`, `generate-de-rtc-descriptor-vectors.mjs`
  and `.php` — the test-vector generators. The intent-log vectors are
  written to two places (Jest and PHPUnit); always update both.
- `doc-lint.mjs` — checks the prose files against the code
  (`npm run lint:docs`, run by CI): backticked paths exist, documented
  option, filter, class and constant names appear in the code, links
  and anchors resolve, `docs/README.md` lists every page, retired names
  appear only beside a word like "retired", and numbers marked with a
  `const:` comment match the source. Its header lists the rules.
- `check-presence-api.php` — checks the Presence API awareness backend
  against the real plugin instead of the test stand-in.
- `dump-yjs-room-blocks.php`, `trace-yjs-room-rows.php` — yjs-server
  session inspection helpers for WP-CLI.

## Typing by yourself in a second window

To test behavior with only one person, open the same post in a second
browser window and paste this into its console. It keeps typing digits
into the selected block until you run `window.__stopTyping()`:

```js
(async () => { const { subscribe, select } = wp.data; const clientId = await new Promise((resolve) => { const initial = select('core/block-editor').getSelectedBlockClientId(); if (initial) { resolve(initial); return; } const unsubscribe = subscribe(() => { const id = select('core/block-editor').getSelectedBlockClientId(); if (id) { unsubscribe(); resolve(id); } }); }); const doc = document.querySelector('iframe[name="editor-canvas"]')?.contentDocument ?? document; const blockEl = doc.querySelector(`[data-block="${clientId}"]`); const editable = blockEl?.querySelector('[contenteditable="true"]') ?? blockEl; if (!editable) { console.warn('No editable element found for block', clientId); return; } editable.focus(); const sel = doc.defaultView.getSelection(); if (!sel.rangeCount || !editable.contains(sel.anchorNode)) { const r = doc.createRange(); r.selectNodeContents(editable); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); } let i = 0; const intervalId = setInterval(() => { const char = String(i % 10); const keyInit = { key: char, code: `Digit${char}`, keyCode: 48 + Number(char), which: 48 + Number(char), bubbles: true, cancelable: true }; editable.dispatchEvent(new KeyboardEvent('keydown', keyInit)); const notCancelled = editable.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true, cancelable: true })); if (notCancelled) { const s = doc.defaultView.getSelection(); if (s.rangeCount) { const r = s.getRangeAt(0); r.deleteContents(); const t = doc.createTextNode(char); r.insertNode(t); r.setStartAfter(t); r.setEndAfter(t); s.removeAllRanges(); s.addRange(r); } editable.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true })); } editable.dispatchEvent(new KeyboardEvent('keyup', keyInit)); i++; }, 60); window.__stopTyping = () => { clearInterval(intervalId); console.log('Stopped.'); }; console.log('Typing started on block', clientId, '— run window.__stopTyping() to stop.'); })();
```
