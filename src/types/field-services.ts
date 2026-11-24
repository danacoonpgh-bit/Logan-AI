import type { Timestamp, FieldValue } from "firebase/firestore";
import type { RecurrenceConfig } from "@/lib/field-services/recurrence";

/** Money is integer minor units. All writes go through server services; rules allow member reads only. */

type Ts = Timestamp | FieldValue | Date | null;

export interface ServiceAddress {
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postcode: string;
  country: string;
  lat?: number | null;
  lng?: number | null;
  geocodeStatus?: "not_requested";
}

/** One working stretch in a day, "HH:MM" in the workspace's time zone. */
export interface DayHours {
  start: string;
  end: string;
}

/** Null for a day off. */
export type WeeklyHours = Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", DayHours | null>;

/** One kind of time a workspace offers on a project, such as Driving. Archived ones keep their name on older entries. */
export interface TimeKindDef {
  id: string;
  label: string;
  /** Time of this kind is billable to the customer by default. */
  billable: boolean;
  /** New projects start with this activity ticked. */
  projectDefault?: boolean;
  archived?: boolean;
}

/** Whole days away, such as leave. Both ends are YYYY-MM-DD and included. */
export interface TimeOff {
  start: string;
  end: string;
  note?: string;
}

export type FieldWorkerKind = "owner" | "employee" | "contractor";
export type FieldWorkerStatus = "active" | "removed";

/** Per-business crew profile. Pay rates live in fieldWorkerPrivate, never here. */
export interface FieldWorker {
  id: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  memberUid: string;
  name: string;
  kind: FieldWorkerKind;
  phone: string;
  email: string;
  color: string;
  status: FieldWorkerStatus;
  /** Whether the worker may see cost and price on parts. */
  canHandlePrices: boolean;
  /** Whether the worker may see the customer's phone and email. */
  canSeeCustomerContact: boolean;
  /** Rate card used to price this worker's time on invoices. Only an id, so it is safe for members to read. */
  rateCardId?: string | null;
  /** Whether this person can use the crew app (phone and desktop). Absent means yes. */
  crewAccess?: boolean;
  /** Where this person's day starts, for route suggestions. */
  homeBase?: ServiceAddress | null;
  /** The map point for homeBase, found when it was saved. */
  homeBasePoint?: { lat: number; lng: number } | null;
  /** A different start for one date (YYYY-MM-DD), such as a depot pick-up. Routing and planning use it for that day only. */
  startOverrides?: Record<string, { address: ServiceAddress; point: { lat: number; lng: number } | null }>;
  /** Usual weekly hours. Absent reads as the default week. */
  workingHours?: WeeklyHours | null;
  /** Most visits this person should be given in one day. Absent or null means no limit. */
  maxVisitsPerDay?: number | null;
  /** Days the worker is away. Treated as a day off on the schedule. */
  timeOff?: TimeOff[];
  /** Services this worker does. Empty or absent means all of them. */
  serviceIds?: string[];
  /** Service areas this worker covers. Empty or absent means all of them. */
  areaIds?: string[];
  /** Set for crew who sign in through the field portal instead of a workspace login. */
  personId?: string | null;
  portalStatus?: "none" | "invited" | "active" | "revoked";
  createdAt: Ts;
  updatedAt: Ts;
}

export type ServiceAreaType = "zip" | "radius";

export interface ServiceArea {
  id: string;
  name: string;
  type: ServiceAreaType;
  /** Exact codes, or prefixes for UK outward codes and Canadian FSAs. Normalised. Empty for a radius area. */
  postcodes: string[];
  /** Radius areas: the point the distance is measured from, and how far it reaches. */
  center?: { lat: number; lng: number; label: string };
  radiusKm?: number;
  /** The unit the admin typed the radius in, for showing it back. */
  radiusUnit?: "km" | "mi";
  travelFeeCents?: number | null;
  createdByUid: string;
  createdAt: Ts;
  updatedAt: Ts;
}

export type OutOfAreaPolicy = "flag" | "block";

/** How a job's logged time reaches the invoice. Absent on a job reads as time_and_materials. */
export type JobBillingType = "time_and_materials" | "day_rate" | "lump_sum";

export const SELECTABLE_BILLING_TYPES: JobBillingType[] = ["time_and_materials", "lump_sum"];

export const BILLING_TYPE_LABELS: Record<JobBillingType, string> = {
  time_and_materials: "Time & materials",
  day_rate: "Day rate",
  lump_sum: "Fixed price",
};

/** An optional extra a customer can tick when booking a service. One shared list per workspace. */
export interface FieldAddOn {
  id: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  name: string;
  priceMinor: number;
  extraMinutes: number;
  /** Goes with every service. When off, only the services in serviceIds. */
  allServices: boolean;
  serviceIds: string[];
  active: boolean;
  createdAt: Ts;
  updatedAt: Ts;
}

/** The tax a booking was made at, kept on the job so a later rate change leaves it alone. */
export interface JobTax {
  name: string;
  percent: number;
  inclusive: boolean;
}

/** What a role is charged out at. Stored server-only, so rates never reach crew by accident. */
export interface RateCard {
  id: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  name: string;
  currency: string;
  hourlyRateMinor: number;
  dayRateMinor: number | null;
  archived: boolean;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface FieldServicesConfig {
  outOfAreaPolicy: OutOfAreaPolicy;
  /** Accept new requests from forms and conversations. */
  requestIntake: boolean;
  timerMaxHours: number;
  timerStopOnComplete: boolean;
  /** Send the Google review request when a job is completed (needs Google reviews set up in Settings). */
  reviewRequestsEnabled: boolean;
  /** Hold the review request until the linked invoice is paid. */
  reviewWaitsForPayment: boolean;
  notifyScheduled: boolean;
  notifyReminder: boolean;
  notifyOnMyWay: boolean;
  notifyCompleted: boolean;
  /** Add the customer's status link to booked, reminder, on-the-way and done messages. */
  statusLinkInMessages: boolean;
  /** Shows the setup guide panel to admins. Turning it off closes the panel. */
  setupGuideEnabled: boolean;
  /** Guided setup for a workspace that started from nothing: it began, the staff step is done, the booking step is done, or it was switched off. */
  guidedSetupStarted: boolean;
  guidedSetupStaffDone: boolean;
  guidedSetupBookingDone: boolean;
  guidedSetupSkipped: boolean;
  /** Show times as 14:30 instead of 2:30 PM on the crew and office screens. */
  use24HourTime: boolean;
  /** Crew can clock in and out for the day. Off by default; they enter hours instead. */
  dayClockEnabled: boolean;
  /** The kinds of time crew can pick on a project. */
  timeKinds: TimeKindDef[];
  /** The one currency for all Field Services money. Absent until the workspace chooses it. */
  currency?: string;
  /** Last hourly rate used when billing time, in minor units. */
  labourRateMinor: number | null;
  /** Rate cards and billing types. Off means invoices bill time at the single rate above. */
  timesheetsEnabled: boolean;
  /** Set the first time timesheets are switched on. Time in earlier weeks bills without approval. */
  timesheetsFirstEnabledAt?: Ts;
  /** Billing type given to new jobs while timesheets are on. */
  defaultBillingType: JobBillingType;
  photoStorageCapMb: number;
  /** The workspace's own word for a job, such as Project, and its plural. */
  jobWord: string;
  jobWordPlural: string;
  /** Name of the Labour tab (and its activity tab), for example Crew or Staff. */
  labourWord: string;
  /** What the kind of time on a project is called, for example Activity or Work type. */
  activityWord: string;
  /** The workspace's own word for the people who do the work, such as Staff, and its plural. */
  workerWord: string;
  workerWordPlural: string;
  /** Shortest time entry a worker may save, in minutes. Shorter timers are dropped. */
  minEntryMinutes: number;
  /** Most hours a worker may log in one day. The office can add more. */
  maxDayHours: number;
  /** Days after sending that an invoice from a project is due. Zero is on receipt, null is no date. */
  invoiceDueDays: number | null;
  /** Colour presets for the timesheet Submit and Unlock buttons. */
  submitButtonColor: string;
  unlockButtonColor: string;
  /** The public booking page where customers send a request. Off until turned on. */
  onlineBookingEnabled: boolean;
  /** The services customers can pick on the booking page. */
  bookingServiceIds: string[];
  /** Ask for a preferred date and time of day. */
  bookingAskWhen: boolean;
  /** How crew are told when their phone has no alert on: by email (default) or a text first. */
  crewAlertChannel: "email" | "sms";
  /** Customers may pay a deposit by card when booking (needs card payments). Off until switched on. */
  bookingDepositEnabled: boolean;
  /** Customers may pay the whole price by card when booking. */
  bookingPayInFull: boolean;
  /** Customers may choose to pay in person. Also the fallback when no card option can be offered. */
  bookingPayInPerson: boolean;
  /** The workspace's one tax rate, named for the customer (GST, VAT, Sales tax). 0 means no tax. */
  taxName: string;
  taxPercent: number;
  /** Service prices already include the tax. Off means tax is added on top. */
  pricesIncludeTax: boolean;
  /** The default deposit as a percentage of the service price. A service can set its own. */
  bookingDepositPercent: number;
  /** Cancellation and refund wording shown beside the deposit on the booking page. */
  bookingRefundPolicy: string;
  /** A footer on the booking page with the business name and details. On unless switched off. */
  bookingFooterEnabled: boolean;
  /** Which business details the footer shows: name, address, phone, email, website. */
  bookingFooterFields: string[];
  /** Offers a Suggest route button on the Schedule day view. Only turns on while the setup checks pass. */
  routeSuggestionsEnabled: boolean;
  /** Days from today (1 to 14) that route suggestions and day planning leave alone; those days are changed by hand. */
  routeLeadDays: number;
  /** How far ahead route suggestions, day planning and staff balancing work: 7, 14, 21 or 28 days from today. */
  routeMaxDays: number;
  /** Online booking offers only the times that fit each person's route. Needs route suggestions on. */
  routeAwareSlots: boolean;
  /** Route planning counts the drive back to each person's start address at the end of the day. */
  routeReturnToBase: boolean;
  /** The booking page takes one service per booking. */
  bookingSingleService: boolean;
  /** Customers pick an open time and the booking is made straight away. Implies one service per booking. */
  bookingInstant: boolean;
  /** Furthest a customer may ask for a date on the booking page: 30, 60 or 90 days. */
  bookingMaxDays: number;
  /** Customers can cancel or move a visit themselves until this many hours before it. 0 turns it off. */
  customerChangeHours: number;
  /** The categories a service can be put in. Default is always first and cannot be removed. */
  serviceCategories: string[];
  bookingIntro: string;
  /** Name shown on the customer portal. Empty uses the workspace name. */
  portalName: string;
  bookingDoneMessage: string;
  /** Hex colour for the booking page, or empty for the default. */
  bookingAccent: string;
  /** Look of the booking page and customer portal: light, dark, or follow the visitor's device. */
  bookingTheme: "light" | "dark" | "auto";
  /** Design direction for the booking page and portal: fonts, corners and surfaces (`booking-styles.ts`). Empty or unknown is the standard look. */
  bookingStyle?: string;
  /** Each booking request also adds a deal to the pipeline. */
  bookingCreateDeal: boolean;
  /** Pipeline and stage for that deal. "default" is the default pipeline. */
  bookingDealPipelineId: string;
  bookingDealStageId: string;
  /** Customers who have made a request can sign in with a code to see their requests and projects. */
  customerPortalEnabled: boolean;
  /** A second booking page styled to match a built website. The standard page is never touched. */
  siteBooking?: SiteBooking | null;
  updatedAt?: Ts;
}

export interface SiteBooking {
  websiteId: string;
  websiteName: string;
  /** The website's live address, once it has published. */
  siteUrl: string | null;
  accent: string;
  theme: "light" | "dark" | "auto";
  /** Design direction, as `bookingStyle`. */
  style?: string;
  /** Changed by hand, so a rebuild leaves the look alone. */
  lookEdited: boolean;
}

export const DEFAULT_FIELD_SERVICES_CONFIG: FieldServicesConfig = {
  outOfAreaPolicy: "flag",
  requestIntake: true,
  timerMaxHours: 12,
  timerStopOnComplete: true,
  reviewRequestsEnabled: false,
  reviewWaitsForPayment: true,
  // Off until turned on, so enabling Field Services never texts customers by itself.
  notifyScheduled: false,
  notifyReminder: false,
  notifyOnMyWay: false,
  notifyCompleted: false,
  statusLinkInMessages: true,
  setupGuideEnabled: true,
  guidedSetupStarted: false,
  guidedSetupStaffDone: false,
  guidedSetupBookingDone: false,
  guidedSetupSkipped: false,
  dayClockEnabled: false,
  use24HourTime: false,
  timeKinds: [
    { id: "travel", label: "Driving", billable: true },
    { id: "admin", label: "Admin", billable: false },
    { id: "general", label: "General", billable: false },
  ],
  labourRateMinor: null,
  timesheetsEnabled: false,
  defaultBillingType: "time_and_materials",
  photoStorageCapMb: 2048,
  jobWord: "Job",
  jobWordPlural: "Jobs",
  labourWord: "Labour",
  activityWord: "Activity",
  workerWord: "Worker",
  workerWordPlural: "Workers",
  minEntryMinutes: 10,
  maxDayHours: 10,
  invoiceDueDays: 7,
  submitButtonColor: "default",
  unlockButtonColor: "default",
  onlineBookingEnabled: false,
  bookingServiceIds: [],
  bookingAskWhen: true,
  crewAlertChannel: "email",
  bookingFooterEnabled: true,
  bookingFooterFields: ["name", "address", "phone", "email", "website"],
  bookingDepositEnabled: false,
  bookingPayInFull: false,
  bookingPayInPerson: false,
  taxName: "Tax",
  taxPercent: 0,
  pricesIncludeTax: false,
  bookingDepositPercent: 20,
  bookingRefundPolicy: "",
  routeSuggestionsEnabled: false,
  routeLeadDays: 1,
  routeMaxDays: 7,
  routeAwareSlots: false,
  routeReturnToBase: false,
  bookingSingleService: false,
  bookingInstant: false,
  bookingMaxDays: 90,
  serviceCategories: ["Default"],
  customerChangeHours: 72,
  bookingIntro: "",
  portalName: "",
  bookingDoneMessage: "",
  bookingAccent: "",
  bookingTheme: "light",
  bookingCreateDeal: false,
  bookingDealPipelineId: "default",
  bookingDealStageId: "new",
  customerPortalEnabled: false,
};

export type ServiceRequestStatus =
  | "new"
  | "scheduled"
  | "action_required"
  | "converted"
  | "archived";

export type ServiceRequestSource =
  | "manual"
  | "form"
  | "booking"
  | "ai"
  | "workflow";

export interface ServiceRequest {
  id: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  territoryId: string | null;
  /** R-YYYY-NNNN. */
  number: string;
  contactId: string;
  contactName: string;
  title: string;
  description: string;
  serviceAddress: ServiceAddress | null;
  serviceIds: string[];
  photos: PhotoRef[];
  status: ServiceRequestStatus;
  archiveReason?: string | null;
  source: ServiceRequestSource;
  dealId?: string | null;
  outOfArea?: boolean;
  convertedTo?: string | null;
  createdAt: Ts;
  updatedAt: Ts;
}

export type JobStatus =
  | "unscheduled"
  | "scheduled"
  | "in_progress"
  | "ready_to_invoice"
  | "closed"
  | "cancelled"
  | "action_required";

/** A note on a project. Times are epoch milliseconds so a note can live in an array on the job. */
export interface JobNote {
  id: string;
  text: string;
  byName: string;
  byWorkerId: string | null;
  byUid: string | null;
  createdAtMs: number;
  editedAtMs?: number;
}

export interface JobLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  productId?: string | null;
  /** The option of the service this line is for, such as Easy or Hard. */
  variantId?: string | null;
  /** The time this line is expected to take, when it came from an option with its own time. */
  durationMinutes?: number | null;
  /** Set on lines the customer approved as extra work. */
  approvalId?: string | null;
  /** Estimate lines only: the staff member the hours are for. The price is their sell rate per hour. */
  workerId?: string | null;
  /** Estimate lines only: the price was typed over the staff sell rate, so rate changes leave it alone. */
  priceLocked?: boolean;
  /** Estimate lines only: the activity (Driving, Admin...) the hours are for. */
  activityId?: string | null;
}

export interface Job {
  id: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  territoryId: string | null;
  /** J-YYYY-NNNN. */
  number: string;
  contactId: string;
  contactName: string;
  dealId?: string | null;
  requestId?: string | null;
  quoteId?: string | null;
  /** What the customer asked for or the office noted when it was created. */
  description?: string;
  notes?: JobNote[];
  invoiceIds: string[];
  /** Server-kept: true when an invoice exists and nothing billable is left off it. Absent until first worked out. */
  invoiceClean?: boolean;
  title: string;
  serviceAddress: ServiceAddress | null;
  /** IANA zone of the job site; every view renders in it. */
  timezone: string;
  currency: string;
  lineItems: JobLineItem[];
  serviceAreaId?: string | null;
  outOfArea?: boolean;
  travelFeeCents?: number | null;
  status: JobStatus;
  completedAt?: Ts;
  /** Set once job.completed has fired, so it never fires twice. */
  completedFiredAt?: Ts;
  closedAt?: Ts;
  jobType: "one_off" | "recurring";
  recurrence: RecurrenceConfig | null;
  /** Set while timesheets are on. Locked once an invoice exists. */
  billingType?: JobBillingType;
  /** The activities (Driving, Admin...) staff can book on this project. Absent means every enabled activity. */
  activityIds?: string[];
  /** The staff the project was created for. Visits are booked separately. */
  workerIds?: string[];
  /** Time and materials only: what the work is expected to cost. Internal, never billed. Feeds Draft estimate and Revenue. */
  estimateLines?: JobLineItem[];
  /** Time and materials only: put the description and estimate on the invoice as text. They are never invoice charges. */
  showScopeOnInvoice?: boolean;
  /** Crew may start and stop a timer on this project. Absent means they only enter hours. */
  timersEnabled?: boolean;
  /** Time is entered as hours for a day, never as start and stop times. Fixed once time is logged. */
  hoursOnly?: boolean;
  /** Extra-work approval id to the invoice that carries it; while that invoice exists a repeating job does not bill it again. */
  billedApprovals?: Record<string, string>;
  /** The invoice that carries the job's own lines. Null when an invoice went out without them. Later invoices leave those lines off. */
  billedLinesInvoiceId?: string | null;
  /** Tax at the time of booking. Missing means the job is tax-free. */
  tax?: JobTax | null;
  /** The deposit invoice from an online booking. */
  depositInvoiceId?: string | null;
  /** The deposit paid, in minor units, once the invoice is paid. */
  depositPaidMinor?: number;
  /** How much of the deposit each invoice took off, by invoice id. A deleted invoice gives its share back. */
  depositCredits?: Record<string, number>;
  /** The invoice that carries the area's travel fee, when the office chose to add it. */
  travelFeeInvoiceId?: string | null;
  kind?: "standard" | "callback";
  relatedJobId?: string | null;
  /** Bumping this ends every customer status link already sent. */
  statusTokenVersion?: number;
  /** Bumped on every change to lineItems, so a stale editor cannot overwrite newer lines. */
  lineItemsVersion?: number;
  createdAt: Ts;
  updatedAt: Ts;
}

export type ExtraWorkStatus = "pending" | "approved" | "declined" | "cancelled";

/** Extra work the customer is asked to approve from their status link. */
export interface ExtraWorkApproval {
  id: string;
  agencyId: string;
  subAccountId: string;
  jobId: string;
  contactId: string;
  lines: JobLineItem[];
  currency: string;
  totalMinor: number;
  note: string;
  status: ExtraWorkStatus;
  createdByUid: string;
  respondedAt?: Ts;
  response?: { name: string; comment: string; ipHash?: string; userAgent?: string } | null;
  createdAt: Ts;
  updatedAt: Ts;
}

export type VisitStatus =
  | "pending"
  | "on_my_way"
  | "checked_in"
  | "completed"
  | "no_show"
  | "cancelled";

/** One tick-box on a visit. */
export interface ChecklistItem {
  id: string;
  text: string;
  required: boolean;
  done: boolean;
  doneAt?: number | null;
  doneByWorkerId?: string | null;
  /** From a service's checklist, or typed on the visit. */
  source: "service" | "added";
  /** "<serviceId>:<itemId>" for service items, so a refresh never adds one twice. */
  origin?: string | null;
}

/** Where a visit stands with the customer's sign-off. */
export interface VisitSignoff {
  id: string;
  status: "pending" | "signed";
  requestedAt: number;
  signedAt?: number | null;
  name?: string | null;
}

/** A service's checklist and what must be done before a visit for it can be completed. */
export interface ChecklistTemplate {
  id: string;
  agencyId: string;
  subAccountId: string;
  productId: string;
  productName: string;
  items: { id: string; text: string; required: boolean }[];
  requireChecklist: boolean;
  requireSignature: boolean;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface Visit {
  id: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  territoryId: string | null;
  jobId: string;
  contactId: string;
  jobNumber: string;
  jobTitle: string;
  contactName: string;
  address: string;
  scheduledStart: Ts;
  scheduledEnd: Ts;
  anytime: boolean;
  arrivalWindow?: { startMinutes: number; endMinutes: number } | null;
  workerIds: string[];
  /** Travel time kept free either side of this visit, copied from its service when it was made. */
  travelMinutes?: number;
  /** The system chose the person and time (online booking with no time picked), so day planning may move it. */
  autoScheduled?: boolean;
  serviceLineIds: string[];
  status: VisitStatus;
  onMyWayAt?: Ts;
  checkedInAt?: Ts;
  completedAt?: Ts;
  notes: string;
  photos: PhotoRef[];
  /** Set on visits created by a repeating job. */
  recurringOf?: string | null;
  /** The repeat date this visit stands for (YYYY-MM-DD in the job's zone). */
  occurrenceDate?: string | null;
  /** The office moved or reassigned it by hand, so edits to the repeat leave it alone. */
  manual?: boolean;
  invoiceId?: string | null;
  /** Copied from the services on the job when the visit is made, then ticked off on site. */
  checklist?: ChecklistItem[];
  /** Required items must be ticked before a worker can complete the visit. */
  requireChecklist?: boolean;
  /** The customer must sign off before a worker can complete the visit. */
  requireSignature?: boolean;
  signoff?: VisitSignoff | null;
  /** Which reminderVersion already has a reminder queued. */
  reminderQueuedVersion?: number;
  /** Stale reminders no-op once this moves. */
  reminderVersion: number;

  createdAt: Ts;
  updatedAt: Ts;
}

export type PhotoLabel = "before" | "after" | "receipt" | "issue" | "other";

export interface PhotoRef {
  id: string;
  path: string;
  label: PhotoLabel;
  takenAt: number;
  byWorkerId: string | null;
  width: number;
  height: number;
  thumbPath?: string | null;
  note?: string | null;
}

/** Non-customer work such as the workshop or training. Time can be booked to it; it is never scheduled or invoiced. */
export interface InternalJob {
  id: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  name: string;
  /** Every active worker may book time to it. */
  allCrew: boolean;
  workerIds: string[];
  archived: boolean;
  /** Crew may start and stop a timer on it. Absent means they only enter hours. */
  timersEnabled?: boolean;
  createdAt: Ts;
  updatedAt: Ts;
}

/** One per worker. Active between Clock In and Clock Out, with a general timer running between jobs. */
export interface Workday {
  agencyId: string;
  subAccountId: string;
  workerId: string;
  active: boolean;
  startedAt: Ts;
  endedAt?: Ts;
}

export interface TimeEntry {
  id: string;
  agencyId: string;
  subAccountId: string;
  territoryId: string | null;
  workerId: string;
  /** Null for general time that belongs to no job. */
  jobId: string | null;
  /** Null for time on a job with no visit, on an internal job, or on no job. */
  visitId: string | null;
  internalJobId?: string | null;
  startAt: Ts;
  endAt?: Ts;
  /** Time on a project that records hours only: a day and a length, no clock times. The stored start is just the start of that day. */
  hoursOnly?: boolean;
  durationMinutes?: number;
  /** True while the timer runs; lets one worker's running timer be found by equality. */
  running: boolean;
  kind: string;
  billable: boolean;
  source: "timer" | "manual";
  note: string;
  status: "open";
  voided?: boolean;
  correctionRequest?: { note: string; at: number } | null;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface MaterialLine {
  id: string;
  agencyId: string;
  subAccountId: string;
  territoryId: string | null;
  jobId: string;
  visitId: string;
  workerId: string;
  catalogItemId?: string | null;
  name: string;
  qty: number;
  unit: string;
  unitCostMinor: number;
  unitPriceMinor: number;
  taxable: boolean;
  source: "catalog" | "adhoc" | "receipt";
  receiptPhoto?: PhotoRef | null;
  billable: boolean;
  notInEstimate: boolean;
  approval: "not_required" | "pending" | "approved" | "declined";
  invoiceLineId?: string | null;
  createdAt: Ts;
  updatedAt: Ts;
}

export type JobPaymentMethod = "cash" | "cheque" | "terminal" | "other";

export interface JobPayment {
  id: string;
  agencyId: string;
  subAccountId: string;
  territoryId: string | null;
  jobId: string;
  visitId: string;
  workerId: string;
  invoiceId?: string | null;
  method: JobPaymentMethod;
  amountMinor: number;
  currency: string;
  note: string;
  photo?: PhotoRef | null;
  status: "pending" | "confirmed" | "rejected";
  confirmedBy?: string | null;
  confirmedAt?: Ts;
  createdAt: Ts;
  updatedAt: Ts;
}

export const MAX_SERVICE_AREA_POSTCODES = 500;
export const MAX_SERVICE_AREAS = 50;
export const MAX_FIELD_WORKERS = 100;
