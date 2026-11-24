"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";

/** My day belongs to one workspace, so this old address hands over to the person's own. */
export default function MyFieldTodayPage() {
  const router = useRouter();
  const { memberships, membershipsLoaded } = useAuth();

  useEffect(() => {
    if (!membershipsLoaded) return;
    const first = memberships[0];
    router.replace(first ? `/sa/${first.subAccountId}/field-services/today` : "/agency");
  }, [membershipsLoaded, memberships, router]);

  return <p className="text-sm text-muted-foreground">Opening your day…</p>;
}
