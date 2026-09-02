import os
import sys
import unittest
from unittest.mock import patch


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

import app  # noqa: E402
from opportunity_contract import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
)


def item():
    return {
        "schemaVersion": FEATURE_SCHEMA_VERSION,
        "asOf": 1_788_320_000_000,
        "code": "600001",
        "formulaId": "INTRADAY_VWAP_PULLBACK",
        "factors": {name: 0.0 for name in FEATURE_NAMES},
    }


class OpportunityAppTest(unittest.TestCase):
    def test_opportunity_endpoint_uses_independent_sidecar(self):
        expected = {
            "schemaVersion": "opportunity-score.v1",
            "state": "NOT_READY",
            "code": "600001",
            "pFill": None,
        }
        with patch.object(
            app,
            "predict_opportunity_items",
            return_value=[expected],
        ) as predict:
            response = app.opportunity_score(
                {"items": [item()]},
                x_api_key="",
            )

        self.assertTrue(response["ok"])
        self.assertTrue(response["shadowOnly"])
        self.assertEqual(response["predictions"], [expected])
        predict.assert_called_once()

    def test_opportunity_endpoint_rejects_invalid_request(self):
        with patch.object(
            app,
            "predict_opportunity_items",
            side_effect=ValueError("机会评分items必须包含1到80项"),
        ):
            with self.assertRaises(app.HTTPException) as error:
                app.opportunity_score({"items": []}, x_api_key="")

        self.assertEqual(error.exception.status_code, 400)

    def test_existing_stock_predict_contract_stays_36_dimensional(self):
        from factors_lib import FEATURE_NAMES as stock_features

        self.assertEqual(len(stock_features), 36)


if __name__ == "__main__":
    unittest.main()
