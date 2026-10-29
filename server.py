"""Rule #1 Stock Analyzer — local server.

Serves public/ and two thin data endpoints (SEC + Yahoo) with a disk cache.
All Rule #1 calculations run in the browser (public/rule1.js).

Run:  python server.py   then open http://127.0.0.1:8765
"""
import gzip
import json
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
CACHE = ROOT / ".cache"
CONFIG_FILE = ROOT / "config.local.json"
HOST, PORT = "127.0.0.1", 8765

TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"

# Keep only the XBRL concepts the engine uses (companyfacts is several MB).
NEEDED = {
    "RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueGoodsNet",
    "NetIncomeLoss", "NetIncomeLossAvailableToCommonStockholdersBasic", "ProfitLoss",
    "EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic",
    "StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    "NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    "PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets",
    "OperatingIncomeLoss",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    "IncomeTaxExpenseBenefit",
    "LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations",
    "WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfShareOutstandingBasicAndDiluted",
    "WeightedAverageNumberOfSharesOutstandingBasic",
}


def load_config():
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    return {}


def sec_user_agent():
    email = load_config().get("sec_contact_email", "").strip()
    if not email:
        raise ApiError(500, "חסר מייל-קשר ל-SEC בקובץ config.local.json (sec_contact_email)")
    return f"RuleOneAnalyzer/0.1 {email}"


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def fetch_json(url, ua):
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Encoding": "gzip", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise ApiError(404, "לא נמצא במקור הנתונים")
        if e.code == 429:
            raise ApiError(429, "מקור הנתונים עמוס — נסה שוב בעוד דקה")
        raise ApiError(502, f"שגיאה ממקור הנתונים ({e.code})")
    except (urllib.error.URLError, TimeoutError):
        raise ApiError(502, "אין חיבור למקור הנתונים")


def cached(name, max_age_s, producer):
    CACHE.mkdir(exist_ok=True)
    p = CACHE / f"{name}.json"
    if p.exists() and time.time() - p.stat().st_mtime < max_age_s:
        return json.loads(p.read_text(encoding="utf-8"))
    data = producer()
    p.write_text(json.dumps(data), encoding="utf-8")
    return data


def ticker_map():
    def produce():
        raw = fetch_json("https://www.sec.gov/files/company_tickers.json", sec_user_agent())
        return {v["ticker"].upper(): {"cik": v["cik_str"], "name": v["title"]} for v in raw.values()}
    return cached("tickers", 7 * 86400, produce)


def company(ticker):
    entry = ticker_map().get(ticker) or ticker_map().get(ticker.replace(".", "-"))
    if not entry:
        raise ApiError(404, f"הסימול {ticker} לא נמצא ב-SEC (רק מניות אמריקאיות שמגישות דוחות)")
    cik = int(entry["cik"])

    def produce():
        raw = fetch_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json", sec_user_agent())
        gaap = raw.get("facts", {}).get("us-gaap", {})
        facts = {k: {"units": v["units"]} for k, v in gaap.items() if k in NEEDED}
        return {"ticker": ticker, "cik": cik, "name": raw.get("entityName") or entry["name"], "facts": facts}
    return cached(f"sec_{cik}", 86400, produce)


def yahoo_chart(ticker, rng, interval):
    sym = ticker.replace(".", "-")
    url = f"https://query2.finance.yahoo.com/v8/finance/chart/{sym}?range={rng}&interval={interval}&events=split"
    raw = fetch_json(url, BROWSER_UA)
    res = (raw.get("chart") or {}).get("result")
    if not res:
        raise ApiError(404, f"אין נתוני מחיר לסימול {ticker}")
    return res[0]


def prices(ticker):
    def produce():
        monthly = yahoo_chart(ticker, "15y", "1mo")
        daily = yahoo_chart(ticker, "1y", "1d")
        meta = daily.get("meta", {})
        splits = [
            {"date": s["date"], "ratio": s["numerator"] / s["denominator"]}
            for s in (monthly.get("events", {}).get("splits") or {}).values() if s.get("denominator")
        ]
        mq = monthly["indicators"]["quote"][0]
        dq = daily["indicators"]["quote"][0]
        return {
            "price": meta.get("regularMarketPrice"),
            "currency": meta.get("currency"),
            "name": meta.get("longName") or meta.get("shortName"),
            "exchange": meta.get("fullExchangeName"),
            "asOf": meta.get("regularMarketTime"),
            "splits": splits,
            "monthly": [{"t": t, "close": c} for t, c in zip(monthly.get("timestamp", []), mq["close"]) if c is not None],
            "daily": [
                {"t": t, "h": h, "l": l, "c": c}
                for t, h, l, c in zip(daily.get("timestamp", []), dq["high"], dq["low"], dq["close"])
                if None not in (h, l, c)
            ],
        }
    return cached(f"px_{ticker}", 15 * 60, produce)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(PUBLIC), **kw)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; "
                         "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
        super().end_headers()

    def send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        gz = "gzip" in (self.headers.get("Accept-Encoding") or "")
        if gz:
            body = gzip.compress(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        m = re.match(r"^/api/(company|prices)/([^/?#]+)$", self.path.split("?")[0])
        if not m:
            if self.path.startswith("/api/"):
                return self.send_json(404, {"error": "לא קיים"})
            return super().do_GET()
        ticker = m.group(2).upper()
        if not TICKER_RE.match(ticker):
            return self.send_json(400, {"error": "סימול לא תקין"})
        try:
            data = company(ticker) if m.group(1) == "company" else prices(ticker)
            self.send_json(200, data)
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except Exception as e:  # never leak a traceback to the page
            print("ERROR", ticker, repr(e), file=sys.stderr)
            self.send_json(500, {"error": "שגיאה פנימית"})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    print(f"Rule #1 Analyzer: http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
