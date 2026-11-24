import "server-only";

import { listWorkerRates, type WorkerRates } from "@/lib/server/field-worker-rates-service";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { formatServiceAddress } from "@/lib/field-services/address";
import { minorToUnit, unitToMinor } from "@/lib/field-services/money";
import { priceLabour, type LabourRate } from "@/lib/field-services/labour-pricing";
import { effectiveBillingType } from "@/lib/field-services/billing-type";
import { inWeekRange, parseWeekRange, periodText } from "@/lib/field-services/week-range";
import { issueQuoteNumber, releaseQuoteNumber } from "@/lib/quotes/number";
import { computeQuoteTotals, effectiveQuoteStatus } from "@/lib/quotes/calc";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getFieldServicesConfig, getJobTerms } from "@/lib/server/field-services-config-service";
import { approvedWeeks, weekStartOf, workspaceTimezone } from "@/lib/server/field-timesheet-service";
import { recordFieldActivity } from "@/lib/server/field-events";
import { existingInvoiceIds, legacyBilledApprovals, refreshInvoicedFlag } from "@/lib/server/field-invoicing";
import { GLOBAL_TERRITORY_ID } from "@/types";
import { DEFAULT_QUOTE } from "@/types/quotes";
import type { Job, JobBillingType, RateCard } from "@/types/field-services";
import type { Quote, QuoteKind, QuoteLineItem } from "@/types/quotes";

export interface DocumentOptions {
  includeParts?: boolean;
  includeJobLines?: boolean;
  /** Add the service area's travel fee. Off unless the office ticks it, and only once per job. */
  includeTravelFee?: boolean;
  /** Leave logged time off this invoice. Only used while timesheets are on. */
  includeLabour?: boolean;
  /** Bill just this finished visit (required for repeating jobs). */
  visitId?: string;
  /** Any date in the last week to bill. Time and parts after that week stay for a later invoice. */
  weekEnding?: string;
  /** How many weeks to include counting back from the week ending. Empty means every unbilled week up to it. */
  weeks?: number | null;
}

function waitingMessage(hours: number): string {
  const n = Math.round(hours * 100) / 100;
  return `Nothing to invoice yet: ${n} logged hour${n === 1 ? " is" : "s are"} waiting for the week to be approved on the Timesheets tab.`;
}

function hoursBetween(start: unknown, end: unknown): number {
  const s = (start as { toMillis?: () => number } | null)?.toMillis?.();
  const e = (end as { toMillis?: () => number } | null)?.toMillis?.();
  return s && e && e > s ? (e - s) / 3_600_000 : 0;
}

/** The job's own lines and travel fee as invoice lines, plus which extra-work approvals they carry. */
function buildJobLines(
  job: Job,
  aliveInvoices: Set<string>,
  skipOwnLines = false,
  legacyBilled?: Set<string>,
  withTravelFee = false,
): { lines: QuoteLineItem[]; approvalIds: string[] } {
  const lines: QuoteLineItem[] = [];
  const approvalIds: string[] = [];
  for (const l of job.lineItems) {
    if (l.approvalId) {
      const billedOn = job.billedApprovals?.[l.approvalId];
      if (billedOn && aliveInvoices.has(billedOn)) continue;
      if (!billedOn && legacyBilled?.has(l.approvalId)) continue;
      if (!approvalIds.includes(l.approvalId)) approvalIds.push(l.approvalId);
    } else if (skipOwnLines) {
      continue;
    }
    lines.push({
      id: crypto.randomUUID(),
      description: l.description,
      quantity: l.quantity,
      unitPrice: minorToUnit(job.currency, l.unitPriceMinor),
      productId: l.productId ?? null,
    });
  }
  if (withTravelFee && job.travelFeeCents && job.travelFeeCents > 0) {
    lines.push({
      id: crypto.randomUUID(),
      description: "Travel fee",
      quantity: 1,
      unitPrice: minorToUnit(job.currency, job.travelFeeCents),
      productId: null,
    });
  }
  return { lines, approvalIds };
}

/** The Time and materials estimate as customer-facing estimate lines. */
function estimateAsLines(job: Job): QuoteLineItem[] {
  return (job.estimateLines ?? []).map((l) => ({
    id: crypto.randomUUID(),
    description: l.description,
    quantity: l.quantity,
    unitPrice: minorToUnit(job.currency, l.unitPriceMinor),
    productId: l.productId ?? null,
  }));
}

/** The description and estimate as plain text for an invoice's notes. Never invoice charges. */
function scopeText(job: Job): string {
  const parts: string[] = [];
  if (job.description?.trim()) parts.push(`Scope: ${job.description.trim()}`);
  const lines = (job.estimateLines ?? []).filter((l) => l.description.trim());
  if (lines.length > 0) {
    parts.push(
      "Estimate:\n" +
        lines
          .map((l) => `- ${l.description} (${l.quantity} x ${minorToUnit(job.currency, l.unitPriceMinor).toFixed(2)} ${job.currency})`)
          .join("\n"),
    );
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

/** What a draft invoice would look like. Nothing is saved. */
export interface InvoicePreview {
  currency: string;
  lines: { description: string; quantity: number; unitPrice: number }[];
  subtotal: number;
  discount: number;
  total: number;
  notes: string;
  /** The whole document as a draft would be saved (without timestamps), for rendering the customer's PDF. */
  document: Record<string, unknown>;
}

export async function createDocumentFromJob(input: {
  subAccountId: string;
  jobId: string;
  kind: QuoteKind;
  createdByUid: string;
  options?: DocumentOptions;
  /** Work out the document exactly as a draft would be, but write nothing and use up no number. */
  preview?: boolean;
}): Promise<{
  id: string;
  quoteNumber: string;
  preview?: InvoicePreview;
  partsBilled: number;
  hoursBilled: number;
  /** Logged hours left off because their week is not approved yet. */
  hoursWaiting: number;
  /** Parts left off because nobody has put a price on them yet. */
  partsUnpriced: number;
}> {
  const db = getAdminDb();
  const terms = await getJobTerms(input.subAccountId);
  const jobRef = db.doc(`jobs/${input.jobId}`);
  const jobSnap = await jobRef.get();
  const job = { id: jobSnap.id, ...jobSnap.data() } as Job;
  if (!jobSnap.exists || job.subAccountId !== input.subAccountId) {
    throw new FieldServicesError(`${terms.Job} not found.`, 404);
  }
  if (job.status === "cancelled") {
    throw new FieldServicesError(`This ${terms.job} was cancelled.`, 409);
  }
  const visitId = input.options?.visitId;
  const repeating = job.jobType === "recurring";
  if (input.kind === "invoice" && repeating && !visitId) {
    throw new FieldServicesError("Choose which finished visit to bill.");
  }
  if (visitId && input.kind !== "invoice") {
    throw new FieldServicesError("Only invoices bill a single visit.");
  }
  if (visitId && !repeating) {
    throw new FieldServicesError(`Only repeating ${terms.jobs} are billed visit by visit.`);
  }
  const visitRef = visitId ? db.doc(`visits/${visitId}`) : null;
  if (visitRef) {
    const v = (await visitRef.get()).data();
    if (!v || v.jobId !== job.id || v.subAccountId !== job.subAccountId) {
      throw new FieldServicesError(`That visit isn't part of this ${terms.job}.`, 404);
    }
    if (v.status !== "completed") throw new FieldServicesError("Only finished visits can be billed.", 409);
    if (v.invoiceId && (await existingInvoiceIds([v.invoiceId as string])).size > 0) {
      throw new FieldServicesError("That visit is already on an invoice.", 409);
    }
  }

  const includeLines = input.options?.includeJobLines !== false;
  const billedInvoices = await existingInvoiceIds([
    ...Object.values(job.billedApprovals ?? {}),
    ...(job.billedLinesInvoiceId ? [job.billedLinesInvoiceId] : (job.invoiceIds ?? [])),
  ]);
  // A job invoiced before this was tracked counts as billed while any of its invoices still exists.
  const ownLinesBilled =
    !repeating &&
    input.kind === "invoice" &&
    (job.billedLinesInvoiceId
      ? billedInvoices.has(job.billedLinesInvoiceId)
      : job.billedLinesInvoiceId === undefined && (job.invoiceIds ?? []).some((i) => billedInvoices.has(i)));
  const skipOwnLines = ownLinesBilled && input.options?.includeJobLines === undefined;
  const legacyApprovals = input.kind === "invoice" ? await legacyBilledApprovals(job) : new Set<string>();
  const travelBilled = job.travelFeeInvoiceId
    ? (await existingInvoiceIds([job.travelFeeInvoiceId])).has(job.travelFeeInvoiceId)
    : false;
  const withTravel = input.options?.includeTravelFee === true && !travelBilled;
  const baseLines = includeLines
    ? buildJobLines(job, billedInvoices, skipOwnLines, legacyApprovals, withTravel).lines
    : [];

  const config = input.kind === "invoice" ? await getFieldServicesConfig(job.subAccountId) : null;
  const useCards = config?.timesheetsEnabled === true;
  // Time in weeks before timesheets were first switched on has no approval to wait for.
  const firstEnabledMs =
    (config?.timesheetsFirstEnabledAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? null;
  const billingType: JobBillingType = effectiveBillingType(job);
  const parsedRange =
    input.kind === "invoice"
      ? parseWeekRange(input.options?.weekEnding, input.options?.weeks)
      : ({ ok: true, range: null } as const);
  if (!parsedRange.ok) throw new FieldServicesError(parsedRange.error);
  const range = parsedRange.range;
  const subTimezone = await workspaceTimezone(job.subAccountId);
  const inRange = (ms: number) => inWeekRange(weekStartOf(ms, subTimezone), range);
  const startMsOf = (d: FirebaseFirestore.QueryDocumentSnapshot) =>
    (d.data().startAt as { toMillis: () => number }).toMillis();
  const partMsOf = (d: FirebaseFirestore.QueryDocumentSnapshot) =>
    (d.data().createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? null;
  const partInRange = (d: FirebaseFirestore.QueryDocumentSnapshot) => {
    const t = partMsOf(d);
    return !range || t === null || inRange(t);
  };
  const wantLabour =
    input.kind === "invoice" &&
    (billingType === "time_and_materials" || billingType === "day_rate") &&
    input.options?.includeLabour !== false;
  const wantParts = input.kind === "invoice" && input.options?.includeParts === true;

  const workerNames = new Map<string, string>();
  const workerCards = new Map<string, string | null>();
  const cards = new Map<string, RateCard>();
  if (wantLabour) {
    const ws = await db.collection("fieldWorkers").where("subAccountId", "==", job.subAccountId).get();
    for (const w of ws.docs) {
      workerNames.set(w.id, (w.data().name as string) ?? "Technician");
      workerCards.set(w.id, (w.data().rateCardId as string | null | undefined) ?? null);
    }
    if (useCards) {
      const cs = await db.collection("fieldRateCards").where("subAccountId", "==", job.subAccountId).get();
      for (const c of cs.docs) cards.set(c.id, { id: c.id, ...c.data() } as RateCard);
    }
  }
  const ownRates = wantLabour ? await listWorkerRates(job.subAccountId) : new Map<string, WorkerRates>();
  const rateFor = (workerId: string): LabourRate | null => {
    const card = cards.get(workerCards.get(workerId) ?? "");
    // A person's own sell rate replaces the hourly rate of their rate card.
    const own = ownRates.get(workerId);
    if (own && own.sellRateMinor > 0) {
      if (own.currency !== job.currency) {
        throw new FieldServicesError(
          `${workerNames.get(workerId) ?? "A worker"}'s sell rate is in ${own.currency}, but this ${terms.job} is in ${job.currency}.`,
          409,
        );
      }
      if (card && card.currency !== job.currency) {
        throw new FieldServicesError(
          `${workerNames.get(workerId) ?? "A worker"}'s rate card "${card.name}" is in ${card.currency}, but this ${terms.job} is in ${job.currency}.`,
          409,
        );
      }
      return {
        hourlyMinor: own.sellRateMinor,
        dayMinor: card ? card.dayRateMinor : null,
        role: card?.name ?? "",
      };
    }
    if (card) {
      if (card.currency !== job.currency) {
        throw new FieldServicesError(
          `${workerNames.get(workerId) ?? "A worker"}'s rate card "${card.name}" is in ${card.currency}, but this ${terms.job} is in ${job.currency}.`,
          409,
        );
      }
      return { hourlyMinor: card.hourlyRateMinor, dayMinor: card.dayRateMinor, role: card.name };
    }
    return null;
  };

  if (baseLines.length === 0) {
    const [t, p] = await Promise.all([
      wantLabour ? db.collection("timeEntries").where("jobId", "==", job.id).get() : null,
      wantParts ? db.collection("materialLines").where("jobId", "==", job.id).get() : null,
    ]);
    const timeDocs = (t?.docs ?? []).filter(
      (d) => !visitId || d.data().visitId === visitId || (useCards && !d.data().visitId),
    );
    const partDocs = (p?.docs ?? []).filter(
      (d) => (!visitId || d.data().visitId === visitId) && partInRange(d),
    );
    const alive = await existingInvoiceIds([
      ...timeDocs.map((d) => d.data().invoiceId as string | undefined),
      ...partDocs.map((d) => d.data().invoiceLineId as string | undefined),
    ]);
    const eligibleTime = timeDocs.filter((d) => {
      const e = d.data();
      return (
        e.subAccountId === job.subAccountId &&
        e.voided !== true &&
        e.billable !== false &&
        !e.running &&
        !(e.invoiceId && alive.has(e.invoiceId)) &&
        hoursBetween(e.startAt, e.endAt) > 0 &&
        inRange(startMsOf(d))
      );
    });
    let anyTime = eligibleTime.length > 0;
    let hoursWaitingPre = 0;
    // Refuse here, before an invoice number is used, when every logged hour is still waiting for approval.
    if (useCards && eligibleTime.length > 0) {
      const startOf = startMsOf;
      const legacyBefore = firstEnabledMs === null ? null : weekStartOf(firstEnabledMs, subTimezone);
      const approvedPre = await approvedWeeks(
        job.subAccountId,
        eligibleTime.map((d) => ({
          workerId: d.data().workerId as string,
          weekStart: weekStartOf(startOf(d), subTimezone),
        })),
      );
      anyTime = false;
      for (const d of eligibleTime) {
        const week = weekStartOf(startOf(d), subTimezone);
        if ((legacyBefore !== null && week < legacyBefore) || approvedPre.has(`${d.data().workerId}|${week}`)) {
          anyTime = true;
        } else {
          hoursWaitingPre += hoursBetween(d.data().startAt, d.data().endAt);
        }
      }
    }
    const anyPart = partDocs.some((d) => {
      const m = d.data();
      return (
        m.subAccountId === job.subAccountId &&
        m.billable !== false &&
        !(m.invoiceLineId && alive.has(m.invoiceLineId))
      );
    });
    if (!anyTime && !anyPart) {
      if (hoursWaitingPre > 0) throw new FieldServicesError(waitingMessage(hoursWaitingPre), 409);
      throw new FieldServicesError(
        `Nothing to put on it yet. Add a line to the ${terms.job}, or log some time or parts first.`,
      );
    }
  }

  const contactSnap = await db.doc(`contacts/${job.contactId}`).get();
  const contact = contactSnap.data() ?? {};
  const quoteNumber = input.preview ? "Preview" : await issueQuoteNumber(input.subAccountId, input.kind);
  const ref = db.collection("quotes").doc();
  const address = formatServiceAddress(job.serviceAddress);

  // Time and parts are marked billed in the same transaction as the invoice.
  const result = await db.runTransaction(async (tx) => {
    const freshJobSnap = await tx.get(jobRef);
    const freshJob = { ...(freshJobSnap.data() as Job), id: freshJobSnap.id };
    if (freshJob.status === "cancelled") throw new FieldServicesError(`This ${terms.job} was cancelled.`, 409);
    const aliveBilled = new Set<string>();
    const billedIds = new Set([
      ...Object.values(freshJob.billedApprovals ?? {}),
      ...(freshJob.billedLinesInvoiceId ? [freshJob.billedLinesInvoiceId] : (freshJob.invoiceIds ?? [])),
      ...(freshJob.travelFeeInvoiceId ? [freshJob.travelFeeInvoiceId] : []),
      ...Object.keys(freshJob.depositCredits ?? {}),
    ]);
    for (const invoiceId of billedIds) {
      if ((await tx.get(db.doc(`quotes/${invoiceId}`))).exists) aliveBilled.add(invoiceId);
    }
    const freshOwnBilled =
      !repeating &&
      input.kind === "invoice" &&
      (freshJob.billedLinesInvoiceId
        ? aliveBilled.has(freshJob.billedLinesInvoiceId)
        : freshJob.billedLinesInvoiceId === undefined &&
          (freshJob.invoiceIds ?? []).some((i) => aliveBilled.has(i)));
    const skipOwnNow = freshOwnBilled && input.options?.includeJobLines === undefined;
    const travelNow =
      input.options?.includeTravelFee === true &&
      !(freshJob.travelFeeInvoiceId && aliveBilled.has(freshJob.travelFeeInvoiceId));
    // A Time and materials estimate document is made from the estimate lines. Its invoice bills actual time and parts.
    const useEstimate =
      input.kind === "quote" && billingType === "time_and_materials" && (freshJob.estimateLines?.length ?? 0) > 0;
    const built = useEstimate
      ? { lines: estimateAsLines(freshJob), approvalIds: [] as string[] }
      : includeLines
        ? buildJobLines(freshJob, aliveBilled, skipOwnNow, legacyApprovals, travelNow)
        : { lines: [] as QuoteLineItem[], approvalIds: [] as string[] };
    // A booking made with prices including tax keeps the tax rate it was made at. Its lines are turned into ex-tax prices so they add up to what the customer saw.
    const jobTax = freshJob.tax && freshJob.tax.percent > 0 ? freshJob.tax : null;
    const taxFactor = jobTax ? 1 + jobTax.percent / 100 : 1;
    const exTax = (l: QuoteLineItem): QuoteLineItem => ({ ...l, unitPrice: Math.round((l.unitPrice / taxFactor) * 1e6) / 1e6 });
    const lineItems: QuoteLineItem[] = [...(jobTax?.inclusive && !useEstimate ? built.lines.map(exTax) : built.lines)];
    const billedEntries: string[] = [];
    const billedParts: string[] = [];
    let partsUnpriced = 0;
    let hoursBilled = 0;
    let hoursWaiting = 0;

    const entrySnap = wantLabour
      ? await tx.get(db.collection("timeEntries").where("jobId", "==", job.id))
      : null;
    const partSnap = wantParts
      ? await tx.get(db.collection("materialLines").where("jobId", "==", job.id))
      : null;
    // Time logged on the job with no visit goes on whichever invoice is drafted next.
    const entryDocs = (entrySnap?.docs ?? []).filter(
      (d) => !visitId || d.data().visitId === visitId || (useCards && !d.data().visitId),
    );
    const partDocsTx = (partSnap?.docs ?? []).filter(
      (d) => (!visitId || d.data().visitId === visitId) && partInRange(d),
    );
    if (visitRef) {
      const fresh = (await tx.get(visitRef)).data();
      if (!fresh || fresh.jobId !== job.id || fresh.status !== "completed") {
        throw new FieldServicesError(`Only finished visits of this ${terms.job} can be billed.`, 409);
      }
      if (fresh.invoiceId && (await tx.get(db.doc(`quotes/${fresh.invoiceId}`))).exists) {
        throw new FieldServicesError("That visit is already on an invoice.", 409);
      }
    }

    if (useCards && effectiveBillingType(freshJob) !== billingType) {
      throw new FieldServicesError(`The ${terms.job}'s billing type just changed. Draft the invoice again.`, 409);
    }
    const invoiceIds = new Set<string>();
    for (const d of entrySnap?.docs ?? []) if (d.data().invoiceId) invoiceIds.add(d.data().invoiceId);
    for (const d of partDocsTx) if (d.data().invoiceLineId) invoiceIds.add(d.data().invoiceLineId);
    const alive = new Set<string>();
    for (const id of invoiceIds) {
      if ((await tx.get(db.doc(`quotes/${id}`))).exists) alive.add(id);
    }

    if (entrySnap) {
      const billable: { workerId: string; startMs: number; endMs: number; fixed?: boolean }[] = [];
      const prior: { workerId: string; startMs: number; endMs: number; fixed?: boolean }[] = [];
      for (const d of entrySnap.docs) {
        const e = d.data();
        if (e.subAccountId !== job.subAccountId || e.voided === true || e.billable === false || e.running) continue;
        if (!e.invoiceId || !alive.has(e.invoiceId) || hoursBetween(e.startAt, e.endAt) <= 0) continue;
        prior.push({
          workerId: e.workerId as string,
          startMs: (e.startAt as { toMillis: () => number }).toMillis(),
          endMs: (e.endAt as { toMillis: () => number }).toMillis(),
          fixed: e.hoursOnly === true,
        });
      }
      const candidates: { id: string; workerId: string; startMs: number; endMs: number; fixed?: boolean }[] = [];
      for (const d of entryDocs) {
        const e = d.data();
        if (e.subAccountId !== job.subAccountId || e.voided === true || e.billable === false || e.running) continue;
        if (e.invoiceId && alive.has(e.invoiceId)) continue;
        const h = hoursBetween(e.startAt, e.endAt);
        if (h <= 0) continue;
        if (!inRange(startMsOf(d))) continue;
        candidates.push({
          id: d.id,
          workerId: e.workerId as string,
          startMs: (e.startAt as { toMillis: () => number }).toMillis(),
          endMs: (e.endAt as { toMillis: () => number }).toMillis(),
          fixed: e.hoursOnly === true,
        });
      }
      // With timesheets on, only time in an approved week reaches an invoice.
      const weekOf = (c: { startMs: number }) => weekStartOf(c.startMs, subTimezone);
      const legacyBefore = firstEnabledMs === null ? null : weekStartOf(firstEnabledMs, subTimezone);
      const approved = useCards
        ? await approvedWeeks(
            job.subAccountId,
            candidates.map((c) => ({ workerId: c.workerId, weekStart: weekOf(c) })),
            tx,
          )
        : null;
      for (const c of candidates) {
        if (
          approved &&
          !(legacyBefore !== null && weekOf(c) < legacyBefore) &&
          !approved.has(`${c.workerId}|${weekOf(c)}`)
        ) {
          hoursWaiting += (c.endMs - c.startMs) / 3_600_000;
          continue;
        }
        billedEntries.push(c.id);
        billable.push({ workerId: c.workerId, startMs: c.startMs, endMs: c.endMs, fixed: c.fixed });
      }
      const nameFor = (workerId: string) => workerNames.get(workerId) ?? "Technician";
      {
        const priced = priceLabour({
          billingType,
          timezone: job.timezone,
          entries: billable,
          prior,
          rateFor,
          nameFor,
        });
        if (priced.missingRate.length > 0) {
          const names = priced.missingRate.map(nameFor).join(", ");
          throw new FieldServicesError(
            `${names} ${priced.missingRate.length === 1 ? "has" : "have"} no rate. Set their sell rate in their staff details.`,
            409,
          );
        }
        if (priced.missingDayRate.length > 0) {
          const names = priced.missingDayRate.map(nameFor).join(", ");
          throw new FieldServicesError(
            `${names} ${priced.missingDayRate.length === 1 ? "has" : "have"} no rate card with a day rate, and this ${terms.job} bills by the day.`,
            409,
          );
        }
        hoursBilled += priced.hours;
        const weeksBilled = billable.map((b) => weekStartOf(b.startMs, subTimezone)).sort();
        const period = weeksBilled.length ? periodText(weeksBilled[0], weeksBilled[weeksBilled.length - 1]) : "";
        for (const l of priced.lines) {
          lineItems.push({
            id: crypto.randomUUID(),
            description: period ? `${l.description} (${period})` : l.description,
            quantity: l.quantity,
            unitPrice: minorToUnit(job.currency, l.unitPriceMinor),
            productId: null,
          });
        }
      }
    }
    if (partSnap) {
      for (const d of partDocsTx) {
        const m = d.data();
        if (m.subAccountId !== job.subAccountId || m.billable === false) continue;
        if (m.invoiceLineId && alive.has(m.invoiceLineId)) continue;
        // Crew without price access log parts at zero. They wait for the office to price them.
        if (!(typeof m.unitPriceMinor === "number" && m.unitPriceMinor > 0)) {
          partsUnpriced += 1;
          continue;
        }
        billedParts.push(d.id);
        lineItems.push({
          id: crypto.randomUUID(),
          description: m.name as string,
          quantity: m.qty as number,
          unitPrice: minorToUnit(job.currency, m.unitPriceMinor as number),
          productId: null,
        });
      }
    }
    if (lineItems.length === 0) {
      if (hoursWaiting > 0) {
        throw new FieldServicesError(waitingMessage(hoursWaiting), 409);
      }
      throw new FieldServicesError(
        `Nothing to put on it yet. Add a line to the ${terms.job}, or log some time or parts first.`,
      );
    }

    // A deposit paid at booking comes off the first invoices, never more than they come to.
    let depositCredit = 0;
    if (input.kind === "invoice" && !repeating && (freshJob.depositPaidMinor ?? 0) > 0) {
      const used = Object.entries(freshJob.depositCredits ?? {})
        .filter(([invoiceId]) => aliveBilled.has(invoiceId))
        .reduce((sum, [, minor]) => sum + minor, 0);
      const remaining = (freshJob.depositPaidMinor ?? 0) - used;
      // The money came in with tax, so it can come off no more than the invoice total with tax.
      const subtotalMinor = unitToMinor(
        job.currency,
        lineItems.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0) * taxFactor,
      );
      depositCredit = Math.max(0, Math.min(remaining, subtotalMinor));
    }

    const doc: Omit<Quote, "id"> = {
      ...DEFAULT_QUOTE,
      kind: input.kind,
      ...(input.kind === "invoice" ? { paymentDueDays: config?.invoiceDueDays === undefined ? 7 : config.invoiceDueDays } : {}),
      ...(jobTax ? { globalTaxPercent: jobTax.percent, globalTaxName: jobTax.name } : {}),
      // Taken off before tax at a smaller figure, so the total drops by exactly what was paid.
      ...(depositCredit > 0
        ? { globalDiscount: { type: "flat" as const, value: Math.round((minorToUnit(job.currency, depositCredit) / taxFactor) * 1e6) / 1e6 } }
        : {}),
      agencyId: job.agencyId,
      subAccountId: job.subAccountId,
      createdByUid: input.createdByUid,
      contactId: job.contactId,
      quoteNumber,
      publicTokenHash: "",
      territoryId:
        (contact.territoryId as string | undefined) ?? job.territoryId ?? GLOBAL_TERRITORY_ID,
      currency: job.currency,
      lineItems,
      termsAndNotes:
        (address
          ? `${terms.Job} ${job.number}: ${job.title}\nService address: ${address}`
          : `${terms.Job} ${job.number}: ${job.title}`) +
        (depositCredit > 0
          ? `\nThe deposit of ${minorToUnit(job.currency, depositCredit).toFixed(2)} ${job.currency} paid at booking is taken off the total.`
          : "") +
        (input.kind === "invoice" && billingType === "time_and_materials" && freshJob.showScopeOnInvoice === true
          ? scopeText(freshJob)
          : ""),
      dealId: input.kind === "quote" ? (job.dealId ?? null) : null,
      jobId: job.id,
      requestId: job.requestId ?? null,
      requireSignature: input.kind === "quote",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (input.preview) {
      const totals = computeQuoteTotals({ lineItems: doc.lineItems, globalDiscount: doc.globalDiscount, globalTaxPercent: doc.globalTaxPercent });
      return {
        partsBilled: billedParts.length,
        hoursBilled,
        hoursWaiting: Math.round(hoursWaiting * 100) / 100,
        partsUnpriced,
        preview: {
          currency: job.currency,
          lines: doc.lineItems.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })),
          subtotal: totals.subtotal,
          discount: totals.discountAmount,
          total: totals.total,
          notes: doc.termsAndNotes,
          document: Object.fromEntries(Object.entries(doc).filter(([k]) => k !== "createdAt" && k !== "updatedAt")),
        },
      };
    }
    tx.set(ref, doc);
    for (const id of billedEntries) {
      tx.update(db.doc(`timeEntries/${id}`), {
        invoicedAt: FieldValue.serverTimestamp(),
        invoiceId: ref.id,
      });
    }
    for (const id of billedParts) tx.update(db.doc(`materialLines/${id}`), { invoiceLineId: ref.id });
    // Extra work on this invoice is not billed again while the invoice exists.
    const newApprovals = input.kind === "invoice" ? built.approvalIds : [];
    const ownLinesIn = includeLines && !skipOwnNow && freshJob.lineItems.some((l) => !l.approvalId);
    if (visitRef) tx.update(visitRef, { invoiceId: ref.id });
    tx.update(
      jobRef,
      input.kind === "invoice"
        ? {
            invoiceIds: FieldValue.arrayUnion(ref.id),
            ...(!repeating && ownLinesIn
              ? { billedLinesInvoiceId: ref.id }
              : !repeating && freshJob.billedLinesInvoiceId === undefined
                ? { billedLinesInvoiceId: null }
                : {}),
            ...(includeLines && travelNow && freshJob.travelFeeCents && freshJob.travelFeeCents > 0
              ? { travelFeeInvoiceId: ref.id }
              : {}),
            ...(depositCredit > 0 ? { [`depositCredits.${ref.id}`]: depositCredit } : {}),
            ...Object.fromEntries(newApprovals.map((a) => [`billedApprovals.${a}`, ref.id])),
            updatedAt: FieldValue.serverTimestamp(),
          }
        : { quoteId: ref.id, updatedAt: FieldValue.serverTimestamp() },
    );
    return {
      partsBilled: billedParts.length,
      hoursBilled,
      hoursWaiting: Math.round(hoursWaiting * 100) / 100,
      partsUnpriced,
    };
  }).catch(async (err) => {
    // A draft that fails gives its number back, so the series has no gaps.
    if (!input.preview) await releaseQuoteNumber(input.subAccountId, input.kind, quoteNumber).catch(() => {});
    throw err;
  });

  if (input.preview) return { id: "", quoteNumber, ...result };

  await recordFieldActivity(
    job.contactId,
    "field_job",
    `${input.kind === "invoice" ? "Invoice" : "Estimate"} ${quoteNumber} drafted from ${terms.job} ${job.number}.`,
    { jobId: job.id, quoteId: ref.id },
  );
  await refreshInvoicedFlag(input.subAccountId, job.id).catch(() => {});
  return { id: ref.id, quoteNumber, ...result };
}

/** Whether the project's own lines are already on an invoice that still exists, so the next invoice leaves them off. */
export async function jobOwnLinesBilled(subAccountId: string, jobId: string): Promise<boolean> {
  const snap = await getAdminDb().doc(`jobs/${jobId}`).get();
  const job = snap.data() as Job | undefined;
  if (!job || job.subAccountId !== subAccountId || job.jobType === "recurring") return false;
  const alive = await existingInvoiceIds(job.billedLinesInvoiceId ? [job.billedLinesInvoiceId] : (job.invoiceIds ?? []));
  return job.billedLinesInvoiceId
    ? alive.has(job.billedLinesInvoiceId)
    : job.billedLinesInvoiceId === undefined && (job.invoiceIds ?? []).some((i) => alive.has(i));
}

export interface IssuedDocument {
  id: string;
  number: string;
  kind: QuoteKind;
  status: Quote["status"];
  currency: string;
  /** In whole currency units, as the Quotes screens show it. */
  total: number;
  issuedAtMs: number | null;
}

/** The estimates and invoices made from one project, newest first. */
export async function listIssuedDocuments(subAccountId: string, jobId: string): Promise<IssuedDocument[]> {
  const snap = await getAdminDb()
    .collection("quotes")
    .where("subAccountId", "==", subAccountId)
    .where("jobId", "==", jobId)
    .get();
  const ms = (v: unknown): number | null => (v && typeof (v as { toMillis?: () => number }).toMillis === "function" ? (v as { toMillis: () => number }).toMillis() : null);
  return snap.docs
    .map((d) => {
      const q = d.data() as Quote;
      const made = ms(q.createdAt) ?? 0;
      return {
        sort: made,
        doc: {
          id: d.id,
          number: q.quoteNumber,
          kind: q.kind,
          status: effectiveQuoteStatus(q),
          currency: q.currency,
          total: computeQuoteTotals(q).total,
          issuedAtMs: ms(q.sentAt),
        } satisfies IssuedDocument,
      };
    })
    .sort((a, b) => b.sort - a.sort)
    .map((x) => x.doc);
}
