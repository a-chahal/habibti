// Global Legal Entity Identifier Foundation — public API, no key required
const BASE = "https://api.gleif.org/api/v1";

export interface LEIRecord {
  lei: string;
  legalName: string;
  legalAddress: {
    addressLines: string[];
    city: string;
    country: string;
    postalCode?: string;
  };
  status: string;
  registrationDate?: string;
}

export async function getLEI(lei: string): Promise<LEIRecord | null> {
  const res = await fetch(`${BASE}/lei-records/${lei}`, {
    headers: { Accept: "application/vnd.api+json" },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GLEIF error ${res.status}: ${await res.text()}`);

  const json = await res.json();
  const d = json.data?.attributes;
  if (!d) return null;

  return {
    lei: json.data.id,
    legalName: d.entity?.legalName?.name ?? "",
    legalAddress: {
      addressLines: d.entity?.legalAddress?.addressLines ?? [],
      city: d.entity?.legalAddress?.city ?? "",
      country: d.entity?.legalAddress?.country ?? "",
      postalCode: d.entity?.legalAddress?.postalCode,
    },
    status: d.registration?.status ?? "",
    registrationDate: d.registration?.initialRegistrationDate,
  };
}

export async function searchLEI(
  companyName: string,
  country?: string
): Promise<LEIRecord[]> {
  const url = new URL(`${BASE}/lei-records`);
  url.searchParams.set("filter[entity.legalName]", companyName);
  if (country) url.searchParams.set("filter[entity.legalAddress.country]", country);
  url.searchParams.set("page[size]", "5");

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/vnd.api+json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GLEIF error ${res.status}: ${await res.text()}`);

  const json = await res.json();
  return (json.data ?? []).map((item: any) => {
    const d = item.attributes;
    return {
      lei: item.id,
      legalName: d.entity?.legalName?.name ?? "",
      legalAddress: {
        addressLines: d.entity?.legalAddress?.addressLines ?? [],
        city: d.entity?.legalAddress?.city ?? "",
        country: d.entity?.legalAddress?.country ?? "",
        postalCode: d.entity?.legalAddress?.postalCode,
      },
      status: d.registration?.status ?? "",
      registrationDate: d.registration?.initialRegistrationDate,
    };
  });
}
