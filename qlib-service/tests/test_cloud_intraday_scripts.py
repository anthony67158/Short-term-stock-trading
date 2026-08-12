import subprocess
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
CLOUD_ROOT = SERVICE_ROOT / "cloud"
SCRIPT_NAMES = (
    "dsw_train_intraday_tcn.sh",
    "dsw_train_intraday_v21.sh",
    "dsw_bakeoff_intraday.sh",
    "dsw_archive_intraday.sh",
    "dsw_archive_intraday_v21.sh",
    "dsw_orchestrate_intraday.sh",
    "dsw_retry_minute_5m.sh",
    "dsw_recover_minute_monthly.sh",
)


class CloudIntradayScriptsTest(unittest.TestCase):
    def test_scripts_accept_a_run_id_without_shell_redirection(self):
        for script_name in SCRIPT_NAMES:
            script = CLOUD_ROOT / script_name
            source = script.read_text(encoding="utf-8")
            lines = source.splitlines()
            run_id_line = next(
                index
                for index, line in enumerate(lines)
                if line.startswith("RUN_ID=")
            )
            prefix = "\n".join(lines[: run_id_line + 1])
            result = subprocess.run(
                ["bash", "-s", "--", "run-20260811-minute5m-v2"],
                input=f"{prefix}\nprintf '%s\\n' \"$RUN_ID\"\n",
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "run-20260811-minute5m-v2\n")

    def test_scripts_report_plain_usage_when_run_id_is_missing(self):
        for script_name in SCRIPT_NAMES:
            script = CLOUD_ROOT / script_name
            result = subprocess.run(
                ["bash", str(script)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn(f"usage: {script_name} RUN_ID", result.stderr)
            self.assertNotIn("No such file", result.stderr)

    def test_training_script_uses_the_quality_aware_download_gate(self):
        source = (CLOUD_ROOT / "dsw_train_intraday_tcn.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn("validate_download_report_for_training", source)
        self.assertNotIn("MINUTE_DOWNLOAD_INCOMPLETE", source)
        self.assertIn("INTRADAY_DATASET_CACHE_HIT", source)

    def test_v21_training_uses_the_guarded_run_level_model_prefix(self):
        source = (CLOUD_ROOT / "dsw_train_intraday_v21.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            'LAB_MODEL_PREFIX="models/challengers/${RUN_ID}/"',
            source,
        )
        self.assertNotIn(
            'LAB_MODEL_PREFIX="models/challengers/${RUN_ID}/v21/"',
            source,
        )

    def test_v21_archives_experiment_outputs_before_enforcing_promotion(self):
        source = (CLOUD_ROOT / "dsw_train_intraday_v21.sh").read_text(
            encoding="utf-8"
        )

        archive_at = source.index(
            'bash cloud/dsw_archive_intraday_v21.sh "${RUN_ID}"'
        )
        promotion_at = source.index('if not gate.get("production_eligible")')
        self.assertLess(archive_at, promotion_at)

    def test_repair_script_explicitly_enables_limited_source_row_drops(self):
        source = (CLOUD_ROOT / "dsw_retry_minute_5m.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn("allow_source_row_drops=True", source)
        self.assertIn("minimum_valid_bars_per_day=40", source)
        self.assertIn("max_source_day_drop_fraction=0.05", source)
