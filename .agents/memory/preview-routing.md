---
name: Preview routing
description: Replit proxy routing and stale web server behavior in this root Express app.
---

**Rule:** Requests under `/api` for the bakery app must reach the root Express server. A leftover artifact service can claim that proxy path before the root app. A failed workflow restart can also leave an earlier `node server/index.js` process bound to port 3000.

**Why:** The starter API returned 404 for `/api/login` through Preview even though the bakery app returned 200 directly on port 3000; restarting while the old process remained produced `EADDRINUSE`.

**How to apply:** Verify app routes through the Replit Preview hostname, not only the local port. Keep unused starter artifact paths away from `/api`; before restarting the root workflow, stop it and confirm port 3000 is free.
