import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

const CONTENT_PATH = path.resolve("src/data/content.json");
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DAILY_TRENDS_COUNT = 6;
const MODEL_PRICE_LIMIT = {
  inputPerToken: 1 / 1_000_000,
  outputPerToken: 5 / 1_000_000
};
const ALLOWED_MODEL_PREFIXES = [
  "qwen/",
  "mistralai/",
  "meta-llama/",
  "deepseek/",
  "nvidia/",
  "google/gemma"
];
const MODEL_FALLBACK = "meta-llama/llama-3.3-70b-instruct";
const TREND_FEEDS = [
  { source: "OpenAI News", url: "https://openai.com/news/rss.xml" },
  { source: "GitHub Blog", url: "https://github.blog/feed/" },
  { source: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml" },
  { source: "Google Research", url: "https://research.google/blog/rss/" },
  { source: "NVIDIA Developer Blog", url: "https://developer.nvidia.com/blog/feed/" }
];
const MODEL_TREND_SOURCES = {
  openrouterRankings: "https://openrouter.ai/rankings",
  huggingFaceTrending: "https://huggingface.co/models?sort=trending",
  arenaLeaderboard: "https://arena.ai/leaderboard"
};

const args = new Map(
  process.argv
    .slice(2)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [key, value] = item.split("=");
      return [key.replace(/^--/, ""), value ?? "true"];
    })
);

const mode = normalizeMode(args.get("mode") ?? process.env.UPDATE_MODE ?? "trends_only");

async function main() {
  const raw = await readFile(CONTENT_PATH, "utf8");
  const before = JSON.parse(raw);
  const content = JSON.parse(raw);

  const outputs = {
    mode,
    changed: "false",
    model_previous: "",
    model_selected: "",
    model_changed: "false",
    model_price_input: "",
    model_price_output: "",
    trends_updated_count: "0",
    sources_count: "0",
    signal_openrouter: "",
    signal_hf: "",
    signal_arena: ""
  };

  if (!content.trends || !Array.isArray(content.trends.items)) {
    throw new Error("content.trends.items is required");
  }

  const now = new Date();
  const currentMeta = normalizeMeta(content.trends.meta);
  outputs.model_previous = currentMeta.model;

  let selectedModel = currentMeta.model;
  let selectedModelPricing = currentMeta.pricing;
  let rankingSignals = { openrouter: [], hf: [], arena: [] };

  if (mode === "full_refresh") {
    const modelCandidates = await loadModelCandidates();
    rankingSignals = await fetchModelSignals(modelCandidates);
    const chosen = pickModel(modelCandidates, rankingSignals, currentMeta.model);

    if (chosen) {
      selectedModel = chosen.id;
      selectedModelPricing = {
        prompt: formatPerMillion(chosen.prompt),
        completion: formatPerMillion(chosen.completion)
      };
    }

    const modelWasChanged = currentMeta.model !== selectedModel;
    const nextLockedAt = modelWasChanged ? now.toISOString() : currentMeta.modelLockedAt;

    content.trends.meta = {
      ...currentMeta,
      model: selectedModel,
      modelLockedAt: nextLockedAt,
      pricing: selectedModelPricing,
      lastModelRefreshMode: mode,
      signals: {
        openrouter: rankingSignals.openrouter.slice(0, 5),
        huggingFace: rankingSignals.hf.slice(0, 5),
        arena: rankingSignals.arena.slice(0, 5)
      }
    };
  } else {
    content.trends.meta = {
      ...currentMeta,
      model: selectedModel,
      pricing: selectedModelPricing,
      lastModelRefreshMode: currentMeta.lastModelRefreshMode || "full_refresh"
    };
  }

  outputs.model_selected = selectedModel;
  outputs.model_changed = String(outputs.model_previous !== selectedModel);
  outputs.model_price_input = content.trends.meta.pricing.prompt;
  outputs.model_price_output = content.trends.meta.pricing.completion;
  outputs.signal_openrouter = rankingSignals.openrouter.slice(0, 3).join(", ");
  outputs.signal_hf = rankingSignals.hf.slice(0, 3).join(", ");
  outputs.signal_arena = rankingSignals.arena.slice(0, 3).join(", ");

  const feedPull = await collectFeedItems();
  outputs.sources_count = String(feedPull.sourcesFetched);

  if (feedPull.items.length > 0 && process.env.OPENROUTER_API_KEY) {
    const generated = await generateTrendsWithModel({
      model: selectedModel,
      items: feedPull.items,
      currentItems: content.trends.items
    });

    if (generated.length > 0) {
      outputs.trends_updated_count = String(countTrendChanges(content.trends.items, generated));
      content.trends.items = generated;
      content.trends.description = "Auto-refreshed snapshot of current AI and software developments.";
      content.trends.meta = {
        ...content.trends.meta,
        lastTrendRefreshAt: now.toISOString(),
        sourceFeeds: TREND_FEEDS.map((item) => item.source)
      };
    }
  }

  const beforeText = JSON.stringify(before, null, 2);
  const afterText = `${JSON.stringify(content, null, 2)}\n`;
  const hasChanged = beforeText !== afterText.trimEnd();

  if (hasChanged) {
    await writeFile(CONTENT_PATH, afterText, "utf8");
    outputs.changed = "true";
  }

  await writeGithubOutputs(outputs);
  printSummary(outputs);
}

function normalizeMode(value) {
  if (value === "full_refresh") return "full_refresh";
  return "trends_only";
}

function normalizeMeta(meta) {
  const source = meta && typeof meta === "object" ? meta : {};
  const model = typeof meta?.model === "string" && meta.model ? meta.model : MODEL_FALLBACK;
  const prompt = normalizePrice(meta?.pricing?.prompt);
  const completion = normalizePrice(meta?.pricing?.completion);

  return {
    ...source,
    model,
    modelLockedAt: typeof meta?.modelLockedAt === "string" ? meta.modelLockedAt : new Date(0).toISOString(),
    pricing: {
      prompt,
      completion
    },
    lastModelRefreshMode: typeof meta?.lastModelRefreshMode === "string" ? meta.lastModelRefreshMode : "full_refresh"
  };
}

function normalizePrice(value) {
  if (typeof value === "string" && value.startsWith("$")) return value;
  return "$0.000/M";
}

async function loadModelCandidates() {
  const response = await fetch(OPENROUTER_MODELS_URL, { headers: { "Accept": "application/json" } });
  if (!response.ok) {
    throw new Error(`OpenRouter models request failed: ${response.status}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  return rows
    .map((row) => {
      const prompt = Number(row?.pricing?.prompt);
      const completion = Number(row?.pricing?.completion);
      const id = typeof row?.id === "string" ? row.id : "";
      const name = typeof row?.name === "string" ? row.name : "";
      const contextLength = Number(row?.context_length) || 0;
      const huggingFaceId = typeof row?.hugging_face_id === "string" ? row.hugging_face_id.toLowerCase() : "";

      return { id, name, prompt, completion, contextLength, huggingFaceId };
    })
    .filter((row) => row.id)
    .filter((row) => Number.isFinite(row.prompt) && Number.isFinite(row.completion))
    .filter((row) => row.prompt >= 0 && row.completion >= 0)
    .filter((row) => !row.id.endsWith(":free"))
    .filter((row) => row.prompt <= MODEL_PRICE_LIMIT.inputPerToken)
    .filter((row) => row.completion <= MODEL_PRICE_LIMIT.outputPerToken)
    .filter((row) => ALLOWED_MODEL_PREFIXES.some((prefix) => row.id.startsWith(prefix)))
    .filter((row) => row.contextLength >= 64_000);
}

async function fetchModelSignals(candidates) {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id.toLowerCase()));
  const [openrouterText, hfText, arenaText] = await Promise.all([
    safeFetchText(MODEL_TREND_SOURCES.openrouterRankings),
    safeFetchText(MODEL_TREND_SOURCES.huggingFaceTrending),
    safeFetchText(MODEL_TREND_SOURCES.arenaLeaderboard)
  ]);

  return {
    openrouter: extractOpenRouterRankings(openrouterText, candidateIds),
    hf: extractHfTrending(hfText),
    arena: extractArenaNames(arenaText)
  };
}

function extractOpenRouterRankings(html, candidateIds) {
  if (!html) return [];
  const matches = [...html.matchAll(/href="\/([a-z0-9-]+\/[a-z0-9-.:]+)"/gi)]
    .map((item) => item[1].toLowerCase())
    .filter((item) => item.includes("/"))
    .filter((item) => ALLOWED_MODEL_PREFIXES.some((prefix) => item.startsWith(prefix)))
    .filter((item) => candidateIds.has(item));
  return unique(matches).slice(0, 40);
}

function extractHfTrending(html) {
  if (!html) return [];
  const matches = [...html.matchAll(/href="\/(?:models\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"/g)]
    .map((item) => item[1].toLowerCase())
    .filter((item) => !item.startsWith("datasets/"));
  return unique(matches).slice(0, 60);
}

function extractArenaNames(html) {
  if (!html) return [];
  const matches = [...html.matchAll(/[\"'\s>]([a-z0-9][a-z0-9.-]{7,})[\"'<\s]/gi)]
    .map((item) => item[1].toLowerCase())
    .filter((item) => /[a-z]/.test(item) && /\d/.test(item))
    .filter((item) => item.includes("-"))
    .filter((item) => !item.startsWith("http"))
    .filter((item) => !item.includes("css"))
    .filter((item) => !item.includes("chunk"))
    .filter((item) => !item.startsWith("w-"))
    .filter((item) => !item.startsWith("h-"))
    .filter((item) => !item.startsWith("p-"))
    .filter((item) => !item.startsWith("m-"))
    .filter((item) => !item.startsWith("text-"))
    .filter((item) => !item.startsWith("bg-"));
  return unique(matches).slice(0, 120);
}

function pickModel(candidates, signals, preferredId) {
  if (!candidates.length) return null;

  const ranked = candidates
    .map((candidate) => {
      const id = candidate.id.toLowerCase();
      const hfId = candidate.huggingFaceId;
      const parts = id.split(/[\/-]/g).filter(Boolean);
      const nameParts = candidate.name.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);

      let score = 0;

      const orIndex = signals.openrouter.indexOf(id);
      if (orIndex >= 0) score += 45 - Math.min(orIndex, 30);

      const hfHit = signals.hf.some((signal) => signal === hfId || signal === id || parts.some((part) => part.length > 3 && signal.includes(part)));
      if (hfHit) score += 25;

      const arenaHit = signals.arena.some((signal) => parts.some((part) => part.length > 4 && signal.includes(part)) || nameParts.some((part) => part.length > 4 && signal.includes(part)));
      if (arenaHit) score += 15;

      score += Math.min(candidate.contextLength / 32_000, 8);

      const pricePenalty = (candidate.prompt * 1_000_000 * 0.7) + (candidate.completion * 1_000_000 * 0.3);
      score -= pricePenalty;

      if (preferredId && candidate.id === preferredId) score += 5;

      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  return ranked[0] ?? null;
}

async function collectFeedItems() {
  const results = await Promise.all(TREND_FEEDS.map(async (feed) => {
    const xml = await safeFetchText(feed.url);
    if (!xml) return [];
    return parseRssItems(xml, feed.source);
  }));

  const combined = uniqueBy(
    results.flat().filter((item) => item.url),
    (item) => item.url
  )
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, 50);

  return {
    items: combined,
    sourcesFetched: results.filter((entry) => entry.length > 0).length
  };
}

function parseRssItems(xml, sourceName) {
  const itemBlocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((item) => item[0]);
  const entryBlocks = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((item) => item[0]);
  const blocks = itemBlocks.length ? itemBlocks : entryBlocks;

  return blocks
    .map((block) => {
      const title = decodeXml(getTagContent(block, "title"));
      const link = decodeXml(getLinkContent(block));
      const pubDateRaw = decodeXml(getTagContent(block, "pubDate") || getTagContent(block, "updated"));
      const summary = decodeXml(stripHtml(getTagContent(block, "description") || getTagContent(block, "content") || getTagContent(block, "summary")));
      const image = decodeXml(getMediaImage(block));
      const publishedAt = toTimestamp(pubDateRaw);

      if (!title || !link || !Number.isFinite(publishedAt)) return null;

      return {
        title: cleanText(title),
        source: sourceName,
        date: formatDate(pubDateRaw),
        summary: cleanText(summary).slice(0, 260),
        image,
        url: link,
        publishedAt
      };
    })
    .filter(Boolean);
}

async function generateTrendsWithModel({ model, items, currentItems }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return [];

  const trimmedCandidates = items.slice(0, 30).map((item, index) => ({
    id: index + 1,
    title: item.title,
    source: item.source,
    date: item.date,
    summary: item.summary,
    url: item.url,
    image: item.image || ""
  }));

  const prompt = [
    "Pick the 6 most relevant current software and AI trends.",
    "Use only provided candidates.",
    "Return strict JSON with shape: {\"items\":[{\"title\":\"\",\"source\":\"\",\"date\":\"\",\"summary\":\"\",\"url\":\"\",\"image\":\"\"}]}",
    "Rules:",
    "- exactly 6 items",
    "- no duplicates by URL",
    "- summary max 180 characters",
    "- keep source names concise",
    "Candidates:",
    JSON.stringify(trimmedCandidates)
  ].join("\n");

  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || "https://github.com",
      "X-Title": "portfolio-trend-updater"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You return compact valid JSON only."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    return [];
  }

  const payload = await response.json();
  const rawText = payload?.choices?.[0]?.message?.content;
  const parsed = extractJson(rawText);
  const drafts = Array.isArray(parsed?.items) ? parsed.items : [];

  const itemMap = new Map(items.map((item) => [item.url, item]));
  const resolved = [];

  for (const draft of drafts) {
    const url = cleanText(String(draft?.url || ""));
    if (!itemMap.has(url)) continue;

    const base = itemMap.get(url);
    const title = cleanText(String(draft?.title || base.title)).slice(0, 120);
    const source = cleanText(String(draft?.source || base.source)).slice(0, 50);
    const date = cleanText(String(draft?.date || base.date)).slice(0, 40);
    const summary = cleanText(String(draft?.summary || base.summary || "")).slice(0, 180);
    const image = cleanText(String(draft?.image || base.image || ""));

    resolved.push({ title, source, date, summary, image, url });
  }

  const deduped = uniqueBy(resolved, (item) => item.url).slice(0, DAILY_TRENDS_COUNT);

  if (deduped.length < DAILY_TRENDS_COUNT) {
    const backup = items
      .filter((item) => !deduped.some((entry) => entry.url === item.url))
      .slice(0, DAILY_TRENDS_COUNT - deduped.length)
      .map((item) => ({
        title: item.title,
        source: item.source,
        date: item.date,
        summary: item.summary.slice(0, 180),
        image: item.image || "",
        url: item.url
      }));
    deduped.push(...backup);
  }

  const hydrated = await Promise.all(deduped.map(async (item, index) => {
    const currentImage = item.image || (currentItems[index]?.image ?? "");
    if (currentImage) return { ...item, image: currentImage };

    const image = await extractOgImage(item.url);
    return { ...item, image: image || (currentItems[index]?.image ?? "") };
  }));

  return hydrated.filter((item) => item.title && item.url).slice(0, DAILY_TRENDS_COUNT);
}

function countTrendChanges(before, after) {
  const beforeUrls = before.map((item) => item.url).join("|");
  const afterUrls = after.map((item) => item.url).join("|");
  if (beforeUrls === afterUrls) return 0;

  const beforeSet = new Set(before.map((item) => item.url));
  return after.reduce((total, item) => total + (beforeSet.has(item.url) ? 0 : 1), 0);
}

function getTagContent(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripCdata(match[1]) : "";
}

function getLinkContent(xml) {
  const direct = getTagContent(xml, "link");
  if (direct && /^https?:\/\//i.test(direct)) return direct;

  const atomLink = xml.match(/<link[^>]+href="([^"]+)"[^>]*>/i);
  return atomLink ? atomLink[1] : "";
}

function getMediaImage(xml) {
  const media = xml.match(/<media:(?:thumbnail|content)[^>]*url="([^"]+)"[^>]*>/i);
  if (media?.[1]) return media[1];

  const enclosure = xml.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image[^\"]*"[^>]*>/i);
  if (enclosure?.[1]) return enclosure[1];

  const ogImage = xml.match(/<img[^>]*src="([^"]+)"[^>]*>/i);
  return ogImage?.[1] || "";
}

async function extractOgImage(url) {
  const html = await safeFetchText(url);
  if (!html) return "";

  const meta = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i);
  return meta?.[1] || "";
}

function decodeXml(value) {
  if (!value) return "";
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x27;/g, "'");
}

function stripCdata(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripHtml(value) {
  return value.replace(/<[^>]+>/g, " ");
}

function cleanText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function toTimestamp(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : NaN;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  });
}

function formatPerMillion(pricePerToken) {
  return `$${(pricePerToken * 1_000_000).toFixed(3)}/M`;
}

function extractJson(value) {
  if (!value || typeof value !== "string") return null;
  const direct = safeJsonParse(value);
  if (direct) return direct;

  const match = value.match(/\{[\s\S]*\}/);
  if (!match) return null;
  return safeJsonParse(match[0]);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function safeFetchText(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "portfolio-trend-updater/1.0"
      }
    });
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  }
}

function unique(items) {
  return [...new Set(items)];
}

function uniqueBy(items, keySelector) {
  const map = new Map();
  for (const item of items) {
    const key = keySelector(item);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

async function writeGithubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) return;

  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${escapeOutput(String(value))}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, "utf8");
}

function escapeOutput(value) {
  return value.replace(/%/g, "%25").replace(/\n/g, "%0A").replace(/\r/g, "%0D");
}

function printSummary(outputs) {
  const summary = {
    mode: outputs.mode,
    changed: outputs.changed,
    modelPrevious: outputs.model_previous,
    modelSelected: outputs.model_selected,
    modelChanged: outputs.model_changed,
    trendsUpdatedCount: outputs.trends_updated_count,
    sourcesCount: outputs.sources_count
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(async (error) => {
  await writeGithubOutputs({
    mode,
    changed: "false",
    model_previous: "",
    model_selected: "",
    model_changed: "false",
    model_price_input: "",
    model_price_output: "",
    trends_updated_count: "0",
    sources_count: "0",
    signal_openrouter: "",
    signal_hf: "",
    signal_arena: ""
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
