const blessed = require('blessed');
const fs = require('fs');
const util = require('util');
const { messageText } = require('../utils/message');

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

  // Reply picker: overlay list to choose a message to quote (opened with Ctrl-R).
  const replyBox = blessed.list({
    parent: screen,
    label: ' ↩ Reply — Enter reply · Esc cancel ',
    hidden: true,
    top: 1,
    left: SIDEBAR,
    width: `100%-${SIDEBAR}`,
    height: '100%-4',
    keys: true,
    vi: true,
    tags: true,
    scrollbar: { ch: ' ', style: { bg: GREEN } },
    border: { type: 'line' },
    style: {
      selected: { bg: GREEN, fg: 'black', bold: true },
      item: { fg: 'white' },
      border: { fg: GREEN },
    },
  });

  // React picker: overlay list to choose a message to emoji-react to (Ctrl-E).
  const reactBox = blessed.list({
    parent: screen,
    label: ' 😀 React — Enter pick · Esc cancel ',
    hidden: true,
    top: 1,
    left: SIDEBAR,
    width: `100%-${SIDEBAR}`,
    height: '100%-4',
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

  // Emoji picker: shown after a message is chosen in the react picker.
  const emojiBox = blessed.list({
    parent: screen,
    label: ' Emoji — Enter send · Esc back ',
    hidden: true,
    top: 'center',
    left: 'center',
    width: 24,
    height: 12,
    keys: true,
    vi: true,
    tags: true,
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
  let replyTo = null;              // WAMessage to quote on the next send, or null
  let renderedMsgs = [];           // messages currently shown in the log (for reply)
  let replySnapshot = [];          // frozen copy of the list shown in the reply picker
  let reactSnapshot = [];          // frozen copy of the list shown in the react picker
  let reactTarget = null;          // message chosen to react to (while emoji picker open)

  const nameFor = (jid) => store.nameFor(jid);
  const numberOf = (jid) => (jid || '').replace(/@.*$/, '');
  const isGroup = (jid) => !!jid && jid.endsWith('@g.us');

  // Message-pane title for a chat, with a live presence suffix (typing…/online).
  const chatLabel = (jid) => {
    const icon = isGroup(jid) ? '👥' : '💬';
    const pres = store.presenceText(jid);
    return ` ${icon} ${nameFor(jid)}${pres ? ` · ${pres}` : ''} `;
  };

  // --- rendering helpers ---
  // Strip C0/C1 control bytes (incl. raw ESC/ANSI sequences and newlines)
  // *before* blessed.escape. blessed.escape only neutralizes its own {tag}
  // chars — a message body carrying raw control bytes would otherwise move the
  // terminal cursor and scatter characters across the pane (corrupt render).
  const esc = (s) =>
    blessed.escape(
      String(s == null ? "" : s).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ")
    );

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
        `    mode: ${mode} [F]    ·  / search · Tab focus · ^R reply · ^E react · q quit `
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
        const n = store.unreadFor(c.id);
        const badge = n ? `  {${GREEN}-fg}{bold}(${n > 99 ? '99+' : n}){/}` : '';
        return `${icon} ${esc(nameFor(c.id))}${badge}`;
      })
    );

    const shown = filter ? `${chats.length}/${total}` : `${total}`;
    list.setLabel(` Chats (${shown}) `);
    updateHeader();

    const newIdx = jids.indexOf(selectedJid);
    if (newIdx >= 0) list.select(newIdx);
    // Selection dropped (e.g. the filter no longer includes it): snap to the
    // top (the best fuzzy match / latest chat) rather than letting blessed
    // clamp the stale index to the last item.
    else if (jids.length) list.select(0);
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
  // Delivery-status tick for a message we sent. Mirrors WhatsApp:
  // · pending, ✓ sent, ✓✓ delivered, ✓✓ (blue) read. proto
  // WebMessageInfo.Status: 0 ERROR, 1 PENDING, 2 SERVER_ACK, 3 DELIVERY_ACK,
  // 4 READ, 5 PLAYED.
  function statusTick(m) {
    // No tick when it's not ours, or the status is unknown (e.g. messages
    // loaded from history that don't carry one — avoids a false "pending").
    if (!m.key?.fromMe || m.status == null) return '';
    const s = Number(m.status);
    if (s <= 1) return ` {${DIM}-fg}·{/}`;          // pending / error
    if (s === 2) return ` {${DIM}-fg}✓{/}`;         // sent to server
    if (s === 3) return ` {${DIM}-fg}✓✓{/}`;        // delivered
    return ` {${BLUE}-fg}✓✓{/}`;                    // read / played
  }

  function lineFor(m) {
    const body = esc(messageText(m));
    const ts = timeStr(m.messageTimestamp);
    const time = ts ? `{${DIM}-fg}${ts}{/} ` : '';
    if (m.key?.fromMe) {
      return `${time}{${GREEN}-fg}{bold}me{/}{${GREEN}-fg}:{/} ${body}${statusTick(m)}`;
    }
    const sjid = m.key?.participant || m.key?.remoteJid;
    const col = colorFor(sjid);
    return `${time}{${col}-fg}{bold}${esc(nameFor(sjid))}{/}{${col}-fg}:{/} ${body}`;
  }

  // Max messages rendered at once — large histories otherwise freeze the UI.
  const RENDER_LIMIT = 300;

  // Render the (recent) history of the open chat in one pass. Skips system /
  // empty messages (key-distribution, protocol edits) so the pane isn't blank.
  const renderChat = safe(function renderChat(jid, keepScroll) {
    log.setLabel(chatLabel(jid));
    // Preserve the reader's scroll position on in-place refreshes (e.g. a
    // status-tick update) unless they're already at the bottom. Captured
    // before setContent replaces the buffer.
    const atBottom = log.getScrollPerc() >= 99;
    const prevScroll = log.getScroll();
    const all = store.messagesFor(jid).filter((m) => messageText(m) !== '');
    const recent = all.slice(-RENDER_LIMIT);
    renderedMsgs = recent; // keep the visible messages for the reply picker
    const lines = recent.map(lineFor);
    if (all.length > recent.length) {
      lines.unshift(`{${DIM}-fg}── last ${recent.length} of ${all.length} messages ──{/}`);
    }
    if (!lines.length) {
      // Distinguish "still syncing" from a genuinely empty chat so an unsynced
      // chat doesn't look broken/blank while history is streaming in.
      const msg = store.syncComplete
        ? '(no messages yet)'
        : '(syncing… messages will appear here)';
      lines.push(`{${DIM}-fg}${msg}{/}`);
    }
    // One setContent is far cheaper than N log.add() calls.
    log.setContent(lines.join('\n'));
    // Keep the reader where they were on an in-place refresh; otherwise jump to
    // the newest message (opening a chat, or already following at the bottom).
    if (keepScroll && !atBottom) log.setScroll(prevScroll);
    else log.setScrollPerc(100);
    lastRenderJid = jid;
    // Track the *unfiltered* count — this is what scheduleRefresh compares
    // against, so late-arriving messages reliably trigger a repaint.
    lastRenderLen = store.messagesFor(jid).length;
    // When the pane shrinks (switching from a long chat to a short/empty one),
    // blessed's cell diff can leave the taller previous render's cells on
    // screen as stray fragments — especially in terminals with imperfect
    // wide-char width (VS Code). Force a full repaint so nothing lingers.
    if (lines.length < lastLineCount) screen.realloc();
    lastLineCount = lines.length;
    screen.render();
  });
  let lastRenderJid = null;
  let lastRenderLen = 0;
  let lastLineCount = 0;

  // Send WhatsApp read receipts for a chat's incoming messages and clear its
  // unread counter. Capped so opening a huge backlog doesn't blast hundreds of
  // receipts. Fire-and-forget: a failed receipt must not disrupt the UI.
  function markChatRead(jid) {
    const c = client();
    const keys = store
      .messagesFor(jid)
      .filter((m) => !m.key?.fromMe)
      .slice(-50)
      .map((m) => m.key);
    if (c && keys.length) {
      Promise.resolve(c.readMessages(keys)).catch(() => {});
    }
    if (store.markRead(jid)) scheduleRefresh(); // repaint list to drop the badge
  }

  const openSelected = safe(function openSelected() {
    const jid = jids[list.selected];
    if (!jid) return;
    currentJid = jid;
    pendingMentions = [];
    replyTo = null; // a pending reply belongs to the chat it was staged in
    setInputLabel();
    renderChat(jid);
    markChatRead(jid); // opening a chat marks it read
    // Bucket empty (history batch not synced yet, or lid/pn alias unresolved)?
    // Pull older messages on demand; they re-render via the 'sync' hook below.
    if (store.messagesFor(jid).length === 0) store.fetchHistory(jid);
    if (isGroup(jid)) loadMembers(jid); // prefetch for @-mentions
    // Subscribe to the chat's presence so typing/online updates start flowing.
    const c = client();
    if (c) Promise.resolve(c.presenceSubscribe(jid)).catch(() => {});
    input.focus();
  });

  // Fetch + cache a group's participant jids (for the mention picker).
  function loadMembers(jid) {
    if (groupMembers.has(jid)) return;
    Promise.resolve(client().groupMetadata(jid))
      .then((meta) => {
        groupMembers.set(jid, (meta?.participants || []).map((p) => p.id));
        if (meta?.subject) {
          store.setGroupSubject(jid, meta.subject);
          if (currentJid === jid) log.setLabel(chatLabel(jid));
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

  // --- reply / quote ---
  const DEFAULT_INPUT_LABEL = ' ✍  message · Enter send · Esc back ';

  // Short single-line preview of a message's text (for pickers / labels).
  function snippet(m, n = 48) {
    const t = messageText(m).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  }

  // Reflect the pending reply (if any) in the input's label.
  function setInputLabel() {
    input.setLabel(
      replyTo
        ? ` ↩ replying: ${esc(snippet(replyTo, 28))} · Enter send · Esc cancel `
        : DEFAULT_INPUT_LABEL
    );
  }

  // Open the reply picker over the message pane for the currently open chat.
  function openReply() {
    if (!currentJid || !renderedMsgs.length) return;
    // Release the input textbox's key grab before focusing the picker; if the
    // textbox keeps reading, focus is split and the keyboard deadlocks (same
    // pattern as openMention). Only when the input is the widget reading.
    if (screen.focused === input) {
      suppressCancel = true;
      input.cancel();
      suppressCancel = false;
    }
    // Snapshot the visible messages: an incoming message can reassign
    // renderedMsgs while the picker is open, which would desync the indexes.
    replySnapshot = renderedMsgs.slice();
    replyBox.setItems(
      replySnapshot.map((m) => {
        const who = m.key?.fromMe
          ? 'me'
          : nameFor(m.key?.participant || m.key?.remoteJid);
        return `{${DIM}-fg}${esc(who)}:{/} ${esc(snippet(m))}`;
      })
    );
    replyBox.select(replySnapshot.length - 1); // default to the newest message
    replyBox.show();
    replyBox.focus();
    screen.render();
  }

  function pickReply() {
    const m = replySnapshot[replyBox.selected];
    replyBox.hide();
    if (m) {
      replyTo = m;
      setInputLabel();
    }
    input.focus();
    screen.render();
  }

  function cancelReply() {
    replyTo = null;
    setInputLabel();
  }

  replyBox.key(['enter'], pickReply);
  replyBox.key(['escape'], () => {
    replyBox.hide();
    input.focus();
    screen.render();
  });

  // --- emoji react ---
  // WhatsApp's default quick-reaction set, plus a couple of extras.
  const REACT_EMOJIS = [
    ['👍', 'thumbs up'],
    ['❤️', 'heart'],
    ['😂', 'laugh'],
    ['😮', 'wow'],
    ['😢', 'sad'],
    ['🙏', 'thanks'],
    ['🔥', 'fire'],
    ['✅', 'done'],
  ];

  // Open the react picker over the message pane for the currently open chat.
  function openReact() {
    if (!currentJid || !renderedMsgs.length) return;
    // Release the input textbox's key grab before focusing the picker (same
    // deadlock-avoidance pattern as openReply / openMention).
    if (screen.focused === input) {
      suppressCancel = true;
      input.cancel();
      suppressCancel = false;
    }
    // Snapshot the visible messages so a live incoming message can't desync the
    // picker indexes while it's open.
    reactSnapshot = renderedMsgs.slice();
    reactBox.setItems(
      reactSnapshot.map((m) => {
        const who = m.key?.fromMe
          ? 'me'
          : nameFor(m.key?.participant || m.key?.remoteJid);
        return `{${DIM}-fg}${esc(who)}:{/} ${esc(snippet(m))}`;
      })
    );
    reactBox.select(reactSnapshot.length - 1); // default to the newest message
    reactBox.show();
    reactBox.focus();
    screen.render();
  }

  // Message chosen — show the emoji picker.
  function pickReactTarget() {
    const m = reactSnapshot[reactBox.selected];
    reactBox.hide();
    if (!m) {
      input.focus();
      screen.render();
      return;
    }
    reactTarget = m;
    emojiBox.setItems(REACT_EMOJIS.map(([e, label]) => ` ${e}  {${DIM}-fg}${label}{/}`));
    emojiBox.select(0);
    emojiBox.show();
    emojiBox.focus();
    screen.render();
  }

  // Emoji chosen — send the reaction. Fire-and-forget like a normal send so a
  // slow socket never freezes the keyboard.
  function sendReact() {
    const pick = REACT_EMOJIS[emojiBox.selected];
    const target = reactTarget;
    emojiBox.hide();
    reactTarget = null;
    input.focus();
    screen.render();
    if (!pick || !target || !currentJid) return;
    Promise.resolve()
      .then(() => client().sendMessage(currentJid, { react: { text: pick[0], key: target.key } }))
      .then((sent) => {
        store.ingest(sent); // echo our own reaction into the store
        screen.render();
      })
      .catch((err) => {
        log.add(`⚠️ react failed: ${err.message}`);
        screen.render();
      });
  }

  reactBox.key(['enter'], pickReactTarget);
  reactBox.key(['escape'], () => {
    reactBox.hide();
    input.focus();
    screen.render();
  });
  emojiBox.key(['enter'], sendReact);
  emojiBox.key(['escape'], () => {
    // Step back to the message picker rather than dropping out entirely.
    emojiBox.hide();
    reactTarget = null;
    reactBox.show();
    reactBox.focus();
    screen.render();
  });

  // --- events ---
  list.on('select', openSelected);

  // Open the mention picker when '@' is typed in a group chat.
  input.on('keypress', (ch, key) => {
    if (ch === '@' && isGroup(currentJid)) setImmediate(openMention);
    // Ctrl-R while typing: open the reply picker (the textbox grabs keys in
    // read mode, so this keypress hook is the reliable place to catch it).
    else if (key && key.ctrl && key.name === 'r' && currentJid) {
      setImmediate(openReply);
    }
    // Ctrl-E while typing: open the emoji react picker.
    else if (key && key.ctrl && key.name === 'e' && currentJid) {
      setImmediate(openReact);
    }
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
    // Capture and clear the quoted message before re-arming, then reset the
    // label so the next message is a normal send.
    const quoted = replyTo;
    replyTo = null;
    setInputLabel();
    // Re-arm the input synchronously so the keyboard never freezes waiting on
    // the network. The send runs in the background — a hung/slow sendMessage
    // must not block re-focus (which is what re-starts blessed's key reading).
    const jid = currentJid;
    input.focus(); // stay in input for the next message
    screen.render();
    if (text && jid) {
      const content = mentions.length ? { text, mentions } : { text };
      const opts = quoted ? { quoted } : undefined;
      Promise.resolve()
        .then(() => client().sendMessage(jid, content, opts))
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
    if (currentJid && store.sameChat(jid, currentJid)) {
      if (messageText(message) !== '') {
        log.add(lineFor(message));
        log.setScrollPerc(100); // follow the conversation
        screen.render();
      }
      // Chat is open: receipt just this new message (not a bulk re-read of the
      // last 50) and keep its unread counter cleared. The trailing
      // scheduleRefresh below repaints the list.
      if (!message.key?.fromMe) {
        const c = client();
        if (c) Promise.resolve(c.readMessages([message.key])).catch(() => {});
        store.markRead(currentJid);
      }
    }
    scheduleRefresh(); // coalesced list update (bump/re-sort)
  }));

  // History batches / contact updates arriving async.
  store.on('sync', scheduleRefresh);

  // Presence changed (typing/online): refresh the open chat's title suffix.
  store.on('presence', safe(({ jid }) => {
    if (currentJid && store.sameChat(jid, currentJid)) {
      log.setLabel(chatLabel(currentJid));
      screen.render();
    }
  }));

  // Delivery/read status changed for a sent message: re-render the open chat so
  // its ticks update. Coalesced — a burst of receipts triggers one repaint.
  let statusRenderTimer = null;
  store.on('message-update', safe(({ jid }) => {
    if (!currentJid || !store.sameChat(jid, currentJid)) return;
    if (statusRenderTimer) return;
    statusRenderTimer = setTimeout(() => {
      statusRenderTimer = null;
      renderChat(currentJid, true); // keep scroll — don't yank a reader to the bottom
    }, 250);
  }));

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
  // Esc always clears the search and returns to the full, latest-first list.
  // Bound on 'cancel' (not the escape key) because the textbox consumes Esc as
  // a cancel while reading, so a plain key handler never fires.
  function clearSearch() {
    search.clearValue();
    filter = '';
    refreshList();  // filter '' → all chats, newest first
    list.select(0); // highlight the latest chat
    list.focus();
    screen.render();
  }
  search.on('cancel', clearSearch);
  search.key(['escape'], clearSearch);

  // --- keys ---
  screen.key(['q', 'C-c'], () => process.exit(0));
  screen.key(['tab'], () => {
    if (screen.focused === input) list.focus();
    else input.focus();
  });
  // Esc while typing: blessed fires 'cancel' (screen keys are grabbed during
  // input), so this is the reliable "back to list" hook.
  input.on('cancel', () => {
    if (suppressCancel) return; // opening a picker, not going back
    // First Esc clears a pending reply (stay in input); next Esc goes back.
    if (replyTo) {
      cancelReply();
      input.focus();
      screen.render();
      return;
    }
    list.focus();
    screen.render();
  });
  // `/` from the list opens search.
  list.key(['/'], () => search.focus());

  // Ctrl-R opens the reply picker. While the input is focused the textbox grabs
  // keys, so that case is handled in the input 'keypress' hook above; this
  // screen-level binding covers Ctrl-R from the list / message pane.
  screen.key(['C-r'], () => {
    if (currentJid) openReply();
  });

  // Ctrl-E opens the emoji react picker (from the list / message pane; the
  // input-focused case is handled in the input 'keypress' hook above).
  screen.key(['C-e'], () => {
    if (currentJid) openReact();
  });

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
