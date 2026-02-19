import { load } from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
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

async function fetchWithTimeout(url: string, ms: number, headers: Record<string, string>) {
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
      const { timeout, backoff } = attempts[i];
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
      // backoff before retry (except after last attempt)
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

    const container =
      el.closest("article").length
        ? el.closest("article")
        : el.closest("li").length
          ? el.closest("li")
          : el.closest("div").length
            ? el.closest("div")
            : el.parent();

    let pubDate = "";
    const timeEl = container.find("time").first();
    if (timeEl.length) {
      pubDate = (timeEl.attr("datetime") || "").trim() || timeEl.text().trim();
    }

    let description = "";
    const ps = container
      .find("p")
      .toArray()
      .map((p) => $(p).text().replace(/\s+/g, " ").trim())
      .filter(Boolean);

    description = ps.find((t) => t && t !== title) || "";
    if (description.length > 500) description = description.slice(0, 497) + "...";

    items.push({
      title,
      link,
      pubDate: pubDate || undefined,
      description: description || undefined,
      guid: `childsafety:${link}`,
    });
  }

  const deduped = Array.from(new Map(items.map((i) => [i.link, i])).values());
  return deduped.slice(0, 15);
}

async function writeFeedFile(items: FeedItem[], note?: string) {
  const outDir = path.join(process.cwd(), "public", "feeds", "childsafety");
  await mkdir(outDir, { recursive: true });

  const rss = toRss(
    "ChildSafety.gov.au - News (Latest)",
    "https://www.childsafety.gov.au/news",
    items.length
      ? items
      : [
          {
            title: "Feed temporarily unavailable",
            link: "https://www.childsafety.gov.au/news",
            pubDate: new Date().toUTCString(),
            description: note || "Upstream fetch failed during scheduled build. Will retry next run.",
            guid: `childsafety:unavailable:${Date.now()}`,
          },
        ]
  );

  const outPath = path.join(outDir, "news.xml");
  await writeFile(outPath, rss, "utf8");
  console.log(`Wrote ${outPath} (${items.length} items)`);
}

async function main() {
  try {
    const items = await fetchChildSafetyNews();
    await writeFeedFile(items);
  } catch (e: any) {
    // Do NOT fail the workflow; publish a placeholder RSS so Pages deploy succeeds
    const msg = e?.stack || e?.message || String(e);
    console.error("Fetch failed; writing placeholder feed instead.\n", msg);
    await writeFeedFile([], msg.slice(0, 800));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
