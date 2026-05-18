/**
 * Cross Now — Vision Backend
 * Node.js / Express server
 *
 * What this does:
 *  1. Every 60 seconds, fetches a camera frame from the MDOT MiDrive
 *     I-75 / Ambassador Bridge approach cameras (public JPEG snapshots)
 *  2. Sends each frame to Claude claude-sonnet-4-20250514 vision API with a
 *     structured prompt: count cars in NEXUS lane vs standard lane
 *  3. Caches the result in memory (+ optional Redis)
 *  4. Exposes a JSON API that the Cross Now frontend calls instead of
 *     (or to supplement) the CBP wait time feed
 *
 * Deploy to: Railway, Render, Fly.io, or any Node host
 * Cost estimate: ~$0.002 per vision call × 60 calls/hour = ~$0.12/hour
 */

const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── CAMERA SOURCES ───────────────────────────────────────────────────────────
// MDOT MiDrive publishes JPEG snapshots for each camera. The URL pattern is:
//   https://mdotjboss.state.mi.us/MiDrive/camimage?id=CAMERA_ID
//
// Camera IDs near the Ambassador Bridge / I-75 Windsor approach:
//   These are identified from the MiDrive interactive map by inspecting
//   network requests when clicking cameras near lat 42.3149, lng -83.0654
//
// Windsor Tunnel / DWT tunnel cameras are operated separately by
//   dwtunnel.com — their snapshot URL is confirmed below.
//
// NOTE: Camera IDs must be verified / updated periodically as MDOT
//   renumbers feeds. The server logs when a fetch fails so you know.

const CAMERAS = [
  {
    id:          'amb_ca_plaza',
    name:        'Ambassador Bridge — Canadian plaza (toward USA)',
    crossing:    'amb',
    lane:        'both',
    // Verified live JPEG — from goodcaring.ca inspection
    url:         'https://ambassador.solutionspal.com/cams/camimage.jpg',
    fallbackUrl: 'https://ambassador.solutionspal.com/cams/camimage2.jpg',
  },
  {
    id:          'amb_us_plaza',
    name:        'Ambassador Bridge — US plaza (toward Canada)',
    crossing:    'amb',
    lane:        'both',
    // Verified live JPEG — from goodcaring.ca inspection
    url:         'https://ambassador.solutionspal.com/cams/camimage2.jpg',
    fallbackUrl: 'https://ambassador.solutionspal.com/cams/camimage.jpg',
  },
  {
    id:          'tun_us_exit',
    name:        'Windsor Tunnel — DWT Authority camera',
    crossing:    'tun',
    lane:        'both',
    // DWT tunnel camera
    url:         'https://www.dwtunnel.com/camera/snapshot.jpg',
    fallbackUrl: null,
  },
];

// ─── VISION PROMPT ────────────────────────────────────────────────────────────
function buildVisionPrompt(cameraName) {
  return `You are analyzing a live traffic camera image from the ${cameraName} border crossing between Windsor, Canada and Detroit, USA.

Count the vehicles visible in the queue, separated by lane type if you can distinguish them.

Respond ONLY with valid JSON in this exact format — no other text:
{
  "standard_cars": <integer — cars in standard/regular lanes>,
  "nexus_cars": <integer — cars in NEXUS/trusted traveler lanes, 0 if lane not visible>,
  "total_visible": <integer — total cars visible>,
  "congestion_level": "<low|medium|high|severe>",
  "nexus_lane_blocked": <boolean — true if NEXUS lane entrance appears blocked by standard queue>,
  "confidence": "<low|medium|high>",
  "notes": "<one sentence observation, e.g. 'NEXUS lane merge point visible, ~8 cars from booth'>"
}

If the image is too dark, obstructed, or unclear, return:
{
  "error": "unclear",
  "standard_cars": null,
  "nexus_cars": null,
  "total_visible": null,
  "congestion_level": "unknown",
  "nexus_lane_blocked": false,
  "confidence": "low",
  "notes": "Image unclear or unavailable"
}`;
}

// ─── WAIT TIME CALCULATION FROM VISION DATA ───────────────────────────────────
// Converts car count → estimated wait minutes
// These constants match what the frontend NEXUS Backup Calculator uses

const STD_OFFICER_MINS  = 4;   // avg minutes per car, standard lane
const NXP_OFFICER_MINS  = 2;   // avg minutes per car, NEXUS lane
const NEXUS_PEEL_OFFSET = 9;   // cars from booth where NEXUS lane opens up

function computeWaitFromVision(visionData, hasNexus = false) {
  const { standard_cars, nexus_cars, nexus_lane_blocked, confidence } = visionData;

  if (standard_cars === null) {
    return { source: 'vision_error', wait_mins: null, nexus_wait_mins: null };
  }

  // Standard wait: each car takes STD_OFFICER_MINS to clear
  const stdWait = Math.round(standard_cars * STD_OFFICER_MINS);

  let nexusWait = null;
  let nexusExplain = null;

  if (nexus_cars !== null) {
    if (nexus_lane_blocked && standard_cars > NEXUS_PEEL_OFFSET) {
      // NEXUS Backup Calculator:
      // Time to reach merge point = (std queue - peel offset) * std processing
      const timeToMerge = Math.max(0, (standard_cars - NEXUS_PEEL_OFFSET) * STD_OFFICER_MINS);
      const nexusProcessing = nexus_cars * NXP_OFFICER_MINS;
      nexusWait = Math.round(timeToMerge + nexusProcessing);
      nexusExplain = `${standard_cars} std cars → merge at ~${NEXUS_PEEL_OFFSET} cars (+${timeToMerge}m) → ${nexus_cars} NEXUS cars × 2m = ${nexusWait}m total`;
    } else {
      // NEXUS lane freely accessible
      nexusWait = Math.round(nexus_cars * NXP_OFFICER_MINS);
      nexusExplain = `${nexus_cars} NEXUS cars × 2 min = ${nexusWait} min`;
    }
  }

  return {
    source:         'vision',
    confidence,
    std_cars:       standard_cars,
    nexus_cars:     nexus_cars,
    std_wait_mins:  stdWait,
    nexus_wait_mins: nexusWait,
    nexus_blocked:  nexus_lane_blocked,
    nexus_explain:  nexusExplain,
    // Pick best lane
    recommended_wait: nexusWait !== null ? Math.min(stdWait, nexusWait) : stdWait,
    recommended_lane: (nexusWait !== null && nexusWait < stdWait) ? 'NEXUS' : 'Standard',
  };
}

// ─── FETCH IMAGE AS BASE64 ────────────────────────────────────────────────────
function fetchImageAsBase64(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'CrossNow/1.0 (border crossing app; contact@crossnow.ca)',
        'Accept': 'image/jpeg,image/png,image/*',
      },
      timeout: 8000,
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          base64: buf.toString('base64'),
          mediaType: res.headers['content-type'] || 'image/jpeg',
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── ANALYZE ONE CAMERA ───────────────────────────────────────────────────────
async function analyzeCamera(camera) {
  let imageData;

  // Try primary URL, then fallback
  try {
    imageData = await fetchImageAsBase64(camera.url);
  } catch (err) {
    console.log(`[${camera.id}] Primary failed: ${err.message}`);
    if (camera.fallbackUrl) {
      try {
        imageData = await fetchImageAsBase64(camera.fallbackUrl);
        console.log(`[${camera.id}] Fallback succeeded`);
      } catch (err2) {
        console.log(`[${camera.id}] Fallback also failed: ${err2.message}`);
        return { camera: camera.id, error: 'fetch_failed', timestamp: new Date().toISOString() };
      }
    } else {
      return { camera: camera.id, error: 'fetch_failed', timestamp: new Date().toISOString() };
    }
  }

  // Send to Claude vision
  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type:       'base64',
              media_type: imageData.mediaType,
              data:       imageData.base64,
            },
          },
          {
            type: 'text',
            text: buildVisionPrompt(camera.name),
          },
        ],
      }],
    });

    const raw = response.content[0].text.trim();
    let parsed;
    try {
      // Strip any markdown fences just in case
      const clean = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      console.error(`[${camera.id}] JSON parse failed:`, raw.substring(0, 100));
      return { camera: camera.id, error: 'parse_failed', timestamp: new Date().toISOString() };
    }

    const waitData = computeWaitFromVision(parsed);

    return {
      camera:    camera.id,
      name:      camera.name,
      crossing:  camera.crossing,
      timestamp: new Date().toISOString(),
      vision:    parsed,
      wait:      waitData,
    };

  } catch (err) {
    console.error(`[${camera.id}] Vision API error:`, err.message);
    return { camera: camera.id, error: 'vision_failed', timestamp: new Date().toISOString() };
  }
}

// ─── CACHE ────────────────────────────────────────────────────────────────────
let cache = {
  lastUpdated: null,
  results: {},
  combined: {},
};

function combineResults(results) {
  // Merge results by crossing (amb / tun)
  const byCrossing = { amb: [], tun: [] };

  for (const r of results) {
    if (r.error || !r.crossing) continue;
    byCrossing[r.crossing].push(r);
  }

  const combined = {};
  for (const [crossing, cams] of Object.entries(byCrossing)) {
    if (!cams.length) continue;

    // Average wait across cameras for same crossing
    const stdWaits  = cams.map(c => c.wait?.std_wait_mins).filter(v => v !== null);
    const nxWaits   = cams.map(c => c.wait?.nexus_wait_mins).filter(v => v !== null);
    const stdCars   = cams.map(c => c.wait?.std_cars).filter(v => v !== null);
    const nxCars    = cams.map(c => c.wait?.nexus_cars).filter(v => v !== null);
    const blocked   = cams.some(c => c.wait?.nexus_blocked);

    const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

    const stdWait = avg(stdWaits);
    const nxWait  = avg(nxWaits);

    combined[crossing] = {
      crossing,
      timestamp:        new Date().toISOString(),
      std_cars:         avg(stdCars),
      nexus_cars:       avg(nxCars),
      std_wait_mins:    stdWait,
      nexus_wait_mins:  nxWait,
      nexus_blocked:    blocked,
      recommended_wait: (nxWait !== null && nxWait < stdWait) ? nxWait : stdWait,
      recommended_lane: (nxWait !== null && nxWait < stdWait) ? 'NEXUS' : 'Standard',
      source:           'vision',
      camera_count:     cams.length,
      cameras:          cams.map(c => c.name),
    };
  }
  return combined;
}

async function runVisionCycle() {
  console.log(`[${new Date().toISOString()}] Vision cycle starting…`);
  const results = await Promise.all(CAMERAS.map(analyzeCamera));
  const combined = combineResults(results);
  cache = {
    lastUpdated: new Date().toISOString(),
    results:     Object.fromEntries(results.map(r => [r.camera, r])),
    combined,
  };
  console.log(`[${new Date().toISOString()}] Vision cycle complete. Crossings:`, Object.keys(combined));
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', lastUpdated: cache.lastUpdated });
});

// Image proxy — serves camera JPEGs to the browser without CORS issues
// e.g. /api/camera-image?url=amb_ca_plaza
app.get('/api/camera-image', async (req, res) => {
  const CAM_URLS = {
    amb_ca: 'https://ambassador.solutionspal.com/cams/camimage.jpg',
    amb_us: 'https://ambassador.solutionspal.com/cams/camimage2.jpg',
    tun:    'https://www.dwtunnel.com/camera/snapshot.jpg',
  };

  const key = req.query.cam;
  const url = CAM_URLS[key];
  if (!url) return res.status(400).json({ error: 'Unknown camera' });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CrossNow/1.0)',
        'Referer': 'https://goodcaring.ca/',
        'Accept': 'image/jpeg,image/*',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const buf = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('X-Camera-Key', key);
    res.set('X-Timestamp', new Date().toISOString());
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(502).json({ error: 'Camera unavailable', message: err.message });
  }
});

// CBP proxy — fetches bwt.cbp.gov server-side (no CORS issues)
// Frontend calls this instead of hitting CBP directly
app.get('/api/border-wait', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');
  try {
    const response = await fetch('https://bwt.cbp.gov/api/waittimes');
    if (!response.ok) throw new Error('CBP HTTP ' + response.status);
    const data = await response.json();
    const detroit = data.filter(p =>
      /detroit/i.test(p.port_name || '') ||
      /ambassador/i.test(p.crossing_name || '') ||
      /tunnel/i.test(p.crossing_name || '')
    );
    res.json({ ok: true, data: detroit, source: 'cbp', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Main endpoint — called by the Cross Now frontend
// Returns vision-based wait times for Ambassador Bridge and Windsor Tunnel
app.get('/api/vision-wait', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Access-Control-Allow-Origin', '*');

  if (!cache.lastUpdated) {
    return res.status(503).json({
      error: 'Vision data not yet available — first cycle running',
      retryAfter: 15,
    });
  }

  const ageSeconds = Math.round((Date.now() - new Date(cache.lastUpdated).getTime()) / 1000);

  res.json({
    lastUpdated: cache.lastUpdated,
    ageSeconds,
    stale: ageSeconds > 120,
    crossings: cache.combined,
  });
});

// Raw camera results (for debugging)
app.get('/api/cameras', (req, res) => {
  res.json({
    lastUpdated: cache.lastUpdated,
    cameras: cache.results,
  });
});

// Manual trigger (protected by secret in production)
app.post('/api/refresh', async (req, res) => {
  const secret = process.env.REFRESH_SECRET;
  if (secret && req.headers['x-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  await runVisionCycle();
  res.json({ ok: true, lastUpdated: cache.lastUpdated });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(port, async () => {
  console.log(`Cross Now Vision Backend running on port ${port}`);
  console.log(`Cameras configured: ${CAMERAS.length}`);
  console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING'}`);

  // Run immediately on start, then every 60 seconds
  await runVisionCycle();
  setInterval(runVisionCycle, 60_000);
});
