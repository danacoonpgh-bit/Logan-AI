"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Wrench } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { getUserDoc, updateUserDoc } from "@/lib/firestore/users";
import { openCrispChat } from "@/lib/crisp";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const LOCAL_KEY = "field-services-beta-ack";
const CHAT_ON = !!process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID;

function readLocal(uid: string): boolean {
  try {
    return localStorage.getItem(`${LOCAL_KEY}:${uid}`) === "1";
  } catch {
    return false;
  }
}

/**
 * The Field Services card on the Labs page, with a one-time beta notice. The answer is kept on the person's
 * users/{uid} doc, with a browser copy in case that write fails.
 */
export function FieldServicesLabsCard({ href }: { href: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const [acknowledged, setAcknowledged] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (readLocal(user.uid)) {
      setAcknowledged(true);
      return;
    }
    let cancelled = false;
    getUserDoc(user.uid)
      .then((doc) => {
        if (!cancelled && doc?.fieldServicesBetaAcknowledged === true) setAcknowledged(true);
      })
      .catch(() => {
        // Unreadable user doc: the notice shows again, which is harmless.
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  function confirm() {
    setAcknowledged(true);
    if (user) {
      try {
        localStorage.setItem(`${LOCAL_KEY}:${user.uid}`, "1");
      } catch {
        // Storage unavailable; the user doc still records it.
      }
      void updateUserDoc(user.uid, { fieldServicesBetaAcknowledged: true }).catch(() => {
        // Best effort; the browser copy stops a repeat on this device.
      });
    }
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <Link
        href={href}
        onClick={(e) => {
          if (acknowledged) return;
          e.preventDefault();
          setOpen(true);
        }}
        className="flex items-start gap-4 rounded-2xl border bg-card p-6 transition-colors hover:bg-muted/40"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600 dark:text-orange-400">
          <Wrench className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Field Services</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Requests, jobs and scheduled visits for crews that go to the customer, with
            workers, service areas, time, parts, photos and on-site payments.
            Pre-release, feedback welcome: once it is fully supported it moves to the main menu.
          </p>
        </div>
        <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
      </Link>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Field Services is in beta
              <span className="rounded-full bg-lime-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-lime-600 dark:text-lime-400">
                Labs
              </span>
            </DialogTitle>
            <DialogDescription>
              Field Services is a Labs feature and is still being tested. It works, but you may
              find bugs, and parts of it may change before it moves to the main menu.
            </DialogDescription>
          </DialogHeader>

          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>Check anything that involves money, such as invoices and card payments, before you rely on it.</li>
            <li>
              If something looks wrong, please report it
              {CHAT_ON ? (
                <>
                  {" "}
                  through the{" "}
                  <button
                    type="button"
                    onClick={() => openCrispChat()}
                    className="font-medium text-foreground underline underline-offset-2"
                  >
                    chat
                  </button>{" "}
                  in the bottom corner
                </>
              ) : (
                <> to your agency</>
              )}
              , or send us a Loom showing what happened.
            </li>
          </ul>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Not now
            </Button>
            <Button onClick={confirm}>I understand, open Field Services</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
