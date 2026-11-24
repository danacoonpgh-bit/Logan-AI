"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, FileText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { QUICK_START_NOTES, type QuickStartLang } from "./quick-start-notes";

/** Renders `backticked` parts of a line as inline code. */
function inline(text: string) {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

function CommandRow({
  command,
  copyLabel,
  copiedLabel,
}: {
  command: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the text is still selectable by hand.
    }
  }

  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <code className="min-w-0 flex-1 select-all break-all font-mono text-xs leading-relaxed">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`${copyLabel}: ${command}`}
        className="inline-flex shrink-0 items-center gap-1 rounded border bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {copied ? (
          <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}

/**
 * Button under the video that opens the written notes (description, chapters,
 * commands, fixes) in their own dialog. It must be rendered inside the video
 * dialog so it nests: closing the notes leaves the video open and playing.
 */
export function QuickStartNotesPanel({ lang }: { lang: QuickStartLang }) {
  const [open, setOpen] = useState(false);
  const notes = QUICK_START_NOTES[lang];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm transition-colors hover:bg-muted/60"
      >
        <span className="flex items-center gap-2 font-semibold">
          <FileText className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          {notes.button}
        </span>
        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          lang={lang}
          className="max-h-[85vh] gap-5 overflow-y-auto sm:max-w-xl"
        >
          <DialogHeader>
            <DialogTitle>{notes.button}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-muted-foreground">
            {notes.intro.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>

          <section>
            <h3 className="mb-2 font-semibold">{notes.chaptersTitle}</h3>
            <ul className="space-y-1">
              {notes.chapters.map((c) => (
                <li key={c.time} className="flex gap-3">
                  <span className="w-10 shrink-0 font-mono text-xs leading-5 text-muted-foreground">
                    {c.time}
                  </span>
                  <span>{c.label}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-2 font-semibold">{notes.commandsTitle}</h3>
            <div className="space-y-2">
              {notes.commands.map((block, i) =>
                "code" in block ? (
                  block.code.map((command) => (
                    <CommandRow
                      key={`${i}-${command}`}
                      command={command}
                      copyLabel={notes.copy}
                      copiedLabel={notes.copied}
                    />
                  ))
                ) : (
                  <p key={i} className="pt-1 text-muted-foreground">
                    {block.text}
                  </p>
                ),
              )}
            </div>
          </section>

          <section>
            <h3 className="mb-2 font-semibold">{notes.stuckTitle}</h3>
            <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
              {notes.stuck.map((line) => (
                <li key={line}>{inline(line)}</li>
              ))}
            </ul>
          </section>
        </DialogContent>
      </Dialog>
    </>
  );
}
