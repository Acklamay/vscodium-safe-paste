import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Safe Terminal Paste — v1.3.0
//
// PURPOSE
// This is a *heuristic workaround* for terminal input corruption when
// pasting large text blocks via VS Code / VSCodium's integrated terminal.
// The corruption is well-documented (see vscode#38137, vscode#283056,
// vscode#292058) and involves truncation, interleaving, or mis-delivery
// of pasted content through node-pty and the OS pseudo-terminal layer.
//
// LIMITATIONS (inherent to the public Extension API)
// • Terminal.sendText() is fire-and-forget — there is no backpressure or
//   drain signal, so inter-chunk delays are purely heuristic.
// • sendText() bypasses VS Code's native bracketed-paste wrapping.  This
//   means tabs may trigger shell completion instead of being inserted
//   literally, and shells that rely on bracketed paste for multiline
//   safety will not see the expected escape sequences.  There is no
//   public API to emit bracketed-paste escapes from an extension.
// • We cannot fully replicate native paste semantics (multiline warnings,
//   shell-specific handling) from a public extension.
//
// KEYBINDING NOTE
// The system "Terminal: Paste into Active Terminal" binding has System
// priority, which outranks extension-contributed bindings even when the
// when-clause is more specific.  Users MUST add entries to their personal
// keybindings.json to disable the system binding and register ours at
// User priority.  See README.md for the required configuration.
//
// If VS Code ships a first-class chunked-paste API in the future, this
// extension should be retired in favour of that.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Paste queue — serialises rapid consecutive Cmd/Ctrl+V presses so their
// chunks never interleave.
// ---------------------------------------------------------------------------
const pasteQueue: string[] = [];
let isDraining = false;

async function drainQueue(terminal: vscode.Terminal): Promise<void> {
    if (isDraining) {
        return;
    }
    isDraining = true;

    try {
        while (pasteQueue.length > 0) {
            const text = pasteQueue.shift()!;
            await dripFeed(terminal, text);
        }
    } finally {
        isDraining = false;
    }
}

// ---------------------------------------------------------------------------
// Core drip-feed logic
// ---------------------------------------------------------------------------
async function dripFeed(terminal: vscode.Terminal, raw: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('safePaste');
    const chunkSize: number = config.get<number>('chunkSize', 50);
    const delayMs: number = config.get<number>('delayMs', 20);

    // Step 1 — Normalize line endings BEFORE chunking.
    // sendText() converts \r?\n → \r internally.  If a \r\n pair straddles
    // a chunk boundary, the \r lands at the end of one sendText() call and
    // the \n at the start of the next, producing two carriage returns.
    // Normalizing to \n up front avoids this entirely.
    const text = raw.replace(/\r\n/g, '\n');

    // Step 2 — Build safe chunks
    const chunks = buildChunks(text, chunkSize);

    // Step 3 — Drip-feed with heuristic pacing
    for (let i = 0; i < chunks.length; i++) {
        terminal.sendText(chunks[i], false);

        if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

// ---------------------------------------------------------------------------
// Chunk builder
//
// Strategy (in priority order):
//   1. Accumulate whole lines up to chunkSize.
//   2. For lines exceeding chunkSize, slice at fixed offsets but NEVER
//      split immediately before an ESC (\x1b) character — this avoids
//      breaking ANSI/VT escape sequences mid-stream, matching the
//      approach used by VS Code's own internal chunker.
// ---------------------------------------------------------------------------
function buildChunks(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    let buffer = '';

    // Split on newlines but retain the delimiter so the final paste is
    // byte-identical (post-normalization) to the clipboard contents.
    const lines = text.split(/(?<=\n)/);

    for (const line of lines) {
        // If appending this line still fits, accumulate
        if (buffer.length + line.length <= chunkSize) {
            buffer += line;
            continue;
        }

        // Flush the current buffer
        if (buffer.length > 0) {
            chunks.push(buffer);
            buffer = '';
        }

        // If the single line exceeds chunkSize, slice it carefully
        if (line.length > chunkSize) {
            sliceWithEscAwareness(line, chunkSize, chunks);
        } else {
            buffer = line;
        }
    }

    if (buffer.length > 0) {
        chunks.push(buffer);
    }

    return chunks;
}

// ---------------------------------------------------------------------------
// Fixed-offset slicing that avoids breaking escape sequences.
// If a cut would land immediately before \x1b, we back up one byte so the
// ESC character starts the next chunk.
// ---------------------------------------------------------------------------
function sliceWithEscAwareness(
    text: string,
    chunkSize: number,
    out: string[],
): void {
    let offset = 0;

    while (offset < text.length) {
        let end = Math.min(offset + chunkSize, text.length);

        // If we're not at the very end, check whether the next character
        // is ESC.  If so, pull the boundary back by one so the escape
        // sequence isn't split across chunks.
        if (end < text.length && text.charCodeAt(end) === 0x1b) {
            end = Math.max(offset + 1, end - 1);
        }

        out.push(text.slice(offset, end));
        offset = end;
    }
}

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand(
        'aiassist.safePaste',
        async () => {
            const terminal = vscode.window.activeTerminal;
            if (!terminal) {
                return;
            }

            let text: string;
            try {
                text = await vscode.env.clipboard.readText();
            } catch (err) {
                // Clipboard read can throw on Wayland compositors or
                // restricted remote environments.  Fall back to native
                // paste so the user never sees a dead keypress.
                console.warn(
                    '[Safe Paste] Clipboard read failed — falling back to native paste:',
                    err,
                );
                await vscode.commands.executeCommand(
                    'workbench.action.terminal.paste',
                );
                return;
            }

            // readText() can return '' on Wayland or headless contexts.
            if (!text) {
                await vscode.commands.executeCommand(
                    'workbench.action.terminal.paste',
                );
                return;
            }

            pasteQueue.push(text);
            await drainQueue(terminal);
        },
    );

    context.subscriptions.push(disposable);
}

export function deactivate() {}
