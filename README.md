# news-app-infra

まとめくん(news-app)のインフラ構成一式。旧名 `news-app-docker`(2026-08-08 改名)。

## 現行構成(OCI・bare)

本番: `matome.folks-chat.com` → Cloudflare → **OCI VM(141.147.165.70・Ubuntu 24.04)**

- コンテナ不使用。Go バイナリ + apt の MySQL 8.0 / Redis / nginx を systemd で直接運用
- セットアップ・デプロイ・カットオーバー手順: **[iac/README.md](iac/README.md)**
- 日常デプロイ: `./iac/deploy-app.sh ubuntu@141.147.165.70`(Macからクロスコンパイル→scp→restart)

## DNS インベントリ(Cloudflare)

2026-08-08 の切替時に、matome ではなく **apex(別プロジェクトのえびてんチャット)** を誤って
本番VMへ向けてしまい約1日停止させた。**Cloudflare の監査ログは「変更後の値」しか残さない**ため
元IPを復元できず、復旧に難儀した。同じことを繰り返さないよう、正しい値をここに残す。

### まとめくんが依存するレコード(`folks-chat.com` ゾーン)

| 名前 | 種別 | 向き先 | 用途 |
|---|---|---|---|
| `matome.folks-chat.com` | A・プロキシ済み | 141.147.165.70(OCI) | API本体・着地ページ `/a/{id}`・AASA・assetlinks |
| `prom.folks-chat.com` | CNAME・プロキシ済み | pedantic-goldstine-826457.netlify.app | プロモーションサイト |

**この2件以外は、まとめくんの作業では一切触らない。** 同ゾーンには別プロジェクトが同居している:

| 名前 | 種別 | 向き先 | 用途 |
|---|---|---|---|
| `folks-chat.com`(apex) | A・プロキシ済み | **35.247.107.215**(GCP) | **えびてんチャット。2026-08-08 に誤変更した当該レコード** |
| `osusumou` / `umm-app` | A | 35.185.233.40 | おすすもう / 練習場検索 |
| `p2p` | A | 35.227.160.217 | P2P |
| `chatsh` | CNAME・DNSのみ | ghs.googlehosted.com | chatsh gRPC(Cloud Run) |
| `ogper` / `ogp-playground` / `sns-ogp` / `zennq-img` | R2 | — | 各種OGP画像 |
| `aws` / `dev` / `_dmarc` / `_domainkey` / `e` ほか | NS | dns1・dns2.onamae.com | 委譲 |

ゾーン全体は46レコード(上表は主要分)。全件は Cloudflare の DNS 画面 →「エクスポート」で取得できる。
`ponyo877.com` は別プロジェクト群(live / termchat / voxel / watchroom ほか)のゾーンで、まとめくんは使わない。
API を `matome.ponyo877.com` へ移す案は 2026-08-09 に**見送り**(DBに絶対URLが29,377件、出荷済みアプリ
1.45〜1.49、共有済み着地URLがあり旧ドメインを永久維持せざるを得ず、分離の効果が薄いため)。

### DNS を変更するときの手順

1. **変更前に `dig +short <name>` で現行値を控える** — 監査ログは変更後しか残らない
2. 変更は1レコードずつ。フォームの「名前」が意図した対象か目視してから保存する
3. 変更後は**対象と同ゾーンの主要ホストの両方**を確認する:
   ```bash
   curl -s https://matome.folks-chat.com/health          # {"status":"ok"}
   curl -s https://folks-chat.com/ | grep og:site_name   # えびてんチャット
   ```
4. 万一元の値を失ったら: `~/.ssh/known_hosts` の全IPへ `curl -H "Host: <domain>" http://<ip>/` を
   並列で投げ、既知の文字列(OGP等)で判定する。Cloudflare配下でもオリジンが直接応答すれば見つかる

### nginx の vhost を追加するときの注意

`sites-enabled` は**アルファベット順で最初の server が default server** になる。2026-08-09 に
`folks.conf` を一時追加した際 `matome.conf` が default を失い、本番APIが数分404になった。
現在は `matome.conf` の `listen` に `default_server` を明示済み(vhost を足しても安全)。

## レガシー構成(GCP・docker-compose)

旧本番: GCP VM(34.173.153.189・Ubuntu 18.04 EOL)。切替後も当面併走中。

- `docker-compose.yml` / `app/` / `mysql/` / `nginx/` / `redis/` はこのレガシー環境用
- VM上のチェックアウトはディレクトリ名 `~/news-app-docker` のまま(composeプロジェクト名が
  ディレクトリ名由来のため改名しない)
- 運用記録: `DEPLOY-2026-08.md` / `MEMO.md`(サーバIPが旧値の箇所あり・歴史資料)

## 関連リポジトリ

- [news-app-backend-refactor](https://github.com/ponyo877/news-app-backend-refactor) — Go API(`develop` が本番)
- news-app-frontend — React Native アプリ(横断ドキュメントは frontend の `docs/` に集約)
