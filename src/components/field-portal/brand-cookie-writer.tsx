"use client";

import { useEffect } from "react";
import { brandCookieName, serializeBrand } from "@/lib/field-portal/brand-cookie";

/** Remembers the business name and logo on this phone for the next launch screen. */
export function BrandCookieWriter({ subAccountId, name, logoUrl }: { subAccountId: string; name: string; logoUrl: string | null }) {
  useEffect(() => {
    if (!name) return;
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${brandCookieName(subAccountId)}=${serializeBrand({ name, logoUrl })}; Path=/field/${subAccountId}; Max-Age=31536000; SameSite=Lax${secure}`;
  }, [subAccountId, name, logoUrl]);
  return null;
}
