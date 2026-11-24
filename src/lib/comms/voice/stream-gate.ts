/**
 * Sits between the model's token stream and the voice line. Booking and capture
 * markers ([[...]]) must never be spoken, so they are swallowed here, and the
 * symbols text-to-speech reads out letter by letter are dropped. Text is passed
 * on as it arrives; only a trailing "[" or "*" is held back until the next piece
 * shows whether it starts a marker or a "**".
 */

/** Per-piece cleanup. Unlike the whole-reply version it must not trim: spaces sit between pieces. */
function cleanPiece(text: string): string {
  return text.replace(/\*\*/g, "").replace(/(?<!\w)\*(?!\w)/g, "");
}

export function makeSpeechGate(emit: (text: string) => void): {
  push: (delta: string) => void;
  end: () => void;
} {
  let pending = "";
  let inMarker = false;

  const send = (text: string) => {
    const t = cleanPiece(text);
    if (t) emit(t);
  };

  const drain = () => {
    for (;;) {
      if (inMarker) {
        const close = pending.indexOf("]]");
        if (close < 0) {
          // Keep one character in case "]]" is split across two pieces.
          pending = pending.slice(-1);
          return;
        }
        pending = pending.slice(close + 2);
        inMarker = false;
        continue;
      }
      const open = pending.indexOf("[[");
      if (open >= 0) {
        send(pending.slice(0, open));
        pending = pending.slice(open + 2);
        inMarker = true;
        continue;
      }
      const hold = /[[*]$/.test(pending) ? 1 : 0;
      send(pending.slice(0, pending.length - hold));
      pending = pending.slice(pending.length - hold);
      return;
    }
  };

  return {
    push(delta) {
      pending += delta;
      drain();
    },
    end() {
      // An unclosed marker is dropped; anything else left over is plain text.
      if (!inMarker) send(pending.replace(/\[$/, ""));
      pending = "";
      inMarker = false;
    },
  };
}
