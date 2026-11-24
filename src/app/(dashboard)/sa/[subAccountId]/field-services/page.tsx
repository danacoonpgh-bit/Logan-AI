"use client";

import { fieldServicesAvailable } from "@/lib/field-services/availability";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Lock, Wrench } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FieldDataProvider, useFieldData } from "@/components/field-services/field-data";
import { FirstJobPrompt } from "@/components/field-services/feedback";
import { JobDetailDialog } from "@/components/field-services/job-detail-dialog";
import { FieldDashboardTab } from "@/components/field-services/field-dashboard-tab";
import { GatedTab, GuidedSetupBanner, GuidedSetupProvider, HideWhileGuided } from "@/components/field-services/guided-setup";
import { JobsTab, type Filter as JobsFilter } from "@/components/field-services/jobs-tab";
import { RateCardsTab } from "@/components/field-services/rate-cards-tab";
import { SetupGuidePanel, useSetupItems } from "@/components/field-services/readiness-tab";
import { ReportsTab } from "@/components/field-services/reports-tab";
import { RequestsTab } from "@/components/field-services/requests-tab";
import { ScheduleTab } from "@/components/field-services/schedule-tab";
import { SettingsTab } from "@/components/field-services/settings-tab";
import { CustomerPortalTab, OnlineBookingTab } from "@/components/field-services/online-pages-tab";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { jobTerms, labourTerm } from "@/lib/field-services/terms";
import { applyClock24 } from "@/lib/field-services/time";
import { ServicesAreasTab } from "@/components/field-services/services-areas-tab";
import { TimesheetsTab, WorkerActivityTab } from "@/components/field-services/timesheets-tab";
import { WorkersTab } from "@/components/field-services/workers-tab";

type TabId = "home" | "requests" | "jobs" | "schedule" | "workers" | "activity" | "timesheets" | "reports" | "setup" | "settings" | "rates" | "booking" | "portal";

/** Only shown while a request is still open, for example one that could not become a job on its own. */
function RequestsTrigger() {
  const { requests } = useFieldData();
  const open = requests.filter((r) => r.status === "new" || r.status === "action_required").length;
  return open > 0 ? <TabsTrigger value="requests">Requests ({open})</TabsTrigger> : null;
}

export default function FieldServicesPage() {
  const { subAccount, subAccountId, isAdmin } = useSubAccount();
  const [tab, setTab] = useState<TabId>("home");
  const [jobsFilter, setJobsFilter] = useState<JobsFilter>("active");
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const { config, reload } = useFieldConfig();
  applyClock24(config?.use24HourTime);
  // The pipeline's Create project shortcut lands on the projects list with the deal chosen.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("newProject")) setTab("jobs");
  }, []);
  const terms = jobTerms(config);
  const labour = labourTerm(config);
  const timesheetsOn = config?.timesheetsEnabled === true;

  const available = fieldServicesAvailable(subAccount);
  const guideOn = available && isAdmin && config !== null && config.setupGuideEnabled !== false;
  const setup = useSetupItems(guideOn);
  const { load: reloadSetup } = setup;
  const hasItems = setup.items !== null;
  // Every workspace member is field staff by default; this fills in anyone who is missing.
  useEffect(() => {
    if (!available || !isAdmin) return;
    void fetch(`/api/sub-accounts/${subAccountId}/field-services/workers/sync`, { method: "POST" }).catch(() => {});
  }, [available, isAdmin, subAccountId]);
  const goTo = (t: TabId) => setTab(t);
  const openTab = useCallback((t: string) => setTab(t as TabId), []);
  const closeGuide = async () => {
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/field-services/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setupGuideEnabled: false }),
      });
      if (!res.ok) throw new Error("bad status");
      reload();
    } catch {
      toast.error("Couldn't close the setup guide. Try again.");
    }
  };
  // Coming back from another tab, the steps may have changed.
  const shownTab = useRef(tab);
  useEffect(() => {
    if (shownTab.current === tab) return;
    shownTab.current = tab;
    if (guideOn && hasItems) void reloadSetup();
  }, [tab, guideOn, hasItems, reloadSetup]);

  if (!fieldServicesAvailable(subAccount)) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <section className="rounded-2xl border bg-card p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Lock className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold">Field Services</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Field Services is a Labs feature and is locked for this
                sub-account. Ask your agency owner to turn on Labs, then Field
                Services, from the sub-account&apos;s Manage panel.
              </p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header className="flex items-start gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500/15 via-amber-500/15 to-yellow-500/15 text-orange-600 dark:text-orange-400">
          <Wrench className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            Field Services
            <span className="rounded-full bg-lime-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-lime-600 dark:text-lime-400">
              Labs · Pre-release
            </span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {terms.Jobs} and scheduled visits for crews that go to the
            customer. Add your workers, services and areas first, then add
            {" "}{terms.jobs} and schedule the work.
          </p>
        </div>
      </header>

      <FieldDataProvider>
        <GuidedSetupProvider config={config} reload={reload} isAdmin={isAdmin} onTab={openTab}>
        <GuidedSetupBanner />
        <FirstJobPrompt />
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as TabId)}
        >
          <TabsList>
            <GatedTab value="home">Home</GatedTab>
            <RequestsTrigger />
            <GatedTab value="jobs">{terms.Jobs}</GatedTab>
            <GatedTab value="setup">Services &amp; areas</GatedTab>
            <GatedTab value="schedule">Schedule</GatedTab>
            {timesheetsOn && <GatedTab value="timesheets">Timesheets</GatedTab>}
            {timesheetsOn && <GatedTab value="activity">{labour} activity</GatedTab>}
            <GatedTab value="reports">Reports</GatedTab>
            <span aria-hidden className="mx-1 h-5 w-px self-center bg-border" />
            <GatedTab value="workers">{labour}</GatedTab>
            {isAdmin && timesheetsOn && <GatedTab value="rates">Rate cards</GatedTab>}
            <GatedTab value="booking">Online booking</GatedTab>
            <GatedTab value="portal">Customer portal</GatedTab>
            <GatedTab value="settings">Settings</GatedTab>
          </TabsList>
          <TabsContent value="home" className="mt-4">
            <FieldDashboardTab
              onGoJobs={(f) => {
                setJobsFilter(f);
                setTab("jobs");
              }}
              onGoTab={(t) => setTab(t)}
            />
          </TabsContent>
          <TabsContent value="requests" className="mt-4">
            <RequestsTab onOpenJob={setOpenJobId} />
          </TabsContent>
          <TabsContent value="jobs" className="mt-4">
            <JobsTab onOpenJob={setOpenJobId} initialFilter={jobsFilter} />
          </TabsContent>
          <TabsContent value="schedule" className="mt-4">
            <ScheduleTab onOpenJob={setOpenJobId} />
          </TabsContent>
          <TabsContent value="workers" className="mt-4">
            <WorkersTab />
          </TabsContent>
          <TabsContent value="rates" className="mt-4">
            <RateCardsTab />
          </TabsContent>
          <TabsContent value="activity" className="mt-4">
            <WorkerActivityTab />
          </TabsContent>
          <TabsContent value="timesheets" className="mt-4">
            <TimesheetsTab />
          </TabsContent>
          <TabsContent value="reports" className="mt-4">
            <ReportsTab />
          </TabsContent>
          <TabsContent value="setup" className="mt-4">
            <ServicesAreasTab />
          </TabsContent>
          <TabsContent value="booking" className="mt-4">
            <OnlineBookingTab />
          </TabsContent>
          <TabsContent value="portal" className="mt-4">
            <CustomerPortalTab />
          </TabsContent>
          <TabsContent value="settings" className="mt-4">
            <SettingsTab onSaved={reload} />
          </TabsContent>
        </Tabs>
        <JobDetailDialog jobId={openJobId} onClose={() => setOpenJobId(null)} />
        {guideOn && (
          <HideWhileGuided>
            <SetupGuidePanel
              items={setup.items}
              failed={setup.failed}
              refreshing={setup.refreshing}
              onReload={() => void reloadSetup()}
              onGo={goTo}
              onClose={() => void closeGuide()}
            />
          </HideWhileGuided>
        )}
        </GuidedSetupProvider>
      </FieldDataProvider>
    </div>
  );
}
