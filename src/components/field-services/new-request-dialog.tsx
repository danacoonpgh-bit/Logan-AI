"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ContactPicker } from "@/components/quotes/contact-picker";
import {
  AddressFields,
  EMPTY_ADDRESS,
  addressIsEmpty,
  callApi,
} from "@/components/field-services/field-ui";
import { formatServiceAddress } from "@/lib/field-services/address";
import type { Contact } from "@/types/contacts";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { jobTerms } from "@/lib/field-services/terms";
import type { ServiceAddress } from "@/types/field-services";

export function NewRequestDialog({
  open,
  onOpenChange,
  contacts,
  fixedContactId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contacts: Contact[];
  fixedContactId?: string;
  onCreated?: (id: string) => void;
}) {
  const { subAccountId } = useSubAccount();
  const { config } = useFieldConfig();
  const terms = jobTerms(config);
  const [contactId, setContactId] = useState(fixedContactId ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [address, setAddress] = useState<ServiceAddress>(EMPTY_ADDRESS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setContactId(fixedContactId ?? "");
      setTitle("");
      setDescription("");
      setAddress(EMPTY_ADDRESS);
    }
  }, [open, fixedContactId]);

  const contact = contacts.find((c) => c.id === contactId);
  const saved = contact?.serviceAddresses ?? [];

  async function submit() {
    if (!contactId || !title.trim()) return;
    setBusy(true);
    const res = await callApi<{ id: string; number: string; warnings?: string[]; jobId?: string | null }>(
      `/api/sub-accounts/${subAccountId}/field-services/requests`,
      "POST",
      {
        contactId,
        title,
        description,
        serviceAddress: addressIsEmpty(address) ? null : address,
      },
    );
    setBusy(false);
    if (!res) return;
    toast.success(res.jobId ? `${terms.Job} added. It is waiting to be scheduled.` : `Request ${res.number} created.`);
    for (const w of res.warnings ?? []) toast.message(w);
    onOpenChange(false);
    onCreated?.(res.id);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New {terms.job}</DialogTitle>
          <DialogDescription>
            What the customer asked for and where. It goes on your list of {terms.jobs} to schedule.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!fixedContactId && (
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                Customer
              </Label>
              <ContactPicker
                contacts={contacts}
                value={contactId}
                onChange={setContactId}
                allowNew
                placeholder="Pick a customer…"
                title="Pick a customer"
              />
            </div>
          )}
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              What do they need?
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Leaking kitchen tap"
              disabled={busy}
            />
          </div>
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              Details (optional)
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              disabled={busy}
            />
          </div>

          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              {terms.Job}-site address
            </Label>
            {saved.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {saved.map((a, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setAddress({ ...EMPTY_ADDRESS, ...a })}
                    className="rounded-full border px-2.5 py-1 text-xs hover:bg-muted"
                  >
                    {formatServiceAddress(a)}
                  </button>
                ))}
              </div>
            )}
            <AddressFields value={address} onChange={setAddress} disabled={busy} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !contactId || !title.trim()}>
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Create request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
