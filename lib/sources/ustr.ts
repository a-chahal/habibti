// USITC HTS Schedule and Federal Register USTR notices
const HTS_BASE = "https://hts.usitc.gov/reststop";
const FEDERAL_REGISTER_BASE = "https://www.federalregister.gov/api/v1";

export interface HTSChapter {
  chapter: string;
  description: string;
  sections: unknown[];
}

export interface FederalRegisterDoc {
  document_number: string;
  title: string;
  type: string;
  publication_date: string;
  html_url: string;
  abstract?: string;
  agencies: { name: string }[];
}

// NOTE: The USITC HTS REST API (hts.usitc.gov/reststop) was replaced with a JS SPA
// and no longer exposes machine-readable endpoints. Fallback: use Federal Register
// USTR notices for tariff actions, and the WCO HS nomenclature for code lookups.

export async function fetchHTSChapterRaw(chapter: number): Promise<unknown> {
  // Fallback: return chapter metadata from Federal Register USTR section 301 actions
  // which references HTS codes. The USITC REST API is no longer available.
  const padded = String(chapter).padStart(2, "0");
  return {
    chapter: padded,
    source: "fallback",
    note: "USITC HTS REST API deprecated — use Federal Register USTR notices for tariff actions",
    federalRegisterUrl: "https://www.federalregister.gov/agencies/office-of-the-united-states-trade-representative",
  };
}

export async function fetchFederalRegisterUSTR(
  perPage = 10
): Promise<FederalRegisterDoc[]> {
  const url = new URL(`${FEDERAL_REGISTER_BASE}/documents.json`);
  // USTR agency ID = 491 (verified from Federal Register agency list)
  // Must use append (not set) for repeated array params
  url.searchParams.append("conditions[agency_ids][]", "491");
  url.searchParams.append("per_page", String(perPage));
  url.searchParams.append("order", "newest");
  url.searchParams.append("fields[]", "document_number");
  url.searchParams.append("fields[]", "title");
  url.searchParams.append("fields[]", "type");
  url.searchParams.append("fields[]", "publication_date");
  url.searchParams.append("fields[]", "html_url");
  url.searchParams.append("fields[]", "abstract");
  url.searchParams.append("fields[]", "agencies");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Federal Register error ${res.status}: ${await res.text()}`);

  const json = await res.json();
  return (json.results ?? []).map((d: any) => ({
    document_number: d.document_number,
    title: d.title,
    type: d.type,
    publication_date: d.publication_date,
    html_url: d.html_url,
    abstract: d.abstract,
    agencies: d.agencies ?? [],
  }));
}
