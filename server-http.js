import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as cheerio from "cheerio";

const BASE = "https://tafsir.net";
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ar,en;q=0.9",
};

// ── scrapers ────────────────────────────────────────────────────
async function getHTML(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.text();
}

function parseList(html) {
  const $ = cheerio.load(html);
  const items = [];
  for (const sel of [".views-row", "article", ".node--type-article", ".node--type-research"]) {
    $(sel).each((_, el) => {
      const a = $(el).find("h3 a, h2 a, .views-field-title a").first();
      const title = a.text().trim();
      let href = a.attr("href") || "";
      if (href && !href.startsWith("http")) href = BASE + href;
      if (title) items.push({
        title, url: href,
        author:  $(el).find("[class*='author'] a").first().text().trim(),
        date:    $(el).find("time").first().text().trim(),
        summary: $(el).find("[class*='body'], p").first().text().trim().slice(0, 200),
      });
    });
    if (items.length) break;
  }
  if (!items.length) {
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (/\/(articles|researchs|researches|interviews|papers|translations|lessons)\/\d+$/.test(href)) {
        const title = $(el).text().trim();
        if (title.length > 10)
          items.push({ title, url: href.startsWith("http") ? href : BASE + href, author:"", date:"", summary:"" });
      }
    });
  }
  let lastPage = 1;
  $("a[href*='page=']").each((_, el) => {
    const m = ($(el).attr("href")||"").match(/page=(\d+)/);
    if (m) lastPage = Math.max(lastPage, +m[1] + 1);
  });
  return { items: [...new Map(items.map(i=>[i.url,i])).values()], lastPage };
}

function parseArticle(html, url) {
  const $ = cheerio.load(html);
  return {
    url,
    title:    $("h1.page-title,h1[class*='title'],h1").first().text().trim(),
    author:   $(".field--name-field-author a,[class*='author'] a").first().text().trim(),
    date:     $("time[datetime]").first().attr("datetime") || $("time").first().text().trim(),
    category: $(".field--name-field-category a,[class*='category'] a").first().text().trim(),
    fullText: $(".field--name-body,.field--type-text-with-summary,article .content").first()
                .text().replace(/\s+/g," ").trim().slice(0, 5000),
    attachments: $("a[href$='.pdf']").map((_,el)=>{
      const h=$(el).attr("href"); return h?.startsWith("http")?h:BASE+h;
    }).get(),
  };
}

function parseAuthor(html, url) {
  const $ = cheerio.load(html);
  const works = [];
  $("a[href]").each((_,el)=>{
    const href=$(el).attr("href")||"";
    if (/\/(articles|researchs|researches|interviews|papers|translations)\/\d+/.test(href)){
      const title=$(el).text().trim();
      if (title.length>10) works.push({title, url: href.startsWith("http")?href:BASE+href});
    }
  });
  return { url, name:$("h1").first().text().trim(),
    bio: $(".field--name-body,[class*='bio']").first().text().trim().slice(0,500),
    works: [...new Map(works.map(w=>[w.url,w])).values()] };
}

const TYPES = { مقالات:"articles", بحوث:"researches", حوارات:"interviews",
                استشراق:"papers", ترجمات:"translations", دروس:"lessons", تعريفات:"definitions" };

// ── MCP factory ─────────────────────────────────────────────────
function buildServer() {
  const srv = new Server({ name:"tafsir-mcp", version:"3.0.0" }, { capabilities:{ tools:{} } });

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools:[
    { name:"search",         description:"البحث الكامل في موقع تفسير — عنوان أو محتوى أو كاتب",
      inputSchema:{ type:"object", properties:{ query:{type:"string"}, page:{type:"number",default:0} }, required:["query"] } },
    { name:"get_content",    description:"جلب المحتوى الكامل لأي مقال أو بحث برابطه",
      inputSchema:{ type:"object", properties:{ url:{type:"string"} }, required:["url"] } },
    { name:"browse",         description:"تصفح قائمة المحتوى — الأنواع: مقالات بحوث حوارات استشراق ترجمات دروس تعريفات",
      inputSchema:{ type:"object", properties:{ type:{type:"string"}, page:{type:"number",default:0} }, required:["type"] } },
    { name:"get_author",     description:"جلب صفحة كاتب وجميع أعماله برابط صفحته",
      inputSchema:{ type:"object", properties:{ url:{type:"string"} }, required:["url"] } },
    { name:"search_author",  description:"البحث عن كاتب باسمه وإيجاد أعماله",
      inputSchema:{ type:"object", properties:{ name:{type:"string"} }, required:["name"] } },
    { name:"get_multiple",   description:"جلب محتوى عدة مقالات دفعة واحدة (حتى 5 روابط)",
      inputSchema:{ type:"object", properties:{ urls:{type:"array",items:{type:"string"}} }, required:["urls"] } },
    { name:"browse_category",description:"تصفح تصنيف موضوعي معين برابطه أو اسمه",
      inputSchema:{ type:"object", properties:{ url:{type:"string"}, page:{type:"number",default:0} }, required:["url"] } },
  ]}));

  srv.setRequestHandler(CallToolRequestSchema, async ({ params:{ name, arguments:a } }) => {
    const ok  = d => ({ content:[{ type:"text", text:JSON.stringify(d,null,2) }] });
    const err = e => ({ content:[{ type:"text", text:`❌ ${e}` }], isError:true });
    try {
      switch(name){
        case "search": {
          const html = await getHTML(`${BASE}/search?keys=${encodeURIComponent(a.query)}&page=${a.page??0}`);
          const $ = cheerio.load(html);
          const results=[];
          $(".search-result,.views-row,article").each((_,el)=>{
            const t=$(el).find("h3 a,h2 a").first();
            const title=t.text().trim();
            let href=t.attr("href")||"";
            if(href&&!href.startsWith("http")) href=BASE+href;
            if(title) results.push({title,url:href,
              author:$(el).find("[class*='author'] a").first().text().trim(),
              snippet:$(el).find("p").first().text().trim().slice(0,250)});
          });
          if(!results.length) $("a[href]").each((_,el)=>{
            const href=$(el).attr("href")||"";
            if(/\/(articles|researchs|researches|interviews|papers)\/\d+/.test(href)){
              const title=$(el).text().trim();
              if(title.length>10) results.push({title,url:href.startsWith("http")?href:BASE+href,author:"",snippet:""});
            }
          });
          return ok({ query:a.query, count:results.length, results });
        }
        case "get_content": {
          const url=a.url.startsWith("http")?a.url:BASE+a.url;
          return ok(parseArticle(await getHTML(url), url));
        }
        case "browse": {
          const path=TYPES[a.type];
          if(!path) throw new Error(`نوع غير معروف: ${a.type}`);
          const {items,lastPage}=parseList(await getHTML(`${BASE}/${path}?page=${a.page??0}`));
          return ok({type:a.type, page:a.page??0, lastPage, count:items.length, items});
        }
        case "get_author": {
          const url=a.url.startsWith("http")?a.url:BASE+a.url;
          return ok(parseAuthor(await getHTML(url), url));
        }
        case "search_author": {
          const html=await getHTML(`${BASE}/search?keys=${encodeURIComponent(a.name)}`);
          const $=cheerio.load(html);
          const authors=[];
          $("a[href*='/authors/']").each((_,el)=>{
            const href=$(el).attr("href")||"";
            const name=$(el).text().trim();
            if(name.length>2){
              const url=href.startsWith("http")?href:BASE+href;
              if(!authors.find(x=>x.url===url)) authors.push({name,url});
            }
          });
          if(authors.length===1){
            return ok(parseAuthor(await getHTML(authors[0].url), authors[0].url));
          }
          return ok({query:a.name, found:authors.length, authors});
        }
        case "get_multiple": {
          const urls=(a.urls||[]).slice(0,5);
          const res=await Promise.allSettled(urls.map(async u=>{
            const url=u.startsWith("http")?u:BASE+u;
            return parseArticle(await getHTML(url),url);
          }));
          return ok({count:urls.length, articles:res.map((r,i)=>r.status==="fulfilled"?r.value:{url:urls[i],error:r.reason?.message})});
        }
        case "browse_category": {
          let url=a.url;
          if(!url.startsWith("http")&&!url.startsWith("/")){
            const $=cheerio.load(await getHTML(`${BASE}/search?keys=${encodeURIComponent(url)}`));
            const l=$("a[href*='/category/']").first();
            if(!l.length) throw new Error(`لم أجد تصنيفاً: ${url}`);
            url=l.attr("href");
          }
          if(!url.startsWith("http")) url=BASE+url;
          const html=await getHTML(`${url}?page=${a.page??0}`);
          const {items,lastPage}=parseList(html);
          const cat=cheerio.load(html)("h1").first().text().trim();
          return ok({category:cat, url, count:items.length, lastPage, items});
        }
        default: throw new Error(`أداة غير معروفة: ${name}`);
      }
    } catch(e){ return err(e.message); }
  });
  return srv;
}

// ── Express HTTP server ──────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
const sessions = {};

app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin","*");
  res.header("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers","Content-Type,Authorization");
  if(req.method==="OPTIONS"){ res.sendStatus(204); return; }
  next();
});

// health check
app.get("/", (_,res) => res.json({ name:"tafsir-mcp", version:"3.0.0", status:"running" }));

// SSE — كل client يفتح connection جديدة
app.get("/sse", async (req,res)=>{
  const transport = new SSEServerTransport("/messages", res);
  sessions[transport.sessionId] = transport;
  res.on("close", ()=> delete sessions[transport.sessionId]);
  const server = buildServer();
  await server.connect(transport);
});

// POST messages من الـ client
app.post("/messages", express.raw({type:"*/*"}), async (req,res)=>{
  const id = req.query.sessionId;
  const t  = sessions[id];
  if(!t){ res.status(404).send("session not found"); return; }
  try {
    await t.handlePostMessage(req, res, JSON.parse(req.body.toString()));
  } catch(e){
    res.status(500).send(e.message);
  }
});

app.listen(PORT, ()=>{
  console.log(`🕌 Tafsir MCP v3 يعمل على المنفذ ${PORT}`);
});
