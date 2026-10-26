"""Máximo histórico (ATH) de cada acción y dónde está la subida respecto a él.

Una subida que rompe máximos históricos no tiene vendedores "atrapados" por encima (todos los accionistas
ganan); un rebote desde muy abajo suele chocar con quienes compraron más caro y quieren salir.
Las estadísticas dirán si esa diferencia se nota en tus datos.
"""
from datetime import date

import yfinance as yf

# Situación respecto al máximo histórico (en este orden de "fuerza")
STATUS = {
    "new_ath": {"label": "Nuevo máximo histórico", "icon": "🚀"},
    "near":    {"label": "Cerca de máximos (a menos del 5%)", "icon": "🔝"},
    "mid":     {"label": "Entre un 5% y un 50% por debajo", "icon": "↗️"},
    "rebound": {"label": "Rebote (más de un 50% por debajo)", "icon": "↩️"},
}
NEAR_PCT, REBOUND_PCT = -5.0, -50.0
SUSPECT_PCT = -98.0  # por debajo: histórico de Yahoo no fiable


def classify(pct_from_ath: float, new_ath: bool) -> str:
    if new_ath:
        return "new_ath"
    if pct_from_ath >= NEAR_PCT:
        return "near"
    if pct_from_ath > REBOUND_PCT:
        return "mid"
    return "rebound"


def ath_info(rows: list[dict], scan_date: str) -> dict[str, dict]:
    """rows: [{symbol, price, day_high?}] del día `scan_date`. Devuelve {symbol: info}.

    Usa máximos intradía ajustados SOLO por splits (si no, un split 10x1 aparentaría una caída del 90%).
    No ajusta por dividendos: en acciones con mucho dividendo rebajaría los máximos antiguos y los
    haría menores que el de 52 semanas (pasaba con RITM). Solo cuenta datos hasta `scan_date`.
    """
    if not rows:
        return {}
    d = date.fromisoformat(scan_date)
    # auto_adjust=False: OHLC de Yahoo ya ajustados por splits pero no por dividendos
    df = yf.download([r["symbol"] for r in rows], period="max", auto_adjust=False, progress=False,
                     threads=True, multi_level_index=True)
    out = {}
    for r in rows:
        sym = r["symbol"]
        try:
            high, close = df["High"][sym].dropna(), df["Close"][sym].dropna()
        except KeyError:
            continue
        high.index, close.index = high.index.date, close.index.date
        before = high[high.index < d]
        if before.empty:
            continue
        prior_ath = float(before.max())
        # Máximo y cierre del día: de la vela si existe; si no (robot tras medianoche UTC), del screener
        day_high = float(high[d]) if d in high.index else float(r.get("day_high") or r["price"])
        day_close = float(close[d]) if d in close.index else float(r["price"])
        new_ath = day_high > prior_ath
        ath = max(prior_ath, day_high)
        ath_date = d if new_ath else before.idxmax()
        pct = round((day_close / ath - 1) * 100, 2)
        listed = before.index[0]
        # Empresas que salieron a bolsa fusionándose con una "shell" con contrasplits enormes arrastran un
        # histórico ajustado absurdo (ORKA: "máximo" de 40 millones $). Un -98% casi siempre es eso.
        suspect = pct < SUSPECT_PCT
        out[sym] = {
            "status": None if suspect else classify(pct, new_ath),
            "suspect": suspect,
            "basis": "splits",  # versión del cálculo (reclassify recalcula los de versiones anteriores)
            "pct_from_ath": pct,
            "ath": round(ath, 2),
            "ath_date": ath_date.isoformat(),
            "prior_ath": round(prior_ath, 2),
            "listed_since": listed.isoformat(),
            "short_history": (d - listed).days < 3 * 365,  # cotiza hace menos de 3 años: ATH poco significativo
        }
    return out
