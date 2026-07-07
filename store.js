const { EventEmitter } = require('events');
const fs = require('fs');

// In-memory store assembled from Baileys socket events.
// (Baileys master removed makeInMemoryStore, so we build our own.)
class Store extends EventEmitter {
  constructor() {
    super();
    this.contacts = new Map();     // id (lid or pn) -> Contact
    this.contactByLid = new Map();  // '<lid>@lid' -> Contact
    this.contactByPn = new Map();   // '<pn>@s.whatsapp.net' -> Contact
    this.lidToPn = new Map();        // '<lid>@lid' -> '<pn>@s.whatsapp.net'
    this.pnToLid = new Map();         // '<pn>@s.whatsapp.net' -> '<lid>@lid'
    this.pushNames = new Map();       // normalized jid -> sender's display name
    this.chats = new Map();    // jid -> Chat
    this.messages = new Map(); // jid -> WAMessage[] (chronological)
    this.unread = new Map();   // canonical jid -> unread count (incoming, live)
    this.client = null;        // Baileys socket, for active LID lookups
    this._lidInflight = new Set(); // lids currently being resolved
    this._historyInflight = new Set(); // jids with an on-demand fetch pending
    this.syncProgress = null;  // 0-100 from messaging-history.set, or null
    this.syncComplete = false; // true once history stops streaming
    this._syncIdle = null;     // idle timer that flips syncComplete
    this._file = null;         // persistence path
    this._saveTimer = null;
    this._maxPerChat = 300;    // cap persisted messages per chat
  }

  // --- persistence: WhatsApp only sends full history on first login, so we
  // cache the store to disk and reload it on restart. ---

  // Load a previously saved store from disk (call before bind()).
  hydrate(file) {
    this._file = file;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const d = JSON.parse(raw);
      for (const c of d.contacts || []) this._upsertContact(c);
      for (const c of d.chats || []) this._upsertChat(c);
      for (const [lid, pn] of d.lidToPn || []) this._mapLidPn(lid, pn);
      for (const [jid, name] of d.pushNames || []) this.pushNames.set(jid, name);
      // Cap on load too — a store file written with a larger cap must not load
      // unbounded arrays into memory (mirrors the trim in _save).
      for (const [jid, list] of d.messages || []) {
        this.messages.set(jid, list.slice(-this._maxPerChat));
      }
      for (const [jid, n] of d.unread || []) this.unread.set(jid, n);
    } catch (_) {
      /* no cache yet, or unreadable — start fresh */
    }
  }

  // Debounced write of the current store to disk.
  _scheduleSave() {
    if (!this._file || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, 2000);
  }

  _save() {
    if (!this._file) return;
    try {
      const data = {
        contacts: [...this.contacts.values()],
        chats: [...this.chats.values()],
        lidToPn: [...this.lidToPn],
        pushNames: [...this.pushNames],
        messages: [...this.messages.entries()].map(([k, v]) => [
          k,
          v.slice(-this._maxPerChat),
        ]),
        unread: [...this.unread],
      };
      fs.writeFile(this._file, JSON.stringify(data), () => {});
    } catch (_) {
      /* ignore persistence failures */
    }
  }

  // Consider the sync "done" once no new history batch has arrived for a while
  // (WhatsApp doesn't always send isLatest, esp. in recent-history mode).
  _bumpSyncIdle() {
    clearTimeout(this._syncIdle);
    this._syncIdle = setTimeout(() => {
      this.syncComplete = true;
      this.emit('sync');
    }, 4000);
  }

  // Human-readable sync status for the UI.
  syncStatus() {
    if (this.syncComplete) return 'synced';
    if (this.syncProgress != null) return `syncing ${this.syncProgress}%`;
    return 'syncing…';
  }

  // Give the store the live socket so it can actively resolve LID -> PN.
  attachClient(client) {
    this.client = client;
  }

  // Actively resolve an unmapped @lid to a phone number via the socket's
  // LID mapping store. Fire-and-forget; emits 'sync' when it lands.
  resolveLid(jid) {
    if (
      !this.client ||
      !jid?.endsWith('@lid') ||
      this.lidToPn.has(jid) ||
      this._lidInflight.has(jid)
    ) {
      return;
    }
    const store = this.client.signalRepository?.lidMapping;
    if (!store?.getPNForLID) return;

    this._lidInflight.add(jid);
    Promise.resolve(store.getPNForLID(jid))
      .then((pn) => {
        if (pn) {
          this.lidToPn.set(jid, pn);
          this.emit('sync');
        }
      })
      .catch(() => {})
      .finally(() => this._lidInflight.delete(jid));
  }

  // Wire the store to a socket's event emitter.
  bind(ev) {
    ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest, progress }) => {
      for (const c of contacts || []) this._upsertContact(c);
      for (const c of chats || []) this._upsertChat(c);
      for (const m of messages || []) this._appendMessage(m, false);
      if (progress != null) this.syncProgress = Math.round(progress);
      if (isLatest) this.syncComplete = true;
      else this._bumpSyncIdle(); // settle to "synced" once batches stop
      this.emit('sync');
    });

    ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) this._upsertContact(c);
      this.emit('sync');
    });
    ev.on('contacts.update', (contacts) => {
      for (const c of contacts) this._upsertContact(c);
      this.emit('sync');
    });

    ev.on('chats.upsert', (chats) => {
      for (const c of chats) this._upsertChat(c);
      this.emit('sync');
    });
    ev.on('chats.update', (chats) => {
      for (const c of chats) this._upsertChat(c);
      this.emit('sync');
    });
    ev.on('chats.delete', (jids) => {
      for (const jid of jids) {
        this.chats.delete(jid);
        this.messages.delete(jid);
        this.unread.delete(this._canonicalJid(jid));
      }
      this.emit('sync');
    });

    ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages) this._appendMessage(m, true);
    });

    // LID <-> phone-number mapping (Baileys 7 addresses DMs by @lid).
    ev.on('lid-mapping.update', ({ lid, pn }) => {
      if (lid && pn) {
        this._mapLidPn(lid, pn);
        this.emit('sync');
      }
    });
  }

  // Record a bidirectional LID <-> PN mapping.
  _mapLidPn(lid, pn) {
    if (!lid || !pn) return;
    this.lidToPn.set(lid, pn);
    this.pnToLid.set(pn, lid);
    this._scheduleSave();
  }

  _upsertContact(c) {
    if (!c?.id) return;
    const prev = this.contacts.get(c.id) || {};
    const merged = { ...prev, ...c };
    this.contacts.set(c.id, merged);
    // Secondary indexes so a chat keyed by lid or pn still resolves.
    if (merged.lid) this.contactByLid.set(merged.lid, merged);
    if (merged.phoneNumber) this.contactByPn.set(merged.phoneNumber, merged);
    if (merged.lid && merged.phoneNumber) this._mapLidPn(merged.lid, merged.phoneNumber);
    this._scheduleSave();
  }

  // Strip the ':<device>' suffix from a jid's user part so that
  // '918160381898:0@s.whatsapp.net' and '918160381898@s.whatsapp.net' unify.
  _norm(jid) {
    return typeof jid === 'string' ? jid.replace(/:\d+(?=@)/, '') : jid;
  }

  // All jid forms that refer to the same DM identity (lid + pn). Groups map to
  // just themselves. Used to merge messages/chats split across lid vs pn keys.
  _aliasSet(jid) {
    jid = this._norm(jid);
    const s = new Set([jid]);
    if (!jid || jid.endsWith('@g.us')) return s;
    if (jid.endsWith('@lid')) {
      const pn = this.lidToPn.get(jid);
      if (pn) s.add(pn);
    } else {
      const lid = this.pnToLid.get(jid);
      if (lid) s.add(lid);
    }
    const c = this._contactFor(jid);
    if (c?.lid) s.add(c.lid);
    if (c?.phoneNumber) s.add(c.phoneNumber);
    return s;
  }

  // Canonical key for a DM identity: prefer the LID form (stable across
  // WhatsApp's number-hiding), else the jid as-is.
  _canonicalJid(jid) {
    jid = this._norm(jid);
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@lid')) return jid;
    const c = this._contactFor(jid);
    return this.pnToLid.get(jid) || c?.lid || jid;
  }

  // Do two jids refer to the same chat (accounting for lid/pn aliasing)?
  sameChat(a, b) {
    a = this._norm(a);
    b = this._norm(b);
    if (!a || !b) return false;
    if (a === b) return true;
    return this._canonicalJid(a) === this._canonicalJid(b) || this._aliasSet(a).has(b);
  }

  _upsertChat(c) {
    if (!c?.id) return;
    const id = this._norm(c.id);
    const prev = this.chats.get(id) || {};
    const merged = { ...prev, ...c, id };
    // Capture a history anchor (last-message key + ts) from the chat preview
    // Baileys ships in history/upsert batches. Lets us backfill an empty chat
    // on demand even when its message bucket hasn't synced yet.
    const last = Array.isArray(c.messages) && c.messages.length
      ? c.messages[c.messages.length - 1]?.message
      : null;
    if (last?.key?.id) {
      merged.anchorKey = last.key;
      merged.anchorTs = Number(last.messageTimestamp) || merged.anchorTs;
    }
    this.chats.set(id, merged);
    this._scheduleSave();
  }

  // Ask WhatsApp for older messages of a chat whose local bucket is empty (or
  // short). Results arrive async via 'messaging-history.set' and land in the
  // normal message store, which then emits 'sync'. Fire-and-forget, deduped.
  async fetchHistory(jid) {
    jid = this._norm(jid);
    if (!jid || !this.client?.fetchMessageHistory || this._historyInflight.has(jid)) {
      return;
    }
    // Anchor from the oldest message we already hold; else the chat preview's
    // last-message key captured in _upsertChat.
    let key, ts;
    const have = this.messagesFor(jid);
    if (have.length) {
      key = have[0].key;
      ts = Number(have[0].messageTimestamp);
    } else {
      for (const alias of this._aliasSet(jid)) {
        const chat = this.chats.get(alias);
        if (chat?.anchorKey?.id) {
          key = chat.anchorKey;
          ts = Number(chat.anchorTs);
          break;
        }
      }
    }
    if (!key?.id) return; // no cursor to page from — nothing we can request

    this._historyInflight.add(jid);
    try {
      await this.client.fetchMessageHistory(50, key, ts || Math.floor(Date.now() / 1000));
    } catch (_) {
      // socket may be mid-reconnect; leave the chat empty, user can retry
    } finally {
      this._historyInflight.delete(jid);
    }
  }

  // Record a group's subject (name) fetched via groupMetadata.
  setGroupSubject(jid, subject) {
    if (!jid || !subject) return;
    const id = this._norm(jid);
    const prev = this.chats.get(id) || { id };
    prev.name = subject;
    prev.subject = subject;
    this.chats.set(id, prev);
    this._scheduleSave();
    this.emit('sync');
  }

  // Feed a message the socket returned to us (e.g. one we just sent) so it is
  // stored + displayed like any received message. Deduped by id.
  ingest(m) {
    if (m) this._appendMessage(m, true);
  }

  // Append a message to its chat bucket. `live` = arrived while connected.
  _appendMessage(m, live) {
    const jid = this._norm(m.key?.remoteJid);
    if (!jid || jid === 'status@broadcast') return;

    // Learn the sender's display name from pushName (best source for group
    // members, who are otherwise unnamed LID jids).
    if (m.pushName && !m.key?.fromMe) {
      const sender = this._norm(m.key?.participant || m.key?.remoteJid);
      if (sender) this.pushNames.set(sender, m.pushName);
    }

    const list = this.messages.get(jid) || [];
    // Dedupe by message id — skip entirely if we already have it.
    const isNew = !list.some((x) => x.key?.id === m.key?.id);
    if (isNew) list.push(m);
    this.messages.set(jid, list);

    // Ensure a chat row exists and bump its sort timestamp.
    const chat = this.chats.get(jid) || { id: jid };
    const ts = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000);
    if (ts >= (Number(chat.conversationTimestamp) || 0)) {
      chat.conversationTimestamp = ts;
    }
    this.chats.set(jid, chat);

    // Count genuinely-new incoming messages as unread. History-sync batches
    // (live=false) and our own echoes (fromMe) never bump the count. The UI
    // clears it via markRead() when the chat is opened / already focused.
    if (live && isNew && !m.key?.fromMe) {
      const canon = this._canonicalJid(jid);
      this.unread.set(canon, (this.unread.get(canon) || 0) + 1);
    }

    // Only notify for genuinely new messages so echoes don't double-render.
    if (live && isNew) this.emit('message', { jid, message: m });
    if (isNew) this._scheduleSave();
  }

  // All keys a chat's unread count might live under: its alias set (lid + pn)
  // plus the canonical form. The canonical jid isn't stable over time — a count
  // written under a pn before the lid mapping is learned would otherwise be
  // orphaned once the chat canonicalizes to the lid — so we always read/clear
  // across every alias, mirroring messagesFor().
  _unreadKeys(jid) {
    const keys = this._aliasSet(jid);
    keys.add(this._canonicalJid(jid));
    return keys;
  }

  // Unread incoming count for a chat, summed across all of its alias keys.
  unreadFor(jid) {
    let n = 0;
    for (const key of this._unreadKeys(jid)) n += this.unread.get(key) || 0;
    return n;
  }

  // Clear a chat's unread counter across every alias. Returns true if changed.
  markRead(jid) {
    let changed = false;
    for (const key of this._unreadKeys(jid)) {
      if (this.unread.get(key)) {
        this.unread.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this._scheduleSave();
      this.emit('sync');
    }
    return changed;
  }

  // Chats sorted newest-first, excluding the status feed. LID/PN duplicates of
  // the same DM identity are collapsed into a single row.
  listChats() {
    const byCanonical = new Map(); // canonical jid -> representative chat
    for (const c of this.chats.values()) {
      if (!c.id || c.id === 'status@broadcast') continue;
      const key = this._canonicalJid(c.id);
      const ts = Number(c.conversationTimestamp) || 0;
      const prev = byCanonical.get(key);
      if (!prev) {
        byCanonical.set(key, { ...c, conversationTimestamp: ts });
        continue;
      }
      // Merge: keep the newest timestamp; prefer an id that resolves to a name.
      const merged = { ...prev };
      merged.conversationTimestamp = Math.max(
        Number(prev.conversationTimestamp) || 0,
        ts
      );
      if (!this._contactHasName(prev.id) && this._contactHasName(c.id)) {
        merged.id = c.id;
        merged.name = c.name || merged.name;
      }
      byCanonical.set(key, merged);
    }

    const chats = [...byCanonical.values()].sort(
      (a, b) =>
        (Number(b.conversationTimestamp) || 0) -
        (Number(a.conversationTimestamp) || 0)
    );
    // Kick off background resolution for any still-unmapped LIDs.
    for (const c of chats) {
      if (c.id.endsWith('@lid') && !this._contactHasName(c.id)) {
        this.resolveLid(c.id);
      }
    }
    return chats;
  }

  _contactHasName(jid) {
    const c = this._contactFor(jid);
    return !!(c?.name || c?.notify || c?.verifiedName || c?.username);
  }

  // Messages for a chat, merged across all alias jids (lid + pn) and deduped.
  messagesFor(jid) {
    const merged = [];
    const seen = new Set();
    for (const alias of this._aliasSet(jid)) {
      for (const m of this.messages.get(alias) || []) {
        const id = m.key?.id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        merged.push(m);
      }
    }
    return merged.sort(
      (a, b) =>
        (Number(a.messageTimestamp) || 0) - (Number(b.messageTimestamp) || 0)
    );
  }

  // Resolve a Contact for a jid across all indexes (id / lid / pn), bridging
  // lid<->pn so a contact stored under one form resolves for the other.
  _contactFor(jid) {
    jid = this._norm(jid);
    let c =
      this.contacts.get(jid) ||
      this.contactByLid.get(jid) ||
      this.contactByPn.get(jid);
    if (c) return c;
    if (jid.endsWith('@lid')) {
      const pn = this.lidToPn.get(jid);
      if (pn) {
        c = this.contacts.get(pn) || this.contactByPn.get(pn);
        if (c) return c;
      }
    } else {
      const lid = this.pnToLid.get(jid);
      if (lid) {
        c = this.contactByLid.get(lid) || this.contacts.get(lid);
        if (c) return c;
      }
    }
    return undefined;
  }

  // Bare number for display: prefer the mapped phone number over a raw lid.
  _numberFor(jid) {
    jid = this._norm(jid);
    const c = this._contactFor(jid);
    if (c?.phoneNumber) return c.phoneNumber.replace(/[:@].*$/, '');
    if (jid.endsWith('@lid')) {
      const pn = this.lidToPn.get(jid);
      if (pn) return pn.replace(/[:@].*$/, '');
      return jid.replace('@lid', '') + ' (hidden)';
    }
    return jid.replace(/[:@].*$/, '');
  }

  // Best-effort display name for a jid.
  nameFor(jid) {
    jid = this._norm(jid);
    if (!jid) return 'Unknown';
    if (jid.endsWith('@g.us')) {
      const chat = this.chats.get(jid);
      if (chat?.name) return chat.name;
      if (chat?.subject) return chat.subject;
      return jid.replace('@g.us', ' (group)');
    }
    const c = this._contactFor(jid);
    const name = c?.name || c?.notify || c?.verifiedName || c?.username;
    if (name) return name;
    // Fall back to a display name learned from message pushName — checked
    // across all alias forms (lid + pn) of this identity.
    for (const alias of this._aliasSet(jid)) {
      const push = this.pushNames.get(alias);
      if (push) return push;
    }
    return this._numberFor(jid);
  }
}

module.exports = { Store };
