"""Nightly static-data build for the GitHub Pages version.

Pulls S&P 500 + Nasdaq-100 constituents, then for each ticker writes
<out>/data/<TICKER>.json = {"company": ..., "prices": ...} in the exact shape
the local server's /api endpoints return, plus <out>/data/index.json.

Usage:  python scripts/build_data.py <out_dir> [--limit N] [--only T1,T2]
Env:    SEC_CONTACT_EMAIL (required by SEC fair-access policy)
        PREVIOUS_SITE      (optional base URL; on failure reuse yesterday's file)
"""
import json
import os
import re
import sys
import time
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402  (reuses fetch/trim logic so both versions stay identical)

INDEX_PAGES = {
    "sp500": "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
    "nasdaq100": "https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies",
}
FALLBACK_LIST = Path(__file__).resolve().parent / "tickers_fallback.json"


class TablesParser(HTMLParser):
    """Collects every <table> as (headers, rows) of plain cell text."""

    def __init__(self):
        super().__init__()
        self.stack, self.tables = [], []
        self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.stack.append({"headers": [], "rows": [], "row": []})
        elif self.stack and tag == "tr":
            self.stack[-1]["row"] = []
        elif self.stack and tag in ("td", "th"):
            self.cell = ""

    def handle_endtag(self, tag):
        if not self.stack:
            return
        t = self.stack[-1]
        if tag == "table":
            self.tables.append(self.stack.pop())
        elif tag in ("td", "th") and self.cell is not None:
            t["row"].append(self.cell.strip())
            self.cell = None
        elif tag == "tr" and t["row"]:
            (t["rows"] if t["headers"] else t["headers"]).extend([t["row"]] if t["headers"] else t["row"])

    def handle_data(self, data):
        if self.cell is not None:
            self.cell += data


def constituents(url, min_rows=90):
    """Ticker column of the first table that has a Symbol/Ticker header and enough rows."""
    req = urllib.request.Request(url, headers={"User-Agent": "RuleOneAnalyzer/0.1 (personal research)"})
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8")
    p = TablesParser()
    p.feed(html)
    for t in p.tables:
        heads = [h.lower() for h in t["headers"]]
        col = next((i for i, h in enumerate(heads) if h in ("symbol", "ticker")), None)
        if col is None or len(t["rows"]) < min_rows:
            continue
        out = []
        for r in t["rows"]:
            if len(r) > col:
                sym = r[col].upper().replace("-", ".").strip()
                if server.TICKER_RE.match(sym):
                    out.append(sym)
        return out
    raise ValueError("no constituents table found")


def load_universe():
    lists = {}
    for name, url in INDEX_PAGES.items():
        try:
            lists[name] = constituents(url)
            print(f"{name}: {len(lists[name])} tickers")
        except Exception as e:  # keep the last known list if Wikipedia changes
            print(f"WARN {name} list failed: {e!r}")
    if len(lists.get("sp500", [])) < 450 or len(lists.get("nasdaq100", [])) < 95:
        print("WARN using fallback ticker list")
        lists = json.loads(FALLBACK_LIST.read_text(encoding="utf-8"))
    else:
        FALLBACK_LIST.write_text(json.dumps(lists, indent=0), encoding="utf-8")
    return lists


def compact_facts(facts):
    """Keep only annual 10-K rows from the last ~14 years with the fields the engine reads."""
    cutoff = f"{time.gmtime().tm_year - 14}-01-01"
    out = {}
    for concept, node in facts.items():
        units = {}
        for unit, rows in node["units"].items():
            keep = [
                {k: r[k] for k in ("start", "end", "val", "filed", "form", "fp") if k in r}
                for r in rows
                if r.get("form") in ("10-K", "10-K/A", "10-KT") and r.get("fp") == "FY" and r.get("end", "") >= cutoff
            ]
            if keep:
                units[unit] = keep
        if units:
            out[concept] = {"units": units}
    return out


def previous(base, ticker):
    try:
        with urllib.request.urlopen(f"{base.rstrip('/')}/data/{ticker}.json", timeout=20) as r:
            return json.loads(r.read())
    except Exception:
        return None


def main():
    out = Path(sys.argv[1])
    args = sys.argv[2:]
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
    only = args[args.index("--only") + 1].split(",") if "--only" in args else None
    prev_base = os.environ.get("PREVIOUS_SITE", "")

    if only:
        lists = {"custom": only}
    else:
        lists = load_universe()
    membership = {}
    for name, ts in lists.items():
        for t in ts:
            membership.setdefault(t, []).append(name)
    tickers = sorted(membership)[:limit] if limit else sorted(membership)

    data_dir = out / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    index, failed, reused = [], [], []
    for i, t in enumerate(tickers, 1):
        try:
            company = server.company(t)
            company["facts"] = compact_facts(company["facts"])
            time.sleep(0.15)  # SEC fair access: well under 10 req/s
            prices = None
            for attempt in range(3):
                try:
                    prices = server.prices(t)
                    break
                except server.ApiError as e:
                    if e.status != 429 or attempt == 2:
                        raise
                    time.sleep(5 * (attempt + 1))
            doc = {"company": company, "prices": prices, "builtAt": int(time.time())}
        except Exception as e:
            doc = previous(prev_base, t) if prev_base else None
            if not doc:
                failed.append(t)
                print(f"[{i}/{len(tickers)}] {t} FAILED {getattr(e, 'message', repr(e))}")
                continue
            reused.append(t)
        (data_dir / f"{t}.json").write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
        index.append({"t": t, "n": doc["company"]["name"], "i": membership[t]})
        if i % 50 == 0:
            print(f"[{i}/{len(tickers)}] ok")
        time.sleep(0.25)

    (data_dir / "index.json").write_text(json.dumps(
        {"builtAt": int(time.time()), "tickers": index, "failed": failed, "reused": reused},
        ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"done: {len(index)} ok, {len(reused)} reused from yesterday, {len(failed)} failed")
    # A mostly-failed run must not replace a good site.
    if len(index) < 0.8 * len(tickers):
        sys.exit(1)


if __name__ == "__main__":
    main()
