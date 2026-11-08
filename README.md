# Car Finder

A private car-search website for one person. You type a car, set your rules and tap **Search**. An AI agent (Claude Code, running in GitHub Actions in your private `car-finder-engine` repo) opens real UK listing and dealer pages, copies each car's details exactly as the listing states them, and scripts check every result against your rules before it reaches the page. Each match comes with a Zuto pre-check and HP/PCP estimates.

This repo holds only the website: plain HTML, CSS and JavaScript, hosted on GitHub Pages. There is no data and no secret in it. Every result lives in `car-finder-engine`, which stays private because listing sites limit their content to personal use.

Live site: `https://lilprogact.github.io/car-finder/`

## How to search

1. Open the site and enter your password (first visit: create one).
2. First time only: go to **Settings** and paste your GitHub token (see below). Tap **Save token**; it should say "Connected as Lilprogact".
3. On **Search**, type the car and set your rules. Defaults are the C-Class search: £20,000, 70,000 miles, 2019 or newer, matte only, dealers only.
4. Tap **Search**. The **Results** tab shows Queued → Searching → Checking → Done with the elapsed time. A search usually takes 10 to 20 minutes and you can close the page; it carries on in GitHub.
5. Results come in three parts: **Matches** (every rule met, best value first), **Near misses** (exactly one rule missed by a small margin, labelled), and **Sites checked** (what was searched, how many listings each gave, any errors, plus one-tap links for Autotrader and My Zuto, which the agent never fetches).

Each card shows the listing's own photo (linked from the listing site, never copied), the figures exactly as listed, the finish label with the evidence quote, the dealer and town, the value note against similar cars in the same run, the Zuto pre-check with reasons, HP and PCP estimates, **View listing** and **Get a Zuto quote**. Sort by value, price, mileage or distance.

Zero matches is a real result, not an error. When nothing meets every rule, the near misses and the sites list tell you why.

## Saved searches and the daily scan

**Save this search** adds the current rules to the daily scan (06:17 UTC every morning, up to 5 saved searches). Switch each one on or off from the **Saved** tab. When a scan finds a new listing or a price drop, the engine opens a GitHub issue titled like "Car Finder: 3 new finds (9 Nov 2026)", mentions and assigns you, so GitHub emails you and sends a push notification through the GitHub app. Days with no changes post nothing. Cars that disappear move to a Gone list in the engine repo rather than being deleted.

To pause the daily scan: switch the saved searches off on the **Saved** tab, or in `car-finder-engine` go to Actions → Daily scan → "…" → Disable workflow.

## Settings

- **GitHub token**: paste, test, or forget it. The token never leaves this device and is encrypted with your password.
- **Search model**: Claude Sonnet 5.5 by default (lowest cost); Opus 5.5 and Fable 5.1 are available, and Haiku 5.5 for the cheapest daily scans. The daily scan has its own setting.
- **Usage and budget**: this month's spend as reported by Claude Code, against your monthly budget (default $100 of your $200 API credits). Runs warn at 80% and stop at 100%. Tap **Save model and budget to the engine** to apply changes.
- **Password**: change it or lock now. The site locks after 30 minutes of inactivity and when you close the tab.
- **This device**: clears the password, token and remembered settings from this browser only.

## Replacing an expired token

Fine-grained tokens last 90 days. When one expires the site tells you on the next action. Make a new one:

1. GitHub → profile photo → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Name: Car Finder. Expiration: 90 days. Resource owner: you.
3. Repository access: **Only select repositories** → `car-finder-engine`.
4. Repository permissions: **Actions: Read and write**, **Contents: Read-only** (Metadata is added automatically).
5. Generate, copy, then on the site: **Settings** → paste → **Save token**.

The token can start workflows and read files in `car-finder-engine`, nothing else. Saving a search runs a small workflow, so the token can never change code or scripts. If a device is lost, revoke the token on GitHub (same page) and use **Forget token** on any other device.

## Checking costs

- **Claude usage**: Settings shows this month's total and a bar against the budget. Each result and each Past searches row shows the cost Claude Code reported for that run. Details are in `car-finder-engine/usage/` (one file per month). Only the API key from your linked Console organisation uses the plan's API credits; the token fallback uses your normal plan limits instead.
- **GitHub Actions minutes**: the free plan includes 2,000 minutes a month for private repos. A search job is capped at 25 minutes; typical runs are shorter. See GitHub → Settings → Billing for the running total.

## About the password

GitHub Pages is a static host, so there is no server-side login. The password locks the site on this device and encrypts the GitHub token in the browser's storage (PBKDF2 with 600,000 rounds, AES-256-GCM). Anyone can read this site's code because the repo is public, but without the token on your device the site has nothing to show and nothing to run. The token is the real key; the password protects it on a device someone else might pick up. If you forget the password, use **Forgot it? Clear this device**, then set a new password and paste a new token.

## Security notes

- Everything the engine returns is shown as plain text, never as HTML. Only https images and links are allowed, and the page sets a strict Content Security Policy: no third-party scripts, styles or fonts, and the only network calls go to `api.github.com`.
- The site never sees your Anthropic key; that lives only as an Actions secret in the engine.

## Development

No build step. `npm test` runs the finance maths tests (`node --test tests/*.test.js`), including the two reference cases: £16,990 price, £1,699 deposit, 48 months at 11.87% APR gives HP £397.21 a month, and with a £7,000 final payment PCP £281.11 a month.
