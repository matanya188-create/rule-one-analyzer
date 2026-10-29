"""Rule #1 Stock Analyzer — local server.

Serves public/ and two thin data endpoints (SEC + Yahoo) with a disk cache.
All Rule #1 calculations run in the browser (public/rule1.js).

Run:  python server.py   then open http://127.0.0.1:8765
"""
import gzip
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
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


def access_key():
    """Secret that gates the whole site. Generated once into config.local.json."""
    cfg = load_config()
    if len(cfg.get("access_key", "")) < 24:
        cfg["access_key"] = secrets.token_urlsafe(24)
        CONFIG_FILE.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    return cfg["access_key"]


ACCESS_KEY = None  # set in __main__ so importing this module (nightly build) has no side effects
COOKIE = "r1k"
COOKIE_MAX_AGE = 90 * 86400


class RateLimiter:
    """Fixed one-minute window, process-wide (the site has a single owner)."""

    def __init__(self, per_minute):
        self.per_minute = per_minute
        self.window = 0
        self.count = 0
        self.lock = threading.Lock()

    def allow(self):
        with self.lock:
            now = int(time.time() // 60)
            if now != self.window:
                self.window, self.count = now, 0
            self.count += 1
            return self.count <= self.per_minute


API_LIMIT = RateLimiter(60)
BAD_KEY_LIMIT = RateLimiter(10)
KEY_IN_URL = re.compile(r"([?&]k=)[^&\s]*")


def sec_user_agent():
    email = (os.environ.get("SEC_CONTACT_EMAIL") or load_config().get("sec_contact_email", "")).strip()
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


LOCKED_PAGE = """<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>גישה נעולה</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px 16px;text-align:center">
<h1>גישה נעולה</h1><p>האתר פרטי. יש להיכנס דרך הקישור האישי.</p></body></html>""".encode("utf-8")


class Handler(SimpleHTTPRequestHandler):
    server_version = "r1"
    sys_version = ""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(PUBLIC), **kw)

    def list_directory(self, path):  # never expose directory listings
        self.send_error(404)
        return None

    def authorized(self):
        """Cookie holds the key; ?k=KEY once sets the cookie and redirects to a clean URL."""
        jar = self.headers.get("Cookie") or ""
        for part in jar.split(";"):
            name, _, value = part.strip().partition("=")
            if name == COOKIE and hmac.compare_digest(value, ACCESS_KEY):
                return True
        url = urllib.parse.urlsplit(self.path)
        given = urllib.parse.parse_qs(url.query).get("k", [""])[0]
        if given:
            if not BAD_KEY_LIMIT.allow() and not hmac.compare_digest(given, ACCESS_KEY):
                self.send_locked(429)
                return False
            if hmac.compare_digest(given, ACCESS_KEY):
                self.send_response(302)
                self.send_header("Set-Cookie", f"{COOKIE}={ACCESS_KEY}; Max-Age={COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax")
                self.send_header("Location", url.path or "/")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return False
        if url.path.startswith("/api/"):
            self.send_json(401, {"error": "נדרשת כניסה דרך הקישור האישי"})
        else:
            self.send_locked(401)
        return False

    def send_locked(self, status):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(LOCKED_PAGE)))
        self.end_headers()
        self.wfile.write(LOCKED_PAGE)

    def do_HEAD(self):
        if self.authorized():
            super().do_HEAD()

    def end_headers(self):
        self.send_header("Strict-Transport-Security", "max-age=31536000")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self' https://s3.tradingview.com; frame-src https://www.tradingview-widget.com https://s.tradingview.com https://www.tradingview.com; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; "
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
        if not self.authorized():
            return
        m = re.match(r"^/api/(company|prices)/([^/?#]+)$", self.path.split("?")[0])
        if not m:
            if self.path.startswith("/api/"):
                return self.send_json(404, {"error": "לא קיים"})
            return super().do_GET()
        if not API_LIMIT.allow():
            return self.send_json(429, {"error": "יותר מדי בקשות — נסה שוב בעוד דקה"})
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
        line = KEY_IN_URL.sub(r"\1***", fmt % args)  # never write the access key to logs
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), line))


if __name__ == "__main__":
    ACCESS_KEY = access_key()
    print(f"Rule #1 Analyzer: http://{HOST}:{PORT}/?k=<access_key from config.local.json>")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
