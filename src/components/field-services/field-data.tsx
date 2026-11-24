"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSubAccount } from "@/context/sub-account-context";
import { useEffectiveTerritoryFilter } from "@/hooks/use-effective-territory-filter";
import { subscribeToContacts } from "@/lib/firestore/contacts";
import {
  subscribeToFieldWorkers,
  subscribeToJobs,
  subscribeToServiceAreas,
  subscribeToServiceRequests,
  subscribeToServices,
  subscribeToVisits,
} from "@/lib/firestore/field-services";
import type { Contact } from "@/types/contacts";
import type { Product } from "@/types/products";
import type {
  FieldWorker,
  Job,
  ServiceArea,
  ServiceRequest,
  Visit,
} from "@/types/field-services";

interface FieldData {
  contacts: Contact[];
  workers: FieldWorker[];
  areas: ServiceArea[];
  services: Product[];
  requests: ServiceRequest[];
  jobs: Job[];
  visits: Visit[];
  loaded: boolean;
}

const Ctx = createContext<FieldData | null>(null);

export function FieldDataProvider({ children }: { children: ReactNode }) {
  const { subAccountId, subAccount } = useSubAccount();
  const agencyId = subAccount?.agencyId ?? "";
  const { ready, filter } = useEffectiveTerritoryFilter();
  const filterKey = filter ? filter.join(",") : "";

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [workers, setWorkers] = useState<FieldWorker[]>([]);
  const [areas, setAreas] = useState<ServiceArea[]>([]);
  const [services, setServices] = useState<Product[]>([]);
  const [requests, setRequests] = useState<ServiceRequest[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!ready || !agencyId) return;
    const f = filter;
    const unsubs = [
      subscribeToContacts({ agencyId, subAccountId }, { territoryFilter: f }, setContacts),
      subscribeToFieldWorkers(subAccountId, setWorkers),
      subscribeToServiceAreas(subAccountId, setAreas),
      subscribeToServices(subAccountId, setServices),
      subscribeToServiceRequests(subAccountId, f, setRequests),
      subscribeToJobs(subAccountId, f, setJobs),
      subscribeToVisits(subAccountId, f, (rows) => {
        setVisits(rows);
        setLoaded(true);
      }),
    ];
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, subAccountId, agencyId, filterKey]);

  const value = useMemo(
    () => ({ contacts, workers, areas, services, requests, jobs, visits, loaded }),
    [contacts, workers, areas, services, requests, jobs, visits, loaded],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFieldData(): FieldData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useFieldData must be used inside FieldDataProvider");
  return v;
}
