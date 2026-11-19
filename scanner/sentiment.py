"""Termómetro del mercado: una nota de 0 a 100 sobre el «ambiente» del día para operar subidas.

Cinco piezas, todas con datos gratuitos y calculables solo con información disponible ese día:
  1. Tendencia   - S&P 500 (SPY) frente a sus medias de 20 y 50 sesiones
  2. Impulso     - variación del SPY en las últimas 5 sesiones
  3. Miedo       - nivel del VIX (volatilidad esperada; alto = miedo)
  4. Amplitud    - cuántas acciones subieron más del 6 % (muchas = apetito por el riesgo)
  5. Seguimiento - cómo les fue al día siguiente a las selecciones del radar de las últimas sesiones
                   (si las subidas se están desinflando, la estrategia sufre)

Cada pieza da 0-100 y la nota es la media. No es una predicción: es un contexto que el Laboratorio
irá validando (los picks guardan la nota del día para poder filtrar por ella).
"""
import math
from datetime import date, timedelta

import pandas as pd
import yfinance as yf

LABELS = [(30, "Miedo", "😨"), (45, "Débil", "🌧️"), (60, "Neutral", "⛅"), (75, "Bueno", "🌤️"), (101, "Euforia", "☀️")]


def _clip(x: float) -> float:
    return max(0.0, min(100.0, x))


def _lin(x: float, lo: float, hi: float) -> float:
    """lo -> 0, hi -> 100 (lineal, recortado)."""
    return _clip((x - lo) / (hi - lo) * 100)


def label(score: float) -> tuple[str, str]:
    for lim, name, icon in LABELS:
        if score < lim:
            return name, icon
    return LABELS[-1][1], LABELS[-1][2]


def download(start: date, end: date) -> pd.DataFrame:
    """Cierres diarios de SPY y VIX (índice = fecha)."""
    df = yf.download(["SPY", "^VIX"], start=start.isoformat(), end=(end + timedelta(days=1)).isoformat(),
                     auto_adjust=True, progress=False, threads=True, multi_level_index=True)["Close"]
    df.index = df.index.date
    return df


def follow_through(picks: list[dict], d: date, sessions: int = 5) -> tuple[float | None, int]:
    """Media de la rentabilidad a +1 sesión de los picks de `sessions` fechas anteriores a d.

    Se salta la fecha inmediatamente anterior: su +1 es el cierre de hoy y el robot lo calcula después
    de publicar el top. Así el valor es el mismo en directo y al reconstruir días pasados."""
    dates = sorted({p["date"] for p in picks if p["date"] < d.isoformat()})[:-1][-sessions:]
    vals = [p["returns"]["1"] for p in picks if p["date"] in dates and p["returns"].get("1") is not None]
    return (sum(vals) / len(vals), len(vals)) if vals else (None, 0)


def compute(d: date, closes: pd.DataFrame, raw_gainers: int | None, picks: list[dict]) -> dict | None:
    spy = closes["SPY"].dropna()
    spy = spy[spy.index <= d]
    vix = closes["^VIX"].dropna()
    vix = vix[vix.index <= d]
    if len(spy) < 50 or spy.index[-1] != d:
        return None
    last = float(spy.iloc[-1])
    sma20, sma50 = float(spy.iloc[-20:].mean()), float(spy.iloc[-50:].mean())
    ret5 = (last / float(spy.iloc[-6]) - 1) * 100
    parts = []

    d20, d50 = (last / sma20 - 1) * 100, (last / sma50 - 1) * 100
    trend = _clip(50 + 12 * d20 + 6 * d50)   # ±3% sobre la media de 20 ≈ ±36 puntos
    parts.append({"key": "trend", "label": "Tendencia", "score": round(trend),
                  "text": f"S&P 500 {d20:+.1f}% vs media 20 sesiones, {d50:+.1f}% vs media 50"})

    parts.append({"key": "momentum", "label": "Impulso", "score": round(_lin(ret5, -4, 4)),
                  "text": f"S&P 500 {ret5:+.1f}% en 5 sesiones"})

    if len(vix) and vix.index[-1] >= d - timedelta(days=3):
        v = float(vix.iloc[-1])
        parts.append({"key": "fear", "label": "Calma (VIX)", "score": round(_lin(-v, -30, -13)),
                      "text": f"VIX {v:.1f} (menos de 15 = calma, más de 25 = miedo)"})

    if raw_gainers is not None:
        # escala logarítmica: 8 subidas > 6% -> 0, 250 -> 100
        b = _lin(math.log(max(raw_gainers, 1)), math.log(8), math.log(250))
        parts.append({"key": "breadth", "label": "Amplitud", "score": round(b),
                      "text": f"{raw_gainers} acciones subieron más del 6%"})

    ft, n = follow_through(picks, d)
    if ft is not None and n >= 10:
        parts.append({"key": "follow", "label": "Seguimiento", "score": round(_lin(ft, -3, 3)),
                      "text": f"Las selecciones de las últimas 5 sesiones: {ft:+.1f}% de media al día siguiente ({n})"})

    score = round(sum(p["score"] for p in parts) / len(parts))
    name, icon = label(score)
    return {"score": score, "label": name, "icon": icon, "parts": parts}
