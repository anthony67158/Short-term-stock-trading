"""Frozen first-cycle policy for causal candidate and label generation."""

SHORT_HORIZON_POLICY = {
    "policyVersion": "short-horizon.v1",
    "featureSchemaVersion": "candidate-features.v1",
    "candidatePolicy": {
        "decisionTimeShanghai": "16:30:00",
        "minimumHistorySessions": 61,
        "quotaPerBoard": 25,
        "selection": "TOP_MEDIAN_20_SESSION_ORDER_BOOK_AMOUNT_PER_BOARD",
        "universe": "ALL_POINT_IN_TIME_LISTED_A_SHARES",
    },
    "executionPolicy": {
        "actionPath": "BUY_LIMIT",
        "entryLimit": "DECISION_SESSION_RAW_CLOSE",
        "entryWindow": "NEXT_SESSION_FIRST_30_MINUTES",
        "frequency": "5min",
        "maximumBarParticipationRate": "0.05",
        "targetNotionalCny": "100000",
    },
    "horizon": {
        "tradingSessions": 5,
        "terminalExit": "SESSION_CLOSE",
    },
    "labelPolicy": {
        "feePolicyVersion": "a-share-cash-equity-fees.v1",
        "noFillReturn": "0",
        "sameBarConflict": "STOP_FIRST",
        "stopLossReturn": "-0.03",
        "takeProfitReturn": "0.06",
        "targets": [
            "pFill",
            "pWinGivenFill",
            "q10",
            "q50",
            "q90",
            "expectedNetReturnGivenFill",
            "stopHazard",
        ],
    },
    "releasePolicy": {
        "minimumAnnualFilledTrades": 60,
        "minimumNetRLowerBound": "0.02",
        "stressCostBps": 10,
        "stressNetReturnMustBePositive": True,
    },
}
