require('dotenv').config();
const { startWhatsApp } = require('./whatsapp');
const { startUI } = require('./ui');

// Full history is needed to populate the chat LIST at startup; recent mode
// only shows chats that get a live message. Default full; opt out with
// `--recent` for a faster-but-sparse start. Toggle live in the UI with F.
const fullHistory = !process.argv.includes('--recent');

// Boot the socket; mount the terminal UI once WhatsApp connects.
// Before 'open', QR is printed to the console for scanning.
startWhatsApp({
  fullHistory,
  onReady: ({ wa }) => {
    console.log('✅ Connected. Loading interface...');
    startUI({ wa });
  },
}).catch((err) => console.error('❌ Failed to start:', err));
