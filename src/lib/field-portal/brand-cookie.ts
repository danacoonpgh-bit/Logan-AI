/** Name and logo of the business, kept in a plain cookie so the launch screen can show them before anything loads. Public details only. */
export interface CrewBrand {
  name: string;
  logoUrl: string | null;
}

export function brandCookieName(subAccountId: string): string {
  return `ls_field_brand_${subAccountId}`;
}

export function serializeBrand(brand: CrewBrand): string {
  const logo = brand.logoUrl && /^https?:\/\//i.test(brand.logoUrl) && brand.logoUrl.length <= 300 ? brand.logoUrl : null;
  return encodeURIComponent(JSON.stringify({ n: brand.name.slice(0, 60), l: logo }));
}

export function parseBrand(raw: string | undefined): CrewBrand | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as { n?: unknown; l?: unknown };
    const name = typeof v.n === "string" ? v.n.trim().slice(0, 60) : "";
    if (!name) return null;
    const logo = typeof v.l === "string" && /^https?:\/\//i.test(v.l) && v.l.length <= 300 ? v.l : null;
    return { name, logoUrl: logo };
  } catch {
    return null;
  }
}
