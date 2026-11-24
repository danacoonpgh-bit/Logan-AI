"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  GitBranch,
  Home,
  Menu,
  MessagesSquare,
  Users,
  Wrench,
} from "lucide-react";
import { useUnreadConversationsCount } from "@/hooks/use-unread-conversations";
import { useIsFieldCrew } from "@/hooks/use-field-crew";
import { cn } from "@/lib/utils";

/**
 * Phone-only bottom tab bar for the core loop (Dashboard, Conversations, Contacts,
 * Pipeline) plus More, which opens the sidebar drawer. Field crew get My day in
 * place of Pipeline. Only inside a sub-account; hidden at md+. The safe-area
 * padding keeps it above the iPhone home indicator.
 */

const TABS = [
  { path: "/dashboard", label: "Home", icon: Home },
  { path: "/conversations", label: "Inbox", icon: MessagesSquare, badge: true },
  { path: "/contacts", label: "Contacts", icon: Users },
  { path: "/pipeline", label: "Pipeline", icon: GitBranch },
] as const;

const CREW_TABS = [
  { path: "/field-services/today", label: "My day", icon: Wrench },
  { path: "/conversations", label: "Inbox", icon: MessagesSquare, badge: true },
  { path: "/contacts", label: "Contacts", icon: Users },
  { path: "/dashboard", label: "Home", icon: Home },
] as const;

export function BottomTabBar({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  // Only rendered inside a sub-account, so take the id from the URL (the unread hook doesn't read context).
  const activeSubId = pathname.match(/^\/sa\/([^/]+)/)?.[1] ?? null;
  const unread = useUnreadConversationsCount(activeSubId);
  const isCrew = useIsFieldCrew(activeSubId);

  if (!activeSubId) return null;
  const subRoot = `/sa/${activeSubId}`;
  const tabs = isCrew ? CREW_TABS : TABS;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <div className="flex h-14 items-stretch">
        {tabs.map((tab) => {
          const href = `${subRoot}${tab.path}`;
          const active =
            tab.path === "/dashboard"
              ? pathname === href || pathname.startsWith(`${href}/`)
              : pathname.startsWith(href);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.path}
              href={href}
              className={cn(
                "relative flex min-w-0 flex-1 touch-manipulation select-none flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors active:opacity-60",
                active ? "text-primary" : "text-muted-foreground",
              )}
            >
              <span className="relative">
                <Icon className="h-6 w-6" />
                {"badge" in tab && tab.badge && unread > 0 && (
                  <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold tabular-nums text-primary-foreground">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </span>
              {tab.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={onMore}
          className="flex min-w-0 flex-1 touch-manipulation select-none flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground transition-colors active:opacity-60"
        >
          <Menu className="h-6 w-6" />
          More
        </button>
      </div>
    </nav>
  );
}
