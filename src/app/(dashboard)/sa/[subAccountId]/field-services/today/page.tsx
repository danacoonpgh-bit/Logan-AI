"use client";

import { fieldServicesAvailable } from "@/lib/field-services/availability";
import { Lock } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { CrewTime } from "@/components/field-services/crew-time";
import { TodayView } from "@/components/field-services/today-view";

export default function FieldTodayPage() {
  const { subAccountId, subAccount } = useSubAccount();

  if (!fieldServicesAvailable(subAccount)) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <section className="rounded-2xl border bg-card p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Lock className="h-4 w-4" />
            </span>
            <p className="text-sm text-muted-foreground">
              Field Services is a Labs feature and is locked for this sub-account. Ask your
              agency owner to turn on Labs, then Field Services.
            </p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        Today
        <span className="rounded-full bg-lime-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-lime-600 dark:text-lime-400">
          Labs · Pre-release
        </span>
      </h1>
      <CrewTime endpoint={`/api/sub-accounts/${subAccountId}/field-services/my-time`} heading="Time" />
      <TodayView endpoint={`/api/sub-accounts/${subAccountId}/field-services/today`} />
    </div>
  );
}
