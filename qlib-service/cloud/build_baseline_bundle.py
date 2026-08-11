"""构建只用于实验环境的量化基线代码包。

使用显式白名单，避免把 .env、生产上传脚本或运行时数据打入云端实验包。
"""
import argparse
import hashlib
import json
import os
import zipfile


BUNDLE_FILES = (
    "factors_lib.py",
    "train_lgb.py",
    "build_dataset_ts.py",
    "tushare_client.py",
    "tushare_panel.py",
    "lgb_score.txt",
    "meta.json",
    "cloud/isolation_guard.py",
    "cloud/env.lab.example",
    "cloud/requirements.baseline.txt",
    "cloud/README.md",
)
ZIP_TIMESTAMP = (2020, 1, 1, 0, 0, 0)


def _write_reproducible(archive, relative, content):
    info = zipfile.ZipInfo(relative, date_time=ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o644 << 16
    archive.writestr(info, content)


def _read_required_files(source_root):
    files = {}
    root = os.path.realpath(source_root)
    for relative in BUNDLE_FILES:
        path = os.path.realpath(os.path.join(root, relative))
        if os.path.commonpath((root, path)) != root:
            raise ValueError(f"非法打包路径：{relative}")
        if not os.path.isfile(path):
            raise FileNotFoundError(f"缺少基线包文件：{relative}")
        with open(path, "rb") as handle:
            files[relative] = handle.read()
    return files


def build_bundle(source_root, output_path):
    """按白名单构建 ZIP，并返回清单。缺文件时不创建不完整产物。"""
    files = _read_required_files(source_root)
    manifest = {
        "schema_version": 1,
        "bundle_type": "quant-lab-baseline",
        "files": {
            relative: {
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
            for relative, content in files.items()
        },
    }
    manifest_bytes = json.dumps(
        manifest, ensure_ascii=False, indent=2, sort_keys=True
    ).encode("utf-8")

    output_path = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    temporary = output_path + ".part"
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for relative, content in files.items():
                _write_reproducible(archive, relative, content)
            _write_reproducible(archive, "bundle_manifest.json", manifest_bytes)
        os.replace(temporary, output_path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    return manifest


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(description="构建量化实验基线包")
    parser.add_argument(
        "--output",
        default=os.path.join(here, "quant-lab-baseline.zip"),
    )
    args = parser.parse_args()
    manifest = build_bundle(here, args.output)
    print(f"已生成：{os.path.abspath(args.output)}")
    print(f"文件数：{len(manifest['files'])}")


if __name__ == "__main__":
    main()
