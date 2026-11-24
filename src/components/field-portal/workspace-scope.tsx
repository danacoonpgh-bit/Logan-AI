"use client";

import { useState } from "react";

let current = "";
let installed = false;

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);
  // Every crew app call says which business it is for. The sign-in cookie is still what proves who is asking.
  window.fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const target = new URL(raw, window.location.href);
    if (!current || target.origin !== window.location.origin || !target.pathname.startsWith("/api/field-portal")) {
      return original(input, init);
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("x-field-sa", current);
    return original(input, { ...init, headers });
  };
}

/** Wraps one business's crew app so its calls carry that business. Set during the first render, before children fetch. */
export function WorkspaceScope({ subAccountId, children }: { subAccountId: string; children: React.ReactNode }) {
  useState(() => {
    current = subAccountId;
    install();
    return null;
  });
  current = subAccountId;
  return <>{children}</>;
}
