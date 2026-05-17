import { get as httpsGet } from "https";

// UN Comtrade public v1 endpoint — no API key required
const BASE = "https://comtradeapi.un.org/public/v1/preview";

export interface ComtradeRecord {
  reporterCode: string;
  reporterDesc: string;
  partnerCode: string;
  partnerDesc: string;
  cmdCode: string;
  cmdDesc: string;
  flowCode: string;
  flowDesc: string;
  period: string;
  primaryValue: number;
  netWgt?: number;
  qty?: number;
}

export interface ComtradeResponse {
  data: ComtradeRecord[];
  count: number;
}

function httpsGetJson(url: string, timeoutMs = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const hardTimer = setTimeout(() => {
      req.destroy();
      done(() => reject(new Error("Comtrade request timed out")));
    }, timeoutMs);

    const req = httpsGet(url, { headers: { Accept: "application/json" } }, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        clearTimeout(hardTimer);
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => done(() => reject(new Error(`Comtrade error ${res.statusCode}: ${body}`))));
        return;
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { clearTimeout(hardTimer); done(() => resolve(data)); });
    });
    req.on("error", (err) => { clearTimeout(hardTimer); done(() => reject(err)); });
  });
}

export async function queryComtrade(params: {
  reporterCode: string; // e.g. "156" for China
  cmdCode: string;      // HS code e.g. "5208"
  period?: string;      // e.g. "2022" annual
  flowCode?: string;    // "X" export, "M" import
  partnerCode?: string; // "0" = world
}): Promise<ComtradeResponse> {
  // Correct public v1 path: /public/v1/preview/C/A/HS (A = annual freq)
  const url = new URL(`${BASE}/C/A/HS`);
  url.searchParams.set("reporterCode", params.reporterCode);
  url.searchParams.set("cmdCode", params.cmdCode);
  url.searchParams.set("flowCode", params.flowCode ?? "X");
  url.searchParams.set("partnerCode", params.partnerCode ?? "0");
  if (params.period) url.searchParams.set("period", params.period);

  const raw = await httpsGetJson(url.toString());
  const json = JSON.parse(raw);
  const records: ComtradeRecord[] = (json.data ?? []).map((r: any) => ({
    reporterCode: String(r.reporterCode ?? ""),
    reporterDesc: r.reporterDesc ?? "",
    partnerCode: String(r.partnerCode ?? ""),
    partnerDesc: r.partnerDesc ?? "",
    cmdCode: String(r.cmdCode ?? ""),
    cmdDesc: r.cmdDesc ?? "",
    flowCode: r.flowCode ?? "",
    flowDesc: r.flowDesc ?? "",
    period: String(r.period ?? ""),
    primaryValue: Number(r.primaryValue ?? 0),
    netWgt: r.netWgt != null ? Number(r.netWgt) : undefined,
    qty: r.qty != null ? Number(r.qty) : undefined,
  }));

  return { data: records, count: records.length };
}
