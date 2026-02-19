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

async function fetchHtml(url: string): Promise<string> {
  const headers = {
    "user-agent": "rss-feeds-bot/1.0 (GitHub Actions; contact via repo issues)",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
    "referer": "https://www.childsafety.gov.au/",
  };

  // 3 attempts, increasing timeout + backoff
  const attempts = [
    { timeout: 15000, backoff: 800 },
    { timeout: 25000, backoff: 1500 },
    { timeout: 35000, backoff: 2500 },
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

      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("text/html")) {
        const snippet = (await res.text()).slice(0, 200);
        throw new Error(`Not HTML (content-type=${ct}): ${snippet}`);
      }

      return await res.text();
    } catch (e: any) {
      lastErr = e;
      if (i < attempts.length - 1) {
        await sleep(attempts[i].backoff);
      }
    }
  }

  throw lastErr;
}

async function fetchChildSafetyNews(): Promise<FeedItem[]> {
  const listUrl = "https://www.childsafety.gov.au/news";
  const html = await fetchHtml(listUrl);
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

async function main() {
  const outDir = path.join(process.cwd(), "public", "feeds", "childsafety");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "news.xml");

  try {
    const items = await fetchChildSafetyNews();
    const rss = toRss(
      "ChildSafety.gov.au - News (Latest)",
      "https://www.childsafety.gov.au/news",
      items
    );

    await writeFile(outPath, rss, "utf8");
    console.log(`Wrote ${outPath} (${items.length} items)`);
  } catch (e: any) {
    const msg = e?.stack || e?.message || String(e);
    console.error("Fetch failed. Keeping last good feed if present.\n", msg);

    // Only write a placeholder if this is the very first run (no existing file).
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
