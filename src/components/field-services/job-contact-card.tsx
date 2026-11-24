"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { Building2, Mail, MapPin, Phone, UserRound } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { ContactPicker } from "@/components/quotes/contact-picker";
import { AddressFields, EMPTY_ADDRESS, addressIsEmpty, callApi } from "@/components/field-services/field-ui";
import { useFieldData } from "@/components/field-services/field-data";
import { subscribeToContact } from "@/lib/firestore/contacts";
import { formatServiceAddress } from "@/lib/field-services/address";
import type { Contact } from "@/types/contacts";
import type { Job, ServiceAddress } from "@/types/field-services";

function Row({ icon: Icon, label, children }: { icon: typeof Mail; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="break-words">{children}</div>
      </div>
    </div>
  );
}

/** The customer on a project, read live from the contact so it never shows a stale copy. */
export function JobContactCard({ job }: { job: Job }) {
  const { subAccountId, saPath, isAdmin } = useSubAccount();
  const { contacts } = useFieldData();
  const [changing, setChanging] = useState(false);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const canChange = isAdmin && job.status !== "closed" && job.status !== "cancelled";

  const [editingAddress, setEditingAddress] = useState(false);
  const [addressDraft, setAddressDraft] = useState<ServiceAddress>(EMPTY_ADDRESS);
  const [savingAddress, setSavingAddress] = useState(false);

  function startEditAddress() {
    setAddressDraft(job.serviceAddress ?? EMPTY_ADDRESS);
    setEditingAddress(true);
  }

  async function saveAddress() {
    setSavingAddress(true);
    const res = await callApi(`/api/sub-accounts/${subAccountId}/field-services/jobs/${job.id}`, "PATCH", {
      serviceAddress: addressIsEmpty(addressDraft) ? null : addressDraft,
    });
    setSavingAddress(false);
    if (!res) return;
    toast.success("Address saved.");
    setEditingAddress(false);
  }

  async function changeCustomer() {
    if (!pick) return;
    setBusy(true);
    const res = await callApi(`/api/sub-accounts/${subAccountId}/field-services/jobs/${job.id}/change-customer`, "POST", { contactId: pick });
    setBusy(false);
    if (!res) return;
    toast.success("Customer changed.");
    setChanging(false);
    setPick("");
  }
  const [contact, setContact] = useState<Contact | null | undefined>(undefined);
  const healed = useRef("");

  useEffect(() => {
    if (!job.contactId) {
      setContact(null);
      return;
    }
    return subscribeToContact(
      job.contactId,
      (c) => setContact(c && c.subAccountId === subAccountId ? c : null),
      () => setContact(null),
    );
  }, [job.contactId, subAccountId]);

  // The project keeps a copy of the name; when the contact has been renamed, correct the copy once.
  useEffect(() => {
    if (!contact || !contact.name || contact.name === job.contactName) return;
    const key = `${job.id}:${contact.name}`;
    if (healed.current === key) return;
    healed.current = key;
    void fetch(`/api/sub-accounts/${subAccountId}/field-services/jobs/${job.id}/refresh-customer`, { method: "POST" }).catch(() => {});
  }, [contact, job.id, job.contactName, subAccountId]);

  const service = job.serviceAddress ? formatServiceAddress(job.serviceAddress) : "";
  const billing = contact?.address?.trim() ?? "";

  return (
    <section className="space-y-3 rounded-xl border p-4" aria-label="Customer">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Customer</h3>
        <div className="flex items-center gap-3">
          {canChange && !changing && (
            <button type="button" className="text-xs text-primary underline-offset-2 hover:underline" onClick={() => setChanging(true)}>
              Change customer
            </button>
          )}
          {contact && (
            <Link href={saPath(`/contacts/${contact.id}`)} className="text-xs text-primary underline-offset-2 hover:underline">
              Open contact
            </Link>
          )}
        </div>
      </div>

      {changing && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            Pick the right customer. The visits move with it, and the old customer&apos;s project link stops working. This is not possible once
            there is an invoice, a linked deal, or the customer has answered extra work or signed off.
          </p>
          <ContactPicker
            contacts={contacts.filter((c) => c.id !== job.contactId)}
            value={pick}
            onChange={setPick}
            placeholder="Pick a customer…"
            title="Pick the customer"
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={!pick || busy} onClick={() => void changeCustomer()}>
              Change customer
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { setChanging(false); setPick(""); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {contact === undefined && <div className="h-16 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />}

      {contact === null && (
        <p className="text-sm text-muted-foreground">
          This customer is no longer in Contacts. The project still says <span className="font-medium text-foreground">{job.contactName}</span>.
        </p>
      )}

      {editingAddress && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">Where the work is done. Crew on its coming visits are told when it changes.</p>
          <AddressFields value={addressDraft} onChange={setAddressDraft} disabled={savingAddress} />
          <div className="flex gap-2">
            <Button size="sm" disabled={savingAddress} onClick={() => void saveAddress()}>
              Save address
            </Button>
            <Button size="sm" variant="outline" disabled={savingAddress} onClick={() => setEditingAddress(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {contact && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Row icon={UserRound} label="Name">
            <span className="font-medium">{contact.name}</span>
          </Row>
          <Row icon={Phone} label="Phone">
            {contact.phone ? (
              <a href={`tel:${contact.phone}`} className="underline-offset-2 hover:underline">
                {contact.phone}
              </a>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </Row>
          <Row icon={Mail} label="Email">
            {contact.email ? (
              <a href={`mailto:${contact.email}`} className="underline-offset-2 hover:underline">
                {contact.email}
              </a>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </Row>
          {contact.company && (
            <Row icon={Building2} label="Company">
              {contact.company}
            </Row>
          )}
          <Row icon={MapPin} label="Service address">
            {service ? (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(service)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {service}
              </a>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
            {canChange && !editingAddress && (
              <button type="button" className="ml-2 text-xs text-primary underline-offset-2 hover:underline" onClick={startEditAddress}>
                {service ? "Edit" : "Add"}
              </button>
            )}
          </Row>
          {billing && (
            <Row icon={MapPin} label="Billing address">
              <span className="whitespace-pre-line">{billing}</span>
            </Row>
          )}
        </div>
      )}
    </section>
  );
}
