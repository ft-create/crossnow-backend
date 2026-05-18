# Deploy Cross Now Backend in 5 Minutes

## Option A — Railway (recommended, free tier)

1. Install Railway CLI:
   npm install -g @railway/cli

2. In the crossnow-backend folder:
   railway login
   railway init
   railway up

3. Set your environment variable in Railway dashboard:
   ANTHROPIC_API_KEY = sk-ant-...

4. Railway gives you a URL like:
   https://crossnow-backend-production.up.railway.app

5. Paste that URL into crossnow.html:
   Find:  const VISION_API = '';
   Replace with: const VISION_API = 'https://your-railway-url.up.railway.app';

6. Re-deploy crossnow.html to Netlify.

---

## Option B — Render (also free)

1. Push the crossnow-backend folder to a GitHub repo

2. Go to render.com → New Web Service → connect your repo

3. Settings:
   Build command:  npm install
   Start command:  npm start
   Environment:    ANTHROPIC_API_KEY = sk-ant-...

4. Render gives you a URL — same step 5-6 as above.

---

## Verify it's working

Visit: https://your-backend-url/health
Should return: {"status":"ok","lastUpdated":"..."}

Visit: https://your-backend-url/api/vision-wait
Should return crossing data with std_cars, nexus_cars, wait times.

If cameras 404, open MiDrive map (mdotjboss.state.mi.us/MiDrive/map),
click camera icon near Ambassador Bridge, copy the ID from the image
URL and update the CAMERAS array in server.js.
