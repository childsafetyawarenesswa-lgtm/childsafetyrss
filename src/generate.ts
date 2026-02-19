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

// Simple “human” headers help (GitHub Actions IPs are usually fine anyway)
async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent": "rss-feeds-bot/1.0 (GitHub Actions; contact via repo issues)",
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "en-AU,en;q=0.9",
      "referer": "https://www.google.com/"
    },
    redirect: "follow",
  });

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
}

async function fetchChildSafetyNews(): Promise<FeedItem[]> {
  const listUrl = "https://www.childsafety.gov.au/news";
  const html = await fetchHtml(listUrl);
  const $ = load(html);

  const items: FeedItem[] = [];

  // Keep only /news/<slug> style links inside main
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

    // Date: prefer <time datetime>, else blank
    let pubDate = "";
    const timeEl = container.find("time").first();
    if (timeEl.length) {
      pubDate = (timeEl.attr("datetime") || "").trim() || timeEl.text().trim();
    }

    // Snippet: first paragraph not equal to title
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

  // Dedup by link, keep first 15
  const deduped = Array.from(new Map(items.map((i) => [i.link, i])).values());
  return deduped.slice(0, 15);
}

async function main() {
  // Ensure output folder exists
  const outDir = path.join(process.cwd(), "public", "feeds", "childsafety");
  await mkdir(outDir, { recursive: true });

  const items = await fetchChildSafetyNews();
  const rss = toRss(
    "ChildSafety.gov.au - News (Latest)",
    "https://www.childsafety.gov.au/news",
    items
  );

  const outPath = path.join(outDir, "news.xml");
  await writeFile(outPath, rss, "utf8");

  console.log(`Wrote ${outPath} (${items.length} items)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

