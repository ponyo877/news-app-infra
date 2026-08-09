// まとめくん推薦基盤。
//
// 役割:
//   1. 取り込みcron(5分毎): 本番API /v1/article から新着を取得し、タイトルを
//      Workers AI (bge-m3・日本語対応・1024次元) で埋め込み、Vectorizeへupsert
//   2. 掃除cron(毎時17分): RETENTION_MS を超えた古いベクトルを削除
//      (Vectorize Freeは5M次元=約4,800記事しか持てないため、掃除が生命線)
//   3. POST /recs/foryou: 端末が送る直近閲覧IDからユーザーベクトルを合成しtopK検索
//   4. POST /recs/related: 今読んでいる記事×ユーザーの加重ベクトルで「次に読む」を検索
//
// 設計方針:
//   - ステートレス: 閲覧履歴は端末が毎回送る。サーバはユーザー状態を一切持たない
//   - 失敗時はアプリ側が端末内リランクへ縮退するため、ここでは素直にエラーを返す

import { handleMatsuriList, updateMatsuri } from './matsuri';

export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  KV: KVNamespace;
  // wrangler secret put INGEST_TOKEN(VMの/etc/news-app/envのCRON_TOKENと同値)
  INGEST_TOKEN?: string;
}

const ORIGIN = 'https://matome.folks-chat.com';
const EMBEDDING_MODEL = '@cf/baai/bge-m3';

// 保持期間。Vectorize Free(5M次元)は約4,800記事=2日分が上限。
// Workers Paidへ昇格したらここを 14日 に変えるだけでよい
const RETENTION_MS = 48 * 60 * 60 * 1000;

// 1回のcronで追う最大ページ数(15件/ページ)。通常は1ページ目で足りる
const MAX_INGEST_PAGES = 3;
// topKはreturnMetadata:'all'の上限が20
const QUERY_TOP_K = 20;
const FORYOU_MAX_PER_SITE = 3;
const RELATED_LIMIT = 10;
// ユーザーベクトル合成時の減衰率(新しい閲覧ほど重い。端末は新しい順で送る)
const RECENCY_DECAY = 0.9;
// relatedでの「今読んでいる記事」と「ユーザー嗜好」の配合
const RELATED_ARTICLE_WEIGHT = 0.7;

export interface ApiArticle {
  id: string;
  titles: string;
  url: string;
  image: string;
  siteID: string;
  sitetitle: string;
  publishedAt: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/recs/matsuri') {
      try {
        return await handleMatsuriList(env);
      } catch (error) {
        console.error('matsuri list error:', error);
        return json({ error: 'internal error' }, 500);
      }
    }
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405);
    }
    try {
      if (url.pathname === '/recs/foryou') {
        return await handleForYou(request, env);
      }
      if (url.pathname === '/recs/related') {
        return await handleRelated(request, env);
      }
      // 取り込み: Workers Freeのcron枠が他プロジェクトで埋まっているため、
      // OCI VMのsystemd timer(recs-ingest.timer・5分毎)がここを叩く
      if (url.pathname === '/internal/ingest') {
        if (!env.INGEST_TOKEN || request.headers.get('X-Cron-Token') !== env.INGEST_TOKEN) {
          return json({ error: 'not found' }, 404);
        }
        const ingested = await ingest(env);
        // 掃除も同じトリガーで賄う(毎時15分台のtickのみ。query枠の節約)
        let cleaned = 0;
        if (new Date().getMinutes() === 15) {
          cleaned = await cleanup(env);
        }
        return json({ ingested, cleaned });
      }
      return json({ error: 'not found' }, 404);
    } catch (error) {
      console.error('recs error:', error);
      return json({ error: 'internal error' }, 500);
    }
  },
};

// ---------------------------------------------------------------- 取り込み

async function ingest(env: Env): Promise<number> {
  const lastIngested = (await env.KV.get('lastPublishedAt')) ?? '';
  const fresh: ApiArticle[] = [];
  let cursor = '';

  for (let page = 0; page < MAX_INGEST_PAGES; page++) {
    const res = await fetch(
      `${ORIGIN}/v1/article?lastPublishedAt=${encodeURIComponent(cursor)}&skipIDs=`,
    );
    if (!res.ok) {
      console.error(`article API failed: ${res.status}`);
      return 0;
    }
    const body = (await res.json()) as { data: ApiArticle[] | null; lastPublishedAt: string };
    const articles = body.data ?? [];
    if (articles.length === 0) {
      break;
    }
    const unseen = articles.filter((a) => !lastIngested || a.publishedAt > lastIngested);
    fresh.push(...unseen);
    // ページ内に既知の記事が現れたら、それより古いページを追う必要はない
    if (unseen.length < articles.length) {
      break;
    }
    cursor = body.lastPublishedAt;
  }

  if (fresh.length === 0) {
    return 0;
  }

  const embeddings = await embedTexts(env, fresh.map((a) => a.titles));
  const now = Date.now();
  const vectors: VectorizeVector[] = fresh.map((a, i) => ({
    id: a.id,
    values: embeddings[i],
    metadata: {
      titles: a.titles.slice(0, 512),
      url: a.url,
      image: a.image,
      siteID: a.siteID,
      sitetitle: a.sitetitle,
      publishedAt: a.publishedAt,
      // 掃除cronのレンジフィルタ用(metadata indexはnumber型で作成する)
      publishedAtTs: Math.min(Date.parse(a.publishedAt) || now, now),
    },
  }));
  await env.VECTORIZE.upsert(vectors);

  try {
    // 祭り検知(同一トピックのクラスタリング)。失敗しても取り込みは止めない
    await updateMatsuri(env, fresh, embeddings);
  } catch (error) {
    console.error('matsuri update failed:', error);
  }

  const newest = fresh.reduce((max, a) => (a.publishedAt > max ? a.publishedAt : max), lastIngested);
  await env.KV.put('lastPublishedAt', newest);
  console.log(`ingested ${vectors.length} articles (through ${newest})`);
  return vectors.length;
}

async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  // bge-m3は1リクエスト最大100テキスト。取り込みは最大45件/回なので1回で足りる
  const result = (await env.AI.run(EMBEDDING_MODEL, { text: texts })) as {
    data: number[][];
  };
  if (!result.data || result.data.length !== texts.length) {
    throw new Error(`embedding count mismatch: ${result.data?.length} != ${texts.length}`);
  }
  return result.data;
}

// ---------------------------------------------------------------- 掃除

async function cleanup(env: Env): Promise<number> {
  const cutoff = Date.now() - RETENTION_MS;
  // queryにはベクトルが必須なのでゼロベクトルでfilterのみ効かせる。
  // returnMetadata:'none'ならtopK=100まで許される
  const zero = new Array(1024).fill(0);
  let deleted = 0;
  for (let round = 0; round < 10; round++) {
    const matches = await env.VECTORIZE.query(zero, {
      topK: 100,
      filter: { publishedAtTs: { $lt: cutoff } },
      returnValues: false,
      returnMetadata: 'none',
    });
    if (matches.matches.length === 0) {
      break;
    }
    await env.VECTORIZE.deleteByIds(matches.matches.map((m) => m.id));
    deleted += matches.matches.length;
  }
  if (deleted > 0) {
    console.log(`cleaned up ${deleted} expired vectors`);
  }
  return deleted;
}

// ---------------------------------------------------------------- 推薦API

interface ForYouRequest {
  recentArticleIds?: string[];
}

interface RelatedRequest {
  articleId?: string;
  recentArticleIds?: string[];
}

function sanitizeIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) {
    return [];
  }
  return ids
    .filter((id): id is string => typeof id === 'string' && /^[0-9a-fA-F-]{36}$/.test(id))
    .slice(0, 20);
}

// 端末の閲覧列(新しい順)から時間減衰付き平均でユーザーベクトルを合成する。
// getByIdsで見つからないID(保持期間切れ)は黙って無視する
async function buildUserVector(env: Env, recentIds: string[]): Promise<number[] | null> {
  if (recentIds.length === 0) {
    return null;
  }
  const found = await env.VECTORIZE.getByIds(recentIds);
  if (found.length === 0) {
    return null;
  }
  const weightById = new Map(recentIds.map((id, i) => [id, RECENCY_DECAY ** i]));
  const sum = new Array(1024).fill(0);
  let totalWeight = 0;
  for (const vector of found) {
    const weight = weightById.get(vector.id) ?? 1;
    const values = vector.values as number[];
    for (let i = 0; i < sum.length; i++) {
      sum[i] += values[i] * weight;
    }
    totalWeight += weight;
  }
  return sum.map((v) => v / totalWeight);
}

function matchToArticle(match: VectorizeMatch): ApiArticle | null {
  const m = match.metadata as Record<string, unknown> | undefined;
  if (!m || typeof m.titles !== 'string' || typeof m.url !== 'string') {
    return null;
  }
  return {
    id: match.id,
    titles: m.titles,
    url: m.url,
    image: typeof m.image === 'string' ? m.image : '',
    siteID: typeof m.siteID === 'string' ? m.siteID : '',
    sitetitle: typeof m.sitetitle === 'string' ? m.sitetitle : '',
    publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : '',
  };
}

async function handleForYou(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ForYouRequest;
  const recentIds = sanitizeIds(body.recentArticleIds);
  const userVector = await buildUserVector(env, recentIds);
  if (!userVector) {
    // 履歴なし・全部保持期間切れ → アプリは端末内リランクへ縮退する
    return json({ error: 'no user vector' }, 404);
  }
  const matches = await env.VECTORIZE.query(userVector, {
    topK: QUERY_TOP_K,
    returnValues: false,
    returnMetadata: 'all',
  });
  const read = new Set(recentIds);
  const perSite = new Map<string, number>();
  const articles: ApiArticle[] = [];
  for (const match of matches.matches) {
    if (read.has(match.id)) {
      continue;
    }
    const article = matchToArticle(match);
    if (!article) {
      continue;
    }
    const siteCount = perSite.get(article.siteID) ?? 0;
    if (siteCount >= FORYOU_MAX_PER_SITE) {
      continue;
    }
    perSite.set(article.siteID, siteCount + 1);
    articles.push(article);
  }
  return json({ data: articles });
}

async function handleRelated(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as RelatedRequest;
  const [articleId] = sanitizeIds([body.articleId]);
  if (!articleId) {
    return json({ error: 'articleId required' }, 400);
  }
  const [articleVector] = await env.VECTORIZE.getByIds([articleId]);
  if (!articleVector) {
    // 記事が古すぎてindexにない → アプリは関連なし扱い
    return json({ error: 'article vector not found' }, 404);
  }
  const articleValues = articleVector.values as number[];
  const recentIds = sanitizeIds(body.recentArticleIds).filter((id) => id !== articleId);
  const userVector = await buildUserVector(env, recentIds);

  // 「今読んでいる記事」を主、「ユーザー嗜好」を従とした加重和(Amazon型の人×記事推薦)
  const blended = userVector
    ? articleValues.map((v, i) => v * RELATED_ARTICLE_WEIGHT + userVector[i] * (1 - RELATED_ARTICLE_WEIGHT))
    : articleValues;

  const matches = await env.VECTORIZE.query(blended, {
    topK: QUERY_TOP_K,
    returnValues: false,
    returnMetadata: 'all',
  });
  const exclude = new Set([articleId, ...recentIds]);
  const articles: ApiArticle[] = [];
  for (const match of matches.matches) {
    if (exclude.has(match.id)) {
      continue;
    }
    const article = matchToArticle(match);
    if (!article) {
      continue;
    }
    articles.push(article);
    if (articles.length >= RELATED_LIMIT) {
      break;
    }
  }
  return json({ data: articles });
}
