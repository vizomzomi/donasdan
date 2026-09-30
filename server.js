/**
 * Saweria Watcher Service - untuk deploy di Railway
 * ---------------------------------------------------
 * Tugasnya CUMA dua:
 * 1. Buka halaman widget alert Saweria pakai Puppeteer, pantengin donasi baru masuk.
 * 2. Nyediain API (GET /donations) buat dipoll dari bot WhatsApp kamu di Pterodactyl.
 *
 * Nggak ada koneksi WhatsApp sama sekali di sini — murni cuma "mata-mata" donasi.
 */

const express = require("express");
const puppeteer = require("puppeteer");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const STREAM_KEY = process.env.SAWERIA_STREAM_KEY;

if (!STREAM_KEY) {
  console.error("ENV SAWERIA_STREAM_KEY belum diisi. Set di Railway > Variables.");
  process.exit(1);
}

// Simpan donasi di memory (cukup buat kebutuhan ini, nggak perlu database)
// Format: { id, nama, nominal, pesan, rawText, ts }
const donations = [];
const MAX_STORED = 200; // biar nggak numpuk terus, simpan 200 terakhir aja

function parseAlertText(rawText) {
  if (!rawText) return null;
  const text = rawText.replace(/\s+/g, " ").trim();

  const re = /(.+?)\s+baru saja memberikan\s+Rp\s*([\d.,]+)\s*(.*)$/i;
  const match = text.match(re);
  if (!match) return null;

  const nama = match[1].trim() || "Orang Baik";
  const nominalRaw = match[2].replace(/[.,]/g, "");
  const nominal = Number(nominalRaw) || 0;
  const pesan = (match[3] || "").trim();

  return { nama, nominal, pesan, rawText: text };
}

function addDonation(rawText) {
  const parsed = parseAlertText(rawText);
  if (!parsed) return;

  const now = Date.now();

  // Dedupe: teks sama persis dalam 30 detik terakhir, skip
  const duplicate = donations.find(
    (d) => d.rawText === parsed.rawText && now - d.ts < 30000
  );
  if (duplicate) return;

  const record = {
    id: crypto.randomUUID(),
    nama: parsed.nama,
    nominal: parsed.nominal,
    pesan: parsed.pesan,
    rawText: parsed.rawText,
    ts: now,
  };

  donations.push(record);
  if (donations.length > MAX_STORED) donations.shift();

  console.log(`[DONASI MASUK] ${record.nama} - Rp${record.nominal} - ${record.pesan}`);
}

let browser = null;
let stopped = false;
let isConnected = false;
let lastError = null;

async function launchAndWatch() {
  if (stopped) return;

  try {
    const launchOpts = {
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();

    // === CCTV: semua console.log & error DI DALAM browser di-forward ke log Railway ===
    page.on("console", (msg) => {
      console.log(`[PAGE CONSOLE:${msg.type()}]`, msg.text());
    });
    page.on("pageerror", (err) => {
      console.log("[PAGE ERROR]", err.message);
    });
    page.on("requestfailed", (req) => {
      console.log("[PAGE REQUEST FAILED]", req.url(), req.failure()?.errorText);
    });

    await page.exposeFunction("__onSaweriaAlert", (text) => {
      addDonation(text);
    });

    await page.exposeFunction("__onHeartbeat", (snippet) => {
      console.log("[HEARTBEAT] Isi halaman saat ini:", JSON.stringify(snippet));
    });

    const url = `https://saweria.co/widgets/alert?streamKey=${encodeURIComponent(
      STREAM_KEY
    )}`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    await page.evaluate(() => {
      try {
        let lastReported = "";
        let scanTimer = null;

        function scanPage() {
          const text = (document.body.innerText || "").replace(/\s+/g, " ").trim();
          const match = text.match(/(.+?baru saja memberikan\s+Rp\s*[\d.,]+.*)/i);
          const candidate = match ? match[1] : null;
          if (candidate && candidate !== lastReported) {
            lastReported = candidate;
            window.__onSaweriaAlert(candidate);
          }
        }

        const observer = new MutationObserver(() => {
          // Debounce dikit biar nggak nembak berkali-kali pas teks lagi dianimasikan
          clearTimeout(scanTimer);
          scanTimer = setTimeout(scanPage, 400);
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });

        // Scan sekali di awal juga, jaga-jaga kalau alert udah kejadian pas baru connect
        scanPage();

        // Heartbeat: tiap 20 detik kirim cuplikan isi halaman + scan ulang manual,
        // biar kita bisa lihat dari log Railway apakah halamannya "hidup" atau mandek.
        setInterval(() => {
          try {
            const snippet = (document.body.innerText || "").slice(0, 150);
            window.__onHeartbeat(snippet);
            scanPage();
          } catch (e) {
            console.error("[HEARTBEAT ERROR]", e.message);
          }
        }, 20000);

        console.log("[PAGE] Observer & heartbeat berhasil dipasang, siap mantengin.");
      } catch (e) {
        console.error("[PAGE EVALUATE ERROR]", e.message, e.stack);
      }
    });

    console.log("[SAWERIA] Berhasil terhubung ke widget alert, mantengin donasi...");
    isConnected = true;
    lastError = null;

    browser.on("disconnected", () => {
      if (stopped) return;
      isConnected = false;
      console.log("[SAWERIA] Browser terputus, reconnect dalam 15 detik...");
      setTimeout(launchAndWatch, 15000);
    });
  } catch (e) {
    console.error("[SAWERIA ERROR]", e.message);
    isConnected = false;
    lastError = e.message;
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    setTimeout(launchAndWatch, 15000);
  }
}

launchAndWatch();

// ---------------- API ----------------

const app = express();

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), totalDonations: donations.length });
});

// Cek apakah listener-nya berhasil connect ke widget Saweria atau nggak
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    lastError: lastError,
  });
});

// Bot WA polling endpoint ini tiap beberapa detik.
// Query param "since" = timestamp (ms) terakhir kali dia cek, biar cuma dapet yang baru.
// CATATAN: endpoint ini publik, siapapun yang tau URL-nya bisa akses.
app.get("/donations", (req, res) => {
  const since = Number(req.query.since) || 0;
  const newOnes = donations.filter((d) => d.ts > since);
  res.json({
    donations: newOnes,
    serverTime: Date.now(), // dipakai client buat update "since" berikutnya
  });
});

app.listen(PORT, () => {
  console.log(`[API] Jalan di port ${PORT}`);
});
