"""Recorrido diario de precios (apertura, máximo, mínimo, cierre) de cada selección durante las
sesiones siguientes. Es la materia prima del Laboratorio de estrategias de la web, que simula
entradas y salidas (objetivo, stop, tiempo máximo) sobre estos datos.

Archivo: docs/data/paths.json -> {"AAAA-MM-DD|TICKER": {"d": [fechas], "o": [...], "h": [...], "l": [...], "c": [...]}}
La posición 0 es el día de la selección; 1..N, las sesiones siguientes.
"""
import json
from datetime import date, timedelta

import yfinance as yf

from . import config

PATHS_FILE = config.DATA_DIR / "paths.json"
SESSIONS = 20          # sesiones guardadas tras el día de la selección
GIVE_UP_DAYS = 45      # días naturales tras los que se deja de completar un recorrido (deslistada...)


def key(p: dict) -> str:
    return f"{p['date']}|{p['symbol']}"


def load() -> dict:
    if PATHS_FILE.exists():
        return json.loads(PATHS_FILE.read_text(encoding="utf-8"))
    return {}


def update(history: list[dict], scan_date: date) -> dict:
    """Completa los recorridos que aún no tienen todas sus sesiones.

    Se vuelve a descargar el recorrido entero (no solo los días nuevos) para que, si hubo un split
    durante el periodo, todos los precios queden en la misma escala. OHLC de Yahoo ajustados solo por
    splits (auto_adjust=False), como el máximo histórico.
    """
    paths = load()
    pending = [
        p for p in history
        if len(paths.get(key(p), {}).get("d", [])) < SESSIONS + 1
        and (scan_date - date.fromisoformat(p["date"])).days <= GIVE_UP_DAYS
    ]
    if pending:
        start = min(date.fromisoformat(p["date"]) for p in pending).isoformat()
        symbols = sorted({p["symbol"] for p in pending})
        df = yf.download(symbols, start=start, end=(scan_date + timedelta(days=1)).isoformat(),
                         auto_adjust=False, progress=False, threads=True, multi_level_index=True)
        for p in pending:
            try:
                bars = df.xs(p["symbol"], axis=1, level=1)[["Open", "High", "Low", "Close"]].dropna()
            except KeyError:
                continue
            bars.index = bars.index.date
            d0 = date.fromisoformat(p["date"])
            bars = bars[(bars.index >= d0) & (bars.index <= scan_date)]
            if bars.empty or bars.index[0] != d0:
                continue  # sin la vela del día de la selección no hay base fiable
            bars = bars.iloc[: SESSIONS + 1]
            paths[key(p)] = {
                "d": [d.isoformat() for d in bars.index],
                **{k: [round(float(v), 4) for v in bars[col]] for k, col in
                   (("o", "Open"), ("h", "High"), ("l", "Low"), ("c", "Close"))},
            }
    PATHS_FILE.write_text(json.dumps(paths, separators=(",", ":")), encoding="utf-8")
    return paths
