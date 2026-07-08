# wp-chat

A terminal WhatsApp client. Connects to WhatsApp Web via [Baileys](https://github.com/WhiskeySockets/Baileys) and renders a full TUI ([blessed](https://github.com/chjj/blessed)) — chat list, message view, and a text input — right in your terminal.

## Features

- **QR login** — scan once; the session is persisted on disk (`auth_info_baileys/`) and reused on restart.
- **Persistent store** — chats and messages are cached to `wp-chat-store.json` and rehydrated at startup, so the chat list is populated immediately.
- **History sync modes** — `recent` (fast, sparse) or `full` (slow, complete backlog). Toggle live in the UI with `F` (reconnects to apply).
- **Search** — filter the chat list with `/`.
- **Mentions** — pick contacts to `@`-mention while composing.
- **Media placeholders** — non-text messages (image, video, sticker, doc, poll, location, reactions, …) render as short labels.
- **LID → phone-number resolution** for accurate sender names.
- Auto-reconnect on dropped connections, reusing the same store.

## Requirements

- Node.js (with `node`/`npm`)
- A WhatsApp account to scan the QR

## Install

```bash
npm install
```

## Usage

```bash
npm start            # full history (default)
npm start -- --recent   # faster start, only chats with live messages
npm run dev          # auto-reload via nodemon
```

On first run a QR code prints to the console — scan it from **WhatsApp → Linked Devices**. Once connected, the TUI mounts automatically.

## Keybindings

| Key         | Action                                        |
|-------------|-----------------------------------------------|
| `Tab`       | Toggle focus between chat list and input      |
| `/`         | Search / filter the chat list                 |
| `Enter`     | (search) jump into the filtered list          |
| `Esc`       | Back to list / clear filter                   |
| `Ctrl-R`    | Reply to a message (pick from the open chat)  |
| `Ctrl-Y`    | React to a message with an emoji              |
| `@`         | (group chat) mention a member                 |
| `F`         | Toggle history-sync mode (recent ↔ full)      |
| `Ctrl-L`    | Force repaint + refocus the list (recovery)   |
| `q` / `Ctrl-C` | Quit                                       |

## Project layout

| File                    | Role                                                          |
|-------------------------|--------------------------------------------------------------|
| `src/index.js`          | Entry point — boots the socket, mounts the UI on connect     |
| `src/core/whatsapp.js`  | Baileys socket lifecycle, auth, reconnect, history toggle    |
| `src/core/store.js`     | In-memory chat/message store with disk persistence           |
| `src/ui/ui.js`          | blessed TUI — chat list, message view, input, keybindings    |
| `src/utils/message.js`  | Extract display text / media labels from Baileys messages    |

## Logout

Delete the `auth_info_baileys/` folder and restart to re-login with a new QR.

## License

ISC
