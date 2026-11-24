const ALLOWED_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

/** Browsers only hand out push endpoints on their vendor's push service, so anything else is refused. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && ALLOWED_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}
