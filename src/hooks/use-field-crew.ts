"use client";

import { fieldServicesAvailable } from "@/lib/field-services/availability";
import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { useAuth } from "@/hooks/use-auth";

export function useIsFieldCrew(subAccountId: string | null): boolean {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const [gateOn, setGateOn] = useState(false);
  const [isWorker, setIsWorker] = useState(false);

  useEffect(() => {
    if (!subAccountId || !uid) {
      setGateOn(false);
      return;
    }
    return onSnapshot(
      doc(getFirebaseDb(), "subAccounts", subAccountId),
      (snap) => setGateOn(fieldServicesAvailable(snap.data())),
      () => setGateOn(false),
    );
  }, [subAccountId, uid]);

  useEffect(() => {
    if (!subAccountId || !uid || !gateOn) {
      setIsWorker(false);
      return;
    }
    return onSnapshot(
      query(
        collection(getFirebaseDb(), "fieldWorkers"),
        where("subAccountId", "==", subAccountId),
        where("memberUid", "==", uid),
      ),
      (snap) => setIsWorker(snap.docs.some((d) => d.data().status === "active" && d.data().kind !== "owner")),
      () => setIsWorker(false),
    );
  }, [subAccountId, uid, gateOn]);

  return gateOn && isWorker;
}
