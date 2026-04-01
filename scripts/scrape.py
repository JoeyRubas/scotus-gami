#!/usr/bin/env python3
"""
SCOTUS Scoragami Scraper

Fetches Supreme Court voting records from the Oyez API and computes:
- Unique dissent coalitions and when they first appeared ("scoragami" moments)
- Pairwise justice agreement rates
- Interesting stats and facts
"""

import json
import requests
import time
import os
import sys
from datetime import datetime, timezone
from collections import defaultdict

# ── Current Court ──────────────────────────────────────────────────────────────
CURRENT_JUSTICES = [
    "Roberts",
    "Thomas",
    "Alito",
    "Sotomayor",
    "Kagan",
    "Gorsuch",
    "Kavanaugh",
    "Barrett",
    "KBJ",
]

# Map every Oyez name variant → short canonical name
NAME_MAP = {
    "John G. Roberts, Jr.": "Roberts",
    "John Roberts": "Roberts",
    "Roberts": "Roberts",
    "Clarence Thomas": "Thomas",
    "Thomas": "Thomas",
    "Samuel A. Alito, Jr.": "Alito",
    "Samuel Alito": "Alito",
    "Alito": "Alito",
    "Sonia Sotomayor": "Sotomayor",
    "Sotomayor": "Sotomayor",
    "Elena Kagan": "Kagan",
    "Kagan": "Kagan",
    "Neil M. Gorsuch": "Gorsuch",
    "Neil Gorsuch": "Gorsuch",
    "Gorsuch": "Gorsuch",
    "Brett M. Kavanaugh": "Kavanaugh",
    "Brett Kavanaugh": "Kavanaugh",
    "Kavanaugh": "Kavanaugh",
    "Amy Coney Barrett": "Barrett",
    "Amy Barrett": "Barrett",
    "Barrett": "Barrett",
    "Ketanji Brown Jackson": "KBJ",
    "KBJ": "KBJ",
    # Previous justices kept so historical cases parse cleanly
    "Stephen G. Breyer": "Breyer",
    "Stephen Breyer": "Breyer",
    "Breyer": "Breyer",
    "Ruth Bader Ginsburg": "Ginsburg",
    "Ginsburg": "Ginsburg",
    "Anthony M. Kennedy": "Kennedy",
    "Kennedy": "Kennedy",
}

# Terms to fetch (Oyez names terms by the year they start, e.g. Oct 2022 = "2022")
TERMS = ["2024", "2023", "2022", "2021", "2020"]

DATA_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "decisions.json")

REQUEST_DELAY = 0.4   # seconds between API requests
MAX_RETRIES   = 3


# ── Oyez API helpers ────────────────────────────────────────────────────────────

def get(url, retries=MAX_RETRIES):
    """HTTP GET with retries and rate-limit back-off."""
    for attempt in range(retries):
        try:
            time.sleep(REQUEST_DELAY)
            resp = requests.get(url, timeout=30,
                                headers={"Accept": "application/json"})
            if resp.status_code == 429:
                wait = 10 * (attempt + 1)
                print(f"  Rate-limited – waiting {wait}s …", flush=True)
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            print(f"  Request error ({url}): {exc}", flush=True)
            if attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
    return None


def fetch_term(term):
    """Return the list of case summary objects for a given term."""
    data = get(f"https://api.oyez.org/cases?per_page=100&filter=term:{term}")
    return data if isinstance(data, list) else []


def fetch_case(href):
    """Return the full case detail object, or None on failure."""
    return get(href)


# ── Name normalisation ──────────────────────────────────────────────────────────

def normalize(raw_name):
    """Return the canonical short name for a justice, or None if unknown."""
    if not raw_name:
        return None
    clean = raw_name.strip()
    if clean in NAME_MAP:
        return NAME_MAP[clean]
    # Fuzzy fallback: try each key as a substring
    lower = clean.lower()
    for key, short in NAME_MAP.items():
        if key.lower() in lower:
            return short
    # Last resort: last token of the name
    return clean.split()[-1] if clean else None


# ── Vote parsing ────────────────────────────────────────────────────────────────

def parse_votes(case_detail):
    """
    Extract majority/dissent/concurrence lists from a case detail response.
    Returns a dict or None if no voting data is available.
    """
    decisions = case_detail.get("decisions") or []
    if not decisions:
        return None

    # Use the last decision entry (usually the final merits decision)
    decision = decisions[-1]
    raw_votes = decision.get("votes") or []
    if not raw_votes:
        return None

    majority, dissent, concurrence = [], [], []

    for entry in raw_votes:
        member = entry.get("member") or {}
        name = normalize(member.get("name", ""))
        if not name:
            continue

        # Prefer the boolean flag; fall back to string inspection
        maj_flag = entry.get("majority_vote")
        vote_str = (entry.get("vote") or "").lower()

        if maj_flag is True or "majority" in vote_str:
            majority.append(name)
        elif maj_flag is False or any(w in vote_str for w in ("dissent", "minority")):
            dissent.append(name)
        elif "concur" in vote_str:
            concurrence.append(name)

    if not majority:
        return None

    return {
        "majority":     sorted(set(majority)),
        "dissent":      sorted(set(dissent)),
        "concurrence":  sorted(set(concurrence)),
    }


def unix_to_iso(ts):
    """Convert a Unix timestamp (int or float) to an ISO-8601 date string."""
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
    except (ValueError, OSError, OverflowError):
        return str(ts)


def extract_decided_date(case_obj):
    """
    Extract the 'Decided' date from a case object.
    Oyez stores it in the timeline array rather than a top-level field.
    Falls back to the top-level decided_date / decided field.
    """
    # Preferred: timeline entry with event == 'Decided'
    for entry in (case_obj.get("timeline") or []):
        if (entry.get("event") or "").lower() == "decided":
            dates = entry.get("dates") or []
            if dates:
                return unix_to_iso(dates[0])

    # Legacy / fallback
    for field in ("decided_date", "decided"):
        raw = case_obj.get(field)
        if raw:
            return unix_to_iso(raw) if isinstance(raw, (int, float)) else str(raw)

    return ""


# ── Statistics ──────────────────────────────────────────────────────────────────

def compute_agreement_matrix(cases):
    """
    Build a pairwise agreement-rate matrix for all current justices.
    Agreement = both on same side (majority OR dissent).
    """
    together = defaultdict(lambda: defaultdict(int))
    total    = defaultdict(lambda: defaultdict(int))

    for case in cases:
        votes = case.get("votes") or {}
        majority     = votes.get("majority", [])
        dissent      = votes.get("dissent", [])
        concurrence  = votes.get("concurrence", [])
        participants = set(majority + dissent + concurrence)

        for j1 in participants:
            for j2 in participants:
                if j1 == j2:
                    continue
                total[j1][j2] += 1
                same_side = (
                    (j1 in majority    and j2 in majority)    or
                    (j1 in dissent     and j2 in dissent)
                )
                if same_side:
                    together[j1][j2] += 1

    matrix = {}
    for j1 in CURRENT_JUSTICES:
        matrix[j1] = {}
        for j2 in CURRENT_JUSTICES:
            if j1 == j2:
                matrix[j1][j2] = 100.0
            else:
                n = total[j1][j2]
                matrix[j1][j2] = round(together[j1][j2] / n * 100, 1) if n > 0 else None
    return matrix


def compute_coalitions(cases):
    """
    Track every unique dissent coalition (sorted tuple of dissenters).
    Returns a dict keyed by comma-joined dissenter names.
    """
    coalitions = {}

    for case in sorted(cases, key=lambda c: c.get("decided_date", "0000")):
        votes = case.get("votes") or {}
        dissenters = [j for j in votes.get("dissent", []) if j in CURRENT_JUSTICES]
        if not dissenters:
            continue

        key = ",".join(sorted(dissenters))
        if key not in coalitions:
            coalitions[key] = {
                "dissenters":   sorted(dissenters),
                "first_case":   case.get("name", "Unknown"),
                "first_date":   case.get("decided_date", ""),
                "first_docket": case.get("docket", ""),
                "count": 1,
            }
        else:
            coalitions[key]["count"] += 1

    return coalitions


def mark_new_coalitions(coalitions, previous_coalitions):
    """Flag coalitions that did not exist in the previously saved data."""
    for key, col in coalitions.items():
        col["is_new"] = key not in previous_coalitions


def generate_facts(coalitions, matrix):
    """Build a list of human-readable interesting facts."""
    facts = []

    # First-time sole dissenter / pair dissenter
    for key, col in sorted(coalitions.items(), key=lambda x: x[1].get("first_date", "")):
        dissenters = col["dissenters"]
        first_case = col["first_case"]
        first_date = col["first_date"]

        is_new = col.get("is_new", False)
        if len(dissenters) == 1:
            j = dissenters[0]
            facts.append({
                "type": "sole_dissent",
                "is_new": is_new,
                "text": f"First time {j} is the sole dissenter — {first_case}",
                "case": first_case,
                "date": first_date,
            })
        elif len(dissenters) == 2:
            j1, j2 = dissenters
            agree_pct = (matrix.get(j1) or {}).get(j2)
            agree_str = f", they agree {agree_pct:.0f}% of the time" if agree_pct is not None else ""
            facts.append({
                "type": "first_pair_dissent",
                "is_new": is_new,
                "text": (
                    f"First time {j1} and {j2} are sole dissenters on a case{agree_str}"
                    f" — {first_case}"
                ),
                "case": first_case,
                "date": first_date,
            })

    # Most / least agreeable pair among current justices
    pairs = [
        (j1, j2, matrix[j1][j2])
        for j1 in CURRENT_JUSTICES
        for j2 in CURRENT_JUSTICES
        if j1 < j2 and matrix.get(j1, {}).get(j2) is not None
    ]
    if pairs:
        most = max(pairs, key=lambda x: x[2])
        least = min(pairs, key=lambda x: x[2])
        facts.append({
            "type": "most_agree",
            "text": (
                f"{most[0]} and {most[1]} agree most often "
                f"({most[2]:.1f}% of cases)"
            ),
        })
        facts.append({
            "type": "most_disagree",
            "text": (
                f"{least[0]} and {least[1]} agree least often "
                f"({least[2]:.1f}% of cases)"
            ),
        })

    return facts


# ── Main ────────────────────────────────────────────────────────────────────────

def load_existing():
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE) as fh:
                return json.load(fh)
        except Exception:
            pass
    return {}


def main():
    print("SCOTUS Scoragami – starting data collection …", flush=True)

    previous = load_existing()
    prev_coalitions = set((previous.get("coalitions") or {}).keys())

    all_cases = []

    for term in TERMS:
        print(f"\nFetching term {term} …", flush=True)
        summaries = fetch_term(term)
        print(f"  {len(summaries)} cases found", flush=True)

        for summary in summaries:
            href = summary.get("href")
            if not href:
                continue

            detail = fetch_case(href)
            if not detail:
                continue

            votes = parse_votes(detail)
            if not votes:
                continue

            # Extract decided date — prefer detail, fall back to summary
            decided = extract_decided_date(detail) or extract_decided_date(summary)

            all_cases.append({
                "name":         detail.get("name") or summary.get("name", "Unknown"),
                "docket":       detail.get("docket_number") or summary.get("docket_number", ""),
                "term":         term,
                "decided_date": decided,
                "votes":        votes,
            })

        print(f"  Running total: {len(all_cases)} cases with voting data", flush=True)

    print(f"\nTotal cases with voting data: {len(all_cases)}", flush=True)

    agreement_matrix = compute_agreement_matrix(all_cases)
    coalitions       = compute_coalitions(all_cases)
    mark_new_coalitions(coalitions, prev_coalitions)
    facts            = generate_facts(coalitions, agreement_matrix)

    # Sort coalitions: most recent first for the UI
    sorted_coalitions = dict(
        sorted(coalitions.items(),
               key=lambda x: x[1].get("first_date", ""), reverse=True)
    )

    # Summary stats
    unanimous = sum(
        1 for c in all_cases
        if not (c.get("votes") or {}).get("dissent")
    )
    stats = {
        "total_cases":               len(all_cases),
        "unique_dissent_coalitions": len(coalitions),
        "unanimous_cases":           unanimous,
        "terms_covered":             TERMS,
    }
    if coalitions:
        most_common_key, most_common_val = max(
            coalitions.items(), key=lambda x: x[1]["count"]
        )
        stats["most_common_dissent"] = {
            "dissenters": most_common_val["dissenters"],
            "count":      most_common_val["count"],
        }

    output = {
        "last_updated":    datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stats":           stats,
        "cases":           all_cases,
        "coalitions":      sorted_coalitions,
        "agreement_matrix": agreement_matrix,
        "interesting_facts": facts,
    }

    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    with open(DATA_FILE, "w") as fh:
        json.dump(output, fh, indent=2)

    print(f"\nData written to {DATA_FILE}", flush=True)
    print(f"  {stats['total_cases']} cases processed", flush=True)
    print(f"  {stats['unique_dissent_coalitions']} unique dissent coalitions", flush=True)
    new_count = sum(1 for c in coalitions.values() if c.get("is_new"))
    if new_count:
        print(f"  🎉 {new_count} NEW scoragami moment(s) discovered!", flush=True)


if __name__ == "__main__":
    main()
