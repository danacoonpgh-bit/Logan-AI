import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured } from "@/lib/comms/resend";
import {
  smsIsConfigured,
  subAccountTwilioIsConfigured,
} from "@/lib/comms/twilio";
import { qstashIsConfigured } from "@/lib/automations/qstash";
import { pushIsConfigured } from "@/lib/push/config";
import { labourTerm, withArticle, workerTerms } from "@/lib/field-services/terms";
import { hasCardRail } from "@/lib/payments/can-take-payment";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import type { SubAccountDoc } from "@/types/tenancy";

export interface ReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  required: boolean;
  fix: string;
  /** Tab where the step is done. Empty for steps only the deployment owner can do. */
  tab: "workers" | "setup" | "settings" | "booking" | "";
  /** Label for the button that opens that tab. */
  action: string;
}

export async function fieldServicesReadiness(
  subAccountId: string,
): Promise<ReadinessItem[]> {
  const db = getAdminDb();
  const [subSnap, services, areas, workers, config] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get(),
    db
      .collection("products")
      .where("subAccountId", "==", subAccountId)
      .where("kind", "==", "service")
      .where("active", "==", true)
      .count()
      .get(),
    db.collection(`subAccounts/${subAccountId}/serviceAreas`).count().get(),
    db
      .collection("fieldWorkers")
      .where("subAccountId", "==", subAccountId)
      .where("status", "==", "active")
      .count()
      .get(),
    getFieldServicesConfig(subAccountId),
  ]);
  const sub = (subSnap.data() ?? {}) as SubAccountDoc;

  const hasSms =
    subAccountTwilioIsConfigured(sub.twilioConfig) ||
    (smsIsConfigured() && sub.twilioConfig?.enabled !== true);

  const serviceDocs = await db
    .collection("products")
    .where("subAccountId", "==", subAccountId)
    .where("kind", "==", "service")
    .where("active", "==", true)
    .get();
  const messagesOn = serviceDocs.docs.some((d) =>
    Object.values((d.data().customerMessages ?? {}) as Record<string, { enabled?: boolean }>).some((m) => m?.enabled === true),
  );

  const wt = workerTerms(config);
  // A Time & materials service is never bookable online, so it does not count.
  const activeServiceIds = new Set(serviceDocs.docs.filter((d) => d.data().billingType !== "time_and_materials").map((d) => d.id));
  const bookableCount = (config.bookingServiceIds ?? []).filter((id) => activeServiceIds.has(id)).length;
  // Instant booking needs as many people set up for a service as it needs on site at once.
  const crew = (await db.collection("fieldWorkers").where("subAccountId", "==", subAccountId).where("status", "==", "active").get()).docs.map(
    (d) => (d.data().serviceIds ?? []) as string[],
  );
  const understaffed = config.bookingInstant === true
    ? serviceDocs.docs
        .filter((d) => (config.bookingServiceIds ?? []).includes(d.id) && d.data().billingType !== "time_and_materials")
        .map((d) => ({ name: String(d.data().name ?? "A service"), need: Number(d.data().staffRequired) || 1, have: crew.filter((ids) => ids.length === 0 || ids.includes(d.id)).length }))
        .filter((x) => x.need > 1 && x.have < x.need)
    : [];
  return [
    {
      key: "workers",
      label: "Add the people who do the work",
      ok: workers.data().count > 0,
      required: true,
      fix: `Add ${withArticle(wt.worker)} on the ${labourTerm(config)} tab, then add ${wt.workers} who don't have a login by email. Workspace members are added for you, and everyone signs in to the crew app with an emailed code.`,
      tab: "workers",
      action: `Add ${wt.workers}`,
    },
    {
      key: "services",
      label: "Add the services you offer",
      ok: services.data().count > 0,
      required: false,
      fix: "Each service has a price, a length, how it is billed (fixed price or time and materials) and an optional checklist.",
      tab: "setup",
      action: "Add services",
    },
    {
      key: "areas",
      label: "Set where you work",
      ok: areas.data().count > 0,
      required: false,
      fix: "Add the postcodes you cover, with an optional travel fee you can add to an invoice when needed. Without an area nothing is checked against where you work.",
      tab: "setup",
      action: "Add an area",
    },
    {
      key: "messages",
      label: "Choose which updates customers get",
      ok: messagesOn,
      required: false,
      fix: "Open a service and switch on its booked, reminder, on the way or done messages. A project with one service uses that service's messages.",
      tab: "setup",
      action: "Set up messages",
    },
    ...(understaffed.length > 0
      ? [
          {
            key: "staffing",
            label: "Enough people for online booking",
            ok: false,
            required: false,
            fix: `${understaffed.map((x) => `${x.name} needs ${x.need} people but only ${x.have} ${x.have === 1 ? "is" : "are"} set up for it`).join("; ")}. Customers see no times for it until more people do the service.`,
            tab: "workers" as const,
            action: "Check staff",
          },
        ]
      : []),
    {
      key: "booking",
      label: "Turn on online booking",
      ok: config.onlineBookingEnabled === true && bookableCount > 0,
      required: false,
      fix: "Let customers send a request from your own booking page. Switch on Bookable online for each service it offers (open a service on the Services & areas tab).",
      tab: "booking",
      action: "Set up booking",
    },
    {
      key: "stripe",
      label: "Connect card payments",
      ok: hasCardRail(sub),
      required: false,
      fix: "Connect Stripe under Settings, Payments so invoices can be paid by card.",
      tab: "",
      action: "",
    },
    {
      key: "sms",
      label: "Set up text messages",
      ok: hasSms,
      required: false,
      fix: "Set up SMS under Settings, SMS to text customers visit updates.",
      tab: "",
      action: "",
    },
    {
      key: "email",
      label: "Email can be sent",
      ok: emailIsConfigured(),
      required: false,
      fix: "Ask whoever runs the deployment to set up email sending.",
      tab: "",
      action: "",
    },
    {
      key: "qstash",
      label: "Reminders and background jobs available",
      ok: qstashIsConfigured(),
      required: true,
      fix: "Ask whoever runs the deployment to configure QStash.",
      tab: "",
      action: "",
    },
    {
      key: "push",
      label: "Push notifications available",
      ok: pushIsConfigured(),
      required: false,
      fix: "Ask whoever runs the deployment to set the push (VAPID) keys.",
      tab: "",
      action: "",
    },
  ];
}
