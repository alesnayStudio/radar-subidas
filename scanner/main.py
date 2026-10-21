"""Punto de entrada: python -m scanner.main

1. Screener: subidas > umbral en NYSE/Nasdaq con filtros de calidad
2. Noticias + clasificación del catalizador para las mejores candidatas
3. Puntuación compuesta -> Top N
4. Guarda JSON para la web y actualiza el histórico / estadísticas
"""
import argparse
import json
import sys
from collections import Counter
from datetime import date, datetime, timezone

from . import catalysts, config, history, news, scoring, screener


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")


def update_dates_index(scan_date: str):
    path = config.DATA_DIR / "dates.json"
    dates = set(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else set()
    dates.add(scan_date)
    write_json(path, sorted(dates, reverse=True))


def run(save_history: bool = True):
    now_ny = datetime.now(screener.NY)
    print(f"Escaneo {now_ny:%Y-%m-%d %H:%M} (hora Nueva York)")

    candidates, raw_count = screener.get_candidates()
    print(f"  {raw_count} subidas > {config.MIN_CHANGE_PCT}% en bruto -> {len(candidates)} pasan filtros")

    for r in candidates:
        r["score"], _ = scoring.score(r)
    candidates.sort(key=lambda r: r["score"], reverse=True)
    shortlist = candidates[: config.NEWS_CANDIDATES]

    for r in shortlist:
        r["news"] = news.get_news(r["symbol"], r["name"])
        r["catalyst"] = catalysts.classify(r["news"], r["earnings_ts"], r["market_date"],
                                           news.company_patterns(r["symbol"], r["name"]))
        r["news"] = catalysts.key_headlines_first(r["news"], r["catalyst"]["type"])
        r["score"], r["score_parts"] = scoring.score(r, r["catalyst"]["quality"])
        print(f"  {r['symbol']:6} {r['change_pct']:6.1f}%  RVOL {r['rvol']:5.1f}  "
              f"{r['catalyst']['label']:<34} score {r['score']}")

    top = sorted(shortlist, key=lambda r: r["score"], reverse=True)[: config.TOP_N]

    dates = Counter(r["market_date"] for r in candidates if r["market_date"])
    scan_date = dates.most_common(1)[0][0] if dates else now_ny.date().isoformat()
    market_state = Counter(r["market_state"] for r in candidates).most_common(1)[0][0] if candidates else None

    # Reapariciones: ¿ya salió en el top en las últimas sesiones? (no cambia la puntuación: primero
    # medimos con las estadísticas si las repetidoras rinden mejor, y solo entonces la premiaremos)
    h = history.load()
    for r in top:
        prev = history.previous_appearances(h, r["symbol"], scan_date)
        r["appearance"] = {"count": len(prev) + 1, "previous": prev, "window": config.REPEAT_WINDOW}

    try:
        holders = history.holding_up(h, scan_date)
    except Exception as e:  # que un fallo aquí no impida publicar el top del día
        print(f"  [aguantan] {type(e).__name__}: {e}")
        holders = {"tracked": 0, "items": []}
    print(f"  Aguantan la subida: {len(holders['items'])} de {holders['tracked']} vigiladas")

    payload = {
        "date": scan_date,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "market_state": market_state,  # REGULAR = escaneo con el mercado abierto (datos provisionales)
        "filters": {
            "min_change_pct": config.MIN_CHANGE_PCT, "min_market_cap": config.MIN_MARKET_CAP,
            "min_price": config.MIN_PRICE, "min_dollar_volume": config.MIN_DOLLAR_VOLUME,
            "min_rvol": config.MIN_RVOL,
        },
        "universe": {"raw_gainers": raw_count, "passed_filters": len(candidates)},
        "score_weights": scoring.WEIGHTS,
        "top": top,
        "holding_up": {**holders, "window": config.HOLD_WINDOW},
    }
    write_json(config.DAILY_DIR / f"{scan_date}.json", payload)
    write_json(config.DATA_DIR / "latest.json", payload)
    update_dates_index(scan_date)
    print(f"  Guardado top {len(top)} del {scan_date}")

    if save_history:
        h = history.add_picks(h, scan_date, top)
        h = history.update_returns(h, date.fromisoformat(scan_date))
        history.save(h)
        history.compute_stats(h)
        repeats = sum(r["appearance"]["count"] > 1 for r in top)
        print(f"  Histórico: {len(h)} selecciones ({repeats} repetidoras hoy)")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # acentos correctos en la consola de Windows
    ap = argparse.ArgumentParser(description="Escáner diario de acciones al alza con catalizador")
    ap.add_argument("--no-history", action="store_true", help="no tocar el histórico (para pruebas)")
    args = ap.parse_args()
    run(save_history=not args.no_history)
