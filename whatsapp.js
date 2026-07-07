const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { Store } = require('./store');

// Start the WhatsApp socket. Returns a controller `wa`:
//   wa.store           - the in-memory store
//   wa.client          - the *current* live socket (changes across reconnects)
//   wa.fullHistory     - current history-sync mode
//   wa.setFullHistory(v) / wa.toggleFullHistory() - switch mode (reconnects)
// `onReady({ wa })` is called once, when the first connection opens.
async function startWhatsApp({ onReady, fullHistory = false } = {}) {
  const store = new Store();
  store.hydrate('wp-chat-store.json'); // restore chat list + messages from disk
  let readyFired = false;
  let reconnecting = false;

  const wa = {
    store,
    client: null,
    fullHistory,
    setFullHistory,
    toggleFullHistory: () => setFullHistory(!wa.fullHistory),
  };

  // Change history-sync mode and reconnect so it takes effect.
  function setFullHistory(v) {
    if (v === wa.fullHistory) return;
    wa.fullHistory = v;
    reconnecting = true;
    try {
      wa.client?.ws?.close(); // triggers the reconnect path below
    } catch (_) {}
  }

  async function connect() {
    // Same auth as whatsapp-bot: multi-file session persisted on disk.
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const client = makeWASocket({
      logger: pino({ level: 'silent' }),
      browser: ['My-Bot', 'Chrome', '1.0.0'],
      auth: state,
      // Off = WhatsApp front-loads the recent chat set fast; on = full backlog
      // (slow). Toggled live from the UI, which reconnects to apply it.
      syncFullHistory: wa.fullHistory,
    });

    wa.client = client;
    store.bind(client.ev);
    store.attachClient(client); // enable active LID -> PN resolution
    client.ev.on('creds.update', saveCreds);

    client.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('📲 Scan this QR code to log in:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        reconnecting = false;
        if (!readyFired && typeof onReady === 'function') {
          readyFired = true;
          onReady({ wa });
        }
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        if (reconnecting || reason !== DisconnectReason.loggedOut) {
          connect(); // reconnect, reusing the same store
        } else {
          console.log('🔐 Logged out. Delete the "auth_info_baileys" folder and restart to re-login.');
          process.exit(0);
        }
      }
    });

    return client;
  }

  await connect();
  return wa;
}

module.exports = { startWhatsApp };
