#!/usr/bin/env python3
"""
適格請求書番号(候補)自動スキャンスクリプト(2026-09-12新規)。

camera-inventory-appの「経費」タブ「適格請求書番号(候補)」サブタブの
「未登録をスキャンする」ボタンが invoice_number_scan_requests へ status='pending' の
行を挿入する。当初はSupabase Edge Functionでこの処理全体を行おうとしたが、
国税庁の全件データ(法人分、圧縮20MB超)を展開・解析する処理がEdge FunctionのCPU時間上限
(約2秒)を超えてしまい WORKER_RESOURCE_LIMIT エラーになることが判明した(ストリーミング処理に
書き直しても解消せず、根本原因がメモリではなくCPU時間そのものだったため)。
そのため、この重い処理はVPS側(このスクリプト)で行い、cronで定期実行してpending依頼を
処理する方式に変更した。ユーザーのブラウザ・PCには一切負荷がかからない。

cron実行例(10分おき):
  */10 * * * * cd /opt/camera-inventory-app-src && python3 scripts/scan_invoice_numbers.py >> logs/scan_invoice_numbers.log 2>&1

必要な環境変数(このスクリブトと同じ階層の親ディレクトリの .env から読み込む):
  VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
  (SUPABASE_SERVICE_ROLE_KEYはRLSを越えてDBへ書き込むために必要。ブラウザ側には一切含めない)
"""
import csv
import io
import os
import re
import sys
import zipfile
from datetime import datetime, timezone

import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
ENV_PATH = os.path.join(ROOT_DIR, ".env")


def load_env() -> dict:
    env = {}
    with open(ENV_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


ENV = load_env()
SUPABASE_URL = ENV.get("VITE_SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = ENV.get("SUPABASE_SERVICE_ROLE_KEY", "")
REST_URL = f"{SUPABASE_URL}/rest/v1"
HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

DOWNLOAD_INDEX_URL = "https://www.invoice-kohyo.nta.go.jp/download/zenken"
DOWNLOAD_FILE_URL = "https://www.invoice-kohyo.nta.go.jp/download/zenken/dlfile"

# 法人格の接頭・接尾辞は始端・終端のみ除去する(中間に含まれる場合は除去しない)。
# 過去にこの一致ロジックを不用意な置換で実装した際、短い文字列に壊れて誤マッチが多発した
# 反省を踏まえた設計(claude/system-info.md参照)。
_SUFFIX = (
    r"(株式会社|（株）|\(株\)|有限会社|（有）|\(有\)|合同会社|合資会社|合名会社|一般社団法人|"
    r"公益社団法人|一般財団法人|公益財団法人|特定非営利活動法人|事務所|株)"
)
SUFFIX_PATTERN_START = re.compile("^" + _SUFFIX)
SUFFIX_PATTERN_END = re.compile(_SUFFIX + "$")

# 国税庁リソース定義書の項番7〜30に対応(0-indexed)。
COL_REG_NO = 1
COL_LATEST = 6
COL_NAME = 18
MAX_PER_VENDOR = 5


def normalize(name: str) -> str:
    n = name.strip()
    n = SUFFIX_PATTERN_START.sub("", n)
    n = SUFFIX_PATTERN_END.sub("", n)
    n = re.sub(r"[\s　]+", "", n)
    return n.lower()


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).isoformat()}] {msg}", flush=True)


def fetch_pending_request():
    resp = requests.get(
        f"{REST_URL}/invoice_number_scan_requests",
        headers=HEADERS,
        params={"status": "eq.pending", "order": "requested_at.asc", "limit": 1},
        timeout=30,
    )
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else None


def mark_request(request_id: str, patch: dict) -> None:
    resp = requests.patch(
        f"{REST_URL}/invoice_number_scan_requests",
        headers=HEADERS,
        params={"id": f"eq.{request_id}"},
        json=patch,
        timeout=30,
    )
    resp.raise_for_status()


def fetch_target_vendors() -> list:
    """invoice_registration_noが未設定のexpenses.vendorのうち、
    まだ一度もinvoice_number_candidatesに現れていないものだけを対象にする。"""
    resp = requests.get(
        f"{REST_URL}/expenses",
        headers=HEADERS,
        params={
            "select": "vendor",
            "or": "(invoice_registration_no.is.null,invoice_registration_no.eq.)",
        },
        timeout=60,
    )
    resp.raise_for_status()
    expense_vendors = {
        (row.get("vendor") or "").strip()
        for row in resp.json()
        if (row.get("vendor") or "").strip()
    }

    resp2 = requests.get(
        f"{REST_URL}/invoice_number_candidates",
        headers=HEADERS,
        params={"select": "vendor"},
        timeout=60,
    )
    resp2.raise_for_status()
    scanned_vendors = {row["vendor"] for row in resp2.json()}

    return sorted(expense_vendors - scanned_vendors)


def fetch_download_files() -> list:
    """国税庁の全件データダウンロードページから、現在月のダウンロード対象ファイル
    (法人・人格のない社団等分、CSV形式のみ)を取得する。ダウンロードリンクはJS(doDownload関数)
    で生成されており、dlFilKanriNo(ファイル管理番号)は毎月変わり予測できないため、
    毎回このページをスクレイピングして取得する。"""
    resp = requests.get(DOWNLOAD_INDEX_URL, timeout=60)
    resp.raise_for_status()
    html = resp.text
    files = []
    for m in re.finditer(r"doDownload\('(\d+)','(\d+)','(\d+)'\)", html):
        dl_id, kbn, type_ = m.group(1), m.group(2), m.group(3)
        # jinkakukbn: 2=法人, 3=人格のない社団等。1=個人は氏名非公開のため対象外。type=01がCSV形式。
        if type_ == "01" and kbn in ("2", "3"):
            files.append((dl_id, kbn))
    return files


def scan_file(dl_id: str, kbn: str, vendor_norms: dict) -> dict:
    """1ファイル(zip)を取得・解凍・CSV走査し、{vendor: [(name, reg_no), ...]}を返す。"""
    params = {"dlFilKanriNo": dl_id, "jinkakukbn": kbn, "type": "01"}
    resp = requests.get(DOWNLOAD_FILE_URL, params=params, timeout=300)
    resp.raise_for_status()

    matches: dict = {}
    counts: dict = {}
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = zf.namelist()
        if not names:
            return matches
        with zf.open(names[0]) as raw:
            text_stream = io.TextIOWrapper(raw, encoding="utf-8", newline="")
            reader = csv.reader(text_stream)
            for row in reader:
                if len(row) <= COL_NAME:
                    continue
                if row[COL_LATEST] != "1":
                    continue
                name = row[COL_NAME]
                if not name:
                    continue
                name_norm = normalize(name)
                if not name_norm:
                    continue
                for vendor, vnorm in vendor_norms.items():
                    if counts.get(vendor, 0) >= MAX_PER_VENDOR:
                        continue
                    if vnorm in name_norm:
                        matches.setdefault(vendor, []).append((name, row[COL_REG_NO]))
                        counts[vendor] = counts.get(vendor, 0) + 1
    return matches


def insert_candidates(rows: list) -> None:
    if not rows:
        return
    resp = requests.post(
        f"{REST_URL}/invoice_number_candidates",
        headers=HEADERS,
        json=rows,
        timeout=60,
    )
    resp.raise_for_status()


def main() -> None:
    req = fetch_pending_request()
    if not req:
        log("スキャン依頼はありません")
        return

    request_id = req["id"]
    log(f"スキャン依頼を処理開始: {request_id}")
    mark_request(
        request_id,
        {"status": "running", "started_at": datetime.now(timezone.utc).isoformat()},
    )

    try:
        vendors = fetch_target_vendors()
        log(f"対象事業者数: {len(vendors)}")
        if not vendors:
            mark_request(
                request_id,
                {
                    "status": "done",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                    "vendors_scanned": 0,
                    "vendors_matched": 0,
                    "candidates_found": 0,
                },
            )
            return

        # 正規化後3文字未満の事業者名は誤マッチのリスクが高いため除外する。
        vendor_norms = {v: normalize(v) for v in vendors}
        vendor_norms = {v: n for v, n in vendor_norms.items() if len(n) >= 3}

        files = fetch_download_files()
        log(f"ダウンロード対象ファイル数: {len(files)}")

        all_matches: dict = {}
        for dl_id, kbn in files:
            log(f"ファイル処理中: dlFilKanriNo={dl_id} jinkakukbn={kbn}")
            file_matches = scan_file(dl_id, kbn, vendor_norms)
            for vendor, items in file_matches.items():
                bucket = all_matches.setdefault(vendor, [])
                for name, reg_no in items:
                    if len(bucket) >= MAX_PER_VENDOR:
                        break
                    if any(existing_reg == reg_no for _, existing_reg in bucket):
                        continue
                    bucket.append((name, reg_no))

        now_iso = datetime.now(timezone.utc).isoformat()
        insert_rows = []
        matched_vendor_count = 0
        candidate_count = 0
        for vendor in vendors:
            items = all_matches.get(vendor)
            if items:
                matched_vendor_count += 1
                for name, reg_no in items:
                    insert_rows.append(
                        {
                            "vendor": vendor,
                            "candidate_name": name,
                            "candidate_reg_no": reg_no,
                            "status": "pending",
                            "searched_at": now_iso,
                        }
                    )
                    candidate_count += 1
            else:
                # 検索したが一致なしのプレースホルダ行(次回以降スキャン対象から除外するため)
                insert_rows.append(
                    {
                        "vendor": vendor,
                        "candidate_name": None,
                        "candidate_reg_no": None,
                        "status": "pending",
                        "searched_at": now_iso,
                    }
                )

        insert_candidates(insert_rows)
        log(
            f"完了: 対象{len(vendors)}件、マッチ{matched_vendor_count}件、候補{candidate_count}件"
        )

        mark_request(
            request_id,
            {
                "status": "done",
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "vendors_scanned": len(vendors),
                "vendors_matched": matched_vendor_count,
                "candidates_found": candidate_count,
            },
        )
    except Exception as exc:  # noqa: BLE001
        log(f"エラー: {exc}")
        try:
            mark_request(
                request_id,
                {
                    "status": "error",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                    "error_message": str(exc)[:2000],
                },
            )
        except Exception:  # noqa: BLE001
            pass
        raise


if __name__ == "__main__":
    main()
