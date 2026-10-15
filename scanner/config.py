"""Configuración central del escáner. Cambia aquí los umbrales sin tocar el resto del código."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"          # la web (GitHub Pages) lee de aquí
DAILY_DIR = DATA_DIR / "daily"

# --- Universo y filtros de calidad -----------------------------------------
# Bolsas de EE.UU. según Yahoo: NMS/NGM/NCM = Nasdaq, NYQ = NYSE, ASE = NYSE American
EXCHANGES = ["NMS", "NGM", "NCM", "NYQ", "ASE"]

MIN_CHANGE_PCT = 6.0             # subida mínima del día (%)
MIN_MARKET_CAP = 1_000_000_000   # 1.000 M$: fuera microcaps manipulables
MIN_PRICE = 5.0                  # fuera penny stocks
MIN_DAY_VOLUME = 300_000         # acciones negociadas hoy
MIN_DOLLAR_VOLUME = 10_000_000   # 10 M$ negociados hoy (liquidez real)
MIN_RVOL = 1.5                   # volumen hoy / media 3 meses

# Palabras que delatan SPACs, warrants, preferentes, etc.
EXCLUDE_NAME_WORDS = ["acquisition corp", "warrant", " units", "preferred", "depositary shares rep"]

# --- Ranking ---------------------------------------------------------------
TOP_N = 10                 # acciones que se muestran
NEWS_CANDIDATES = 25       # a cuántas candidatas se les buscan noticias antes del ranking final
NEWS_LOOKBACK_DAYS = 3     # antigüedad máxima de un titular para contar como catalizador

# --- Reapariciones y "aguantan la subida" ----------------------------------
REPEAT_WINDOW = 10      # sesiones hacia atrás para contar si una acción ya salió en el top
HOLD_WINDOW = 10        # sesiones hacia atrás para buscar acciones que aguantan su subida

# --- Seguimiento -----------------------------------------------------------
FOLLOW_UP_DAYS = [1, 5, 20]   # sesiones bursátiles tras la detección
BENCHMARK = "SPY"             # índice de referencia para comparar
