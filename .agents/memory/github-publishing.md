---
name: GitHub publishing
description: The user's standing approval boundary for commits and pushes to this app's GitHub main branch.
---

**Rule:** Keep tracked app source, configuration, schema, and sanitized fixtures aligned with `applications-eman/eman-orders` on `main` through manual Push/Pull only when the user asks. Keep secret values, database credentials, and live order/customer data out of GitHub.

**Why:** The user uses GitHub as a handoff for another AI agent. Source and safe test data support that workflow; credentials and live database records should remain in controlled services.

**How to apply:** Before each requested sync, inspect local and remote changes and preserve both sides. Keep Replit PostgreSQL and Secrets in Replit; use synthetic fixtures or a separately provisioned development database if an agent needs test data. Do not include unrelated attachments unless asked.
