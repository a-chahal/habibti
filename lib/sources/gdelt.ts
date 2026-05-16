import { get as httpsGet } from "https";

const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";

export interface GDELTArticle {
  url: string;
  title: string;
  seendate: string;
  sourcecountry: string;
  sourcelang: string;
  domain: string;
}

export interface GDELTResponse {
  articles: GDELTArticle[];
  totalResults: number;
}

function httpsGetJson(url: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(
      url,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; trade-platform/1.0)" } },
      (res) => {
        if (res.statusCode === 429) {
          reject(new Error(`GDELT rate limited (429)`));
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GDELT error ${res.statusCode}`));
          res.resume();
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("GDELT request timed out"));
    });
  });
}

export async function searchGDELT(params: {
  query: string;
  startDate?: string; // YYYYMMDDHHMMSS
  maxRecords?: number;
  sourceLang?: string;
  mode?: "artlist" | "timelinevolume";
}): Promise<GDELTResponse> {
  const url = new URL(GDELT_DOC_API);
  url.searchParams.set("query", params.query);
  url.searchParams.set("mode", params.mode ?? "artlist");
  url.searchParams.set("maxrecords", String(params.maxRecords ?? 25));
  url.searchParams.set("format", "json");
  if (params.startDate) url.searchParams.set("startdatetime", params.startDate);
  if (params.sourceLang) url.searchParams.set("sourcelang", params.sourceLang);

  let raw: string;
  try {
    raw = await httpsGetJson(url.toString());
  } catch (err: any) {
    if (err.message?.includes("429")) {
      // Rate limited — wait 6s and retry once
      await new Promise((r) => setTimeout(r, 6000));
      raw = await httpsGetJson(url.toString());
    } else {
      throw err;
    }
  }

  const data = JSON.parse(raw);
  return {
    articles: data.articles ?? [],
    totalResults: data.articles?.length ?? 0,
  };
}

function daysAgoTimestamp(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

export async function searchRecentGDELT(
  query: string,
  daysBack = 7,
  maxRecords = 25
): Promise<GDELTResponse> {
  return searchGDELT({
    query,
    startDate: daysAgoTimestamp(daysBack),
    maxRecords,
  });
}
