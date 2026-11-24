"use client";

import { useCallback, useEffect, useState } from "react";
import { useSubAccount } from "@/context/sub-account-context";
import { SELECT_CLASS } from "@/components/field-services/field-ui";
import {
  BILLING_TYPE_LABELS,
  SELECTABLE_BILLING_TYPES,
  type FieldServicesConfig,
  type JobBillingType,
  type RateCard,
} from "@/types/field-services";
import type { JobTerms } from "@/lib/field-services/terms";

export function billingTypeHints(t: JobTerms): Record<JobBillingType, string> {
  return {
    time_and_materials:
      "Logged time is billed at each worker's hourly rate, never more than their day rate for one day.",
    day_rate: `Billed by the day. This type is no longer offered.`,
    lump_sum: `The price is the ${t.job}'s lines. Time is tracked but never added to the invoice.`,
  };
}

export function useFieldConfig(): { config: FieldServicesConfig | null; reload: () => void } {
  const { subAccountId } = useSubAccount();
  const [config, setConfig] = useState<FieldServicesConfig | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sub-accounts/${subAccountId}/field-services/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { config?: FieldServicesConfig } | null) => {
        if (!cancelled && d?.config) setConfig(d.config);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [subAccountId, tick]);

  return { config, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/** Rate cards carry rates, so only the office can load them; others get an empty list. */
export function useRateCards(enabled: boolean): { cards: RateCard[]; loaded: boolean; reload: () => void } {
  const { subAccountId } = useSubAccount();
  const [cards, setCards] = useState<RateCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setCards([]);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    fetch(`/api/sub-accounts/${subAccountId}/field-services/rate-cards`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { cards?: RateCard[] } | null) => {
        if (cancelled) return;
        setCards(d?.cards ?? []);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [subAccountId, enabled, tick]);

  return { cards, loaded, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export function BillingTypeSelect({
  value,
  onChange,
  disabled,
  className,
  onInternal,
}: {
  value: JobBillingType;
  onChange: (v: JobBillingType) => void;
  disabled?: boolean;
  className?: string;
  /** When given, an Internal choice is listed. It has no customer, so the caller opens the internal project form. */
  onInternal?: () => void;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value === "internal") onInternal?.();
        else onChange(e.target.value as JobBillingType);
      }}
      className={className ?? SELECT_CLASS}
    >
      {SELECTABLE_BILLING_TYPES.map((t) => (
        <option key={t} value={t}>
          {BILLING_TYPE_LABELS[t]}
        </option>
      ))}
      {onInternal && <option value="internal">Internal</option>}
    </select>
  );
}
