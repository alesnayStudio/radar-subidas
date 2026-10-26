"""Titulares recientes de cada acción. Fuentes gratuitas y sin API key: Google News RSS + Yahoo Finance."""
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import yfinance as yf

from . import config

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"}
_SUFFIXES = re.compile(
    r"[,.]?\s+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|n\.?v|s\.?a|ag|se|class [a-c])\.?$",
    re.I,
)


def clean_company_name(name: str) -> str:
    """'Penske Automotive Group, Inc.' -> 'Penske Automotive'."""
    prev = None
    name = name.strip()
    while prev != name:
        prev, name = name, _SUFFIXES.sub("", name).strip(" ,.")
    return name


_GENERIC = {
    "the", "and", "group", "holdings", "international", "technologies", "technology", "global", "american",
    "national", "company", "industries", "systems", "financial", "services", "therapeutics", "pharmaceuticals",
    "energy", "bank", "capital", "resources", "partners", "trust", "realty", "properties", "brands", "health",
}


# Vocabulario bursátil: para nombres de una sola palabra común ("Pool", "Noble", "Blackstone") exigimos
# que el titular hable de bolsa cerca del nombre, para no colar "NFL Survivor Pool" o "Barnes & Noble"
_FIN = (r"stocks?|shares?|earnings|q[1-4]|results|revenue|profit|eps|guidance|outlook|forecast|analysts?|"
        r"price target|rating|upgrades?|downgrades?|dividend|nyse|nasdaq|inc|corp|corporation|ltd|plc|ceo|"
        r"deal|acquir\w*|merger|buy\w*|takeover|premium|invest\w*|billion|million|\$\d+\w*|growth|"
        r"surges?|jumps?|soars?|rall\w*|falls?|drops?|beats?|miss\w*|sales|quarter")
# Basura recurrente de Google News (retransmisiones deportivas piratas, etc.)
_JUNK = re.compile(r"live ?stream|free ?stream|\[\S*stream|watch .{0,40} online|crackstreams|buffstreams|\[\s*live", re.I)


def _name_words(name: str) -> list[str]:
    return [w for w in re.findall(r"[A-Za-z][\w&'-]+", clean_company_name(name))
            if len(w) >= 4 and w.lower() not in _GENERIC]


def company_names(symbol: str, name: str) -> list[re.Pattern]:
    """Patrones que encuentran SOLO el nombre o ticker (para saber en qué posición del titular aparece)."""
    return ([re.compile(rf"\b{re.escape(w)}\b", re.I) for w in _name_words(name)[:3]]
            + [re.compile(rf"\b{re.escape(symbol)}\b")])


def company_patterns(symbol: str, name: str) -> list[re.Pattern]:
    """Patrones para decidir si un titular habla de la empresa (más estrictos con nombres genéricos)."""
    words = _name_words(name)
    if len(words) == 1:
        w = re.escape(words[0])
        other = r"(?<!& )"  # "Barnes & Noble" es otra empresa
        name_rx = [
            re.compile(rf"^\W*(\S+\s+)?{w}\b", re.I),  # el nombre es el sujeto: "MiniMed Completes...", "Why Biohaven..."
            re.compile(rf"{other}\b{w}\b.{{0,40}}({_FIN})\b|\b({_FIN})\b.{{0,40}}{other}\b{w}\b", re.I),
        ]
    else:
        name_rx = [re.compile(rf"\b{re.escape(w)}\b", re.I) for w in words[:3]]
    s = re.escape(symbol)
    # Tickers de 1-2 letras (R, NE) solo en formato bursátil: "(NYSE:R)", "$NE", "R stock"
    sym_rx = (re.compile(rf"[(:$]\s*{s}\b|\b{s}\s+(stock|shares)\b") if len(symbol) <= 2
              else re.compile(rf"\b{s}\b"))
    return name_rx + [sym_rx]


def is_relevant(title: str, keywords: list[re.Pattern]) -> bool:
    """Descarta titulares que no nombran a la empresa (p. ej. 'Appian Way' para Appian sí pasa, pero
    'Name Day October 14th' no)."""
    return not _JUNK.search(title) and any(k.search(title) for k in keywords)


def _google_news(symbol: str, name: str, since: datetime) -> list[dict]:
    q = f'"{clean_company_name(name)}" OR "{symbol} stock" when:{config.NEWS_LOOKBACK_DAYS}d'
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": q, "hl": "en-US", "gl": "US", "ceid": "US:en"}
    )
    xml = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15).read()
    out = []
    for item in ET.fromstring(xml).iterfind(".//item"):
        try:
            published = parsedate_to_datetime(item.findtext("pubDate"))
        except (TypeError, ValueError):
            continue
        if published < since:
            continue
        source = item.findtext("source") or ""
        title = item.findtext("title") or ""
        if source and title.endswith(" - " + source):
            title = title[: -len(source) - 3]
        out.append({"title": title, "source": source, "link": item.findtext("link"), "published": published})
    return out


def _yahoo_news(symbol: str, since: datetime) -> list[dict]:
    out = []
    for n in yf.Search(symbol, news_count=10, enable_fuzzy_query=False).news:
        if symbol not in (n.get("relatedTickers") or []):
            continue
        published = datetime.fromtimestamp(n.get("providerPublishTime", 0), timezone.utc)
        if published < since:
            continue
        out.append({"title": n["title"], "source": n.get("publisher", "Yahoo"), "link": n.get("link"), "published": published})
    return out


def get_news(symbol: str, name: str, limit: int = 8) -> list[dict]:
    since = datetime.now(timezone.utc) - timedelta(days=config.NEWS_LOOKBACK_DAYS)
    items = []
    for fetch in (lambda: _google_news(symbol, name, since), lambda: _yahoo_news(symbol, since)):
        try:
            items += fetch()
        except Exception as e:  # una fuente caída no debe tumbar el escaneo
            print(f"  [news] {symbol}: {type(e).__name__}: {e}")
    keywords = company_patterns(symbol, name)
    seen, unique = set(), []
    for it in sorted(items, key=lambda x: x["published"], reverse=True):
        key = re.sub(r"\W+", "", it["title"].lower())[:60]
        if key not in seen and is_relevant(it["title"], keywords):
            seen.add(key)
            unique.append({**it, "published": it["published"].isoformat()})
    time.sleep(0.4)  # cortesía con los servidores gratuitos
    return unique[:limit]
