import "server-only";

import { coercePhoneCountry } from "@/lib/contacts/phone";
import { countryForPhone } from "@/lib/contacts/phone-timezone";
import { sendSms, sendSmsForSubAccount, smsIsConfigured } from "@/lib/comms/twilio";
import { hitLimit } from "@/lib/server/field-rate-limit";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import type { SubAccountDoc } from "@/types";

function extraCountries(): string[] {
  return (process.env.FIELD_PORTAL_SMS_COUNTRIES ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

/** Portal texts only go to the workspace's own country (plus any listed in env), within a daily cap. */
export async function sendPortalSms(input: {
  subAccountId: string;
  sub: SubAccountDoc;
  to: string;
  body: string;
  bucket?: "auth" | "alerts";
  /** Use the deployment's own number, so the workspace cannot read the message in its own phone account. */
  platform?: boolean;
}): Promise<void> {
  const home = coercePhoneCountry((input.sub as { defaultPhoneCountry?: string }).defaultPhoneCountry);
  const dest = countryForPhone(input.to);
  if (!dest || (dest !== home && !extraCountries().includes(dest))) {
    throw new FieldServicesError(
      "Texts to that country aren't switched on. Use an email address, or ask your agency.",
    );
  }
  const cap = await hitLimit(`sms:sa:${input.subAccountId}:${input.bucket ?? "auth"}`, 150, 24 * 3_600_000);
  if (!cap.ok) throw new FieldServicesError("Daily crew-app text limit reached. Try tomorrow.", 429);
  if (input.platform && smsIsConfigured()) {
    await sendSms({ to: input.to, body: input.body });
    return;
  }
  await sendSmsForSubAccount({
    subAccountId: input.subAccountId,
    subAccount: input.sub,
    to: input.to,
    body: input.body,
  });
}
