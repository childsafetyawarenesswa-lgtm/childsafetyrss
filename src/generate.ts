// src/generate.ts
import { load } from "cheerio";
import { mkdir, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

type FeedItem = {
  title: string;
  link: string;
  pubDate?: string;
  description?: string;
  guid: string;
};

function escapeXml(input: string) {
  const str = String(input ?? "");
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toRss(title: string, link: string, items: FeedItem[]) {
  const now = new Date().toUTCString();
  const itemXml = items
    .map((i) => {
      const desc = i.description
        ? `<description>${escapeXml(i.description)}</description>`
        : "";
      const pub = i.pubDate ? `<pubDate>${escapeXml(i.pubDate)}</pubDate>` : "";
      return `
  <item>
    <title>${escapeXml(i.title)}</title>
    <link>${escapeXml(i.link)}</link>
    <guid isPermaLink="false">${escapeXml(i.guid)}</guid>
    ${pub}
    ${desc}
  </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${escapeXml(title)}</title>
  <link>${escapeXml(link)}</link>
  <description>${escapeXml(title)}</description>
  <lastBuildDate>${escapeXml(now)}</lastBuildDate>
  ${itemXml}
</channel>
</rss>`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fileExists(p: string) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(
  url: string,
  ms: number,
  headers: Record<string, string>
) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);

  try {
    return await fetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(id);
  }
}

async function fetchTextWithRetries(url: string, expectHtml: boolean): Promise<string> {
  const headers = {
    "user-agent": "rss-feeds-bot/1.0 (GitHub Actions; contact via repo issues)",
    "accept": expectHtml
      ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      : "application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
    "referer": "https://www.childsafety.gov.au/",
  };

  const attempts = [
    { timeout: 30000, backoff: 1200 },
    { timeout: 45000, backoff: 2000 },
    { timeout: 60000, backoff: 3000 },
  ];

  let lastErr: any;

  for (let i = 0; i < attempts.length; i++) {
    try {
      const { timeout } = attempts[i];
      const res = await fetchWithTimeout(url, timeout, headers);

      if (!res.ok) {
        const snippet = (await res.text()).slice(0, 400);
        throw new Error(`Fetch failed ${res.status} ${res.statusText}: ${snippet}`);
      }

      return await res.text();
    } catch (e: any) {
      lastErr = e;
      if (i < attempts.length - 1) await sleep(attempts[i].backoff);
    }
  }

  throw lastErr;
}

/**
 * Primary attempt: scrape ChildSafety listing HTML
 */
async function fetchChildSafetyNewsFromHtml(): Promise<FeedItem[]> {
  const listUrl = "https://www.childsafety.gov.au/news";
  const html = await fetchTextWithRetries(listUrl, true);

  const $ = load(html);
  const items: FeedItem[] = [];

  const links = $("main a[href^='/news/']").toArray();
  for (const a of links) {
    const el = $(a);
    const href = (el.attr("href") || "").trim();
    const title = el.text().replace(/\s+/g, " ").trim();

    if (!href || !title) continue;
    if (href === "/news") continue;
    if (!/^\/news\/[^/?#]+\/?$/.test(href)) continue;

    const link = new URL(href, "https://www.childsafety.gov.au").toString();

    items.push({
      title,
      link,
      guid: `childsafety:${link}`,
    });
  }

  const deduped = Array.from(new Map(items.map((i) => [i.link, i])).values());
  return deduped.slice(0, 15);
}

/**
 * Fallback attempt: pull items from your Worker RSS feed (already working)
 */
async function fetchChildSafetyNewsFromWorkerRss(): Promise<FeedItem[]> {
  const workerRssUrl = "https://rsshub-wa.childsafetyawarenesswa.workers.dev/feeds/childsafety/news";
  const xml = await fetchTextWithRetries(workerRssUrl, false);

  // Cheerio can parse XML fine for our simple needs
  const $ = load(xml, { xmlMode: true });

  const items: FeedItem[] = [];
  $("item").each((_, itemEl) => {
    const title = ($(itemEl).find("title").text() || "").trim();
    const link = ($(itemEl).find("link").text() || "").trim();
    const pubDate = ($(itemEl).find("pubDate").text() || "").trim();
    const description = ($(itemEl).find("description").text() || "").trim();
    const guid = ($(itemEl).find("guid").text() || "").trim() || `childsafety:${link}`;

    if (!title || !link) return;

    items.push({
      title,
      link,
      pubDate: pubDate || undefined,
      description: description || undefined,
      guid,
    });
  });

  // Dedup + cap
  const deduped = Array.from(new Map(items.map((i) => [i.link, i])).values());
  return deduped.slice(0, 15);
}

async function main() {
  const outDir = path.join(process.cwd(), "public", "feeds", "childsafety");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "news.xml");

  try {
    // 1) Try direct HTML scrape first
    let items: FeedItem[] = [];
    try {
      items = await fetchChildSafetyNewsFromHtml();
      console.log(`Direct scrape OK (${items.length} items)`);
    } catch (e: any) {
      console.warn("Direct scrape failed; falling back to Worker RSS.\n", e?.message || e);
      // 2) Fallback to Worker RSS (should keep your Pages feed populated)
      items = await fetchChildSafetyNewsFromWorkerRss();
      console.log(`Worker RSS fallback OK (${items.length} items)`);
    }

    if (!items.length) {
      throw new Error("No items returned from direct scrape or fallback.");
    }

    const rss = toRss(
      "ChildSafety.gov.au - News (Latest)",
      "https://www.childsafety.gov.au/news",
      items
    );

    await writeFile(outPath, rss, "utf8");
    console.log(`Wrote ${outPath} (${items.length} items)`);
  } catch (e: any) {
    const msg = e?.stack || e?.message || String(e);
    console.error("All fetch methods failed. Keeping last good feed if present.\n", msg);

    // Only write a placeholder if this is the very first run (no existing file)
    if (!(await fileExists(outPath))) {
      const rss = toRss(
        "ChildSafety.gov.au - News (Latest)",
        "https://www.childsafety.gov.au/news",
        [
          {
            title: "Feed temporarily unavailable",
            link: "https://www.childsafety.gov.au/news",
            pubDate: new Date().toUTCString(),
            description: msg.slice(0, 800),
            guid: `childsafety:unavailable:${Date.now()}`,
          },
        ]
      );
      await writeFile(outPath, rss, "utf8");
      console.log(`Wrote placeholder ${outPath}`);
    } else {
      console.log("Existing feed found — leaving it unchanged.");
    }

    // Do NOT fail the workflow
    return;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
