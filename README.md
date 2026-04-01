# SCOTUS Scoragami

Track every unique voting coalition on the Supreme Court — and celebrate when a new one appears for the first time.

Inspired by [NFL Scorigami](https://nflscorigami.com): just as NFL Scorigami tracks final scores that have never happened before, SCOTUS Scoragami tracks dissent coalitions that have never occurred before.

## What It Does

- **Scoragami moments** — highlights the first time a specific set of justices dissents together  
  *"This is the first time KBJ and Alito are sole dissenters on a case, they agree 86% of the time"*
- **Agreement matrix** — heat-map showing pairwise agreement rates between all current justices
- **Coalition explorer** — browse, filter, and sort every unique dissent coalition with case history

## Architecture

| Component | Purpose |
|---|---|
| `scripts/scrape.py` | Python scraper using the [Oyez API](https://api.oyez.org); outputs `data/decisions.json` |
| `.github/workflows/update-data.yml` | Daily GitHub Action that runs the scraper and commits updated data |
| `index.html` / `style.css` / `app.js` | Static GitHub Pages site that reads from `data/decisions.json` |

## Local Development

```bash
# Install dependencies
pip install requests

# Run the scraper (writes data/decisions.json)
python scripts/scrape.py

# Serve the site locally
python -m http.server 8080
# open http://localhost:8080
```

## Data Source

Voting records are fetched from the [Oyez Project](https://www.oyez.org) API, covering SCOTUS terms 2020–2024.
