const BASE = "https://api.company-information.service.gov.uk";

function authHeader(): string {
  const key = process.env.UK_COMPANIES_HOUSE_API_KEY;
  if (!key) throw new Error("UK_COMPANIES_HOUSE_API_KEY not set");
  return "Basic " + Buffer.from(key + ":").toString("base64");
}

export interface CompanySearchResult {
  company_number: string;
  title: string;
  company_status: string;
  company_type: string;
  date_of_creation?: string;
  registered_office_address?: {
    address_line_1?: string;
    locality?: string;
    postal_code?: string;
    country?: string;
  };
}

export interface CompanyDetail extends CompanySearchResult {
  sic_codes?: string[];
  accounts?: { next_due?: string };
  confirmation_statement?: { next_due?: string };
}

export async function searchCompanies(
  query: string,
  itemsPerPage = 10
): Promise<CompanySearchResult[]> {
  const url = new URL(`${BASE}/search/companies`);
  url.searchParams.set("q", query);
  url.searchParams.set("items_per_page", String(itemsPerPage));

  const res = await fetch(url.toString(), {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`Companies House error ${res.status}: ${await res.text()}`);

  const json = await res.json();
  return (json.items ?? []).map((c: any) => ({
    company_number: c.company_number,
    title: c.title,
    company_status: c.company_status,
    company_type: c.company_type,
    date_of_creation: c.date_of_creation,
    registered_office_address: c.registered_office_address,
  }));
}

export async function getCompany(companyNumber: string): Promise<CompanyDetail> {
  const res = await fetch(`${BASE}/company/${companyNumber}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`Companies House error ${res.status}: ${await res.text()}`);

  const c = await res.json();
  return {
    company_number: c.company_number,
    title: c.company_name,
    company_status: c.company_status,
    company_type: c.type,
    date_of_creation: c.date_of_creation,
    registered_office_address: c.registered_office_address,
    sic_codes: c.sic_codes,
    accounts: c.accounts,
    confirmation_statement: c.confirmation_statement,
  };
}
