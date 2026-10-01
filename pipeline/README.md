# Runner pipeline

Pipeline 4 tahap untuk menyaring token trending GMGN: token yang di-bundle, di-bot, atau cuma jadi exit liquidity dibuang, sisanya di-alert dan dicatat di jurnal. Kodenya memakai `OpenApiClient` dari repo ini secara langsung, jadi autentikasi dan konfigurasinya sama dengan `gmgn-cli`.

```
/v1/market/rank (tiap 30 detik, interval 1m + 5m, token < 24 jam)
   │  tahap 1: umur, holder, likuiditas, porsi dev, porsi top 10, wash trading
   ▼
tracking (minimal 4 scan / 2 menit, maksimal 30 menit)
   │  tahap 2: holder naik, likuiditas stabil, beli > jual, bundler & bot wajar
   ▼
/v1/token/info (1 panggilan per token)
   │  tahap 3: rug ratio, entrapment, KOL/smart money, jiplakan sosial/gambar
   ▼
alert (console + Discord) → jurnal tiap 30 detik selama 6 jam
```

## Menjalankan

```bash
npm ci
# API key di ~/.config/gmgn/.env atau ./.env
echo 'GMGN_API_KEY=...' >> ~/.config/gmgn/.env

npm run pipeline:selftest     # tes offline, tanpa API (kedua profil)
npm run pipeline -- --once    # satu scan saja (smoke test)
npm run pipeline              # jalan terus sampai Ctrl+C
npm run pipeline:evaluate     # laporan dari data yang sudah terkumpul
npm run pipeline:history      # backtest strategi exit dengan candle 14 hari terakhir
```

`pipeline:history` tidak bisa menguji filter tahap 1–3, karena GMGN tidak menyimpan data trending, holder, bot, atau bundler masa lalu. Sebagai pengganti alert, script ini memakai sinyal harga dan volume (umur ≥ 10 menit, mcap ≥ $40K, volume 5 menit ≥ $10K, harga naik dalam 15 menit). Daftar tokennya diambil dari daftar trending hari ini, jadi hasilnya condong ke token yang bertahan hidup (survivorship bias). Hasil "hold" akan terlihat jauh lebih bagus dari kenyataan. Pengaturannya ada di `HISTORY_*` dan `ENTRY_*` di awal `history.ts`.

Di VPS dengan pm2:

```bash
pm2 start npm --name runner -- run pipeline
pm2 logs runner
```

State disimpan di `pipeline/data/state.json`, jadi kalau proses restart, tracking dan jurnal lanjut dari posisi terakhir.

## Profil `newlaunch`: token baru, mcap kecil

```bash
npm run pipeline:newlaunch                         # atau: PIPELINE_PROFILE=newlaunch npm run pipeline
PIPELINE_PROFILE=newlaunch npm run pipeline:evaluate
```

Profil ini memantau token launchpad (`/v1/trenches`: new, near completion, completed) tiap 20 detik, dan datanya disimpan terpisah di `data-newlaunch/`. Daftar launchpad bawaan trenches tidak memasukkan stonkfun, padahal 7 dari 15 runner $100 rb → $10 jt+ dalam 30 hari terakhir berasal dari sana. Karena itu setiap scan menambah satu panggilan khusus untuk stonkfun (`TRENCH_EXTRA_PLATFORMS`, kosongkan untuk mematikan).

| Tahap | Aturan (default) |
|---|---|
| 1. Discovery | umur 2–60 menit, mcap **$30–60 rb**, holder ≥ 80, likuiditas ≥ $8 rb, top 10 ≤ 30%, dev ≤ 5%, bundle ≤ 30%, sniper ≤ 15%, insider ≤ 15%, rug ratio ≤ 0,3, creator < 10 token (bukan peluncur serial), tidak wash trading. Kalau berbagi gambar/Twitter/website dengan token lain, hanya lolos kalau dia yang holder-nya terbanyak di antara token bersimbol sama (yang "asli" dari narasinya) |
| 2. Tracking | minimal 3 scan / 40 detik, maksimal 10 menit: holder naik, likuiditas tidak terkuras, beli ≥ jual, bundler dan bot wajar |
| 3. Deep dive | `token info` + 3 daftar holder: minimal **2 wallet smart money/KOL masih memegang** (> $20), **median entry top 20 holder ≤ 1,3× mcap sekarang** (holder tidak sedang rugi), dan **tidak ada wallet non-pool yang memegang > 15%**. Akun sistem berlabel (misalnya "DBC Vault") tidak dihitung sebagai whale, tapi porsinya ditampilkan di alert |
| 4. Alert | seperti biasa, ditambah siapa yang masih memegang, harga masuk mereka, dan porsi vault |

Semua angka bisa diubah lewat variabel `S1_*`, `S2_*`, `S3_*`, dan `TRENCH_*` di `config.ts`. Nilai 0 mematikan aturan "maks".

## Profil `loose` + paper trading

```bash
npm run pipeline:loose                             # scan + paper trading, jalan terus
PIPELINE_PROFILE=loose npm run pipeline:evaluate   # laporan, termasuk hasil paper trading
npm run pipeline:replay                            # uji ulang aturan yang sama pada token 3-10 jam terakhir
```

Profil ini **tidak mengirim order sungguhan.** Setiap alert membuka posisi simulasi, dan hasilnya dicatat supaya strateginya bisa dinilai dengan data live sebelum memakai uang sungguhan.

| Bagian | Aturan (default) |
|---|---|
| Discovery | token launchpad umur 2–60 menit, mcap $20–150 rb, minimal 50 holder dan likuiditas $5 rb. Tanpa syarat smart money, dev, bundle, atau jiplakan |
| Tracking | minimal 3 scan / 40 detik; gagal hanya kalau likuiditas turun lebih dari 25% |
| Paper trading | modal $140, **10% ekuitas per transaksi**, maksimal **8 posisi** terbuka (alert berikutnya dilewati dan dihitung), **TP +100%** (jual semua), **SL −30%**, tutup paksa setelah **180 menit**, biaya 1,5% per sisi |
| Jurnal | hanya token yang sedang dipegang, tiap 30 detik; berhenti saat posisi ditutup |

Cara transaksi simulasi diisi: TP terisi tepat di levelnya (limit order); SL terisi di harga pertama yang terlihat di bawah level (kalau harga melompat, rugi lebih besar dari −30%); harga dicek tiap 30 detik.

**Tahan runner (default aktif di profil ini).** Saat TP +100% tersentuh, pipeline mengecek token dengan data `token info` terbaru. Token dianggap masih kuat kalau semua syarat ini terpenuhi:
- holder naik minimal 20% sejak beli;
- volume 5 menit minimal $30 rb;
- jumlah wallet smart money + KOL tidak berkurang.

Kalau kuat, 50% dijual di TP dan 50% ditahan. Sisa itu dijual saat salah satu terjadi lebih dulu:
- harga turun 30% dari puncaknya (stop tidak pernah di bawah harga beli, tapi kalau harga melompat, fill bisa lebih rendah);
- holder turun 15% dari jumlah tertingginya;
- sudah 12 jam sejak TP.

Kalau lemah, semua dijual seperti biasa. Hasil akhirnya dicatat sebagai satu transaksi (bagian yang dijual di TP ikut dihitung). Pengaturannya lewat `PAPER_RUNNER` (0 untuk mematikan), `RUNNER_MIN_HOLDER_GROWTH`, `RUNNER_MIN_VOLUME_5M`, `RUNNER_KEEP_PCT`, `RUNNER_TRAIL_PCT`, `RUNNER_HOLDER_DROP_PCT`, dan `RUNNER_MAX_HOLD_MIN`. Di replay 151 transaksi dengan volume sebagai satu-satunya cek, aturan ini memperbaiki rata-rata sekitar 1 poin dibanding menjual semua. Syarat holder belum terbukti; itulah yang diukur paper trading.

Pengaturan bisa diubah lewat `PAPER_CAPITAL`, `PAPER_POSITION_PCT`, `PAPER_MAX_OPEN`, `PAPER_TP` (2 = +100%), `PAPER_SL` (0,7 = −30%), `PAPER_MAX_HOLD_MIN`, dan `PAPER_COST_PCT`. Paper trading juga bisa diaktifkan di profil lain dengan `PAPER=1`.

`pipeline:replay` (opsi: `REPLAY_TPS=1.15,1.3,2`, `REPLAY_SLS=0.9,0.7`, `REPLAY_DIR=<folder cache lama>` untuk memakai ulang data) mengambil token berdasarkan **umur** (termasuk yang sudah mati), memutar ulang aturan di atas per menit tanpa melihat harga ke depan, lalu membandingkan berbagai kombinasi TP/SL. Satu kali jalan hanya mewakili satu sesi pasar, jadi ulangi di hari yang berbeda. Data holder, top 10, bundler, dan dev pada waktu itu tidak tersedia, sehingga aturan-aturan tersebut tidak ikut di-replay.

## Konfigurasi

Semua angka ada di `config.ts` dan bisa ditimpa lewat `.env`. Yang paling sering diubah:

| Variabel | Default | Arti |
|---|---|---|
| `GMGN_RATE_LIMIT` | `5` | Rate paket GMGN: Free 5, Plus 20, Pro 50. Pipeline memakai 80% dari angka ini. |
| `DISCORD_WEBHOOK_URL` | – | Kalau diisi, alert juga dikirim ke Discord. |
| `PIPELINE_CHAIN` | `sol` | Chain yang dipantau. |
| `RANK_INTERVALS` | `1m,5m` | Interval trending yang digabung tiap scan. |
| `SCAN_INTERVAL_SEC` | `30` | Jeda antar scan. |
| `S1_MIN_HOLDERS` | `150` | Holder minimum di tahap 1. |
| `S1_MIN_LIQUIDITY_USD` | `10000` | Likuiditas minimum di tahap 1. |
| `S2_MAX_BOT_RATE` | `0.7` | Batas bot rate di tahap 2. Token trending biasa berada di 0,4–0,65. |
| `S3_MAX_RUG_RATIO` | `0.5` | Batas rug ratio di tahap 3. |
| `S3_MIN_KOL_PLUS_SMART` | `1` | Jumlah minimal wallet KOL + smart money. |
| `JOURNAL_HOURS` | `6` | Lama jurnal per token. |

Daftar lengkap (termasuk `S2_*` dan `S3_*` lainnya) ada di `config.ts`.

## Beban API

GMGN memakai leaky bucket. `/v1/market/rank` bernilai 3 unit dan `/v1/token/info` 1 unit. Paket Free hanya punya kapasitas 5 unit, jadi dua panggilan rank sekaligus sudah melewati batas. Karena itu semua panggilan lewat satu antrian (`Throttle` di `gmgn.ts`). Kalau server tetap membalas 429, semua panggilan berhenti sampai waktu reset yang diberikan server.

Satu scan memakai 2 panggilan rank (6 unit), ditambah 1 unit per token yang lolos tahap 2 dan 1 unit per token di jurnal setiap 30 detik. Di paket Free, kapasitasnya sekitar 120 unit per 30 detik.

## Data

- `data/events.jsonl`: satu baris untuk setiap keputusan tahap (`s1_reject`, `s1_pass`, `s2_fail`, `s2_pass`, `s3_fail`, `alert`, `journal_done`), lengkap dengan alasan dan data mentahnya.
- `data/journal/<address>.jsonl`: snapshot tiap 30 detik berisi harga, mcap, likuiditas, holder, bot rate, bundler, top 10, smart money, KOL, whale, serta beli/jual 1 menit.

`npm run pipeline:evaluate` menampilkan:
1. corong (funnel) dan aturan mana yang paling banyak menggugurkan token di tiap tahap;
2. hasil setiap alert: kenaikan tertinggi, harga akhir, harga terendah, dan waktu menuju puncak;
3. perbandingan runner vs non-runner saat alert (butuh minimal 4 alert; baru bermakna setelah sekitar 30+);
4. backtest strategi exit dari `strategies.ts`, masing-masing diuji dengan beli tepat saat alert dan beli setelah jeda `BT_ENTRY_DELAY_SEC` (default 30 detik).

| Strategi | Aturan |
|---|---|
| hold | beli, tahan sampai jurnal habis (6 jam) |
| C | jual semua di +25%, SL −25% |
| D | jual semua di +25%, SL −12% |
| +50% | jual semua di +50%, SL −30% |
| A | jual 50% di +50%, lalu 25% dari sisa di setiap +25% berikutnya; sisa dijual kalau harga balik ke harga beli; SL −25% sebelum target pertama |
| A + stop bertahap | seperti A, tapi stop naik ke target sebelumnya setiap kali target baru tersentuh; SL −30% |
| A + trailing | seperti A, tapi sisa dijual kalau harga turun 30% dari puncaknya; SL −30% |

Strategi baru cukup ditambahkan ke `STRATEGIES` di `strategies.ts`.

**Catatan backtest:** stop loss terisi di harga snapshot yang melewatinya (harga bisa lompat melewati stop), sedangkan take profit terisi tepat di levelnya. Slippage (`BT_SLIPPAGE_PCT`, default 0,5%) dan fee (`BT_FEE_PCT`, default 1%) adalah angka asumsi yang tetap, bukan dihitung dari data transaksi on-chain. Pakai hasilnya untuk membandingkan strategi satu sama lain, bukan sebagai perkiraan profit, dan baru pilih strategi setelah ada 30+ alert.

## Batasan

- Semua angka filter adalah titik awal, dikalibrasi dari beberapa menit data SOL. Jalankan beberapa hari, lalu sesuaikan berdasarkan laporan `evaluate`.
- Pipeline ini tidak melakukan swap. Alert hanyalah sinyal untuk dipelajari, bukan saran beli.
- Nama dan simbol token dibersihkan dengan `sanitizeString` sebelum dicatat atau dikirim ke Discord, karena isinya dikendalikan pembuat token.
