import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { listInternalJobs, workerMayUseInternalJob } from "@/lib/server/field-internal-jobs-service";
import type { Job } from "@/types/field-services";

const VISIT_LOOKBACK_DAYS = 120;
const MAX_JOBS = 100;
const MAX_LOOKUP = 400;

export interface TimeTargets {
  jobs: { id: string; number: string; title: string; customer: string; timezone: string; currency: string; timers: boolean; hoursOnly: boolean; activityIds: string[] | null }[];
  internalJobs: { id: string; name: string; timers: boolean }[];
}

/** What a worker may book time to: open jobs they have a visit on, and the internal jobs open to them. */
export async function listTimeTargets(input: {
  subAccountId: string;
  workerId: string;
}): Promise<TimeTargets> {
  const { subAccountId, workerId } = input;
  const db = getAdminDb();
  const since = new Date(Date.now() - VISIT_LOOKBACK_DAYS * 86_400_000);

  const [visits, internal] = await Promise.all([
    db
      .collection("visits")
      .where("subAccountId", "==", subAccountId)
      .where("workerIds", "array-contains", workerId)
      .where("scheduledStart", ">=", since)
      .get(),
    listInternalJobs(subAccountId),
  ]);

  const jobIds = new Set<string>();
  for (const d of visits.docs) {
    const jobId = d.data().jobId as string | undefined;
    if (jobId) jobIds.add(jobId);
  }
  const byId = new Map<string, Job>();
  // Look up more than we show, because closed jobs are dropped afterwards.
  const missing = [...jobIds].filter((id) => !byId.has(id)).slice(0, MAX_LOOKUP);
  if (missing.length > 0) {
    const docs = await db.getAll(...missing.map((id) => db.doc(`jobs/${id}`)));
    for (const d of docs) {
      if (d.exists && d.data()?.subAccountId === subAccountId) {
        byId.set(d.id, { id: d.id, ...d.data() } as Job);
      }
    }
  }

  const jobs = [...byId.values()]
    .filter((j) => j.status !== "closed" && j.status !== "cancelled")
    .sort((a, b) => b.number.localeCompare(a.number))
    .slice(0, MAX_JOBS)
    .map((j) => ({
      id: j.id,
      number: j.number,
      title: j.title,
      customer: j.contactName,
      timezone: j.timezone,
      currency: j.currency,
      timers: j.timersEnabled === true && j.hoursOnly !== true,
      hoursOnly: j.hoursOnly === true,
      activityIds: j.activityIds ?? null,
    }));

  return {
    jobs,
    internalJobs: internal
      .filter((j) => workerMayUseInternalJob(j, workerId))
      .map((j) => ({ id: j.id, name: j.name, timers: j.timersEnabled === true })),
  };
}
