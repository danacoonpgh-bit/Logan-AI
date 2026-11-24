"use client";

import { useMemo } from "react";
import { useSubAccount } from "@/context/sub-account-context";
import { useFieldData } from "@/components/field-services/field-data";
import { RateCardsSection } from "@/components/field-services/rate-cards-section";
import { useFieldConfig, useRateCards } from "@/components/field-services/timesheets-ui";

/** Rate cards on their own tab. Rates are admin-only, so others see a note. */
export function RateCardsTab() {
  const { isAdmin } = useSubAccount();
  const { config } = useFieldConfig();
  const { workers } = useFieldData();
  const enabled = isAdmin && config?.timesheetsEnabled === true;
  const cards = useRateCards(enabled);

  const workerCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const w of workers) {
      if (w.status === "active" && w.rateCardId) counts[w.rateCardId] = (counts[w.rateCardId] ?? 0) + 1;
    }
    return counts;
  }, [workers]);

  if (!isAdmin) {
    return (
      <section className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
        Only admins can see rate cards.
      </section>
    );
  }
  if (config && config.timesheetsEnabled !== true) {
    return (
      <section className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
        Rate cards are part of timesheets. Turn timesheets on in Settings first.
      </section>
    );
  }
  return (
    <RateCardsSection
      cards={cards.cards}
      loaded={cards.loaded && config !== null}
      workerCounts={workerCounts}
      onChanged={cards.reload}
    />
  );
}
