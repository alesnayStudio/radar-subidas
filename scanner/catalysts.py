"""Clasifica el motivo de la subida a partir de los titulares (reglas por palabras clave, gratis).

Más adelante se puede sustituir/complementar por un LLM; la interfaz (classify) no cambiaría.
"""
import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")

CATALYSTS = {
    "earnings_guidance": {
        "label": "Resultados + mejora de previsiones", "quality": 1.0,
        "note": "El catalizador con más continuidad histórica (post-earnings drift).",
    },
    "earnings": {
        "label": "Resultados trimestrales", "quality": 0.85,
        "note": "Mira si además mejoran previsiones: es lo que sostiene la subida.",
    },
    "analyst": {
        "label": "Mejora de analista", "quality": 0.6,
        "note": "Impulso moderado; suele diluirse si no hay más noticias.",
    },
    "contract": {
        "label": "Contrato / alianza", "quality": 0.6,
        "note": "Valora el tamaño del contrato frente a los ingresos de la empresa.",
    },
    "fda": {
        "label": "Biotech / FDA / ensayo", "quality": 0.5,
        "note": "Muy volátil: puede revertir con fuerza.",
    },
    "corporate": {
        "label": "Evento corporativo (spin-off, índice, salida a bolsa)", "quality": 0.5,
        "note": "Flujos de fondos que compran o venden por obligación: el efecto suele ser temporal.",
    },
    "sector": {
        "label": "Movimiento sectorial / macro", "quality": 0.4,
        "note": "Sube con su sector; depende del contexto general.",
    },
    "acquisition": {
        "label": "Compra / fusión con otra empresa", "quality": 0.5,
        "note": "El mercado premia la operación; vigila cómo se financia y si la aprueban reguladores.",
    },
    "capital": {
        "label": "Financiación / recompra", "quality": 0.45,
        "note": "Mejora del balance o recompra de acciones: impulso limitado salvo que cambie la tesis.",
    },
    "takeover": {
        "label": "OPA / la compran", "quality": 0.3,
        "note": "Si la compran, el precio se queda pegado al de la oferta: poco recorrido.",
    },
    "pre_earnings": {
        "label": "Subida antes de resultados", "quality": 0.15,
        "note": "Aún no ha presentado resultados: el día que los publique puede moverse ±10-20% en cualquier sentido.",
    },
    "none": {
        "label": "Sin noticia clara", "quality": 0.1,
        "note": "Precaución: subida sin catalizador identificable.",
    },
}

PATTERNS = {
    "earnings_guidance": r"(raise[sd]?|lifts?|boosts?|hikes?|ups|upgrade[sd]?|increases?|upbeat|strong|above-consensus)\s+(its\s+)?([\w-]+\s+){0,2}(guidance|outlook|forecast)",  # "raises 2027 EBITDA outlook"
    "earnings": r"\bearnings\b|\bresults\b|\bquarterly\b|\bq[1-4]\b|\beps\b|\bbeats?\b|tops?\s+(estimates|expectations|forecasts)|same-store sales|(revenue|sales|profit)s?\s+(beat|jump|surge|soar|rise|top|climb)",
    # Objetivo de una OPA (la compran a ella): sube hasta el precio ofrecido y se queda ahí
    "takeover": r"take[- ]private|go(ing|es)? private|to be (acquired|bought)|agrees? to be (acquired|bought)|acquired by|buyout (offer|deal|bid)|takeover (bid|offer)|tender offer|receives? .{0,30}(offer|bid|proposal)|explor\w+ (a )?sale",
    # Ella compra a otra o se fusiona
    "acquisition": r"\bacquires?\b|\bto acquire\b|acquisition of|\bmerger\b|\bmerge\b|\bto buy\b|\bbuys\b",
    "capital": r"refinanc|credit (facilit|agreement)|amend\w* .{0,20}credit|term loan|\bbuyback\b|repurchase|special dividend|debt (deal|reduction|paydown)",
    "fda": r"\bfda\b|approv(al|es|ed)|phase\s*(1|2|3|i{1,3})\b|\btrial\b|clinical|topline|breakthrough therapy|\bema\b",
    "analyst": r"\bupgrad|price target (raise|hike|boost)|raises? (price )?target|initiat\w* (coverage|at)|overweight|outperform|buy rating|bullish (call|on)|top pick"
               # "Morgan Stanley Call Sends TeraWulf Stock Surging", "Goldman says ... mispriced"
               r"|\b(morgan stanley|goldman|jpmorgan|j\.?p\.? ?morgan|bank of america|bofa|citi(group)?|ubs|barclays|wells fargo|jefferies|bernstein|deutsche bank|evercore|piper sandler|raymond james|mizuho|btig|needham|wedbush|oppenheimer|cantor|truist|stifel|hsbc|kepler)\b.{0,40}\b(call|says|sees|names|picks|bullish|upgrade)",
    "contract": r"contract|partnership|partners with|(?<!credit )agreement|collaborat|awarded|\border\b|deal with|selected (by|as)",
    "corporate": r"spin-?off|completes? (the )?separation|separation from|begins (trading|operations) as|\bipo\b|trading debut|debut|added to (the )?(s&p|nasdaq|russell)|join(s|ing)? (the )?(s&p|nasdaq-100|russell)|index (inclusion|addition)",
    "sector": r"sector|stocks (are )?(rall|surg|jump|soar|ris)\w*|peers|industry|rate cut|tariff|\bfed\b|broader|\brival\b|next (takeover )?target|sympathy",
}

# Frases de "clickbait" que contienen "buy" pero no hablan de ninguna compra de empresa
_BUY_NOISE = re.compile(
    r"too late to buy|should you buy|(time|stocks?|reasons?|ways) to buy|buy (now|today|the dip)|"
    r"\ba buy\b|worth buying|buy or sell|buy rating|strong buy", re.I)
# Titulares que hablan de resultados FUTUROS (fecha, previa) y no de unos resultados publicados
_EARNINGS_NOISE = re.compile(
    r"\bto (report|announce|release|host)\b|will (report|announce|release|consider)|schedul|board meeting|"
    r"ahead of|preview|earnings date|what to (expect|look for|watch)|expectations for", re.I)
# Conectores que indican que la compra la hace un tercero ("Klaviyo jumps as Salesforce moves to acquire Braze")
_THIRD_PARTY = re.compile(r"\b(as|after|amid|while|following)\b", re.I)
# Los titulares "sectoriales" suelen ser resúmenes de mercado que mencionan a muchas empresas a la vez:
# pesan menos para que no tapen el motivo concreto (ni conviertan en "sector" una subida sin noticia)
WEIGHT = {"sector": 0.6}
_RX = {k: re.compile(v, re.I) for k, v in PATTERNS.items()}


def key_headlines_first(headlines: list[dict], kind: str) -> list[dict]:
    """Reordena: primero los titulares que explican el catalizador detectado, luego el resto."""
    rxs = [_RX[k] for k in ("earnings_guidance", "earnings")] if kind == "earnings_guidance" else (
        [_RX[kind]] if kind in _RX else [])
    if kind in ("takeover", "acquisition"):  # "Salesforce buys Braze" explica la OPA de Braze
        rxs.append(_RX["acquisition"])
    hit = [h for h in headlines if any(rx.search(h["title"]) for rx in rxs)]
    return hit + [h for h in headlines if h not in hit]


def _deal_role(title: str, company: list[re.Pattern] | None) -> str | None:
    """Para un titular de compra/fusión decide el papel de NUESTRA empresa según dónde aparece su nombre:
    'Salesforce buys Braze' -> para Braze es 'takeover' (la compran); para Salesforce, 'acquisition'.
    Devuelve None si el titular no habla de una compra."""
    m = _RX["acquisition"].search(title)
    if not m:
        return None
    if not company:
        return "acquisition"
    hits = [h for rx in company for h in rx.finditer(title)]
    before = [h for h in hits if h.start() < m.start()]
    after = [h for h in hits if h.start() >= m.end()]
    if after and not before:
        return "takeover"
    if before and _THIRD_PARTY.search(title[max(h.end() for h in before):m.start()]):
        return "sector"  # sube por contagio de una operación entre otras empresas
    return "acquisition"


def classify(headlines: list[dict], earnings_ts: int | None, market_date: str | None,
             company: list[re.Pattern] | None = None) -> dict:
    """`company`: patrones con el nombre/ticker de la empresa (news.company_names), para saber si
    en una operación es la compradora o la comprada."""
    scores = {k: 0.0 for k in PATTERNS}
    for i, h in enumerate(headlines):
        w = 1.5 if i < 3 else 1.0  # los titulares más recientes pesan más
        title = h["title"]
        deal_title = _BUY_NOISE.sub(" ", title)
        for k, rx in _RX.items():
            if k in ("earnings", "earnings_guidance") and _EARNINGS_NOISE.search(title):
                continue
            if k == "acquisition":
                role = _deal_role(deal_title, company)
                if role:
                    scores[role] += w * WEIGHT.get(role, 1.0)
                continue
            if rx.search(title):
                scores[k] += w * WEIGHT.get(k, 1.0)

    timing, _ = earnings_timing(earnings_ts, market_date)
    if timing == "reported":
        # Resultados publicados antes del cierre de la sesión: casi seguro que son el motivo
        scores["earnings"] += 3
    elif timing == "upcoming":
        # Los resultados llegan DESPUÉS de la subida: los titulares de "beat" son de después del cierre
        # o previas. La subida del día no la explican los resultados.
        scores["earnings"] = scores["earnings_guidance"] = 0
    else:
        # Sin fecha cercana: los titulares de "earnings" suelen ser transcripciones antiguas, pesan poco
        scores["earnings"] *= 0.3
        scores["earnings_guidance"] *= 0.3

    if scores["earnings_guidance"] and scores["earnings"]:
        kind = "earnings_guidance"
    else:
        scores.pop("earnings_guidance")
        # "X to be acquired" también casa con el patrón de compradora: la OPA tiene prioridad
        if scores["takeover"]:
            scores["acquisition"] = 0
        kind = max(scores, key=scores.get)
        if scores[kind] < 1:
            kind = "none"
        if timing == "upcoming" and kind in ("none", "sector"):
            kind = "pre_earnings"

    return {"type": kind, **CATALYSTS[kind], "confidence": round(min(scores.get(kind, 0) / 5, 1), 2)}


def earnings_timing(earnings_ts: int | None, market_date: str | None) -> tuple[str | None, str | None]:
    """Sitúa los resultados respecto al CIERRE de la sesión escaneada (16:00 Nueva York):
    'reported' = publicados en los 4 días anteriores al cierre (explican la subida);
    'upcoming' = se publican tras el cierre, en los próximos 5 días (la subida fue ANTES de conocerlos).
    Devuelve (situación, fecha y hora ISO en Nueva York)."""
    if not earnings_ts or not market_date:
        return None, None
    earn = datetime.fromtimestamp(earnings_ts, NY)
    close = datetime.combine(date.fromisoformat(market_date), time(16, 0), NY)
    if close - timedelta(days=4) <= earn < close:
        return "reported", earn.isoformat()
    if close <= earn <= close + timedelta(days=5):
        return "upcoming", earn.isoformat()
    return None, None
