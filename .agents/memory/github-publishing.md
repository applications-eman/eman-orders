---
name: GitHub publishing
description: The user's standing approval boundary for commits and pushes to this app's GitHub main branch.
---

**Rule:** Keep tracked app source and configuration aligned between Replit and `applications-eman/eman-orders` on `main` when the user explicitly requests a sync. Do not push or pull automatically; never sync Replit database data or Secrets.

**Why:** The user uses GitHub as a handoff for another AI agent, then asks for its code changes to be pulled back into Replit. Replit remains the runtime and holds the database and Secrets.

**How to apply:** Before each requested sync, inspect local and remote changes and preserve both sides. Include unrelated attachments only when specifically requested; credentials alone do not authorize a push or pull.
