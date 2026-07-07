const blessed = require('blessed');
const fs = require('fs');
const util = require('util');
const { messageText } = require('./message');

// Build and run the terminal UI. Takes the WhatsApp controller `wa`.
function startUI({ wa }) {
  const store = wa.store;
  const client = () => wa.client; // live socket ref (changes across reconnects)
  // Keyboard needs a real TTY on stdin. nodemon / piped stdin breaks this,
  // making every keypress echo instead of navigating. Fail loud.
  if (!process.stdin.isTTY) {
    console.error(
      '❌ No interactive terminal (stdin is not a TTY).\n' +
        '   Run directly: `node index.js`  (not `npm run dev` / nodemon).'
    );
    process.exit(1);
  }

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: 'wp-chat',
  });
  // Draw box borders with plain chars instead of the DEC line-drawing charset
  // (ESC(0 / ESC(B). Some terminals — notably VS Code's integrated terminal —
  // don't switch cleanly back out of line-drawing mode, so every message after
  // a border char renders as (mostly blank) graphics glyphs: the pane looks
  // scrambled / half-empty. Forcing brokenACS drops the charset toggles.
  screen.program.tput.brokenACS = true;
  // Clear any leftover console output (QR, logs) before drawing the UI.
  screen.program.clear();
  screen.program.disableMouse();

  // Baileys (and its Signal internals) sometimes write raw console output —
  // any stdout/stderr write corrupts the blessed screen. Redirect all console
  // logging to a file so the TUI stays clean. Tail wp-chat.log to debug.
  const toFile = (...args) => {
    try {
      const line = args
        .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 2 })))
        .join(' ');
      fs.appendFileSync('wp-chat.log', `${new Date().toISOString()} ${line}\n`);
    } catch (_) {
      /* ignore logging failures */
    }
  };
  console.log = toFile;
  console.error = toFile;
  console.warn = toFile;
  console.info = toFile;
  console.debug = toFile;

  // --- theme ---
  const TEAL = '#075E54';   // WhatsApp header
  const GREEN = '#25D366';  // accent / me
  const BLUE = '#34B7F1';   // links / other accent
  const DIM = 'gray';
  const SIDEBAR = 32; // left column width in columns (must be a number)

  // Top status bar.
  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: { bg: TEAL, fg: 'white' },
  });

  // Left-top: search box.
  const search = blessed.textbox({
    parent: screen,
    label: ' 🔍 Search ',
    top: 1,
    left: 0,
    width: SIDEBAR,
    height: 3,
    inputOnFocus: true,
    border: { type: 'line' },
    style: { border: { fg: DIM }, focus: { border: { fg: GREEN } } },
  });

  // Left: chat list.
  const list = blessed.list({
    parent: screen,
    label: ' Chats ',
    top: 4,
    left: 0,
    width: SIDEBAR,
    height: '100%-4',
    keys: true,
    vi: true,
    tags: true,
    scrollbar: { ch: ' ', style: { bg: DIM } },
    border: { type: 'line' },
    style: {
      selected: { bg: GREEN, fg: 'black', bold: true },
      item: { fg: 'white' },
      border: { fg: DIM },
      focus: { border: { fg: GREEN } },
    },
  });

  // Right: message log.
  const log = blessed.log({
    parent: screen,
    label: ' Messages ',
    top: 1,
    left: SIDEBAR,
    width: `100%-${SIDEBAR}`,
    height: '100%-4',
    keys: true,
    vi: true,
    tags: true,
    scrollable: true,
    scrollbar: { ch: ' ', style: { bg: GREEN } },
    border: { type: 'line' },
    style: { border: { fg: DIM } },
  });

  // Right-bottom: input box.
  const input = blessed.textbox({
    parent: screen,
    label: ' ✍  message · Enter send · Esc back ',
    bottom: 0,
    left: SIDEBAR,
    width: `100%-${SIDEBAR}`,
    height: 3,
    inputOnFocus: true,
    border: { type: 'line' },
    style: { border: { fg: DIM }, focus: { border: { fg: GREEN } } },
  });

  // Popup member picker for @-mentions (hidden until '@' is typed).
  const mentionBox = blessed.list({
    parent: screen,
    label: ' Mention ',
    hidden: true,
    bottom: 3,
    left: SIDEBAR,
    width: `100%-${SIDEBAR}`,
    height: 12,
    keys: true,
    vi: true,
    tags: true,
    scrollbar: { ch: ' ', style: { bg: BLUE } },
    border: { type: 'line' },
    style: {
      selected: { bg: BLUE, fg: 'black', bold: true },
      item: { fg: 'white' },
      border: { fg: BLUE },
    },
  });

  let jids = [];        // parallel to list items: index -> jid
  let currentJid = null;
  let filter = '';      // current search query (lowercased)

  const groupMembers = new Map(); // group jid -> participant jids
  let pendingMentions = [];        // jids to attach to the outgoing message
  let mentionFilter = '';          // filter text inside the picker
  let mentionCandidates = [];      // parallel to mentionBox items: participant jids
  let suppressCancel = false;      // ignore the textbox 'cancel' while opening picker

  const nameFor = (jid) => store.nameFor(jid);
  const numberOf = (jid) => (jid || '').replace(/@.*$/, '');
  const isGroup = (jid) => !!jid && jid.endsWith('@g.us');

  // --- rendering helpers ---
  const esc = (s) => blessed.escape(String(s == null ? '' : s));

  const SENDER_COLORS = [
    '#34B7F1', '#25D366', '#f5c542', '#ff7b72', '#c792ea',
    '#7ee787', '#ffa657', '#79c0ff', '#f78c6c', '#82aaff',
  ];
  // Stable color per sender so each person keeps the same hue.
  function colorFor(key) {
    let h = 0;
    const s = String(key || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return SENDER_COLORS[h % SENDER_COLORS.length];
  }

  function timeStr(ts) {
    const n = Number(ts);
    if (!n) return '';
    const d = new Date(n * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  // Top status bar: brand, connection, sync state, mode, key hints.
  function updateHeader() {
    const dot = wa.client ? `{${GREEN}-fg}●{/}` : '{red-fg}●{/}';
    const state = wa.client ? 'online' : 'connecting…';
    const mode = wa.fullHistory ? 'full' : 'recent';
    header.setContent(
      ` {bold}wp-chat{/}    ${dot} ${state}    sync: ${esc(store.syncStatus())}` +
        `    mode: ${mode} [F]    ·  / search · Tab focus · q quit `
    );
  }

  // Fuzzy subsequence match: every char of `q` must appear in `text` in order.
  // Returns a score (higher = tighter/earlier match) or -1 for no match.
  function fuzzyScore(q, text) {
    if (!q) return 0;
    const t = text.toLowerCase();
    let ti = 0;
    let score = 0;
    let streak = 0;
    for (const ch of q) {
      const idx = t.indexOf(ch, ti);
      if (idx === -1) return -1;
      // Reward contiguous runs and earlier positions.
      streak = idx === ti ? streak + 1 : 0;
      score += 10 + streak * 5 - Math.min(idx - ti, 10);
      ti = idx + 1;
    }
    return score;
  }

  // Run a handler without letting a thrown error wedge blessed's key
  // dispatch. Errors are surfaced in the message pane instead of freezing.
  function safe(fn) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        try {
          log.add(`⚠️ error: ${err.message}`);
          screen.render();
        } catch (_) {
          /* last resort: swallow */
        }
      }
    };
  }

  // Rebuild the left list from the store, preserving selection where possible.
  const refreshList = safe(function refreshList() {
    let chats = store.listChats();
    const total = chats.length; // unfiltered count for the status label
    if (filter) {
      chats = chats
        .map((c) => {
          const s = Math.max(
            fuzzyScore(filter, nameFor(c.id)),
            fuzzyScore(filter, numberOf(c.id))
          );
          return { c, s };
        })
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s) // best matches first
        .map((x) => x.c);
    }
    const selectedJid = jids[list.selected];
    jids = chats.map((c) => c.id);
    list.setItems(
      chats.map((c) => {
        const g = isGroup(c.id);
        const icon = g ? `{${BLUE}-fg}#{/}` : `{${GREEN}-fg}@{/}`;
        return `${icon} ${esc(nameFor(c.id))}`;
      })
    );

    const shown = filter ? `${chats.length}/${total}` : `${total}`;
    list.setLabel(` Chats (${shown}) `);
    updateHeader();

    const newIdx = jids.indexOf(selectedJid);
    if (newIdx >= 0) list.select(newIdx);
    screen.render();
  });

  // Coalesce bursts of store updates into at most one list rebuild per tick.
  // Rebuilding the whole (hundreds-of-items) list per incoming message is what
  // caused the lag during active chats / history sync.
  let refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshList();
      // Backfilled history (from fetchHistory) arrives via 'sync', not the
      // 'message' event, so re-render the open pane when its bucket grew.
      if (currentJid) {
        const n = store.messagesFor(currentJid).length;
        if (currentJid !== lastRenderJid || n !== lastRenderLen) {
          renderChat(currentJid);
        }
      }
    }, 300);
  }

  // Format one message as a styled (tagged) display line.
  function lineFor(m) {
    const body = esc(messageText(m));
    const ts = timeStr(m.messageTimestamp);
    const time = ts ? `{${DIM}-fg}${ts}{/} ` : '';
    if (m.key?.fromMe) {
      return `${time}{${GREEN}-fg}{bold}me{/}{${GREEN}-fg}:{/} ${body}`;
    }
    const sjid = m.key?.participant || m.key?.remoteJid;
    const col = colorFor(sjid);
    return `${time}{${col}-fg}{bold}${esc(nameFor(sjid))}{/}{${col}-fg}:{/} ${body}`;
  }

  // Max messages rendered at once — large histories otherwise freeze the UI.
  const RENDER_LIMIT = 300;

  // Render the (recent) history of the open chat in one pass. Skips system /
  // empty messages (key-distribution, protocol edits) so the pane isn't blank.
  function renderChat(jid) {
    const icon = isGroup(jid) ? '👥' : '💬';
    log.setLabel(` ${icon} ${nameFor(jid)} `);
    const all = store.messagesFor(jid).filter((m) => messageText(m) !== '');
    const recent = all.slice(-RENDER_LIMIT);
    const lines = recent.map(lineFor);
    if (all.length > recent.length) {
      lines.unshift(`{${DIM}-fg}── last ${recent.length} of ${all.length} messages ──{/}`);
    }
    if (!lines.length) lines.push(`{${DIM}-fg}(no messages yet){/}`);
    // One setContent is far cheaper than N log.add() calls.
    log.setContent(lines.join('\n'));
    log.setScrollPerc(100); // jump to the newest message
    lastRenderJid = jid;
    lastRenderLen = all.length;
    screen.render();
  }
  let lastRenderJid = null;
  let lastRenderLen = 0;

  function openSelected() {
    const jid = jids[list.selected];
    if (!jid) return;
    currentJid = jid;
    pendingMentions = [];
    renderChat(jid);
    // Bucket empty (history batch not synced yet, or lid/pn alias unresolved)?
    // Pull older messages on demand; they re-render via the 'sync' hook below.
    if (store.messagesFor(jid).length === 0) store.fetchHistory(jid);
    if (isGroup(jid)) loadMembers(jid); // prefetch for @-mentions
    input.focus();
  }

  // Fetch + cache a group's participant jids (for the mention picker).
  function loadMembers(jid) {
    if (groupMembers.has(jid)) return;
    Promise.resolve(client().groupMetadata(jid))
      .then((meta) => {
        groupMembers.set(jid, (meta?.participants || []).map((p) => p.id));
        if (meta?.subject) {
          store.setGroupSubject(jid, meta.subject);
          if (currentJid === jid) log.setLabel(` ${nameFor(jid)} `);
          scheduleRefresh();
          screen.render();
        }
      })
      .catch(() => {});
  }

  // --- @-mention picker ---
  function openMention() {
    if (!isGroup(currentJid)) return;
    const members = groupMembers.get(currentJid) || [];
    if (!members.length) return; // metadata not loaded yet — leave '@' as text
    // Stop the textbox reading so it releases the key grab; otherwise its
    // keypress listener keeps eating arrows/jk and the picker can't navigate.
    suppressCancel = true;
    input.cancel(); // fires 'cancel' (ignored via flag), releases grab
    suppressCancel = false;
    mentionFilter = '';
    renderMentions();
    mentionBox.show();
    mentionBox.focus();
    screen.render();
  }

  function renderMentions() {
    const members = groupMembers.get(currentJid) || [];
    // Try to resolve unnamed (LID) members to real names in the background.
    for (const jid of members) store.resolveLid(jid);

    const q = mentionFilter.toLowerCase();
    const matches = members.filter((jid) => {
      if (!q) return true;
      return nameFor(jid).toLowerCase().includes(q) || numberOf(jid).includes(q);
    });
    // Named members first (a named member is more useful to tag than a number).
    const named = (jid) => !/^\d/.test(nameFor(jid));
    matches.sort((a, b) => (named(b) ? 1 : 0) - (named(a) ? 1 : 0));

    mentionCandidates = matches;
    mentionBox.setItems(
      matches.map((jid) => {
        const name = nameFor(jid);
        const num = numberOf(jid);
        if (name === num || name.startsWith(num)) return `{${DIM}-fg}${esc(num)}{/}`;
        return `{bold}${esc(name)}{/}  {${DIM}-fg}${esc(num)}{/}`;
      })
    );
    mentionBox.setLabel(
      ` @ mention ${mentionFilter ? `"${esc(mentionFilter)}" ` : ''}(${matches.length}) · Enter pick · Esc cancel `
    );
    screen.render();
  }

  function pickMention() {
    const jid = mentionCandidates[mentionBox.selected];
    mentionBox.hide();
    if (jid) {
      // The user already typed '@'; append the number and register the jid.
      // WhatsApp renders '@<number>' as the contact/participant name.
      const draft = input.getValue() + numberOf(jid) + ' ';
      input.setValue(draft);
      if (!pendingMentions.includes(jid)) pendingMentions.push(jid);
    }
    input.focus();
    screen.render();
  }

  mentionBox.on('keypress', (ch, key) => {
    const name = key && key.name;
    // Let navigation / accept / cancel keys pass through to the list untouched.
    if (['enter', 'escape', 'up', 'down', 'j', 'k', 'pageup', 'pagedown'].includes(name)) {
      return;
    }
    setImmediate(() => {
      let f = mentionFilter;
      if (name === 'backspace') f = f.slice(0, -1);
      else if (ch && ch.length === 1 && ch >= ' ') f += ch;
      // Only re-render (which resets selection) when the filter actually changes.
      if (f !== mentionFilter) {
        mentionFilter = f;
        renderMentions();
      }
    });
  });
  mentionBox.key(['enter'], pickMention);
  mentionBox.key(['escape'], () => {
    mentionBox.hide();
    input.focus();
    screen.render();
  });

  // --- events ---
  list.on('select', openSelected);

  // Open the mention picker when '@' is typed in a group chat.
  input.on('keypress', (ch) => {
    if (ch === '@' && isGroup(currentJid)) setImmediate(openMention);
  });

  input.on('submit', (value) => {
    const text = (value || '').trim();
    input.clearValue();
    // Only keep mentions whose exact '@<number>' token still appears in the
    // sent text. A bare substring check is wrong — one member's number can be
    // a substring of another's, or appear incidentally in the message body.
    const mentions = pendingMentions.filter((jid) =>
      new RegExp(`@${numberOf(jid)}(?!\\d)`).test(text)
    );
    pendingMentions = [];
    // Re-arm the input synchronously so the keyboard never freezes waiting on
    // the network. The send runs in the background — a hung/slow sendMessage
    // must not block re-focus (which is what re-starts blessed's key reading).
    const jid = currentJid;
    input.focus(); // stay in input for the next message
    screen.render();
    if (text && jid) {
      Promise.resolve()
        .then(() =>
          client().sendMessage(jid, mentions.length ? { text, mentions } : { text })
        )
        .then((sent) => {
          store.ingest(sent); // ensure our own message shows immediately
          screen.render();
        })
        .catch((err) => {
          log.add(`⚠️ send failed: ${err.message}`);
          screen.render();
        });
    }
  });

  // Live incoming/outgoing messages.
  store.on('message', safe(({ jid, message }) => {
    if (currentJid && store.sameChat(jid, currentJid) && messageText(message) !== '') {
      log.add(lineFor(message));
      log.setScrollPerc(100); // follow the conversation
      screen.render();
    }
    scheduleRefresh(); // coalesced list update (bump/re-sort)
  }));

  // History batches / contact updates arriving async.
  store.on('sync', scheduleRefresh);

  // Live-filter the list as the user types in the search box.
  search.on('keypress', () => {
    // Read the value after blessed has applied the keystroke.
    setImmediate(() => {
      filter = search.getValue().trim().toLowerCase();
      refreshList();
    });
  });
  // Enter in search jumps into the (filtered) list.
  search.key(['enter'], () => list.focus());
  // Esc clears the filter and returns to the list.
  search.key(['escape'], () => {
    search.clearValue();
    filter = '';
    refreshList();
    list.focus();
  });

  // --- keys ---
  screen.key(['q', 'C-c'], () => process.exit(0));
  screen.key(['tab'], () => {
    if (screen.focused === input) list.focus();
    else input.focus();
  });
  // Esc while typing: blessed fires 'cancel' (screen keys are grabbed during
  // input), so this is the reliable "back to list" hook.
  input.on('cancel', () => {
    if (suppressCancel) return; // opening the mention picker, not going back
    list.focus();
    screen.render();
  });
  // `/` from the list opens search.
  list.key(['/'], () => search.focus());

  // F toggles history-sync mode (recent <-> full). Reconnects to apply it.
  screen.key(['f', 'F'], () => {
    wa.toggleFullHistory();
    store.syncComplete = false; // a fresh sync begins after reconnect
    store.syncProgress = null;
    log.add(`↻ switching to ${wa.fullHistory ? 'FULL' : 'RECENT'} history — reconnecting…`);
    refreshList();
  });

  // Recovery: Ctrl-L forces a repaint and returns focus to the list, in case
  // focus ever ends up nowhere (frozen-looking keyboard).
  screen.key(['C-l'], () => {
    list.focus();
    screen.realloc();
    refreshList();
  });

  // Keep the layout correct when the terminal is resized.
  screen.on('resize', () => {
    refreshList();
    if (currentJid) renderChat(currentJid);
  });

  // A stray async error must not wedge the UI's key handling.
  process.on('unhandledRejection', (err) => {
    try {
      log.add(`⚠️ async error: ${err?.message || err}`);
      screen.render();
    } catch (_) {}
  });
  process.on('uncaughtException', (err) => {
    try {
      log.add(`⚠️ uncaught: ${err?.message || err}`);
      screen.render();
    } catch (_) {}
  });

  list.focus();
  refreshList();
  screen.render();
}

module.exports = { startUI };
