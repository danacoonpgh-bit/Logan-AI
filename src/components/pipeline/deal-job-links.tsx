"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useSubAccount } from "@/context/sub-account-context";
import { useEffectiveTerritoryFilter } from "@/hooks/use-effective-territory-filter";
import { fieldServicesAvailable } from "@/lib/field-services/availability";
import { subscribeToJobs } from "@/lib/firestore/field-services";

/** The Field Services project each pipeline deal is linked to, by deal id. */
const DealJobLinks = createContext<Map<string, { number: string }>>(new Map());

export function DealJobLinksProvider({ children }: { children: React.ReactNode }) {
  const { subAccount, subAccountId } = useSubAccount();
  const { filter, ready } = useEffectiveTerritoryFilter();
  const [links, setLinks] = useState<Map<string, { number: string }>>(new Map());
  const on = fieldServicesAvailable(subAccount);

  useEffect(() => {
    if (!on || !ready) return;
    return subscribeToJobs(
      subAccountId,
      filter,
      (jobs) => {
        const next = new Map<string, { number: string }>();
        for (const j of jobs) if (j.dealId && j.status !== "cancelled") next.set(j.dealId, { number: j.number });
        setLinks(next);
      },
      () => {},
    );
  }, [on, ready, filter, subAccountId]);

  const value = useMemo(() => links, [links]);
  return <DealJobLinks.Provider value={value}>{children}</DealJobLinks.Provider>;
}

export function useDealProjectNumber(dealId: string): string | null {
  return useContext(DealJobLinks).get(dealId)?.number ?? null;
}
