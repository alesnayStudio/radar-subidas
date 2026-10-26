"""Pruebas de regresión con casos REALES corregidos en las auditorías.

Ejecutar:  python -m unittest discover tests
Si cambias el clasificador o el filtro de titulares y algo de aquí falla, has roto un caso que ya funcionaba.
"""
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from scanner.catalysts import classify, earnings_timing
from scanner.news import company_names, company_patterns, is_relevant

NY = ZoneInfo("America/New_York")


def ts(s: str) -> int:
    return int(datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=NY).timestamp())


def kind(symbol, name, titles, earnings=None, day="2026-10-20"):
    news = [{"title": t} for t in titles]
    return classify(news, ts(earnings) if earnings else None, day, company_names(symbol, name))["type"]


class Catalysts(unittest.TestCase):
    def test_target_of_acquisition_is_takeover(self):  # BRZE 20-oct
        self.assertEqual(kind("BRZE", "Braze, Inc.", [
            "Salesforce Agrees to Acquire Braze for $5.66 Billion: BRZE Stock Soars",
            "A tale of two interfaces: Salesforce buys Braze for $US5.66bn"]), "takeover")

    def test_acquirer_is_acquisition(self):  # INTU 15-oct
        self.assertEqual(kind("INTU", "Intuit Inc.", [
            "Intuit to Acquire Sequence to Expand Mid-Market Financial Offerings"]), "acquisition")

    def test_peer_of_deal_is_sector(self):  # KVYO 20-oct
        self.assertEqual(kind("KVYO", "Klaviyo, Inc.", [
            "Klaviyo shares jump 8% as Salesforce moves to acquire rival Braze for $5.7 billion"]), "sector")

    def test_buy_clickbait_is_not_a_deal(self):  # APLD/EFX
        self.assertNotIn(kind("EFX", "Equifax Inc.", [
            "Is It Too Late to Buy Equifax Inc (EFX) After 11.3% Rally?"]), ("acquisition", "takeover"))

    def test_earnings_date_announcement_is_not_results(self):  # HSAI 20-oct
        self.assertEqual(kind("HSAI", "Hesai Group", [
            "Hesai Group to Report Third Quarter 2026 Financial Results on November 10, 2026"],
            earnings="2026-11-10 07:30"), "none")

    def test_raises_outlook_with_word_in_between(self):  # CLF 19-oct
        self.assertEqual(kind("CLF", "Cleveland-Cliffs Inc.", [
            "Cleveland-Cliffs Reports Strong Q3 Results, Raises EBITDA Outlook"],
            earnings="2026-10-19 08:30", day="2026-10-19"), "earnings_guidance")

    def test_rise_before_results_is_pre_earnings(self):  # MEDP 21-oct (resultados tras el cierre)
        self.assertEqual(kind("MEDP", "Medpace Holdings, Inc.", [
            "Medpace Holdings earnings beat by $0.40, revenue topped estimates",
            "Medpace raises 2026 EPS guidance range"],
            earnings="2026-10-21 16:00", day="2026-10-21"), "pre_earnings")

    def test_group_move_is_sector(self):  # Z 15-oct
        self.assertEqual(kind("Z", "Zillow Group, Inc.", [
            "TeraWulf, Opendoor, and Zillow Stocks Surged Today",
            "Here's why Zillow Group, Better Home, and Opendoor stocks are rising today"]), "sector")

    def test_bank_call_is_analyst(self):  # WULF 15-oct
        self.assertEqual(kind("WULF", "TeraWulf Inc.", [
            "Morgan Stanley Call Sends TeraWulf Stock Surging"]), "analyst")

    def test_credit_agreement_is_capital(self):  # CRGY 16-oct
        self.assertEqual(kind("CRGY", "Crescent Energy Company", [
            "Crescent Energy Amends Credit Agreement to Back Devon Eagle Ford Deal"]), "capital")


class EarningsTiming(unittest.TestCase):
    def test_timing(self):
        self.assertEqual(earnings_timing(ts("2026-10-20 08:30"), "2026-10-20")[0], "reported")   # antes de abrir
        self.assertEqual(earnings_timing(ts("2026-10-19 16:00"), "2026-10-20")[0], "reported")   # ayer tras el cierre
        self.assertEqual(earnings_timing(ts("2026-10-20 16:00"), "2026-10-20")[0], "upcoming")   # hoy tras el cierre
        self.assertEqual(earnings_timing(ts("2026-10-22 08:30"), "2026-10-21")[0], "upcoming")   # TTMI
        self.assertIsNone(earnings_timing(ts("2027-01-20 15:00"), "2026-10-22")[0])


class Headlines(unittest.TestCase):
    def test_generic_names_drop_junk(self):
        pool = company_patterns("POOL", "Pool Corporation")
        self.assertFalse(is_relevant("NFL Survivor Pool Picks: Week 7 Targets and Avoids (2026)", pool))
        self.assertFalse(is_relevant("76-year-old Bethel volunteer works to rebuild town pool", pool))
        noble = company_patterns("NE", "Noble Corporation plc")
        self.assertFalse(is_relevant("Form 8K Barnes & Noble Education Inc For: 23 October", noble))
        kyiv = company_patterns("KYIV", "Kyivstar Group Ltd.")
        self.assertFalse(is_relevant("Zorya - Kryvbas, 2026: watch sports online in high quality on Kyivstar TV", kyiv))

    def test_distinctive_names_keep_news(self):
        self.assertTrue(is_relevant("MiniMed Completes Separation From Medtronic",
                                    company_patterns("MMED", "MiniMed Group, Inc.")))
        self.assertTrue(is_relevant("Why Biohaven Catapulted 25%", company_patterns("BHVN", "Biohaven Ltd.")))
        self.assertTrue(is_relevant("Blackstone Q3 Profit Falls as Higher Rates Slow Dealmaking",
                                    company_patterns("BX", "Blackstone Inc.")))

    def test_short_tickers_need_market_format(self):
        r = company_patterns("R", "Ryder System, Inc.")
        self.assertTrue(is_relevant("Shares of (NYSE:R) climb after earnings", r))
        self.assertFalse(is_relevant("R&D spending rises across the industry", r))


if __name__ == "__main__":
    unittest.main()
