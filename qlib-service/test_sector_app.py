import unittest
from unittest.mock import patch

import app
from factors_lib import FEATURE_NAMES as STOCK_FEATURE_NAMES


class SectorAppTest(unittest.TestCase):
    def test_sector_predict_uses_independent_dual_head_model(self):
        with patch.object(
            app,
            "predict_sector_items",
            return_value=[{
                "code": "BK1000",
                "nextProbability": 0.8,
                "weekProbability": 0.7,
            }],
        ) as predict:
            response = app.sector_predict({
                "signalDate": "2026-08-20",
                "items": [{
                    "code": "BK1000",
                    "factors": {"flowPersistence": 80},
                }],
            }, x_api_key="")

        self.assertTrue(response["ok"])
        self.assertEqual(response["predictions"][0]["code"], "BK1000")
        predict.assert_called_once()

    def test_sector_predict_rejects_empty_or_oversized_payload(self):
        with self.assertRaises(app.HTTPException) as empty:
            app.sector_predict({"items": []}, x_api_key="")
        self.assertEqual(empty.exception.status_code, 400)

        with self.assertRaises(app.HTTPException) as oversized:
            app.sector_predict({
                "items": [
                    {"code": "BK1000", "factors": {}}
                    for _ in range(81)
                ],
            }, x_api_key="")
        self.assertEqual(oversized.exception.status_code, 400)

    def test_existing_stock_predict_contract_stays_36_dimensional(self):
        self.assertTrue(callable(app.predict))
        self.assertEqual(len(STOCK_FEATURE_NAMES), 36)


if __name__ == "__main__":
    unittest.main()
