const BASE = "https://api.currentsapi.services/v1";

export interface NewsArticle {
  id: string;
  title: string;
  description: string;
  url: string;
  author?: string;
  image?: string;
  language: string;
  category: string[];
  published: string;
}

export interface NewsResponse {
  status: string;
  news: NewsArticle[];
}

export async function searchNews(params: {
  keywords: string;
  language?: string;
  country?: string;
  startDate?: string; // YYYY-MM-DD
  pageSize?: number;
}): Promise<NewsResponse> {
  const apiKey = process.env.CURRENTS_API_KEY;
  if (!apiKey) throw new Error("CURRENTS_API_KEY not set");

  const url = new URL(`${BASE}/search`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("keywords", params.keywords);
  if (params.language) url.searchParams.set("language", params.language);
  if (params.country) url.searchParams.set("country", params.country);
  if (params.startDate) url.searchParams.set("start_date", params.startDate);
  if (params.pageSize) url.searchParams.set("page_size", String(params.pageSize));

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Currents API error ${res.status}: ${await res.text()}`);

  const json = await res.json();
  return {
    status: json.status,
    news: (json.news ?? []).map((a: any) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      url: a.url,
      author: a.author,
      image: a.image,
      language: a.language,
      category: a.category ?? [],
      published: a.published,
    })),
  };
}

export async function getLatestNews(topic: string, pageSize = 10): Promise<NewsArticle[]> {
  const result = await searchNews({ keywords: topic, language: "en", pageSize });
  return result.news;
}
