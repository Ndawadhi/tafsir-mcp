#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as cheerio from "cheerio";

const BASE = "https://tafsir.net";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ar,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ── أنواع المحتوى المتاحة ─────────────────────────────────────
const CONTENT_TYPES = {
  مقالات:   { path: "articles",   label: "مقالات" },
  بحوث:     { path: "researches", label: "بحوث" },
  حوارات:   { path: "interviews", label: "حوارات" },
  استشراق:  { path: "papers",     label: "استشراق" },
  ترجمات:   { path: "translations", label: "ترجمات" },
  دروس:     { path: "lessons",    label: "دروس ومحاضرات" },
  تعريفات:  { path: "definitions", label: "تعريفات كتب" },
};

// ── دالة جلب HTML ─────────────────────────────────────────────
async function getHTML(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return await res.text();
}

// ── استخراج بطاقة مقال من عنصر cheerio ──────────────────────
function extractCard($, el) {
  const $el = $(el);
  const titleEl = $el.find("h3 a, h2 a, .views-field-title a, .field--name-title a").first();
  const title = titleEl.text().trim();
  let href  = titleEl.attr("href") || "";
  if (href && !href.startsWith("http")) href = BASE + href;

  const author  = $el.find(".views-field-field-author a, .field--name-field-author a, [class*='author'] a").first().text().trim();
  const date    = $el.find("time, .date-display-single, [class*='date']").first().text().trim();
  const summary = $el.find(".field--name-body, .views-field-body, [class*='summary'], p").first().text().trim().slice(0, 200);

  return title ? { title, url: href, author, date, summary } : null;
}

// ── استخراج صفحة قائمة (listing page) ───────────────────────
function parseListingPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  // محاولات متعددة لأنماط Drupal المختلفة
  const selectors = [
    ".views-row",
    "article",
    ".node--type-article",
    ".node--type-research",
    ".views-infinite-scroll-content-wrapper > div",
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const card = extractCard($, el);
      if (card) items.push(card);
    });
    if (items.length > 0) break;
  }

  // Fallback: جمع كل الروابط التي تشبه مقالات
  if (items.length === 0) {
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      const match = href.match(/\/(articles|researchs|researches|interviews|papers|translations|lessons)\/(\d+)$/);
      if (match) {
        const title = $(el).text().trim();
        if (title.length > 10) {
          items.push({
            title,
            url: href.startsWith("http") ? href : BASE + href,
            author: "", date: "", summary: "",
          });
        }
      }
    });
  }

  // رقم الصفحة الأخيرة
  let lastPage = 1;
  $("a[href*='page=']").each((_, el) => {
    const m = ($(el).attr("href") || "").match(/page=(\d+)/);
    if (m) lastPage = Math.max(lastPage, parseInt(m[1]) + 1);
  });

  return { items: [...new Map(items.map(i => [i.url, i])).values()], lastPage };
}

// ── استخراج محتوى مقال كامل ──────────────────────────────────
function parseArticlePage(html, url) {
  const $ = cheerio.load(html);

  const title = $("h1.page-title, h1[class*='title'], .field--name-title h1, h1").first().text().trim();

  const author = $(".field--name-field-author a, [class*='author'] a, .author a").first().text().trim()
    || $("[class*='author']").first().text().replace(/الكاتب|المؤلف/g, "").trim();

  const date = $("time[datetime], .field--name-created time, .date").first().attr("datetime")
    || $("time").first().text().trim();

  const category = $(".field--name-field-category a, .taxonomy-term a, [class*='category'] a").first().text().trim();

  // المحتوى الكامل
  const bodyEl = $(".field--name-body, .field--type-text-with-summary, article .content, .node__content").first();
  const fullText = bodyEl.text().replace(/\s+/g, " ").trim();

  // PDF أو ملفات مرفقة
  const attachments = [];
  $("a[href$='.pdf'], a[href*='files/']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) attachments.push(href.startsWith("http") ? href : BASE + href);
  });

  // مقالات مقترحة
  const related = [];
  $(".view-id-related a, [class*='related'] a").each((_, el) => {
    const t = $(el).text().trim();
    const h = $(el).attr("href");
    if (t && h && t.length > 10) related.push({ title: t, url: h.startsWith("http") ? h : BASE + h });
  });

  return { url, title, author, date, category, fullText: fullText.slice(0, 5000), attachments, related };
}

// ── استخراج صفحة مؤلف ─────────────────────────────────────────
function parseAuthorPage(html, url) {
  const $ = cheerio.load(html);
  const name = $("h1").first().text().trim();
  const bio  = $(".field--name-body, .user-bio, [class*='bio']").first().text().trim().slice(0, 500);
  const works = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/\/(articles|researchs|researches|interviews|papers|translations)\/(\d+)/);
    if (match) {
      const title = $(el).text().trim();
      if (title.length > 10) {
        works.push({ title, url: href.startsWith("http") ? href : BASE + href, type: match[1] });
      }
    }
  });

  return { url, name, bio, works: [...new Map(works.map(w => [w.url, w])).values()] };
}

// ══════════════════════════════════════════════════════════════
//  تعريف السيرفر
// ══════════════════════════════════════════════════════════════
const server = new Server(
  { name: "tafsir-mcp", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // 1. بحث شامل
    {
      name: "search",
      description: `البحث الكامل في موقع تفسير بالعنوان أو المحتوى أو اسم الكاتب.
يمكن استخدامه للعثور على مقالة بعينها أو موضوع معين.`,
      inputSchema: {
        type: "object",
        properties: {
          query:    { type: "string",  description: "كلمة أو عبارة البحث" },
          page:     { type: "number",  description: "رقم الصفحة (ابدأ من 0)", default: 0 },
        },
        required: ["query"],
      },
    },

    // 2. جلب محتوى كامل لمقال/بحث
    {
      name: "get_content",
      description: `جلب المحتوى الكامل لأي مقال أو بحث أو حوار.
أعطه رابط URL كامل أو مسار مثل /articles/24766`,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "رابط المقال أو البحث (مثال: https://tafsir.net/articles/24766)" },
        },
        required: ["url"],
      },
    },

    // 3. تصفح المحتوى حسب النوع
    {
      name: "browse",
      description: `تصفح قائمة المقالات أو البحوث أو الحوارات مع دعم الصفحات.
الأنواع: مقالات، بحوث، حوارات، استشراق، ترجمات، دروس، تعريفات`,
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "نوع المحتوى",
            enum: ["مقالات", "بحوث", "حوارات", "استشراق", "ترجمات", "دروس", "تعريفات"],
          },
          page: { type: "number", description: "رقم الصفحة (ابدأ من 0)", default: 0 },
        },
        required: ["type"],
      },
    },

    // 4. البحث عن كاتب وأعماله
    {
      name: "get_author",
      description: `جلب صفحة كاتب وجميع أعماله المنشورة في الموقع.
أعطه رابط صفحة الكاتب أو معرّفه (مثال: /authors/6105)`,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "رابط صفحة الكاتب (مثال: https://tafsir.net/authors/6105)" },
        },
        required: ["url"],
      },
    },

    // 5. البحث عن كاتب باسمه
    {
      name: "search_author",
      description: "البحث عن كاتب باسمه للعثور على صفحته وأعماله",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "اسم الكاتب أو جزء منه" },
        },
        required: ["name"],
      },
    },

    // 6. جلب عدة مقالات دفعة واحدة
    {
      name: "get_multiple",
      description: "جلب محتوى عدة مقالات أو بحوث دفعة واحدة بإعطاء قائمة روابط",
      inputSchema: {
        type: "object",
        properties: {
          urls: {
            type: "array",
            items: { type: "string" },
            description: "قائمة روابط المقالات (حتى 5 روابط)",
          },
        },
        required: ["urls"],
      },
    },

    // 7. تصفح تصنيف معين
    {
      name: "browse_category",
      description: "تصفح محتويات تصنيف أو ملف موضوعي معين",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "رابط التصنيف (مثال: https://tafsir.net/category/411) أو كلمة تصفها مثل: علوم القرآن",
          },
          page: { type: "number", default: 0 },
        },
        required: ["url"],
      },
    },
  ],
}));

// ══════════════════════════════════════════════════════════════
//  تنفيذ الأدوات
// ══════════════════════════════════════════════════════════════
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      // ── 1. بحث شامل ─────────────────────────────────────────
      case "search": {
        const page = args.page ?? 0;
        const url  = `${BASE}/search?keys=${encodeURIComponent(args.query)}&page=${page}`;
        const html = await getHTML(url);
        const $    = cheerio.load(html);

        const results = [];
        // Drupal search results
        $(".search-result, .views-row, article").each((_, el) => {
          const $el = $(el);
          const titleEl = $el.find("h3 a, h2 a, .search-result__title a").first();
          const title  = titleEl.text().trim();
          let   href   = titleEl.attr("href") || "";
          if (href && !href.startsWith("http")) href = BASE + href;
          const snippet = $el.find(".search-snippet-info, .search-result__snippet, p").first().text().trim().slice(0, 250);
          const author  = $el.find("[class*='author'] a, .field--name-field-author a").first().text().trim();
          if (title) results.push({ title, url: href, author, snippet });
        });

        // Fallback إذا كان HTML مختلف
        if (results.length === 0) {
          $("a[href]").each((_, el) => {
            const href = $(el).attr("href") || "";
            if (href.match(/\/(articles|researchs|researches|interviews|papers|translations)\/\d+/)) {
              const title = $(el).text().trim();
              if (title.length > 10) {
                results.push({ title, url: href.startsWith("http") ? href : BASE + href, author: "", snippet: "" });
              }
            }
          });
        }

        // هل هناك صفحات أخرى؟
        let totalPages = 1;
        $("a[href*='page=']").each((_, el) => {
          const m = ($(el).attr("href") || "").match(/page=(\d+)/);
          if (m) totalPages = Math.max(totalPages, parseInt(m[1]) + 1);
        });

        return text({ query: args.query, page, totalPages, count: results.length, results });
      }

      // ── 2. محتوى كامل ───────────────────────────────────────
      case "get_content": {
        let url = args.url;
        if (!url.startsWith("http")) url = BASE + url;
        const html = await getHTML(url);
        return text(parseArticlePage(html, url));
      }

      // ── 3. تصفح حسب النوع ───────────────────────────────────
      case "browse": {
        const ct   = CONTENT_TYPES[args.type];
        if (!ct) throw new Error(`نوع غير معروف: ${args.type}. الأنواع المتاحة: ${Object.keys(CONTENT_TYPES).join("، ")}`);
        const page = args.page ?? 0;
        const url  = `${BASE}/${ct.path}?page=${page}`;
        const html = await getHTML(url);
        const { items, lastPage } = parseListingPage(html);
        return text({ type: args.type, page, lastPage, count: items.length, items });
      }

      // ── 4. صفحة كاتب ────────────────────────────────────────
      case "get_author": {
        let url = args.url;
        if (!url.startsWith("http")) url = BASE + url;
        const html = await getHTML(url);
        return text(parseAuthorPage(html, url));
      }

      // ── 5. بحث عن كاتب باسمه ────────────────────────────────
      case "search_author": {
        // ابحث في الموقع عن اسم الكاتب
        const searchUrl = `${BASE}/search?keys=${encodeURIComponent(args.name)}`;
        const html = await getHTML(searchUrl);
        const $ = cheerio.load(html);

        const authors = [];
        $("a[href*='/authors/']").each((_, el) => {
          const href  = $(el).attr("href") || "";
          const title = $(el).text().trim();
          if (title.length > 2) {
            const url = href.startsWith("http") ? href : BASE + href;
            if (!authors.find(a => a.url === url)) authors.push({ name: title, url });
          }
        });

        // إذا وجدنا كاتباً واحداً فقط، جلب صفحته كاملاً
        if (authors.length === 1) {
          const authorHtml = await getHTML(authors[0].url);
          return text(parseAuthorPage(authorHtml, authors[0].url));
        }

        return text({ query: args.name, found: authors.length, authors });
      }

      // ── 6. عدة مقالات دفعة واحدة ────────────────────────────
      case "get_multiple": {
        const urls = (args.urls || []).slice(0, 5); // حد أقصى 5
        const results = await Promise.allSettled(
          urls.map(async (url) => {
            if (!url.startsWith("http")) url = BASE + url;
            const html = await getHTML(url);
            return parseArticlePage(html, url);
          })
        );
        const output = results.map((r, i) =>
          r.status === "fulfilled"
            ? r.value
            : { url: urls[i], error: r.reason?.message }
        );
        return text({ count: output.length, articles: output });
      }

      // ── 7. تصفح تصنيف ───────────────────────────────────────
      case "browse_category": {
        let url = args.url;
        // إذا أرسل كلمة وليس رابطاً، ابحث عنها أولاً
        if (!url.startsWith("http") && !url.startsWith("/")) {
          const searchHtml = await getHTML(`${BASE}/search?keys=${encodeURIComponent(url)}`);
          const $ = cheerio.load(searchHtml);
          const catLink = $("a[href*='/category/']").first();
          if (catLink.length) {
            url = catLink.attr("href");
          } else {
            throw new Error(`لم أجد تصنيفاً باسم: ${url}`);
          }
        }
        if (!url.startsWith("http")) url = BASE + url;
        const page = args.page ?? 0;
        const finalUrl = `${url}?page=${page}`;
        const html = await getHTML(finalUrl);
        const { items, lastPage } = parseListingPage(html);
        const $ = cheerio.load(html);
        const catTitle = $("h1").first().text().trim();
        return text({ category: catTitle, url: finalUrl, page, lastPage, count: items.length, items });
      }

      default:
        throw new Error(`أداة غير معروفة: ${name}`);
    }
  } catch (err) {
    return { content: [{ type: "text", text: `❌ خطأ: ${err.message}` }], isError: true };
  }
});

// helper
function text(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("🕌 Tafsir MCP v3 — جاهز!");
