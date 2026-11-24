import "server-only";

import { kindLabelOf } from "@/lib/field-services/time-kinds";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDayKey, mondayOf } from "@/lib/field-services/intervals";
import { addDaysToKey, utcToZonedInput, zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import {
  entriesInRange,
  readSheet,
  workspaceTimezone,
} from "@/lib/server/field-timesheet-service";
import { getFieldServicesConfig, getJobTerms } from "@/lib/server/field-services-config-service";

const MAX_DAYS = 93;
const MAX_ROWS = 20_000;

/** Quotes a cell, and stops a spreadsheet running anything a name or note might start with. */
function cell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function ms(v: unknown): number | null {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
}

export async function exportTimeCsv(input: {
  subAccountId: string;
  from: unknown;
  to: unknown;
}): Promise<{ csv: string; filename: string }> {
  const { subAccountId } = input;
  const config = await getFieldServicesConfig(subAccountId);
  if (!config.timesheetsEnabled) {
    throw new FieldServicesError("Timesheets are switched off for this workspace.", 409);
  }
  if (!isDayKey(input.from) || !isDayKey(input.to) || input.from > input.to) {
    throw new FieldServicesError("Choose a start date and a later end date.");
  }
  if (addDaysToKey(input.from, MAX_DAYS) <= input.to) {
    throw new FieldServicesError("Choose a range of three months or less.");
  }
  const tz = await workspaceTimezone(subAccountId);
  const from = zonedTimeToUtc(`${input.from}T00:00`, tz);
  const to = zonedTimeToUtc(`${addDaysToKey(input.to, 1)}T00:00`, tz);
  const db = getAdminDb();

  const workers = await db.collection("fieldWorkers").where("subAccountId", "==", subAccountId).get();
  const names = new Map(workers.docs.map((d) => [d.id, String(d.data().name ?? "")]));

  const rows: { workerId: string; id: string; data: Record<string, unknown> }[] = [];
  for (let i = 0; i < workers.docs.length; i += 10) {
    const chunk = workers.docs.slice(i, i + 10);
    const lists = await Promise.all(chunk.map((w) => entriesInRange(subAccountId, w.id, from, to)));
    chunk.forEach((w, n) => {
      for (const r of lists[n]) {
        if (r.data.voided !== true) rows.push({ workerId: w.id, ...r });
      }
    });
    if (rows.length > MAX_ROWS) throw new FieldServicesError("That range has too many entries. Choose fewer days.");
  }

  const jobIds = new Set<string>();
  const internalIds = new Set<string>();
  for (const r of rows) {
    if (typeof r.data.jobId === "string") jobIds.add(r.data.jobId);
    if (typeof r.data.internalJobId === "string") internalIds.add(r.data.internalJobId);
  }
  const [jobDocs, internalDocs] = await Promise.all([
    jobIds.size ? db.getAll(...[...jobIds].map((id) => db.doc(`jobs/${id}`))) : Promise.resolve([]),
    internalIds.size ? db.getAll(...[...internalIds].map((id) => db.doc(`fieldInternalJobs/${id}`))) : Promise.resolve([]),
  ]);
  const jobs = new Map<string, { number: string; title: string }>();
  for (const j of jobDocs) {
    if (j.exists && j.data()?.subAccountId === subAccountId) {
      jobs.set(j.id, { number: String(j.data()?.number ?? ""), title: String(j.data()?.title ?? "") });
    }
  }
  const internals = new Map<string, string>();
  for (const j of internalDocs) {
    if (j.exists && j.data()?.subAccountId === subAccountId) internals.set(j.id, String(j.data()?.name ?? ""));
  }

  const weekStatus = new Map<string, string>();
  const keys = new Set(
    rows.map((r) => `${r.workerId}|${mondayOf(zonedDateKey(new Date(ms(r.data.startAt) ?? 0), tz))}`),
  );
  await Promise.all(
    [...keys].map(async (k) => {
      const [workerId, weekStart] = k.split("|");
      weekStatus.set(k, (await readSheet(subAccountId, workerId, weekStart)).status);
    }),
  );

  const terms = await getJobTerms(subAccountId);
  const header = [
    "Worker",
    "Date",
    "Start",
    "End",
    "Hours",
    "Category",
    `${terms.Job} number`,
    terms.Job,
    `Internal ${terms.job}`,
    "Billable",
    "Week status",
    "Note",
  ];
  const lines = [header.map(cell).join(",")];
  rows.sort((a, b) => (ms(a.data.startAt) ?? 0) - (ms(b.data.startAt) ?? 0));
  for (const r of rows) {
    const start = ms(r.data.startAt);
    if (start === null) continue;
    const end = r.data.running === true ? null : ms(r.data.endAt);
    const startLocal = utcToZonedInput(new Date(start), tz);
    const job = typeof r.data.jobId === "string" ? jobs.get(r.data.jobId) : undefined;
    const week = mondayOf(startLocal.slice(0, 10));
    lines.push(
      [
        names.get(r.workerId) ?? "",
        startLocal.slice(0, 10),
        r.data.hoursOnly === true ? "" : startLocal.slice(11, 16),
        end === null || r.data.hoursOnly === true ? "" : utcToZonedInput(new Date(end), tz).slice(11, 16),
        end === null ? "" : (Math.round(((end - start) / 3_600_000) * 100) / 100).toFixed(2),
        kindLabelOf(config.timeKinds, String(r.data.kind ?? "")),
        job?.number ?? "",
        job?.title ?? "",
        typeof r.data.internalJobId === "string" ? (internals.get(r.data.internalJobId) ?? "") : "",
        r.data.billable === false ? "No" : "Yes",
        weekStatus.get(`${r.workerId}|${week}`) ?? "open",
        typeof r.data.note === "string" ? r.data.note : "",
      ]
        .map(cell)
        .join(","),
    );
  }
  return { csv: `﻿${lines.join("\r\n")}\r\n`, filename: `timesheets-${input.from}-to-${input.to}.csv` };
}
