# Safe Terminal Paste (VS Code / VSCodium)

Sadly an early version worked but this one does not yet. The issue is believed to be from the terminal perceiving the paste as complete when it is not and it auto sends on paste. The earlier version was slower and the buffer flow kept it from dropping and sending in chunks. Working on flow and pressure to fix and not sure if this issue is with all terminal varieties.

A heuristic workaround extension that reduces silent truncation and interleaving when pasting large text blocks into the integrated terminal.

## The Problem

If you've ever pasted a large script or log into the VS Code terminal and noticed part of the output was missing or garbled — with no error — you've hit a well-documented class of terminal input corruption bugs (see [vscode#38137](https://github.com/Microsoft/vscode/issues/38137), [vscode#283056](https://github.com/microsoft/vscode/issues/283056), [vscode#292058](https://github.com/microsoft/vscode/issues/292058)).

The integrated terminal relies on `node-pty` to communicate with your operating system's pseudo-terminal (PTY). The OS-level PTY input queue has implementation-defined size limits, and when a large paste payload arrives faster than the shell can drain the buffer, bytes can be silently dropped, interleaved, or corrupted.

VS Code's core already contains some internal chunking/throttling logic for this, but corruption still occurs in practice — particularly with very large payloads, remote SSH sessions, or certain shell configurations.

## How This Extension Helps

This extension intercepts the paste shortcut when the terminal has focus and replaces the native paste path with a controlled drip-feed:

1. **Interception** — overrides the default paste shortcut exclusively in terminal focus context.
2. **Clipboard Read** — reads raw text directly from the OS clipboard, bypassing the native terminal paste handler.
3. **Line-Ending Normalization** — normalizes `\r\n` to `\n` before chunking to prevent double carriage returns when `sendText()` performs its own conversion.
4. **Newline-Aware Chunking** — splits on line boundaries first so commands are never bisected mid-line. Falls back to fixed-offset slicing for individual lines that exceed the chunk size, with awareness of ANSI escape sequence boundaries.
5. **Queue & Drip-Feed** — a FIFO queue serialises rapid consecutive pastes, and an async loop pipes chunks with a configurable delay between writes.

## Known Limitations

This extension operates within the constraints of VS Code's public Extension API. You should be aware of:

- **No bracketed paste.** `Terminal.sendText()` does not emit the bracketed-paste escape sequences (`\x1b[200~` / `\x1b[201~`) that the native paste path uses. This means tabs in pasted content may trigger shell completion instead of being inserted literally, and shells that rely on bracketed paste for multiline safety won't see the expected signals.
- **No backpressure.** `sendText()` returns `void` — there's no way to know when the terminal has actually consumed a chunk. The inter-chunk delay is purely heuristic.
- **No multiline warnings.** The native paste path can show a confirmation dialog for multiline content in some shell configurations. This extension bypasses that.

If VS Code ships a first-class chunked-paste API in the future, this extension should be retired in favour of that.

## Installation

### Step 1: Install the Extension

#### From .vsix (Quick Install)

Download the `.vsix` from the [Releases](https://github.com/Acklamay/vscodium-safe-paste/releases) page.

**GUI:** Open Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`) → `...` menu → **Install from VSIX...** → select the file.

**CLI:**
```bash
# VS Code
code --install-extension vscodium-safe-paste-1.3.0.vsix

# VSCodium
codium --install-extension vscodium-safe-paste-1.3.0.vsix
```

#### From Source

```bash
git clone https://github.com/Acklamay/vscodium-safe-paste.git
cd vscodium-safe-paste
npm install
npm run compile
npm install -g @vscode/vsce
vsce package
```

Then install the generated `.vsix` using the GUI or CLI method above.

### Step 2: Configure Keybindings (Required)

**This step is required.** The built-in "Terminal: Paste into Active Terminal" command has System priority, which outranks extension-contributed keybindings. Without this step, the system paste will intercept `Ctrl+V` before the extension ever sees it.

1. Open the command palette: `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS)
2. Type **"Open Keyboard Shortcuts (JSON)"** and select it
3. Paste the appropriate block for your OS:

**Windows:**
```json
[
    {
        "key": "ctrl+v",
        "command": "-workbench.action.terminal.paste",
        "when": "terminalFocus && terminalHasBeenCreated || terminalFocus && terminalProcessSupported"
    },
    {
        "key": "ctrl+v",
        "command": "aiassist.safePaste",
        "when": "terminalFocus && !findInputFocussed"
    }
]
```

**macOS:**
```json
[
    {
        "key": "cmd+v",
        "command": "-workbench.action.terminal.paste",
        "when": "terminalFocus && terminalHasBeenCreated || terminalFocus && terminalProcessSupported"
    },
    {
        "key": "cmd+v",
        "command": "aiassist.safePaste",
        "when": "terminalFocus && !findInputFocussed"
    }
]
```

**Linux:**
```json
[
    {
        "key": "ctrl+shift+v",
        "command": "-workbench.action.terminal.paste",
        "when": "terminalFocus && terminalHasBeenCreated || terminalFocus && terminalProcessSupported"
    },
    {
        "key": "ctrl+shift+v",
        "command": "aiassist.safePaste",
        "when": "terminalFocus && !findInputFocussed"
    }
]
```

4. Save the file and restart VS Code / VSCodium.

**What this does:** The first entry (with the `-` prefix) disables the built-in terminal paste binding. The second entry registers the Safe Paste command at User priority, which always outranks System priority. If you already have other entries in your `keybindings.json`, merge the new entries into the existing array.

### Step 3: Verify

1. Open a terminal in VS Code / VSCodium
2. Copy a large block of text to your clipboard (several hundred lines)
3. Paste with your normal shortcut
4. The text should arrive without truncation

You can also verify via the command palette: `Ctrl+Shift+P` → **Terminal: Safe Paste**.

## Configuration

Tune these in your `settings.json` or via the Settings UI (search "Safe Paste"):

| Setting              | Default | Range    | Description                                                                                              |
|----------------------|---------|----------|----------------------------------------------------------------------------------------------------------|
| `safePaste.chunkSize`| `50`    | 10–512   | Max characters per chunk. VS Code's own internal chunker has used values as low as 50. Higher is faster but riskier. |
| `safePaste.delayMs`  | `20`    | 1–500    | Milliseconds between chunks. Increase for slow systems or high-latency SSH.                              |

To edit directly, open `Ctrl+Shift+P` → **"Open User Settings (JSON)"** and add:

```json
"safePaste.chunkSize": 50,
"safePaste.delayMs": 20
```

## Architecture

- **Paste Queue** — rapid consecutive pastes are FIFO-queued and drained sequentially. An `isDraining` lock prevents interleaved chunk streams.
- **`\r\n` Normalization** — performed before chunking so that `sendText()`'s internal `\r?\n → \r` conversion doesn't produce double line breaks at chunk boundaries.
- **ESC-Aware Slicing** — when a long line must be sliced at fixed offsets, the slicer avoids cutting immediately before `\x1b` to prevent breaking ANSI escape sequences.
- **Graceful Fallback** — if clipboard read fails or returns empty (common on Wayland or restricted remote environments), the extension falls back to the native `workbench.action.terminal.paste` command so the keypress is never silently swallowed.

## Troubleshooting

**Paste still truncates / extension doesn't intercept:**
You most likely skipped Step 2 above. The system terminal paste binding must be explicitly disabled in `keybindings.json` for this extension to intercept `Ctrl+V`.

**Settings don't appear in the Settings UI:**
Search for `safePaste.chunkSize` (the full setting name) rather than "Safe Paste". Alternatively, edit `settings.json` directly as described in the Configuration section.

**Still seeing corruption after installation:**
Try lowering `safePaste.chunkSize` to `25` and raising `safePaste.delayMs` to `50`. If you're on a remote SSH session, try `delayMs` of `100` or higher.

## License

[MIT](LICENSE.md) — consistent with VSCodium's own license.
