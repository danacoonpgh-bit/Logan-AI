"use client";

import { minorToUnit, parseDecimalInput, unitToMinor } from "@/lib/field-services/money";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronRight, Loader2, UserPlus } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToFieldWorkers } from "@/lib/firestore/field-services";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StaffAvailabilityFields } from "@/components/field-services/staff-availability";
import { useFieldData } from "@/components/field-services/field-data";
import { useFieldConfig, useRateCards } from "@/components/field-services/timesheets-ui";
import { clockHourCycle } from "@/lib/field-services/time";
import { workspaceCurrencyOf } from "@/lib/field-services/money";
import { jobTerms, labourTerm, workerTerms, withArticle, withArticleCap } from "@/lib/field-services/terms";
import { DEFAULT_WEEKLY_HOURS, cleanTimeOff, cleanWeeklyHours, hoursOf } from "@/lib/field-services/working-hours";
import type { FieldWorker, FieldWorkerKind, ServiceAddress, TimeOff, WeeklyHours } from "@/types/field-services";
import { AddressFields, EMPTY_ADDRESS, addressIsEmpty } from "@/components/field-services/field-ui";
import type { ServiceMemberRow } from "@/lib/server/field-service-members-service";
import type { CrewAppStatus } from "@/lib/server/field-crew-status-service";
import { formatRelativeTime } from "@/lib/format";

const KIND_LABELS: Record<FieldWorkerKind, string> = {
  owner: "Owner",
  employee: "Employee",
  contractor: "Contractor",
};

const WORKER_COLOR_NAMES: Record<string, string> = {
  "#2563eb": "Blue",
  "#16a34a": "Green",
  "#ea580c": "Orange",
  "#9333ea": "Purple",
  "#0891b2": "Teal",
  "#db2777": "Pink",
  "#ca8a04": "Gold",
  "#475569": "Slate",
};

const WORKER_COLORS = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#0891b2", "#db2777", "#ca8a04", "#475569"];

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_option]:bg-background [&_option]:text-foreground";

type StaffTab = "profile" | "availability" | "work" | "pay";
const STAFF_TABS: { id: StaffTab; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "availability", label: "Availability" },
  { id: "work", label: "Work" },
  { id: "pay", label: "Pay & app" },
];

export function WorkersTab() {
  const { subAccountId, isAdmin, subAccount } = useSubAccount();
  // New staff start from the business address; it can be changed per person.
  const businessStart: ServiceAddress = { ...EMPTY_ADDRESS, ...(subAccount?.businessDetails?.address ?? {}) };

  const [workers, setWorkers] = useState<FieldWorker[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [crew, setCrew] = useState<Record<string, CrewAppStatus>>({});
  const [form, setForm] = useState({
    name: "",
    email: "",
    kind: "employee" as FieldWorkerKind,
    color: WORKER_COLORS[0],
    rateCardId: "",
    contact: true,
    prices: false,
    phone: "",
    crew: true,
    hours: DEFAULT_WEEKLY_HOURS as WeeklyHours,
    maxVisits: "",
    timeOff: [] as TimeOff[],
    serviceIds: [] as string[],
    areaIds: [] as string[],
    homeBase: EMPTY_ADDRESS as ServiceAddress,
  });
  const [rates, setRates] = useState({ cost: "", sell: "", currency: "USD", loaded: false, orig: "" });
  const [addOpen, setAddOpen] = useState(false);
  const [staffTab, setStaffTab] = useState<StaffTab>("profile");
  const [showDisabled, setShowDisabled] = useState(false);
  const { services: catalogServices, areas: catalogAreas } = useFieldData();

  const [reassignFor, setReassignFor] = useState<FieldWorker | null>(null);
  const [reassignTo, setReassignTo] = useState("unassigned");
  const [serviceMembers, setServiceMembers] = useState<ServiceMemberRow[] | null>(null);
  const [inviting, setInviting] = useState(false);
  const [invited, setInvited] = useState<{ name: string; delivered: boolean } | null>(null);
  // A person just added: once their record arrives the full form opens so setup is one flow.
  const [confirmDropId, setConfirmDropId] = useState<string | null>(null);
  const [openNewId, setOpenNewId] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<{ id: string; delivered: boolean } | null>(null);
  const [preview, setPreview] = useState<{
    name: string;
    prices: boolean;
    contact: boolean;
    visits: { id: string; title: string; when: string; customer: string; phone: string; address: string }[];
  } | null>(null);

  useEffect(() => {
    return subscribeToFieldWorkers(
      subAccountId,
      (list) => {
        setWorkers(list);
        setLoaded(true);
      },
      () => setLoaded(true),
    );
  }, [subAccountId]);

  const { config } = useFieldConfig();
  const wsCur = workspaceCurrencyOf(config);
  const terms = jobTerms(config);
  const wt = workerTerms(config);
  const showRates = isAdmin && config?.timesheetsEnabled === true;
  const rateCards = useRateCards(showRates);

  const sorted = useMemo(
    () =>
      [...workers].sort(
        (a, b) =>
          Number(a.status === "removed") - Number(b.status === "removed") ||
          a.name.localeCompare(b.name),
      ),
    [workers],
  );
  const disabledCount = sorted.filter((w) => w.status === "removed").length;
  const shown = showDisabled ? sorted : sorted.filter((w) => w.status !== "removed");

  async function call(
    url: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
  ): Promise<boolean> {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return true;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    toast.error(data.error ?? "That didn't work.");
    return false;
  }

  const loadServiceMembers = useCallback(async () => {
    const res = await fetch(`/api/sub-accounts/${subAccountId}/field-services/service-members`, {
      cache: "no-store",
    });
    if (!res.ok) {
      setServiceMembers([]);
      return;
    }
    const data = (await res.json()) as { members: ServiceMemberRow[] };
    setServiceMembers(data.members);
  }, [subAccountId]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const load = () =>
      fetch(`/api/sub-accounts/${subAccountId}/field-services/crew-status`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { status?: Record<string, CrewAppStatus> } | null) => {
          if (!cancelled && d?.status) setCrew(d.status);
        })
        .catch(() => {});
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isAdmin, subAccountId, workers]);

  useEffect(() => {
    if (isAdmin) void loadServiceMembers();
  }, [isAdmin, loadServiceMembers, workers]);

  function openAdd() {
    setForm({
      name: "",
      email: "",
      kind: "employee",
      color: WORKER_COLORS[0],
      rateCardId: "",
      contact: true,
      prices: false,
      phone: "",
      crew: true,
      hours: DEFAULT_WEEKLY_HOURS,
      maxVisits: "",
      timeOff: [],
      serviceIds: [],
      areaIds: [],
      homeBase: businessStart,
    });
    setRates({ cost: "", sell: "", currency: wsCur, loaded: true, orig: JSON.stringify(["", "", wsCur]) });
    setAddOpen(true);
  }

  async function createAndInvite() {
    if (!form.phone.trim()) {
      toast.error("Enter their mobile number.");
      return;
    }
    const checked = cleanWeeklyHours(form.hours);
    if (typeof checked === "string") {
      toast.error(checked);
      return;
    }
    const leave = cleanTimeOff(form.timeOff);
    if (typeof leave === "string") {
      toast.error(leave);
      return;
    }
    const cur = rates.currency.trim().toUpperCase();
    const cost = parseDecimalInput(rates.cost);
    const sell = parseDecimalInput(rates.sell);
    if (cost === null || cost <= 0) {
      toast.error("Set a cost rate, for example 35.");
      return;
    }
    if (sell === null || sell <= 0) {
      toast.error("Set a sell rate, for example 85.");
      return;
    }
    if (addressIsEmpty(form.homeBase) || !form.homeBase.line1.trim()) {
      toast.error("Enter where their day starts.");
      return;
    }
    const costMinor = unitToMinor(cur, cost);
    const sellMinor = unitToMinor(cur, sell);
    setInviting(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/field-services/service-members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          identifier: form.email,
          phone: form.phone,
          ...(showRates && form.rateCardId ? { rateCardId: form.rateCardId } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        toast.error(data.error ?? "That didn't work.");
        return;
      }
      const added = await addServiceMember({ id: data.id, name: form.name.trim() }, true);
      if (!added) return;
      let allSaved = true;
      if (added.workerId) {
        const workerUrl = `/api/sub-accounts/${subAccountId}/field-services/workers/${added.workerId}`;
        allSaved = await call(workerUrl, "PATCH", {
          color: form.color,
          workingHours: checked,
          timeOff: leave,
          maxVisitsPerDay: form.maxVisits.trim() === "" ? null : Number.parseInt(form.maxVisits, 10),
          serviceIds: form.serviceIds,
          areaIds: form.areaIds,
          ...(addressIsEmpty(form.homeBase) ? {} : { homeBase: form.homeBase }),
        });
        {
          const r = await fetch(`${workerUrl}/rates`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ costRateMinor: costMinor, sellRateMinor: sellMinor, currency: cur }),
          });
          if (!r.ok) allSaved = false;
        }
      }
      if (!allSaved) toast.warning(`${form.name.trim()} was added, but some details did not save. Open them to finish.`);
      else if (added.delivered) toast.success(`${form.name.trim()} added. The invite is on its way.`);
      else toast.warning(`${form.name.trim()} added, but the invite could not be sent. Open them and use Resend invite.`);
    } catch {
      toast.error("No connection. Try again.");
    } finally {
      setInviting(false);
    }
  }

  async function dropServiceMember(id: string) {
    if (confirmDropId !== id) {
      setConfirmDropId(id);
      return;
    }
    setInviting(true);
    const res = await fetch(`/api/sub-accounts/${subAccountId}/field-services/service-members/${id}`, { method: "DELETE" });
    setInviting(false);
    setConfirmDropId(null);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(data.error ?? "That didn't work.");
      return;
    }
    await loadServiceMembers();
  }

  async function addServiceMember(
    m: { id: string; name: string },
    quiet = false,
  ): Promise<{ workerId?: string; delivered: boolean } | null> {
    setInviting(true);
    const res = await fetch(
      `/api/sub-accounts/${subAccountId}/field-services/service-members/${m.id}/add`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: form.kind,
          canHandlePrices: form.prices,
          canSeeCustomerContact: form.contact,
        }),
      },
    );
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      delivered?: string;
      workerId?: string;
    };
    if (!quiet) setInviting(false);
    if (!res.ok) {
      setInviting(false);
      toast.error(data.error ?? "That didn't work.");
      return null;
    }
    const out = { workerId: data.workerId, delivered: data.delivered === "sent" };
    setAddOpen(false);
    if (!quiet) {
      if (out.workerId) {
        setJustAdded({ id: out.workerId, delivered: out.delivered });
        setOpenNewId(out.workerId);
      } else {
        setInvited({ name: m.name, delivered: out.delivered });
      }
    }
    await loadServiceMembers();
    return out;
  }

  async function portalAction(w: FieldWorker, action: "resend" | "revoke") {
    setBusyId(w.id);
    const res = await fetch(
      `/api/sub-accounts/${subAccountId}/field-services/workers/${w.id}/portal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      },
    );
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      delivered?: string;
    };
    setBusyId(null);
    if (!res.ok) {
      toast.error(data.error ?? "That didn't work.");
      return;
    }
    if (action === "resend" && res.ok) {
      setInvited({ name: w.name, delivered: data.delivered === "sent" });
    } else {
      toast.success("Access removed. They can't sign in to your crew any more.");
    }
  }

  async function sendCrewLink(w: FieldWorker) {
    setBusyId(w.id);
    const res = await fetch(`/api/sub-accounts/${subAccountId}/field-services/workers/${w.id}/portal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send_link" }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; delivered?: boolean };
    setBusyId(null);
    if (!res.ok) {
      toast.error(data.error ?? "That didn't work.");
      return;
    }
    if (data.delivered) toast.success(`Sign-in link emailed to ${w.email}.`);
    else toast.error("The link couldn't be sent. Check their email address and your email setup.");
  }

  async function testAlert(w: FieldWorker) {
    setBusyId(w.id);
    const res = await fetch(
      `/api/sub-accounts/${subAccountId}/field-services/workers/${w.id}/portal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test_push" }),
      },
    );
    const data = (await res.json().catch(() => ({}))) as { error?: string; delivered?: number };
    setBusyId(null);
    if (!res.ok) {
      toast.error(data.error ?? "That didn't work.");
      return;
    }
    if ((data.delivered ?? 0) > 0) toast.success(`Alert sent to ${w.name}.`);
    else toast.error(`${w.name} hasn't turned alerts on yet. They'll get a text or email instead.`);
  }

  async function seeTheirDay(w: FieldWorker) {
    setBusyId(w.id);
    const res = await fetch(
      `/api/sub-accounts/${subAccountId}/field-services/workers/${w.id}/preview`,
      { cache: "no-store" },
    );
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      prices?: boolean;
      contact?: boolean;
      visits?: {
        visit: { id: string; scheduledStart: string | null };
        job: { title: string; address: string; timezone: string };
        customer: { name: string; phone: string };
      }[];
    };
    setBusyId(null);
    if (!res.ok || !data.visits) {
      toast.error(data.error ?? "That didn't work.");
      return;
    }
    setPreview({
      name: w.name,
      prices: data.prices === true,
      contact: data.contact === true,
      visits: data.visits.map((v) => ({
        id: v.visit.id,
        title: v.job.title,
        when: v.visit.scheduledStart
          ? new Date(v.visit.scheduledStart).toLocaleString(undefined, {
              timeZone: v.job.timezone,
              weekday: "short",
              day: "numeric",
              month: "short",
              hour: "numeric",
              minute: "2-digit",
              hourCycle: clockHourCycle(),
            })
          : "Any time",
        customer: v.customer.name,
        phone: v.customer.phone,
        address: v.job.address,
      })),
    });
  }

  async function removeWorker(w: FieldWorker) {
    setBusyId(w.id);
    const res = await fetch(
      `/api/sub-accounts/${subAccountId}/field-services/workers/${w.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "removed" }),
      },
    );
    setBusyId(null);
    if (res.status === 409) {
      setReassignTo("unassigned");
      setReassignFor(w);
      return;
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(data.error ?? "That didn't work.");
    }
  }

  async function confirmRemove() {
    if (!reassignFor) return;
    setBusyId(reassignFor.id);
    const ok = await call(
      `/api/sub-accounts/${subAccountId}/field-services/workers/${reassignFor.id}`,
      "PATCH",
      { status: "removed", reassignTo },
    );
    setBusyId(null);
    if (ok) setReassignFor(null);
  }

  const editing = workers.find((w) => w.id === editingId) ?? null;

  useEffect(() => {
    if (!openNewId) return;
    const w = workers.find((x) => x.id === openNewId);
    if (!w) return;
    openEditor(w);
    setOpenNewId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNewId, workers]);

  function openEditor(w: FieldWorker) {
    setForm({
      name: w.name,
      email: w.email ?? "",
      kind: w.kind,
      color: w.color,
      rateCardId: w.rateCardId ?? "",
      contact: w.canSeeCustomerContact,
      prices: w.canHandlePrices,
      phone: w.phone ?? "",
      crew: w.crewAccess !== false,
      hours: hoursOf(w),
      maxVisits: typeof w.maxVisitsPerDay === "number" ? String(w.maxVisitsPerDay) : "",
      timeOff: w.timeOff ?? [],
      serviceIds: w.serviceIds ?? [],
      areaIds: w.areaIds ?? [],
      homeBase: w.homeBase ? { ...EMPTY_ADDRESS, ...w.homeBase } : businessStart,
    });
    setRates({ cost: "", sell: "", currency: wsCur, loaded: false, orig: "" });
    void fetch(`/api/sub-accounts/${subAccountId}/field-services/workers/${w.id}/rates`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { costRateMinor: number; sellRateMinor: number; currency: string } | null) => {
        if (!d) return;
        const currency = config?.currency ? wsCur : d.currency || wsCur;
        const cost = d.costRateMinor ? String(minorToUnit(currency, d.costRateMinor)) : "";
        const sell = d.sellRateMinor ? String(minorToUnit(currency, d.sellRateMinor)) : "";
        setRates({ cost, sell, currency, loaded: true, orig: JSON.stringify([cost, sell, currency]) });
      })
      .catch(() => {});
    setStaffTab("profile");
    setEditingId(w.id);
  }

  async function saveEditor() {
    if (!editing) return;
    const checked = cleanWeeklyHours(form.hours);
    if (typeof checked === "string") {
      setStaffTab("availability");
      toast.error(checked);
      return;
    }
    const leave = cleanTimeOff(form.timeOff);
    if (typeof leave === "string") {
      setStaffTab("availability");
      toast.error(leave);
      return;
    }
    if (rates.loaded) {
      const cost = parseDecimalInput(rates.cost);
      const sell = parseDecimalInput(rates.sell);
      if (cost === null || cost <= 0) {
        setStaffTab("pay");
        toast.error("Set a cost rate before saving, for example 35.");
        return;
      }
      if (sell === null || sell <= 0) {
        setStaffTab("pay");
        toast.error("Set a sell rate before saving, for example 85.");
        return;
      }
    }
    if (addressIsEmpty(form.homeBase) || !form.homeBase.line1.trim()) {
      setStaffTab("availability");
      toast.error("Enter where their day starts.");
      return;
    }
    if (rates.loaded && JSON.stringify([rates.cost, rates.sell, rates.currency]) !== rates.orig) {
      const cost = parseDecimalInput(rates.cost) as number;
      const sell = parseDecimalInput(rates.sell) as number;
      const cur = rates.currency.trim().toUpperCase();
      const res = await fetch(`/api/sub-accounts/${subAccountId}/field-services/workers/${editing.id}/rates`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ costRateMinor: unitToMinor(cur, cost), sellRateMinor: unitToMinor(cur, sell), currency: cur }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ?? "The rates didn't save.");
        return;
      }
    }
    setBusyId(editing.id);
    const ok = await call(
      `/api/sub-accounts/${subAccountId}/field-services/workers/${editing.id}`,
      "PATCH",
      {
        timeOff: leave,
        name: form.name,
        kind: form.kind,
        color: form.color,
        canSeeCustomerContact: form.contact,
        canHandlePrices: form.prices,
        workingHours: checked,
        maxVisitsPerDay: form.maxVisits.trim() === "" ? null : Number.parseInt(form.maxVisits, 10),
        crewAccess: form.crew,
        serviceIds: form.serviceIds,
        areaIds: form.areaIds,
        ...(JSON.stringify(form.homeBase) !== JSON.stringify({ ...EMPTY_ADDRESS, ...(editing.homeBase ?? {}) })
          ? { homeBase: addressIsEmpty(form.homeBase) ? null : form.homeBase }
          : {}),
        ...(form.phone.trim() !== (editing.phone ?? "").trim() || editing.memberUid ? { phone: form.phone } : {}),
        ...(!editing.memberUid && form.email.trim().toLowerCase() !== (editing.email ?? "").toLowerCase() ? { email: form.email } : {}),
        ...(showRates ? { rateCardId: form.rateCardId || null } : {}),
      },
    );
    setBusyId(null);
    if (ok) {
      toast.success("Saved.");
      setJustAdded(null);
      setEditingId(null);
    }
  }

  async function patchWorker(id: string, body: Record<string, unknown>): Promise<boolean> {
    setBusyId(id);
    const ok = await call(
      `/api/sub-accounts/${subAccountId}/field-services/workers/${id}`,
      "PATCH",
      body,
    );
    setBusyId(null);
    return ok;
  }

  /** The on/off switch that disables a person, shown first on their Profile tab. */
  function activeToggle(editing: FieldWorker) {
    return (
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={editing.status !== "removed"}
          disabled={busyId === editing.id}
          onCheckedChange={(v) => {
            if (v === true) {
              void patchWorker(editing.id, { status: "active" }).then((ok) => ok && setEditingId(null));
            } else {
              setEditingId(null);
              void removeWorker(editing);
            }
          }}
        />
        <span>
          <span className="block font-medium">Active</span>
          <span className="block text-xs text-muted-foreground">
            Turn off to disable all field access for this person: the crew app, scheduling and time. Their visits move to
            someone else or become unassigned, and their history is kept. This applies straight away and doesn&apos;t change
            any CRM login.
          </span>
        </span>
      </label>
    );
  }

  /** One short line for the dialog header: whether they have joined the crew app. */
  function crewChip(w: FieldWorker): string {
    if (w.crewAccess === false) return "Crew app off";
    if (w.portalStatus === "active") {
      const seen = crew[w.id]?.lastSeenAt;
      return seen ? `Crew app: joined, seen ${formatRelativeTime(new Date(seen))}` : "Crew app: joined";
    }
    return w.portalStatus === "invited" ? "Crew app: invited" : "Crew app: not invited yet";
  }

  function staffFields(editing: FieldWorker | null) {
    const on = (id: StaffTab) => !editing || staffTab === id;
    return (
      <div className="space-y-4">
        <div className={on("profile") ? "space-y-4" : "hidden"}>
          {editing && activeToggle(editing)}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="worker-name" className="mb-1 block text-xs font-medium text-muted-foreground">Name</Label>
                      <Input id="worker-name" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                    </div>
                    <div>
                      <Label htmlFor="worker-kind" className="mb-1 block text-xs font-medium text-muted-foreground">Type</Label>
                      <select
                        id="worker-kind"
                        value={form.kind}
                        onChange={(e) => setForm({ ...form, kind: e.target.value as FieldWorkerKind })}
                        className={SELECT_CLASS}
                      >
                        {(Object.keys(KIND_LABELS) as FieldWorkerKind[])
                          .filter((k) => (editing ? editing.memberUid || k !== "owner" || editing.kind === "owner" : k !== "owner"))
                          .map((k) => (
                            <option key={k} value={k}>
                              {KIND_LABELS[k]}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>

                  {!editing && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="worker-email" className="mb-1 block text-xs font-medium text-muted-foreground">Email (they sign in with this)</Label>
                        <Input
                          id="worker-email"
                          type="email"
                          value={form.email}
                          maxLength={200}
                          placeholder="name@example.com"
                          onChange={(e) => setForm({ ...form, email: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label htmlFor="worker-mobile" className="mb-1 block text-xs font-medium text-muted-foreground">Mobile (required, for contact)</Label>
                        <Input
                          id="worker-mobile"
                          value={form.phone}
                          maxLength={40}
                          placeholder="+61 400 000 000"
                          onChange={(e) => setForm({ ...form, phone: e.target.value })}
                        />
                      </div>
                    </div>
                  )}

                  {editing && !editing.memberUid && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="worker-edit-email" className="mb-1 block text-xs font-medium text-muted-foreground">Email (they sign in with this)</Label>
                        <Input id="worker-edit-email" type="email" value={form.email} maxLength={200} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                        <p className="mt-1 text-xs text-muted-foreground">Changing it makes them a new sign-in: send them the crew app link again after saving.</p>
                      </div>
                      <div>
                        <Label htmlFor="worker-edit-mobile" className="mb-1 block text-xs font-medium text-muted-foreground">Mobile number</Label>
                        <Input id="worker-edit-mobile" value={form.phone} maxLength={40} placeholder="+61 400 000 000" onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                        <p className="mt-1 text-xs text-muted-foreground">For contact, and for visit alerts by text when they have no app alerts on.</p>
                      </div>
                    </div>
                  )}

                  {editing?.memberUid && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label className="mb-1 block text-xs font-medium text-muted-foreground">Email</Label>
                        <p className="flex h-9 items-center truncate text-sm text-muted-foreground">{editing.email || "None"}</p>
                      </div>
                      <div>
                        <Label htmlFor="worker-phone" className="mb-1 block text-xs font-medium text-muted-foreground">Phone number</Label>
                        <Input id="worker-phone" value={form.phone} maxLength={40} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                      </div>
                    </div>
                  )}

                  <div>
                    <Label className="mb-1 block text-xs font-medium text-muted-foreground">Colour on the schedule</Label>
                    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
                      {WORKER_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          role="radio"
                          aria-checked={form.color === c}
                          aria-label={WORKER_COLOR_NAMES[c] ?? c}
                          title={WORKER_COLOR_NAMES[c] ?? c}
                          onClick={() => setForm({ ...form, color: c })}
                          className={
                            "h-8 w-8 rounded-full border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                            (form.color === c ? "border-foreground" : "border-transparent")
                          }
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                  </div>
        </div>

        <div className={on("pay") ? "space-y-4" : "hidden"}>
                  {showRates && (
                    <div>
                      <Label htmlFor="worker-rate" className="mb-1 block text-xs font-medium text-muted-foreground">Rate card</Label>
                      <select
                        id="worker-rate"
                        disabled={!rateCards.loaded}
                        value={form.rateCardId}
                        onChange={(e) => setForm({ ...form, rateCardId: e.target.value })}
                        className={SELECT_CLASS}
                      >
                        <option value="">None</option>
                        {rateCards.cards
                          .filter((c) => !c.archived || c.id === editing?.rateCardId)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    </div>
                  )}

                  <div className="space-y-2 rounded-lg border p-3">
                    <p className="text-sm font-medium">Hourly rates ({rates.currency} per hour)</p>
                    <p className="text-xs text-muted-foreground">
                      Both are required. The sell rate is what you charge for each hour this person works, and it replaces their
                      rate card&apos;s hourly rate on invoices. The cost rate is what their time costs you and feeds the profit
                      reports. Only admins see these.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="worker-cost" className="mb-1 block text-xs font-medium text-red-600/80 dark:text-red-400/80">
                          Cost rate (required)
                        </Label>
                        <Input
                          id="worker-cost"
                          inputMode="decimal"
                          required
                          disabled={!rates.loaded}
                          value={rates.cost}
                          onChange={(e) => setRates({ ...rates, cost: e.target.value })}
                          placeholder="35"
                        />
                      </div>
                      <div>
                        <Label htmlFor="worker-sell" className="mb-1 block text-xs font-medium text-green-600/80 dark:text-green-400/80">
                          Sell rate (required)
                        </Label>
                        <Input
                          id="worker-sell"
                          inputMode="decimal"
                          required
                          disabled={!rates.loaded}
                          value={rates.sell}
                          onChange={(e) => setRates({ ...rates, sell: e.target.value })}
                          placeholder="85"
                        />
                      </div>
                    </div>
                  </div>

                  {editing && (
                  <div className="space-y-2 rounded-lg border p-3">
                    <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                      <Checkbox checked={form.crew} onCheckedChange={(v) => setForm({ ...form, crew: v === true })} />
                      Crew app access (phone and desktop)
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {!form.crew
                        ? "Off. They can't sign in to the crew app. Save to apply."
                        : editing.portalStatus === "active"
                          ? `Joined. ${crew[editing.id]?.lastSeenAt ? `Last seen ${formatRelativeTime(new Date(crew[editing.id]!.lastSeenAt!))}.` : "Not opened since joining."} Alerts are ${crew[editing.id]?.alerts ? "on" : "off"} on their phone.`
                          : editing.portalStatus === "invited"
                            ? crew[editing.id]?.inviteExpired
                              ? "The invite ran out before they used it. Resend it, or they can sign in with their email."
                              : "Invite sent. They can also sign in at the crew app with their email."
                            : `They sign in at the crew app with ${editing.email || "their email"}. We email a 6-digit code.`}
                      {" "}The crew app never gives access to the CRM or the workspace.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {form.crew && editing.status === "active" && editing.email && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyId === editing.id}
                          onClick={() => void sendCrewLink(editing)}
                        >
                          Send crew app link
                        </Button>
                      )}
                      {form.crew && !editing.memberUid && editing.portalStatus !== "active" && editing.email && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyId === editing.id}
                          onClick={() => void portalAction(editing, "resend")}
                        >
                          Resend invite
                        </Button>
                      )}
                      {editing.portalStatus === "active" && (
                        <>
                          <Button variant="outline" size="sm" disabled={busyId === editing.id} onClick={() => void seeTheirDay(editing)}>
                            See their day
                          </Button>
                          <Button variant="outline" size="sm" disabled={busyId === editing.id} onClick={() => void testAlert(editing)}>
                            Send test alert
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  )}
        </div>

        <div className={on("availability") ? "space-y-4" : "hidden"}>
                  <StaffAvailabilityFields
                    part="hours"
                    hours={form.hours}
                    onHours={(hours) => setForm({ ...form, hours })}
                    timeOff={form.timeOff}
                    onTimeOff={(timeOff) => setForm({ ...form, timeOff })}
                    serviceIds={form.serviceIds}
                    onServiceIds={(serviceIds) => setForm({ ...form, serviceIds })}
                    areaIds={form.areaIds}
                    onAreaIds={(areaIds) => setForm({ ...form, areaIds })}
                    services={catalogServices}
                    areas={catalogAreas}
                  />

                  <div className="sm:max-w-xs">
                    <Label htmlFor="worker-max-visits" className="mb-1 block text-xs font-medium text-muted-foreground">
                      Most visits in a day
                    </Label>
                    <Input
                      id="worker-max-visits"
                      value={form.maxVisits}
                      inputMode="numeric"
                      placeholder="No limit"
                      onChange={(e) => setForm({ ...form, maxVisits: e.target.value.replace(/\D/g, "").slice(0, 2) })}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Online booking stops offering this person once they reach it, and you get a warning if you book them past it.
                    </p>
                  </div>

                  <div>
                    <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Where their day starts (required)
                    </Label>
                    <p className="mb-2 text-xs text-muted-foreground">
                      Starts as the business address from Settings, so change it for someone who leaves from home. Routing, day
                      planning and online booking start from here. A different start for one day is set from the Schedule.
                    </p>
                    {addressIsEmpty(businessStart) && addressIsEmpty(form.homeBase) && (
                      <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
                        Add your business address in Settings, Business details, and new staff will start with it.
                      </p>
                    )}
                    <AddressFields value={form.homeBase} onChange={(homeBase) => setForm({ ...form, homeBase })} />
                  </div>
        </div>

        <div className={on("work") ? "space-y-4" : "hidden"}>
                  <StaffAvailabilityFields
                    part="work"
                    hours={form.hours}
                    onHours={(hours) => setForm({ ...form, hours })}
                    timeOff={form.timeOff}
                    onTimeOff={(timeOff) => setForm({ ...form, timeOff })}
                    serviceIds={form.serviceIds}
                    onServiceIds={(serviceIds) => setForm({ ...form, serviceIds })}
                    areaIds={form.areaIds}
                    onAreaIds={(areaIds) => setForm({ ...form, areaIds })}
                    services={catalogServices}
                    areas={catalogAreas}
                  />

                  <div className="space-y-2">
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={form.contact}
                        onCheckedChange={(v) => setForm({ ...form, contact: v === true })}
                      />
                      Sees customer contact
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={form.prices}
                        onCheckedChange={(v) => setForm({ ...form, prices: v === true })}
                      />
                      Sees prices and can record payments
                    </label>
                    {editing?.memberUid && (
                      <p className="text-xs text-muted-foreground">
                        Not enforced for workspace members. Crew app users follow these.
                      </p>
                    )}
                  </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border bg-card p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{labourTerm(config)}</h2>
          {isAdmin && (
            <Button size="sm" onClick={openAdd}>
              <UserPlus className="mr-1 h-3.5 w-3.5" /> Add {wt.worker}
            </Button>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          People who go out on {terms.jobs}. Workspace members sign in with their normal
          login. {wt.Workers} who aren&apos;t workspace users get their own phone app, added with the Add button. {withArticleCap(wt.worker)} needs a profile here to be assigned to visits.
        </p>
        {isAdmin && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-3 text-sm">
            <span className="text-muted-foreground">Crew app address for this business:</span>
            <code className="break-all">{typeof window === "undefined" ? "" : `${window.location.origin}/field/${subAccountId}`}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  .writeText(`${window.location.origin}/field/${subAccountId}`)
                  .then(() => toast.success("Address copied."));
              }}
            >
              Copy
            </Button>
            <span className="w-full text-xs text-muted-foreground">
              Each business has its own crew app. Staff sign in here with their email and install it from here.
            </span>
          </div>
        )}

        {!loaded ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </p>
        ) : sorted.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            No {wt.workers} yet.
            {isAdmin ? " Add the first one with the button above." : ""}
          </p>
        ) : (
          <>
          {disabledCount > 0 && (
            <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={showDisabled} onCheckedChange={(v) => setShowDisabled(v === true)} />
              Show non-active ({disabledCount})
            </label>
          )}
          {shown.length === 0 && (
            <p className="mt-4 text-sm text-muted-foreground">No active {wt.workers}. Tick Show non-active to see the rest.</p>
          )}
          <ul className={"divide-y rounded-lg border" + (shown.length === 0 ? " hidden" : " mt-3")}>
            {shown.map((w) => {
              const removed = w.status === "removed";
              const cardName = showRates ? rateCards.cards.find((c) => c.id === w.rateCardId)?.name : undefined;
              const cs = crew[w.id];
              const access = w.memberUid
                ? "Workspace login"
                : w.portalStatus === "active"
                  ? "Joined"
                  : w.portalStatus === "invited"
                    ? cs?.inviteExpired
                      ? "Invite expired"
                      : "Invite sent"
                    : "No app access";
              return (
                <li key={w.id}>
                  <button
                    type="button"
                    disabled={!isAdmin}
                    onClick={() => openEditor(w)}
                    aria-label={isAdmin ? `Edit ${w.name}` : undefined}
                    className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: w.color }}
                      aria-hidden
                    />
                    <span className="block min-w-0 flex-1">
                      <span
                        className={
                          "block truncate text-sm font-medium " +
                          (removed ? "text-muted-foreground line-through" : "")
                        }
                      >
                        {w.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {KIND_LABELS[w.kind]}
                        {cs?.lastSeenAt ? ` · seen ${formatRelativeTime(new Date(cs.lastSeenAt))}` : ""}
                      </span>
                    </span>
                    <span className="flex max-w-[45%] shrink-0 flex-wrap items-center justify-end gap-1.5">
                      {cardName && (
                        <span className="max-w-full truncate rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{cardName}</span>
                      )}
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-xs " +
                          (removed
                            ? "bg-muted text-muted-foreground"
                            : access === "Joined" || access === "Workspace login"
                              ? "bg-green-500/15 text-green-700 dark:text-green-400"
                              : access === "Invite sent"
                                ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                : access === "Invite expired"
                                  ? "bg-red-500/15 text-red-700 dark:text-red-400"
                                : "bg-muted text-muted-foreground")
                        }
                      >
                        {removed ? "Disabled" : access}
                      </span>
                      {!removed && cs?.alerts !== null && cs?.alerts !== undefined && (
                        <span
                          className={
                            "rounded-full px-2 py-0.5 text-xs " +
                            (cs.alerts ? "bg-green-500/15 text-green-700 dark:text-green-400" : "bg-muted text-muted-foreground")
                          }
                        >
                          {cs.alerts ? "Alerts on" : "Alerts off"}
                        </span>
                      )}
                      {!removed && w.canHandlePrices && (
                        <span
                          title="Sees prices and can record payments"
                          aria-label="Sees prices and can record payments"
                          className="rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-700 dark:text-sky-400"
                        >
                          $
                        </span>
                      )}
                    </span>
                    {isAdmin && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
          </>
        )}

        {workers.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            {wt.Workers} who sign in with a workspace login can see whatever their
            workspace role allows. The price and customer-contact switches are
            enforced for {wt.workers} who use the crew app.
          </p>
        )}
      </section>

      {isAdmin && (
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Add {withArticle(wt.worker)}</DialogTitle>
              <DialogDescription>
                They get the crew app on their phone or desktop, with no CRM login. We email an invite link, then a 6-digit code to
                their email to sign in. Workspace members are added automatically. Everything is set here, and you can change it later by clicking them in the list.
              </DialogDescription>
            </DialogHeader>
            {staffFields(null)}

            {serviceMembers && serviceMembers.some((m) => !m.inFieldServices) && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Created earlier but never added (left over from a setup that did not finish)</p>
                <ul className="divide-y rounded-lg border">
                  {serviceMembers
                    .filter((m) => !m.inFieldServices)
                    .map((m) => (
                      <li key={m.id} className="flex flex-wrap items-center gap-3 p-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{m.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {m.identifier}
                            {m.classification ? ` · ${m.classification}` : ""}
                          </p>
                        </div>
                        <Button size="sm" variant="outline" disabled={inviting} onClick={() => void dropServiceMember(m.id)}>
                          {confirmDropId === m.id ? "Tap again to remove" : "Remove"}
                        </Button>
                        <Button size="sm" variant="outline" disabled={inviting} onClick={() => void addServiceMember(m)}>
                          Add and send invite
                        </Button>
                      </li>
                    ))}
                </ul>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setAddOpen(false)} disabled={inviting}>
                Cancel
              </Button>
              <Button disabled={inviting || !form.name.trim() || !form.email.trim() || !form.phone.trim() || !rates.sell.trim() || !rates.cost.trim()} onClick={() => void createAndInvite()}>
                {inviting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Add and send invite
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{preview?.name}&apos;s day in the crew app</DialogTitle>
            <DialogDescription>
              Customer phone: {preview?.contact ? "shown" : "hidden"}. Prices and payments:{" "}
              {preview?.prices ? "shown" : "hidden"}.
            </DialogDescription>
          </DialogHeader>
          {preview && preview.visits.length === 0 ? (
            <p className="text-sm text-muted-foreground">No visits around today.</p>
          ) : (
            <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border text-sm">
              {preview?.visits.map((v) => (
                <li key={v.id} className="space-y-0.5 p-3">
                  <p className="font-medium">{v.title}</p>
                  <p className="text-muted-foreground">
                    {v.when} · {v.customer}
                    {v.phone ? ` · ${v.phone}` : ""}
                  </p>
                  {v.address && <p className="text-muted-foreground">{v.address}</p>}
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button onClick={() => setPreview(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={invited !== null} onOpenChange={(o) => !o && setInvited(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{invited?.delivered ? `Invite sent to ${invited?.name}` : "Invite not sent"}</DialogTitle>
            <DialogDescription>
              {invited?.delivered
                ? "They open the link, and we send a 6-digit code to their email to confirm it's them. There's nothing for you to read out."
                : "The invite link couldn't be sent. Check the number or email, then resend."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setInvited(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) {
            setEditingId(null);
            setJustAdded(null);
          }
        }}
      >
        <DialogContent className="flex max-h-[90vh] flex-col gap-4 overflow-hidden sm:h-[90vh] sm:max-w-3xl">
          {editing && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: form.color }} aria-hidden />
                  {editing.name}
                </DialogTitle>
                <DialogDescription>
                  {[KIND_LABELS[editing.kind], editing.email, editing.phone].filter(Boolean).join(" · ")}
                  {editing.memberUid ? " · signs in with a workspace login" : ""}
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-wrap gap-1.5 text-xs">
                <span className="rounded-full bg-muted px-2.5 py-0.5">{editing.status === "removed" ? "Disabled" : "Active"}</span>
                <span className="rounded-full bg-muted px-2.5 py-0.5">{crewChip(editing)}</span>
                {rates.loaded && rates.sell && rates.cost && (
                  <span className="rounded-full bg-muted px-2.5 py-0.5">{`${rates.currency} ${rates.sell} sell · ${rates.cost} cost`}</span>
                )}
              </div>

              {editing.status !== "removed" && (
                <div className="flex flex-wrap gap-1 border-b">
                  {STAFF_TABS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setStaffTab(t.id)}
                      className={
                        "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition " +
                        (staffTab === t.id
                          ? "border-primary text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground")
                      }
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="-mx-4 min-h-0 flex-1 space-y-4 overflow-y-auto px-4">

              {justAdded?.id === editing.id && (
                <p className="rounded-lg bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">
                  {justAdded.delivered
                    ? `Added. The invite is on its way to ${editing.email || "their email"}.`
                    : "Added. The invite could not be sent; use Resend invite below once the email is right."}{" "}
                  Set their hours and the rest below, then Save.
                </p>
              )}

              {editing.status === "removed" ? (
                <>
                  {activeToggle(editing)}
                  <p className="text-sm text-muted-foreground">
                    This person is disabled. Turn Active back on to schedule them and give them crew app access again.
                  </p>
                </>
              ) : (
                staffFields(editing)
              )}

              </div>

              <DialogFooter>
                {editing.status !== "removed" && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(`${window.location.origin}/field/${subAccountId}`)
                          .then(() => toast.success("App link copied. They sign in with their email."));
                      }}
                    >
                      Copy app link
                    </Button>
                    <Button variant="outline" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                    <Button disabled={busyId === editing.id || !form.name.trim()} onClick={() => void saveEditor()}>
                      {busyId === editing.id && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                      Save
                    </Button>
                  </div>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={reassignFor !== null} onOpenChange={(o) => !o && setReassignFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Who takes {reassignFor?.name}&apos;s visits?</DialogTitle>
            <DialogDescription>
              They still have visits that haven&apos;t finished. Move them to
              someone else, or leave them unassigned so they show in the
              Unassigned lane of the schedule.
            </DialogDescription>
          </DialogHeader>
          <select
            value={reassignTo}
            onChange={(e) => setReassignTo(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="unassigned">Leave unassigned</option>
            {workers
              .filter((x) => x.status === "active" && x.id !== reassignFor?.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReassignFor(null)}>
              Cancel
            </Button>
            <Button onClick={confirmRemove} disabled={busyId === reassignFor?.id}>
              Disable {wt.worker}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
