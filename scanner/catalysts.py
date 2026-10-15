"""Clasifica el motivo de la subida a partir de los titulares (reglas por palabras clave, gratis).

Más adelante se puede sustituir/complementar por un LLM; la interfaz (classify) no cambiaría.
"""
import re
from datetime import date, datetime, timezone

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
    "none": {
        "label": "Sin noticia clara", "quality": 0.1,
        "note": "Precaución: subida sin catalizador identificable.",
    },
}

PATTERNS = {
    "earnings_guidance": r"(raise[sd]?|lifts?|boosts?|hikes?|ups|increases?|upbeat|strong|above-consensus)\s+(its\s+)?(full[- ]year\s+|annual\s+|fy\s*\d*\s+|\d{4}\s+)?(guidance|outlook|forecast)",
    "earnings": r"\bearnings\b|\bresults\b|\bquarterly\b|\bq[1-4]\b|\beps\b|\bbeats?\b|tops?\s+(estimates|expectations|forecasts)|same-store sales|(revenue|sales|profit)s?\s+(beat|jump|surge|soar|rise|top|climb)",
    # Objetivo de una OPA (la compran a ella): sube hasta el precio ofrecido y se queda ahí
    "takeover": r"take[- ]private|go(ing|es)? private|to be (acquired|bought)|agrees? to be (acquired|bought)|acquired by|buyout (offer|deal|bid)|takeover (bid|offer)|tender offer|receives? .{0,30}(offer|bid|proposal)|explor\w+ (a )?sale",
    # Ella compra a otra o se fusiona
    "acquisition": r"\bacquires?\b|\bto acquire\b|acquisition of|\bmerger\b|\bmerge\b|\bto buy\b|\bbuys\b",
    "capital": r"refinanc|credit facilit|term loan|\bbuyback\b|repurchase|special dividend|debt (deal|reduction|paydown)",
    "fda": r"\bfda\b|approv(al|es|ed)|phase\s*(1|2|3|i{1,3})\b|\btrial\b|clinical|topline|breakthrough therapy|\bema\b",
    "analyst": r"\bupgrad|price target (raise|hike|boost)|raises? (price )?target|initiat\w* (coverage|at)|overweight|outperform|buy rating|bullish (call|on)|top pick",
    "contract": r"contract|partnership|partners with|agreement|collaborat|awarded|\border\b|deal with|selected (by|as)",
    "sector": r"sector|stocks (rally|surge|jump|soar)|peers|industry|rate cut|tariff|\bfed\b",
}
_RX = {k: re.compile(v, re.I) for k, v in PATTERNS.items()}


def key_headlines_first(headlines: list[dict], kind: str) -> list[dict]:
    """Reordena: primero los titulares que explican el catalizador detectado, luego el resto."""
    rxs = [_RX[k] for k in ("earnings_guidance", "earnings")] if kind == "earnings_guidance" else (
        [_RX[kind]] if kind in _RX else [])
    hit = [h for h in headlines if any(rx.search(h["title"]) for rx in rxs)]
    return hit + [h for h in headlines if h not in hit]


def classify(headlines: list[dict], earnings_ts: int | None, market_date: str | None) -> dict:
    scores = {k: 0.0 for k in PATTERNS}
    for i, h in enumerate(headlines):
        w = 1.5 if i < 3 else 1.0  # los titulares más recientes pesan más
        for k, rx in _RX.items():
            if rx.search(h["title"]):
                scores[k] += w

    # Fecha de resultados oficial muy cercana = señal fuerte de que el motivo son los resultados.
    # Si no la hay, los titulares de "earnings" suelen ser previas o transcripciones antiguas: pesan poco.
    near_earnings = False
    if earnings_ts and market_date:
        d_earn = datetime.fromtimestamp(earnings_ts, timezone.utc).date()
        near_earnings = -3 <= (date.fromisoformat(market_date) - d_earn).days <= 1
    if near_earnings:
        scores["earnings"] += 3
    else:
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

    return {"type": kind, **CATALYSTS[kind], "confidence": round(min(scores.get(kind, 0) / 5, 1), 2)}
