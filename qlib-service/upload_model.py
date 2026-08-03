"""
上传训练好的模型到 OSS（前缀 quantmodel/），供量化服务运行时拉取。
读取 .env 里的 OSS_* 变量。用法：
  set -a; source ../.env; set +a
  python3 upload_model.py --model lgb_score.txt --meta meta.json
"""
import argparse
import os


def bucket():
    import oss2
    ak = os.environ["OSS_ACCESS_KEY_ID"]
    sk = os.environ["OSS_ACCESS_KEY_SECRET"]
    bkt = os.environ["OSS_BUCKET"]
    endpoint = os.environ.get("OSS_ENDPOINT")
    if not endpoint:
        region = os.environ.get("OSS_REGION", "oss-cn-hangzhou")
        if not region.startswith("oss-"):
            region = "oss-" + region
        endpoint = f"https://{region}.aliyuncs.com"
    return oss2.Bucket(oss2.Auth(ak, sk), endpoint, bkt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="lgb_score.txt")
    ap.add_argument("--meta", default="meta.json")
    ap.add_argument("--prefix", default=os.environ.get("QUANT_MODEL_PREFIX", "quantmodel/"))
    a = ap.parse_args()
    b = bucket()
    for local, key in [(a.model, a.prefix + "lgb_score.txt"),
                       (a.meta, a.prefix + "meta.json")]:
        b.put_object_from_file(key, local)
        print(f"[uploaded] {local} -> oss://{os.environ['OSS_BUCKET']}/{key}")
    # 读回校验
    got = b.head_object(a.prefix + "lgb_score.txt")
    print(f"[verify] model size on OSS = {got.content_length} bytes")


if __name__ == "__main__":
    main()
