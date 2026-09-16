from platform_app.modules.experiments.combination_fee_comparison import compare


def test_common_date_comparison_does_not_treat_missing_path_as_zero_return():
    selections, values = [], {}
    for date in ("20250101", "20250102"):
        for index in range(11):
            names = []
            if index < 10:
                names.append("rank5")
            if index > 0:
                names.append("equal")
            stock = str(index)
            selections.append({"decisionDate": date, "instrumentId": stock, "selectedBy": names})
            values[(date, stock)] = {"netReturn": 0 if index == 10 else .1, "fillRatio": 1}
    del values[("20250101", "10")]
    report = compare(selections, {"ONE_BOARD_LOT": values})["ONE_BOARD_LOT"]
    assert report["commonDates"] == ["20250102"]
    assert report["excludedDates"] == 1
    assert report["models"]["rank5"]["coveredSelections"] == 20
    assert report["models"]["equal"]["coveredSelections"] == 19
    assert report["models"]["equal"]["meanNetReturnOnRequestedNotional"] < .1
