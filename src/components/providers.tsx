"use client";

import { ThemeProvider, useTheme } from "next-themes";
import { Toaster } from "sonner";
import { AuthProvider } from "@/context/auth-context";

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      position="top-right"
      offset={{ top: "calc(env(safe-area-inset-top) + 16px)" }}
      mobileOffset={{ top: "calc(env(safe-area-inset-top) + 16px)" }}
      richColors
      closeButton
      theme={resolvedTheme === "dark" ? "dark" : "light"}
    />
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <AuthProvider>
        {children}
        <ThemedToaster />
      </AuthProvider>
    </ThemeProvider>
  );
}
