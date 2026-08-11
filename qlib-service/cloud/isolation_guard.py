"""实验量化任务的写入目标护栏。

训练任务必须显式声明 lab 环境、指定实验 Bucket，并使用带 run-id 的候选模型目录。
任何缺失或不匹配都视为配置错误，绝不回退到生产模型前缀。
"""
import argparse
import os
import re
import sys


LAB_BUCKET_PREFIX = "stock-quant-lab-"
CHALLENGER_PREFIX = "models/challengers/"
RUN_PREFIX_RE = re.compile(r"^models/challengers/[^/\s]+/$")


class LabIsolationError(RuntimeError):
    """实验任务目标不满足生产隔离要求。"""


def _required_text(label, value):
    if not isinstance(value, str) or not value.strip():
        raise LabIsolationError(f"{label} 不能为空")
    return value.strip()


def require_lab_target(*, environment, bucket, prefix, expected_bucket):
    """验证实验任务唯一允许写入的 OSS 目标。

    expected_bucket 必须来自实验环境配置，而非生产配置。prefix 必须是不可变 run-id
    所在的 challenger 根目录，例如 ``models/challengers/run-20260810-001/``。
    """
    environment = _required_text("环境名称", environment)
    bucket = _required_text("OSS Bucket", bucket)
    prefix = _required_text("模型前缀", prefix)
    expected_bucket = _required_text("实验 OSS Bucket", expected_bucket)

    if environment != "lab":
        raise LabIsolationError("训练任务只允许在 lab 环境运行")
    if not expected_bucket.startswith(LAB_BUCKET_PREFIX):
        raise LabIsolationError("实验 OSS Bucket 不符合隔离命名规则")
    if bucket != expected_bucket:
        raise LabIsolationError("拒绝写入未配置的实验 OSS Bucket")
    if not RUN_PREFIX_RE.fullmatch(prefix):
        raise LabIsolationError(
            "模型前缀必须是 models/challengers/<run-id>/，且不得为空"
        )
    return {"environment": environment, "bucket": bucket, "prefix": prefix}


def main(argv=None):
    parser = argparse.ArgumentParser(description="校验量化实验任务的 OSS 写入目标")
    parser.add_argument("--check", action="store_true", help="读取环境变量并执行校验")
    args = parser.parse_args(argv)

    if not args.check:
        parser.error("只支持 --check")

    try:
        target = require_lab_target(
            environment=os.environ.get("QUANT_ENVIRONMENT"),
            bucket=os.environ.get("LAB_OSS_BUCKET"),
            prefix=os.environ.get("LAB_MODEL_PREFIX"),
            expected_bucket=os.environ.get("LAB_OSS_BUCKET"),
        )
    except LabIsolationError as error:
        print(f"实验目标校验失败：{error}", file=sys.stderr)
        return 2

    print(
        "实验目标校验通过："
        f"{target['environment']} {target['bucket']} {target['prefix']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
