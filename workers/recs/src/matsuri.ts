// 「祭り」検知(docs/PHASE2.5-DESIGN.md §A)。
// 複数のまとめサイトが同じスレを一斉にまとめたら祭り。
//
// Vectorize queryは使わない(月77M queried dimsでFree枠超過)。
// 代わりに直近6時間分の記事ベクトルをKVに保持し、取り込み時にWorker内で
// コサイン計算する(保存時に正規化済みなので内積=コサイン)。追加コストゼロ

import type { ApiArticle } from './index';

export interface MatsuriEnv {
  KV: KVNamespace;
  INGEST_TOKEN?: string;
}

// 類似判定の閾値。緩いと別話題が混ざり、厳しいと改題まとめを取りこぼす。
// 誤検知の方が信頼を毀損するため保守的な初期値(/recs/matsuriを観測して調整)
const SIMILARITY_THRESHOLD = 0.9;
// 祭りは数時間スケールの現象。このウィンドウ内の記事同士だけを比較する
const RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;
// 異なるサイト数がこの値に達したら「祭り」
export const MATSURI_SITE_COUNT = 3;
// 通知の頻度制御(鬱陶しさ対策): 同一クラスタ1回・1日最大2件・深夜帯は送らない
const NOTIFY_DAILY_LIMIT = 2;
const QUIET_HOURS_JST = { start: 23, end: 7 };
const CLUSTER_TTL_SECONDS = 48 * 60 * 60;
// /recs/matsuri で返すアクティブ祭りの鮮度と件数
const MATSURI_ACTIVE_MS = 24 * 60 * 60 * 1000;
const MATSURI_LIST_LIMIT = 10;

const ORIGIN = 'https://matome.folks-chat.com';

interface RecentVector extends ApiArticle {
  publishedAtTs: number;
  // 正規化済みFloat32Arrayのbase64
  v: string;
}

interface Cluster {
  articles: ApiArticle[];
  siteIds: string[];
  updatedAt: number;
}

interface MatsuriIndexEntry {
  clusterId: string;
  siteCount: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- ベクトル

function normalize(values: number[]): Float32Array {
  let norm = 0;
  for (const value of values) {
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  const unit = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    unit[i] = values[i] / norm;
  }
  return unit;
}

function encodeVector(unit: Float32Array): string {
  const bytes = new Uint8Array(unit.buffer, unit.byteOffset, unit.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function decodeVector(encoded: string): Float32Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

// ---------------------------------------------------------------- クラスタ更新

// 取り込みと同じトリガで呼ばれる。新記事を直近ベクトルと突き合わせ、
// 別サイトの類似記事があればクラスタへ併合し、閾値到達で通知を試みる
export async function updateMatsuri(
  env: MatsuriEnv,
  articles: ApiArticle[],
  embeddings: number[][],
): Promise<void> {
  const now = Date.now();
  const recent: RecentVector[] = JSON.parse((await env.KV.get('recent-vectors')) ?? '[]');
  const decoded = recent.map((entry) => decodeVector(entry.v));

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const unit = normalize(embeddings[i]);

    let matched: RecentVector | null = null;
    for (let j = 0; j < recent.length; j++) {
      if (recent[j].siteID === article.siteID) {
        continue;
      }
      if (dot(unit, decoded[j]) >= SIMILARITY_THRESHOLD) {
        matched = recent[j];
        break;
      }
    }
    if (matched) {
      await mergeIntoCluster(env, article, matched, now);
    }

    const entry: RecentVector = {
      ...article,
      publishedAtTs: Date.parse(article.publishedAt) || now,
      v: encodeVector(unit),
    };
    recent.push(entry);
    decoded.push(unit);
  }

  // 6時間ウィンドウの外を落として書き戻す(5M次元制約とは独立の祭り用キャッシュ)
  const cutoff = now - RECENT_WINDOW_MS;
  const kept = recent.filter((entry) => entry.publishedAtTs > cutoff);
  await env.KV.put('recent-vectors', JSON.stringify(kept));
}

function stripVector(entry: ApiArticle): ApiArticle {
  const { id, titles, url, image, siteID, sitetitle, publishedAt } = entry;
  return { id, titles, url, image, siteID, sitetitle, publishedAt };
}

async function mergeIntoCluster(
  env: MatsuriEnv,
  article: ApiArticle,
  matched: RecentVector,
  now: number,
): Promise<void> {
  const clusterId = (await env.KV.get(`article-cluster:${matched.id}`)) ?? matched.id;
  const cluster: Cluster = JSON.parse(
    (await env.KV.get(`cluster:${clusterId}`)) ??
      JSON.stringify({
        articles: [stripVector(matched)],
        siteIds: [matched.siteID],
        updatedAt: now,
      }),
  );

  if (!cluster.articles.some((existing) => existing.id === article.id)) {
    cluster.articles.push(stripVector(article));
  }
  if (!cluster.siteIds.includes(article.siteID)) {
    cluster.siteIds.push(article.siteID);
  }
  cluster.updatedAt = now;

  const ttl = { expirationTtl: CLUSTER_TTL_SECONDS };
  await env.KV.put(`cluster:${clusterId}`, JSON.stringify(cluster), ttl);
  await env.KV.put(`article-cluster:${article.id}`, clusterId, ttl);
  await env.KV.put(`article-cluster:${matched.id}`, clusterId, ttl);
  await updateMatsuriIndex(env, clusterId, cluster);

  if (cluster.siteIds.length >= MATSURI_SITE_COUNT) {
    await maybeNotify(env, clusterId, cluster);
  }
}

async function updateMatsuriIndex(
  env: MatsuriEnv,
  clusterId: string,
  cluster: Cluster,
): Promise<void> {
  const index: MatsuriIndexEntry[] = JSON.parse((await env.KV.get('matsuri-index')) ?? '[]');
  const filtered = index.filter(
    (entry) => entry.clusterId !== clusterId && Date.now() - entry.updatedAt < MATSURI_ACTIVE_MS,
  );
  filtered.push({ clusterId, siteCount: cluster.siteIds.length, updatedAt: cluster.updatedAt });
  await env.KV.put('matsuri-index', JSON.stringify(filtered));
}

// ---------------------------------------------------------------- 通知

async function maybeNotify(env: MatsuriEnv, clusterId: string, cluster: Cluster): Promise<void> {
  if (!env.INGEST_TOKEN) {
    return;
  }
  // 同一クラスタは1回だけ
  if (await env.KV.get(`matsuri-notified:${clusterId}`)) {
    return;
  }
  // 深夜帯(JST 23時〜7時)は送らない。朝のダイジェストに任せる
  const jstHour = (new Date().getUTCHours() + 9) % 24;
  if (jstHour >= QUIET_HOURS_JST.start || jstHour < QUIET_HOURS_JST.end) {
    return;
  }
  // 1日の上限(digest 2件と合わせて日4通まで)
  const jstDate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dailyKey = `matsuri-daily:${jstDate}`;
  const dailyCount = parseInt((await env.KV.get(dailyKey)) ?? '0', 10);
  if (dailyCount >= NOTIFY_DAILY_LIMIT) {
    return;
  }

  const top = cluster.articles[0];
  const response = await fetch(`${ORIGIN}/v1/notification/matsuri`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cron-Token': env.INGEST_TOKEN,
    },
    body: JSON.stringify({ ...top, siteCount: cluster.siteIds.length }),
  });
  if (!response.ok) {
    console.error(`matsuri notify failed: ${response.status}`);
    return;
  }
  await env.KV.put(`matsuri-notified:${clusterId}`, '1', {
    expirationTtl: CLUSTER_TTL_SECONDS,
  });
  await env.KV.put(dailyKey, String(dailyCount + 1), { expirationTtl: CLUSTER_TTL_SECONDS });
  console.log(`matsuri notified: ${top.titles} (${cluster.siteIds.length} sites)`);
}

// ---------------------------------------------------------------- 一覧API

// GET /recs/matsuri — アクティブな祭り一覧(24h以内・サイト数降順)
export async function handleMatsuriList(env: MatsuriEnv): Promise<Response> {
  const index: MatsuriIndexEntry[] = JSON.parse((await env.KV.get('matsuri-index')) ?? '[]');
  const active = index
    .filter(
      (entry) =>
        entry.siteCount >= MATSURI_SITE_COUNT && Date.now() - entry.updatedAt < MATSURI_ACTIVE_MS,
    )
    .sort((a, b) => b.siteCount - a.siteCount)
    .slice(0, MATSURI_LIST_LIMIT);

  const clusters = [];
  for (const entry of active) {
    const cluster: Cluster | null = JSON.parse(
      (await env.KV.get(`cluster:${entry.clusterId}`)) ?? 'null',
    );
    if (cluster) {
      clusters.push({
        clusterId: entry.clusterId,
        siteCount: cluster.siteIds.length,
        articles: cluster.articles,
      });
    }
  }
  return new Response(JSON.stringify({ data: clusters }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // 全ユーザー同一内容なのでエッジに60秒置ける
      'Cache-Control': 'public, max-age=60',
    },
  });
}
