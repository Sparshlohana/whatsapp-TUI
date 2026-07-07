// Helpers to pull a displayable text out of a Baileys message object.

// Map of non-text message content keys to a short placeholder label.
const MEDIA_LABELS = {
  imageMessage: '<image>',
  videoMessage: '<video>',
  stickerMessage: '<sticker>',
  documentMessage: '<document>',
  audioMessage: '<audio>',
  ptvMessage: '<video note>',
  contactMessage: '<contact>',
  contactsArrayMessage: '<contacts>',
  locationMessage: '<location>',
  liveLocationMessage: '<live location>',
  pollCreationMessage: '<poll>',
  pollCreationMessageV3: '<poll>',
  productMessage: '<product>',
};

// Wrapper messages that nest the real content one level down. Unwrap them
// (recursively) before trying to read text — group / disappearing / edited /
// view-once / multi-device messages all wrap the actual payload.
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'deviceSentMessage',
  'documentWithCaptionMessage',
  'editedMessage',
];

// Drill through wrapper layers to the innermost content object.
function unwrap(content) {
  let cur = content;
  for (let i = 0; i < 5 && cur; i++) {
    const key = WRAPPERS.find((k) => cur[k]?.message);
    if (!key) break;
    cur = cur[key].message;
  }
  return cur;
}

// Extract the plain text of a message, or a placeholder for media/unknown types.
function messageText(m) {
  const content = unwrap(m.message);
  if (!content) return '';

  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    '';

  if (text) return text;

  // Reactions: show the emoji itself. Empty text = reaction removed → skip.
  if (content.reactionMessage) {
    const emoji = content.reactionMessage.text;
    return emoji ? `↩ reacted ${emoji}` : '';
  }

  for (const key of Object.keys(MEDIA_LABELS)) {
    if (content[key]) return MEDIA_LABELS[key];
  }

  // System / non-content messages (edits, revokes, key distribution) carry no
  // display text — show nothing rather than a noisy placeholder.
  if (content.protocolMessage || content.senderKeyDistributionMessage) return '';

  return '<message>';
}

module.exports = { messageText };
