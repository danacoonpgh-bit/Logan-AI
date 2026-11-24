"use client";

import { useState } from "react";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clockHourCycle } from "@/lib/field-services/time";
import { Textarea } from "@/components/ui/textarea";

export interface NoteView {
  id: string;
  text: string;
  byName: string;
  createdAtMs: number;
  editedAtMs?: number | null;
  canEdit: boolean;
}

type Change = { action: "add" | "edit" | "delete"; noteId?: string; text?: string };

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: clockHourCycle() });
}

/** The notes on a project, with a box for a new one. Used by the office dialog and the crew screens. */
export function JobNotes({
  notes,
  onChange,
  heading = "Notes",
}: {
  notes: NoteView[];
  /** Resolves true when the change was saved. */
  onChange: (change: Change) => Promise<boolean>;
  heading?: string;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, change: Change): Promise<boolean> {
    setBusy(key);
    const ok = await onChange(change);
    setBusy(null);
    return ok;
  }

  return (
    <section className="space-y-2" aria-label={heading}>
      <h3 className="text-sm font-semibold">{heading}</h3>
      {notes.length > 0 && (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg border bg-muted/30 p-3 text-sm">
              {editing === n.id ? (
                <div className="space-y-2">
                  <Textarea
                    value={editText}
                    maxLength={2000}
                    rows={3}
                    aria-label="Edit note"
                    onChange={(e) => setEditText(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="h-10 touch-manipulation"
                      disabled={busy === n.id || !editText.trim()}
                      onClick={async () => {
                        if (await run(n.id, { action: "edit", noteId: n.id, text: editText })) setEditing(null);
                      }}
                    >
                      {busy === n.id && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                      Save
                    </Button>
                    <Button size="sm" variant="outline" className="h-10 touch-manipulation" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="whitespace-pre-wrap">{n.text}</p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {n.byName || "Someone"} · {when(n.createdAtMs)}
                      {n.editedAtMs ? " · edited" : ""}
                    </p>
                    {n.canEdit && (
                      <span className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          aria-label="Edit note"
                          className="inline-flex h-9 w-9 touch-manipulation items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={() => {
                            setEditText(n.text);
                            setEditing(n.id);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="Delete note"
                          disabled={busy === n.id}
                          className="inline-flex h-9 w-9 touch-manipulation items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                          onClick={() => void run(n.id, { action: "delete", noteId: n.id })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </span>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2">
        <Textarea
          value={draft}
          maxLength={2000}
          rows={2}
          placeholder="Add a note"
          aria-label="New note"
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          size="sm"
          className="h-10 touch-manipulation"
          disabled={busy === "new" || !draft.trim()}
          onClick={async () => {
            if (await run("new", { action: "add", text: draft })) setDraft("");
          }}
        >
          {busy === "new" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Add note
        </Button>
      </div>
    </section>
  );
}
