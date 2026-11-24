"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { formatServiceAddress } from "@/lib/field-services/address";
import { useFieldData } from "@/components/field-services/field-data";
import { AddressFields, EMPTY_ADDRESS, SELECT_CLASS, addressIsEmpty, callApi } from "@/components/field-services/field-ui";
import type { ServiceAddress } from "@/types/field-services";

/** Where one person's day starts on one date, when it is not their usual start. Routing and planning use it for that day only. */
export function DayStartDialog({ open, day, onClose }: { open: boolean; day: string; onClose: () => void }) {
  const { subAccountId } = useSubAccount();
  const { workers } = useFieldData();
  const people = workers.filter((w) => w.status === "active");
  const [workerId, setWorkerId] = useState("");
  const [address, setAddress] = useState<ServiceAddress>(EMPTY_ADDRESS);
  const [busy, setBusy] = useState(false);

  const worker = people.find((w) => w.id === workerId);
  const special = worker?.startOverrides?.[day];

  useEffect(() => {
    if (!open) return;
    setWorkerId("");
    setAddress(EMPTY_ADDRESS);
  }, [open, day]);

  useEffect(() => {
    setAddress(special ? { ...EMPTY_ADDRESS, ...special.address } : EMPTY_ADDRESS);
  }, [workerId, special]);

  async function save(next: ServiceAddress | null) {
    if (!workerId) return;
    setBusy(true);
    const res = await callApi(`/api/sub-accounts/${subAccountId}/field-services/workers/${workerId}/day-start`, "PATCH", {
      day,
      address: next,
    });
    setBusy(false);
    if (!res) return;
    toast.success(next ? "Start for this day saved." : "Back to their usual start.");
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Where the day starts</DialogTitle>
          <DialogDescription>
            {day}: use a different start for one person on this day only, such as a depot or supplier pick-up. Route suggestions,
            Plan the day and online booking use it for this date.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">Person</Label>
            <select className={SELECT_CLASS} value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
              <option value="">Choose…</option>
              {people.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          {worker && (
            <>
              <p className="text-xs text-muted-foreground">
                Usual start: {worker.homeBase ? formatServiceAddress(worker.homeBase) : "not set"}
                {special ? ". A different start is set for this day." : ""}
              </p>
              <AddressFields value={address} onChange={setAddress} />
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {special && (
            <Button variant="outline" onClick={() => void save(null)} disabled={busy}>
              Use their usual start
            </Button>
          )}
          <Button onClick={() => void save(address)} disabled={busy || !worker || addressIsEmpty(address)}>
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Save for this day
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
