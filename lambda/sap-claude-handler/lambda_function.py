# lambda_function.py
# Stable, no external deps. Reads salesData (array) or csv (string). Bedrock converse. CORS/OPTIONS ready.

import json, os, base64, logging, boto3, urllib.request, urllib.parse
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Tuple

# ====== ENV ======
MODEL_ID       = os.environ.get("BEDROCK_MODEL_ID", "us.deepseek.r1-v1:0")
REGION         = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
DEFAULT_FORMAT = (os.environ.get("DEFAULT_FORMAT", "json") or "json").lower()  # 'json'|'markdown'|'text'
MAX_TOKENS     = int(os.environ.get("MAX_TOKENS", "8000"))  # 戦略レベル分析用に大幅増加
TEMPERATURE    = float(os.environ.get("TEMPERATURE", "0.15"))
LINE_NOTIFY_TOKEN = os.environ.get("LINE_NOTIFY_TOKEN", "")

# ====== LOG ======
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ====== CORS/Response ======
def response_json(status: int, body: Dict[str, Any]) -> Dict[str, Any]:
    # Lambda Function URLのCORS設定を使用するため、Lambdaではヘッダー設定しない
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json; charset=utf-8"
        },
        "body": json.dumps(body, ensure_ascii=False)
    }

# ====== Debug early echo (enable with LAMBDA_DEBUG_ECHO=1 or ?echo=1) ======
def _early_echo(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        qs = (event.get("rawQueryString") or "").lower()
        env_on = os.environ.get("LAMBDA_DEBUG_ECHO") in ("1", "true", "TRUE")
        if not (env_on or ("echo=1" in qs)):
            return None
        body_raw = event.get("body")
        if event.get("isBase64Encoded") and isinstance(body_raw, str):
            try:
                body_raw = base64.b64decode(body_raw).decode("utf-8-sig")
            except Exception:
                body_raw = "<base64 decode error>"
        elif isinstance(body_raw, (bytes, bytearray)):
            try:
                body_raw = body_raw.decode("utf-8-sig")
            except Exception:
                body_raw = body_raw.decode("utf-8", errors="ignore")
        sample = body_raw[:1000] if isinstance(body_raw, str) else str(type(body_raw))
        return response_json(200, {
            "message": "DEBUG",
            "format": "json",
            "engine": "bedrock",
            "model": MODEL_ID,
            "response": {
                "echo": "early",
                "received_type": type(body_raw).__name__ if body_raw is not None else "None",
                "raw_sample": sample
            }
        })
    except Exception:
        return None

# ====== Helpers ======
def _to_number(x: Any) -> float:
    try:
        s = str(x).replace(",", "").replace("¥", "").replace("円", "").strip()
        return float(s)
    except Exception:
        return 0.0

def _detect_columns(rows: List[Dict[str, Any]]) -> Dict[str, str]:
    colmap: Dict[str, str] = {}
    if not rows:
        return colmap
    for c in rows[0].keys():
        name = str(c)
        lc = name.lower()
        if ("日" in name) or ("date" in lc):
            colmap.setdefault("date", name)
        # 金額系の列を幅広く検出
        if (("売" in name) or ("金額" in name) or ("amount" in lc) or ("sales" in lc) or ("total" in lc) or
            ("給与" in name) or ("salary" in lc) or ("在庫金額" in name) or ("roi" in lc) or ("予算" in name)):
            colmap.setdefault("sales", name)
        # 名前系の列を幅広く検出
        if (("商" in name) or ("品" in name) or ("product" in lc) or ("item" in lc) or ("name" in lc) or
            ("氏名" in name) or ("社員" in name) or ("employee" in lc) or ("キャンペーン" in name) or ("商品コード" in name)):
            colmap.setdefault("product", name)
    return colmap

def _compute_stats(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    total = len(rows)
    if total == 0:
        return {"total_rows": 0, "total_sales": 0.0, "avg_row_sales": 0.0, "top_products": [], "timeseries": []}

    colmap = _detect_columns(rows)
    dcol, scol, pcol = colmap.get("date"), colmap.get("sales"), colmap.get("product")

    ts = defaultdict(float)
    by_product: Counter = Counter()
    total_sales = 0.0

    for r in rows:
        v = _to_number(r.get(scol, 0)) if scol else 0.0
        total_sales += v
        if pcol:
            by_product[str(r.get(pcol, "")).strip()] += v
        if dcol:
            dt = str(r.get(dcol, "")).strip().replace("/", "-")
            day = dt[:10] if len(dt) >= 10 else dt
            if day:
                ts[day] += v

    top_products = [{"name": k, "sales": float(v)} for k, v in by_product.most_common(5)]
    trend = [{"date": d, "sales": float(v)} for d, v in sorted(ts.items())]
    avg = float(total_sales / total) if total else 0.0

    return {
        "total_rows": total,
        "total_sales": float(total_sales),
        "avg_row_sales": avg,
        "top_products": top_products,
        "timeseries": trend
    }

def _build_prompt_json(stats: Dict[str, Any], sample: List[Dict[str, Any]], data_type: str = "sales_data", industry: str = "general") -> str:
    schema_hint = {
        "type": "object",
        "properties": {
            "overview": {"type": "string"},
            "findings": {"type": "array", "items": {"type": "string"}},
            "kpis": {
                "type": "object",
                "properties": {
                    "total_sales": {"type": "number"},
                    "top_products": {
                        "type": "array",
                        "items": {"type": "object", "properties": {"name": {"type": "string"}, "sales": {"type": "number"}}}
                    }
                }
            },
            "trend": {"type": "array", "items": {"type": "object", "properties": {"date": {"type": "string"}, "sales": {"type": "number"}}}},
            "action_plan": {"type": "array", "items": {"type": "string"}}
        },
        "required": ["overview", "findings", "kpis", "action_plan"]
    }

    # 業種別・データタイプ別の専門的分析指示
    analysis_instructions = _get_industry_specific_instructions(data_type, industry)
    data_type_name = _get_data_type_name(data_type)

    # 業種名を取得
    industry_names = {
        "retail": "小売業",
        "manufacturing": "製造業",
        "service": "サービス業",
        "general": "汎用"
    }
    industry_name = industry_names.get(industry, "汎用")

    return f"""【{industry_name}専門ビジネス分析実行指令 - 業界特化の実践的改善提案】

クライアント: 日本の{industry_name}中小企業経営陣
分析対象: {data_type_name}
分析スタイル: {industry_name}の業界特性を考慮した明日から実行できる具体的アクション重視

【必須アウトプット】
以下の実践的分析を実行してください：

{analysis_instructions}

【アウトプット形式 - 必ず守ってください】

1. **概要** (overview)
   - データの重要な発見を3行以内で要約
   - 最も重要な改善機会を1つ明確に特定
   - 具体的な金額効果を必ず記載（例："月○○万円の売上向上が期待"）

2. **重要な発見** (findings)
   - データから読み取れる具体的事実を5個以内で列挙
   - 各発見に必ず数値を含める
   - 改善すべき問題点を明確に指摘

3. **アクションプラン** (action_plan)  ← 最重要！
   - 明日から実行できる具体的な行動を5-7個提示
   - 各アクションに実行期限・担当者・期待効果を明記
   - 例："営業部長は来週までに○○商品の単価を500円値上げ検討（月売上20万円向上見込み）"
   - 実行コストと効果を必ず数値で示す

【絶対に避けること】
× 抽象的な提案（"戦略を見直す"など）
× 実行期限のない提案
× 金額効果の記載がない提案
× 大企業向けの高額投資が必要な提案

【必須要件】
✓ 全提案が中小企業で即実行可能
✓ 各アクションに具体的な数値目標
✓ 低コスト・高効果の改善案優先
✓ 責任者・期限・KPIを明確化
✓ ROI（投資対効果）を金額で明示

JSON形式で出力: {json.dumps(schema_hint, ensure_ascii=False)}

【分析データ】
統計サマリー: {json.dumps(stats, ensure_ascii=False)}
サンプルデータ: {json.dumps(sample, ensure_ascii=False)}

※このレポートは経営陣が読んだ翌日から実行に移せる実用性を最優先してください。"""

def _build_prompt_markdown(stats: Dict[str, Any], sample: List[Dict[str, Any]], data_type: str = "sales_data") -> str:
    return f"""あなたは会社の売上データを分析するビジネスアドバイザーです。以下の売上データを見て、社長や部長が読むレポートを、完全に日本語と数字だけで作成してください。

【重要】
- Markdownや記号は一切使わず、普通の日本語文章で書いてください
- 「##」「**」「|」「-」などの記号は絶対に使わないでください
- 英語や専門用語は一切使わないでください
- まるで部下が上司に口頭で報告するような、自然な文章で書いてください
- 数字は「○○万円」「○○%増加」など、日本人が話すときの表現で書いてください

# 統計要約
{json.dumps(stats, ensure_ascii=False)}

# サンプル（最大50）
{json.dumps(sample, ensure_ascii=False)}
"""

def _build_prompt_text(stats: Dict[str, Any], sample: List[Dict[str, Any]], data_type: str = "sales_data") -> str:
    return f"""あなたは会社の売上データを分析するビジネスアドバイザーです。以下の売上データを見て、上司に口頭で報告するように、完全に日本語だけで3行以内にまとめてください。

【絶対守ること】
- 記号、英語、カタカナ専門用語は一切使わないでください
- 数字は「○○万円」「○○%増加」など、普通に話すときの表現で書いてください
- まるで朝礼で報告するような、自然な話し言葉で書いてください
- 「です・ます」調で、丁寧に書いてください

[統計要約]
{json.dumps(stats, ensure_ascii=False)}

[サンプル（最大50）]
{json.dumps(sample, ensure_ascii=False)}
"""

def _parse_csv_simple(csv_text: str) -> List[Dict[str, Any]]:
    lines = [l for l in csv_text.splitlines() if l.strip() != ""]
    if not lines: return []
    headers = [h.strip() for h in lines[0].split(",")]
    rows: List[Dict[str, Any]] = []
    for line in lines[1:]:
        cells = [c.strip() for c in line.split(",")]
        row = {}
        for i, h in enumerate(headers):
            row[h] = cells[i] if i < len(cells) else ""
        rows.append(row)
    return rows

def _identify_data_type(columns: List[str], sample_data: List[Dict[str, Any]]) -> str:
    """データの列名とサンプルから財務データの種類を自動判別（7つの分析タイプに特化）"""
    if not columns:
        return "financial_data"
    
    # 列名を小文字に変換して判別しやすくする
    col_lower = [col.lower() for col in columns]
    col_str = " ".join(col_lower) + " " + " ".join(columns)
    
    # スコアベースの判定システム
    scores = {
        "hr_data": 0,
        "marketing_data": 0,
        "sales_data": 0,
        "financial_data": 0,
        "inventory_data": 0,
        "customer_data": 0
    }
    
    # 人事データの強いキーワード（高スコア）
    hr_strong_keywords = ["社員id", "employee", "氏名", "部署", "給与", "salary", "賞与", "年収", "評価", "performance", "残業", "overtime", "有給", "離職", "昇進", "スキル", "チーム貢献", "人事"]
    for keyword in hr_strong_keywords:
        if keyword in col_str:
            scores["hr_data"] += 3
    
    # 人事データの中程度キーワード
    hr_medium_keywords = ["勤怠", "attendance", "研修", "training", "目標達成", "職位", "入社", "年齢"]
    for keyword in hr_medium_keywords:
        if keyword in col_str:
            scores["hr_data"] += 2
    
    # マーケティングデータの強いキーワード
    marketing_strong_keywords = ["キャンペーン", "campaign", "roi", "インプレッション", "impression", "クリック", "click", "cv数", "conversion", "顧客獲得", "cac", "roas", "広告", "媒体", "ターゲット"]
    for keyword in marketing_strong_keywords:
        if keyword in col_str:
            scores["marketing_data"] += 3
    
    # マーケティングデータの中程度キーワード
    marketing_medium_keywords = ["予算", "budget", "支出", "cost", "facebook", "google", "youtube", "instagram", "tiktok", "twitter"]
    for keyword in marketing_medium_keywords:
        if keyword in col_str:
            scores["marketing_data"] += 1
    
    # 売上データの強いキーワード
    sales_strong_keywords = ["売上", "sales", "revenue", "商品", "product", "顧客", "customer", "金額", "amount", "単価", "price", "数量", "quantity"]
    for keyword in sales_strong_keywords:
        if keyword in col_str:
            scores["sales_data"] += 3
    
    # 売上データの中程度キーワード
    sales_medium_keywords = ["日付", "date", "店舗", "store", "地域", "region", "カテゴリ", "category"]
    for keyword in sales_medium_keywords:
        if keyword in col_str:
            scores["sales_data"] += 1
    
    # 統合戦略データ（財務データ）の強いキーワード
    financial_strong_keywords = ["売上高", "revenue", "利益", "profit", "資産", "asset", "負債", "liability", "キャッシュ", "cash", "損益", "pl", "貸借", "bs"]
    for keyword in financial_strong_keywords:
        if keyword in col_str:
            scores["financial_data"] += 3
    
    # 在庫分析データの強いキーワード
    inventory_strong_keywords = ["在庫", "inventory", "stock", "在庫数", "保有数", "倉庫", "warehouse", "回転率", "turnover", "滞留", "入庫", "出庫", "調達", "procurement"]
    for keyword in inventory_strong_keywords:
        if keyword in col_str:
            scores["inventory_data"] += 3
    
    # 在庫分析データの中程度キーワード
    inventory_medium_keywords = ["商品コード", "sku", "ロット", "lot", "品番", "型番", "仕入", "supplier", "発注", "order", "納期", "delivery"]
    for keyword in inventory_medium_keywords:
        if keyword in col_str:
            scores["inventory_data"] += 1
    
    # 顧客分析データの強いキーワード  
    customer_strong_keywords = ["顧客", "customer", "会員", "member", "ユーザー", "user", "ltv", "lifetime", "churn", "離脱", "継続", "retention", "満足度", "satisfaction"]
    for keyword in customer_strong_keywords:
        if keyword in col_str:
            scores["customer_data"] += 3
    
    # 顧客分析データの中程度キーワード
    customer_medium_keywords = ["セグメント", "segment", "年齢", "age", "性別", "gender", "地域", "region", "購入履歴", "purchase", "アクセス", "access", "クリック", "click"]
    for keyword in customer_medium_keywords:
        if keyword in col_str:
            scores["customer_data"] += 1
    
    # データの内容からも判定（サンプルデータが利用可能な場合）
    if sample_data and len(sample_data) > 0:
        sample = sample_data[0]
        
        # 人事データの特徴的な値パターン
        for key, value in sample.items():
            str_value = str(value).lower()
            
            # 人事系の値パターン
            if any(dept in str_value for dept in ["営業部", "it部", "人事部", "財務部", "マーケティング部"]):
                scores["hr_data"] += 5
            if any(pos in str_value for pos in ["主任", "係長", "一般", "部長", "課長"]):
                scores["hr_data"] += 3
            if any(risk in str_value for risk in ["低", "中", "高"]) and ("リスク" in key or "risk" in key.lower()):
                scores["hr_data"] += 4
                
            # マーケティング系の値パターン
            if any(media in str_value for media in ["google広告", "facebook広告", "youtube広告", "instagram広告", "line広告", "tiktok広告"]):
                scores["marketing_data"] += 5
            if "%" in str_value and any(metric in key.lower() for metric in ["roi", "達成率", "満足度"]):
                scores["marketing_data"] += 2
                
            # 売上系の値パターン（数値が大きく、商品名がある場合）
            if "商品" in key or "product" in key.lower():
                scores["sales_data"] += 3
            if key.lower() in ["店舗", "store"] and str_value:
                scores["sales_data"] += 4
                
            # 在庫系の値パターン
            if any(unit in str_value for unit in ["個", "本", "kg", "箱", "セット", "台"]):
                scores["inventory_data"] += 2
            if "warehouse" in key.lower() or "倉庫" in key:
                scores["inventory_data"] += 3
            if any(status in str_value for status in ["入荷待ち", "出荷済み", "在庫切れ", "調達中"]):
                scores["inventory_data"] += 4
                
            # 顧客系の値パターン  
            if any(age in str_value for age in ["20代", "30代", "40代", "50代", "60代"]) or str_value.isdigit() and 18 <= int(str_value) <= 80:
                scores["customer_data"] += 3
            if any(gender in str_value for gender in ["男性", "女性", "male", "female", "男", "女"]):
                scores["customer_data"] += 3
            if "@" in str_value:  # メールアドレス
                scores["customer_data"] += 4
    
    # 最高スコアのタイプを返す
    if max(scores.values()) > 0:
        return max(scores, key=scores.get)
    
    # デフォルト
    return "financial_data"

def _get_data_type_name(data_type: str) -> str:
    """データタイプの日本語名を返す"""
    type_names = {
        "pl_statement": "損益計算書（PL表）",
        "balance_sheet": "貸借対照表（BS）",
        "cashflow_statement": "キャッシュフロー計算書",
        "sales_data": "売上データ",
        "inventory_data": "在庫データ",
        "customer_data": "顧客データ",
        "hr_data": "人事データ",
        "marketing_data": "マーケティングデータ",
        "financial_data": "財務データ",
        "document_data": "書類画像データ",
        "unknown": "不明なデータ"
    }
    return type_names.get(data_type, "財務データ")

def validate_analysis_compatibility(detected_data_type: str, requested_analysis_type: str) -> Tuple[bool, str]:
    """データタイプと分析タイプの適合性をチェック（使いやすさ重視）"""
    # 適合性マトリックス - より柔軟に
    compatibility_matrix = {
        'sales': {
            'primary': ['sales_data'],  # 主要対応
            'secondary': ['financial_data'],  # 副次対応（警告なしで通す）
            'name': '売上分析',
            'description': '売上・商品・顧客データの分析'
        },
        'hr': {
            'primary': ['hr_data'],
            'secondary': [],  # 人事は厳密に
            'name': '人事分析', 
            'description': '従業員パフォーマンス・給与・評価データの分析'
        },
        'marketing': {
            'primary': ['marketing_data'],
            'secondary': ['financial_data'],  # 予算データなども可
            'name': 'マーケティング分析',
            'description': 'キャンペーン・ROI・顧客獲得データの分析'
        },
        'strategic': {
            'primary': ['financial_data', 'sales_data'],
            'secondary': ['hr_data', 'marketing_data'],  # 統合戦略は何でも可
            'name': '統合戦略分析',
            'description': '総合的なビジネスデータの戦略分析'
        }
    }
    
    # リクエストタイプが存在しない場合は通す
    if requested_analysis_type not in compatibility_matrix:
        return True, ""
    
    config = compatibility_matrix[requested_analysis_type]
    
    # 主要タイプまたは副次タイプに適合するかチェック
    all_allowed = config['primary'] + config['secondary']
    
    if detected_data_type in all_allowed:
        return True, ""  # 適合している
    
    # 不適合の場合のみエラー
    if detected_data_type not in all_allowed:
        # 最適なボタンを提案
        best_match = None
        for btn_type, btn_config in compatibility_matrix.items():
            if detected_data_type in (btn_config['primary'] + btn_config['secondary']):
                best_match = btn_config['name']
                break
        
        error_msg = f"""⚠️ データタイプの不一致が検出されました

アップロードされたデータ: {_get_data_type_name(detected_data_type)}
選択された分析: {config['name']}

このデータは{config['name']}には最適化されていません。"""
        
        if best_match:
            error_msg += f"\n\n💡 このデータには「{best_match}」がおすすめです。\n\nただし、そのまま分析を続行することも可能です。"
            # 警告だけで続行を許可
            return True, ""
        else:
            error_msg += f"\n\n「統合戦略分析」ボタンをお試しください。"
            return True, ""
    
    return True, ""

def _get_practical_analysis_instructions(data_type: str) -> str:
    """データタイプ別の実践的分析指示を返す"""
    instructions = {
        "pl_statement": """
**即効性のある財務改善分析**
- 粗利率の低い商品・サービスを特定し、価格見直しまたは原価削減の具体案
- 販管費で削減可能な項目トップ3と削減金額を算出
- 営業利益率を2%向上させるための具体的施策
- 来月から実行できるコスト削減案（金額効果付き）""",

        "balance_sheet": """
**資金繰り改善の実践的提案**
- 売掛金回収サイト短縮による資金繰り改善効果を計算
- 在庫削減で捻出できる資金額と具体的削減対象
- 流動比率改善のための即効性ある施策
- 借入金利負担軽減のための金融機関交渉ポイント""",

        "cashflow_statement": """
**キャッシュフロー改善の具体的アクション**
- 回収サイト・支払サイト見直しによる資金繰り改善額
- 不要な設備投資の見直し対象と節約効果
- 営業CFを月○○万円改善するための具体的手順
- 資金ショート回避のための緊急対応策""",
        
        "sales_data": """
**即効性売上改善アクション**

**今月実行可能な売上向上策**
- 売上TOP商品の単価を段階的に5-10%値上げした場合の増収効果を計算
- 低収益商品の販売中止・価格改定による利益改善額
- 優良顧客への追加商品提案で獲得できる売上額（具体的アプローチ方法付き）
- 営業効率の悪い商品・顧客の見直しによる時間当たり売上向上

**3ヶ月以内の営業改善計画**
- 成約率向上のための営業プロセス改善（具体的手順と期待効果）
- リピート率向上施策（コスト・実行方法・効果測定方法）
- 新規開拓すべき顧客層の特定と具体的アプローチ手順
- 営業担当者別の改善ポイントと研修内容

**数値改善目標の設定**
- 月次売上目標を達成するために必要な具体的アクション数
- 客単価・成約率・リピート率の改善による売上インパクト試算
- 営業コスト削減と売上効率化の両立案
- 競合対策として即座に実行すべき差別化施策""",
        
        "inventory_data": """
- 在庫の総額、商品別構成を確認してください
- 在庫回転率や滞留在庫があれば指摘してください
- 適正在庫レベルと過剰在庫のリスクを評価してください
- 在庫管理の改善点があれば提案してください""",
        
        "hr_data": """
**即効性人事改善アクション**

**今月実行可能な生産性向上策**
- 残業時間削減による人件費削減額と具体的時短施策
- 低パフォーマー社員への具体的改善指導プラン（期限・目標設定）
- 高パフォーマー社員の離職防止策（昇給・昇格・特別手当の具体案）
- 部署間の人員配置見直しによる業務効率化

**3ヶ月以内の人事コスト最適化**
- 外部委託vs内製化の切り替えによるコスト削減効果
- 研修費用対効果の見直しと優先順位付け
- 評価制度改善による社員モチベーション向上施策
- 採用コスト削減のための紹介制度・リファラル強化

**人材リスク管理の実践策**
- 離職リスクの高い社員への具体的慰留アクション
- 業務属人化解消のためのマニュアル化・引継ぎ体制
- 管理職の人事評価スキル向上のための実践研修
- 給与・賞与の適正化による人件費配分最適化""",
        
        "marketing_data": """
**即効性マーケティング改善アクション**

**今月実行可能な広告効率化**
- ROASの低い広告媒体・キーワードの停止による無駄コスト削減額
- 高成果広告の予算増額による売上向上見込み（具体的金額配分）
- CPA（顧客獲得単価）改善のための広告文・ターゲティング見直し
- 無料施策（SNS・口コミ・紹介制度）で代替可能な有料広告の特定

**3ヶ月以内の顧客獲得最適化**
- 新規顧客獲得コストと既存顧客維持コストの最適配分
- リピート率向上施策（メルマガ・LINE・会員特典）の具体的実行プラン
- 高LTV顧客の特徴分析と同様顧客の獲得ターゲティング
- クロスセル・アップセルによる客単価向上の具体的アプローチ

**マーケティング予算最適化**
- 効果測定可能な施策への予算集中による ROI 向上
- 季節性を考慮した予算配分の見直し（具体的月別配分案）
- 競合他社の成功事例を参考にした低コスト施策の導入
- マーケティングオートメーション導入による人件費削減効果""",

        "inventory_data": """
**即効性在庫改善アクション**

**今月実行可能な在庫最適化**
- 回転率の悪い商品の処分・値引き販売による資金回収額
- 過剰在庫商品の他店舗・他チャネルへの振り分けによる売上化
- 品切れ頻発商品の安全在庫見直しによる機会損失防止
- 発注サイクル・発注量見直しによる在庫コスト削減額

**3ヶ月以内の在庫効率化**
- ABC分析による重点管理商品の絞り込みと管理コスト削減
- 季節商品の予約販売・前払い制導入による資金繰り改善
- サプライヤーとの支払条件見直しによるキャッシュフロー改善
- 倉庫レイアウト・ピッキング効率化による人件費削減

**在庫リスク管理の実践策**
- デッドストック化する前の早期処分基準の設定
- 新商品導入時の適正初回発注量の算定方法
- 売れ筋商品の欠品防止のための発注アラート設定
- 在庫評価損を最小化するための定期的な棚卸し・評価見直し""",

        "customer_data": """
**即効性顧客関係改善アクション**

**今月実行可能な顧客価値向上策**
- 高価値顧客（上位20%）への特別サービス・割引による離脱防止
- 休眠顧客（6ヶ月以上未購入）への復活キャンペーンの具体的内容・予算
- リピート率向上のためのポイント制度・会員特典の見直し
- 顧客満足度の低い要因の特定と即座に改善可能な施策

**3ヶ月以内の収益性向上施策**
- 客単価アップのためのセット販売・関連商品提案の仕組み化
- 購入頻度向上のための定期購入・サブスクリプション導入
- 紹介・口コミ促進のためのインセンティブ制度設計
- 顧客データベース整備による効果的なDM・メール配信

**顧客維持コスト最適化**
- 顧客獲得コストvs維持コストの比較による予算配分見直し
- 解約・離脱予兆の早期発見システムと対応フロー構築
- 顧客対応品質向上のためのスタッフ研修・マニュアル整備
- 顧客ニーズに基づく商品・サービス改善の優先順位付け""",
        
        "financial_data": """
**即効性財務改善アクション**

**今月実行可能な収益性向上策**
- 利益率の低い事業・商品の価格改定・販売中止による収益改善額
- 固定費削減の具体的項目と削減可能金額（家賃・保険・通信費等）
- 売掛金回収期間短縮による資金繰り改善とキャッシュフロー増加額
- 不要資産（遊休不動産・車両・設備）の売却による資金調達

**3ヶ月以内の財務体質強化**
- 借入金利の見直し・借り換えによる金利負担軽減額
- 運転資本の最適化（在庫・売掛金・買掛金）による資金効率向上
- 投資効果の低い事業からの撤退・縮小による収益性改善
- 税務最適化（節税対策・控除活用）による実質利益増加

**リスク管理の実践策**
- 資金繰り表作成による将来3ヶ月の資金ショートリスク回避
- 主要取引先の与信管理強化による貸倒リスク軽減
- 為替・金利変動リスクのヘッジ手法導入
- 事業継続性確保のための緊急時資金調達手段の確保"""
    }
    return instructions.get(data_type, instructions["financial_data"])

def _get_industry_specific_instructions(data_type: str, industry: str = "general") -> str:
    """業種別・データタイプ別の専門的分析指示を返す"""

    # 業種別の専門指示
    industry_instructions = {
        "retail": {  # 小売業
            "sales_data": """
**小売業売上最適化 - 実店舗運営の実践的改善**

**店舗運営の即効改善（今日から実行可能）**
- 商品陳列・ゴールデンゾーン活用による売上20%向上策
- 時間帯別客層分析と人員配置最適化（人件費10%削減）
- 死に筋商品特定と処分セール実行（資金回収月○○万円）
- レジ待ち時間短縮によるクレーム防止と客満足度向上

**在庫・仕入れの資金効率化（1週間以内実行）**
- 売れ筋商品の欠品防止・機会損失回避（月○○万円効果）
- 仕入先価格交渉の具体的アプローチと削減目標金額
- 季節商品の適切な仕入れタイミングと処分時期設定
- 返品・廃棄リスク最小化の具体的手順

**顧客関係強化・リピート率向上**
- 常連客識別システムと特別待遇による囲い込み
- 一見客→常連客転換の接客マニュアル作成
- 口コミ・地域評判向上の無料集客手法
- 客単価向上のクロスセル・セット販売テクニック""",

            "inventory_data": """
**小売業在庫管理 - 資金効率最大化**

**即効性在庫最適化（今週実行）**
- ABC分析による重点管理商品の絞り込み
- 回転率1回転/月以下商品の緊急処分計画
- 仕入れロット最適化とキャッシュフロー30日改善
- 陳列効率化による坪効率・売上向上

**季節・トレンド対応の実践手法**
- 季節商品仕入れカレンダー作成と実行
- 流行予測と適正仕入れ量の決定手順
- 売れ残り商品の段階的値下げスケジュール
- 新商品導入時の既存商品入替フロー

**多店舗・マルチチャネル最適化**
- 店舗間在庫移動による欠品・過剰在庫解消
- EC・実店舗在庫統合による効率化
- 店舗特性に応じた在庫配分アルゴリズム
- 取引先との支払条件交渉による資金繰り改善""",

            "customer_data": """
**小売業顧客戦略 - 地域密着型売上向上**

**常連客育成・離脱防止（即効性あり）**
- 購入履歴分析による優良顧客ランク付け
- 購入間隔アラート設定による離脱予兆検知
- 地域イベント・季節行事との連動企画
- 顧客年齢層別アプローチ方法の確立

**新規客獲得・地域シェア拡大**
- 商圏分析による効果的チラシ配布エリア選定
- 近隣競合店との差別化ポイント強化
- 地域コミュニティ参加による信頼関係構築
- 紹介客獲得のインセンティブ制度設計

**客単価・購買頻度の具体的向上策**
- 買い物カゴ分析による関連商品提案
- まとめ買い・セット販売の効果的陳列
- 客層別（主婦・サラリーマン・高齢者）接客手法
- 地域特性を活かした商品構成と価格設定""",

            "hr_data": """
**小売業人事管理 - 店舗運営効率化**

**店舗スタッフ生産性向上（即効改善）**
- 時間帯別客数分析による最適人員配置
- レジ効率化・待ち時間短縮による顧客満足度向上
- 接客スキル標準化による売上貢献度アップ
- パート・アルバイト戦力最大化の実践手法

**離職率削減・人材定着**
- シフト調整による働きやすさ向上
- 販売実績連動インセンティブによるモチベーション管理
- 新人早期戦力化のOJTプログラム
- 多店舗展開時の人材交流・キャリアパス設計

**労働コスト最適化**
- 繁忙期・閑散期の効率的人員配置
- 労働時間管理による残業代削減
- 多能工化による人件費効率向上
- 人時売上向上の具体的改善策""",

            "marketing_data": """
**小売業マーケティング - 地域密着集客**

**低コスト集客・販促効果最大化**
- 地域特性に応じたチラシ・広告戦略
- SNS活用による口コミ拡散促進
- 季節イベント・地域行事連動企画
- 近隣競合対策と差別化ポイント強化

**店頭販促・客単価向上**
- POP・陳列による購買促進効果測定
- セール・特価タイミングの最適化
- 関連商品クロスセル促進の具体手法
- 客層別アプローチによる売上向上

**デジタル活用・オムニチャネル**
- EC連携による集客・売上拡大
- 顧客データベース活用による個別アプローチ
- アプリ・ポイントカード活用の効果測定
- オンライン・オフライン統合戦略""",

            "financial_data": """
**小売業財務管理 - 資金効率最大化**

**キャッシュフロー改善（即効性あり）**
- 仕入先支払条件交渉による資金繰り改善
- 在庫回転率向上による運転資金削減
- 売掛金回収期間短縮の具体的手法
- 季節資金需要の事前計画・調達戦略

**収益性・採算性改善**
- 商品別・店舗別損益分析と改善策
- 固定費削減と売上維持の両立手法
- 投資回収期間短縮の設備・改装計画
- 税務最適化による手取り利益最大化

**経営指標管理・予算統制**
- 日次・週次売上管理による目標達成
- 人件費率・家賃比率の業界標準比較
- 資金調達コスト削減の金融機関交渉
- 事業拡大時の資金計画・リスク管理"""
        },

        "manufacturing": {  # 製造業
            "inventory_data": """
**製造業在庫管理 - 生産効率最大化**

**生産計画・在庫最適化（即効性あり）**
- 原材料調達リードタイム短縮による在庫削減
- 製品別需要予測精度向上と安全在庫適正化
- 仕掛品・半製品の滞留時間短縮手法
- 生産ロット最適化による効率向上

**品質・納期管理の実践改善**
- 不良品発生要因分析と再発防止策
- 納期遅延リスクの早期発見システム
- 外注・内製の採算性比較と最適化
- 設備稼働率向上による生産性20%アップ

**原価管理・コスト削減**
- 材料費・労務費・経費の詳細分析
- 歩留まり改善による材料ロス削減
- 外注費削減の交渉ポイントと代替案
- エネルギーコスト削減の具体的手法""",

            "hr_data": """
**製造業人事管理 - 生産性・安全性向上**

**現場作業員の生産性向上**
- 技能レベル別作業配置による効率化
- 多能工化による人員配置の柔軟性向上
- 残業削減と生産性維持の両立手法
- 安全教育強化による事故コスト削減

**技能継承・人材育成**
- ベテラン技能の標準化・マニュアル化
- OJT効率化による教育期間短縮
- 資格取得支援による技能向上促進
- 若手定着率向上の具体的施策

**労働環境・安全管理**
- 作業環境改善による生産性向上
- 設備安全対策の優先順位付け
- 健康管理による欠勤率・離職率削減
- 労働基準法遵守とコスト最適化の両立""",

            "sales_data": """
**製造業売上管理 - 受注・納期最適化**

**受注体制・顧客管理最適化**
- 既存顧客の継続受注確保と顧客維持率向上
- 新規開拓と既存深掘りのバランス最適化
- 空き時間を活用した効率的新規開拓戦略
- 受注取消リスク管理と代替顧客確保

**生産スケジュール連動型営業**
- 生産キャパシティと連動した受注コントロール
- 納期管理高度化による顧客信頼度向上
- 原材料調達リードタイムを考慮した受注戦略
- 急ぎ注文対応能力向上と付加価値创出

**価格戦略・収益性最適化**
- 原材料費変動を考慮した動的価格設定
- ロットサイズ別原価算出と最適価格提案
- 長期受注案件の収益性確保戦略
- 競合他社との差別化ポイント強化""",

            "customer_data": """
**製造業顧客管理 - B2B関係最適化**

**長期顧客関係維持・拡大**
- 主要顧客の取引維持とリスク管理
- 顧客ニーズ変化の早期捕捉と対応策
- 既存顧客内での部署拡大・取引深掘り
- 顧客満足度管理と継続受注確保

**新規顧客開拓・市場拡大**
- 構内企業情報收集とアプローチ戦略
- 紹介ルート活用による信頼関係構築
- 業界トレンド把握と新分野参入機会発掘
- 競合他社からのシェア奥取戦略

**顧客別収益管理・最適化**
- 顧客別原価・利益率分析と改善策
- 顧客ランク別サービスレベル設定
- 長期取引予測と適正在庫・設備投資
- 顧客集約リスク回避と水平展開""",

            "marketing_data": """
**製造業マーケティング - B2Bブランディング**

**技術マーケティング・信頼性向上**
- 技術資料・事例紹介による専門性アピール
- 品質認証・安全基準対応実績の効果的訴求
- 展示会・セミナー活用によるリード獲得
- 業界誌・専門メディアへの投稿戦略

**デジタルマーケティング活用**
- LinkedINなどB2Bプラットフォーム活用
- ウェブサイトSEO対策によるリード獲得
- 動画コンテンツによる技術力訴求
- メールマーケティングによる顧客育成

**競合分析・差別化戦略**
- 競合他社製品・サービス比較分析
- 独自技術・特許活用による差別化
- 顧客事例・導入実績による信頼性訴求
- アフターサービス充実による長期関係構築""",

            "financial_data": """
**製造業財務管理 - 生産効率連動最適化**

**原価管理・収益性向上**
- 製品別・工程別原価精度向上と改善策
- 歩留まり改善による材料費削減
- 外注・VS内製のコスト比較と最適化
- 設備投資回収期間短縮の具体的手法

**キャッシュフロー管理最適化**
- 受注残・仕掛品・完成品在庫のバランス最適化
- 貢献利益管理による製品ミックス最適化
- 設備稼働率向上による固定費回収效率化
- 運転資金回転率向上の具体策

**投資計画・成長戦略**
- 新製品開発投資のROI最適化
- 生産能力拡大投資のタイミング最適化
- M&A・業務提携による成長戦略
- 税務最適化と研究開発税制活用"""
        },

        "service": {  # サービス業
            "hr_data": """
**サービス業人事管理 - 顧客満足度・収益性向上**

**接客スキル・サービス品質向上**
- 顧客満足度向上のための接客研修設計
- クレーム対応力強化による顧客維持
- スタッフモチベーション管理と離職防止
- 繁忙期の効率的人員配置と教育

**売上・生産性の人的要因分析**
- スタッフ別売上貢献度の定量化
- 接客品質と客単価・リピート率の相関分析
- 人件費対売上比率の最適化
- インセンティブ制度による売上向上

**労働環境・働き方改革**
- シフト最適化による人件費削減
- 働き方改革とサービス品質維持の両立
- パート・アルバイト活用の効率化
- デジタル化による業務効率向上""",

            "customer_data": """
**サービス業顧客戦略 - 満足度・収益性向上**

**顧客満足度・リピート率向上**
- サービス品質向上による顧客満足度改善
- 顧客ニーズ分析に基づくサービス改善
- クレーム分析による根本的問題解決
- 顧客生涯価値（LTV）最大化戦略

**新規顧客獲得・市場拡大**
- 口コミ・紹介促進による無料集客
- 地域特性に応じたサービス差別化
- デジタルマーケティング活用の集客
- 競合分析による優位性の確立

**収益性・客単価向上**
- サービスメニュー最適化による単価向上
- アップセル・クロスセル機会の創出
- 顧客セグメント別価格戦略
- サービス付加価値向上による差別化""",

            "sales_data": """
**サービス業売上管理 - サービス品質連動売上**

**サービス品質と売上の直結**
- 接客品質向上によるリピート率・口コミ率向上
- サービス待ち時間短縮による顧客満足度アップ
- スタッフの接客スキル標準化と売上貢献測定
- 特別サービス・付加価値提供による差別化

**時間帯・季節別売上最適化**
- 集客パターン分析による効率的人員配置
- オフピーク時間活用による売上平均化
- 特別キャンペーン・イベントによる集客強化
- 予約システム活用による機会損失防止

**客単価・メニュー最適化**
- 人気メニュー分析と利益率連動価格設定
- セットメニュー・コース料理による客単価向上
- 顧客層別（ファミリー・カップル・シニア）メニュー最適化
- アップセル・クロスセルの効果的提案手法""",

            "inventory_data": """
**サービス業在庫管理 - 商材・設備効率最適化**

**サービス提供に必要な商材管理**
- 消耗品・サービス商材の適正在庫管理
- 仕入コスト削減と品質維持の両立
- 季節・イベント連動商材調達計画
- 総菜・飲料など生鮮食品のロス削減

**設備・機器の効率管理**
- サービス設備の稼働率向上とメンテナンス最適化
- 設備投資回収期間短縮の具体策
- 予備部品・消耗品の適正在庫管理
- リースVS購入のコスト比較と最適化

**サービス品質連動在庫管理**
- 高品質サービス提供に必要な商材あるべき姿
- 顧客満足度と連動した在庫投資最適化
- サービスメニュー変更に対応した柔軟な在庫管理
- サービス中断リスク最小化の安全在庫設定""",

            "marketing_data": """
**サービス業マーケティング - 体験型集客**

**口コミ・紹介マーケティング最適化**
- 顧客満足度向上による自然な口コミ促進
- 紹介インセンティブ制度による新規客獲得
- SNS活用によるファンコミュニティ形成
- オンラインレビュー対策と評判管理

**体験マーケティング・イベント活用**
- 無料体験サービスによる新規客获得
- 季節イベント・地域行事連動企画
- 常連客向け特別サービス・優待制度
- コラボレーション企画による相互集客

**デジタルマーケティング活用**
- Googleマイビジネス・ローカルSEO最適化
- アプリ・予約システム活用による顧客接点強化
- メールマガジン・ニュースレターによる顧客育成
- インフルエンサーマーケティングの効果測定""",

            "financial_data": """
**サービス業財務管理 - サービス品質連動収益**

**サービス品質と収益性の直結**
- 顧客満足度向上によるリピート率・収益性直結
- サービス品質投資のROI測定と最適化
- 人件費率とサービス品質のバランス最適化
- 顧客単価向上のための付加価値创出投資

**キャッシュフロー管理最適化**
- 時間帯別・曜日別売上パターンを考慮した資金管理
- 設備投資タイミングと回収期間短縮
- 季節変動を考慮した運転資金管理
- キャンペーン・イベント投資のROI管理

**成長投資・拡大戦略**
- 新店舗出店投資のタイミングと立地選定
- サービスメニュー拡充投資の効果測定
- フランチャイズ展開と直営拡大の比較分析
- M&A・業務提携による成長戦略とリスク管理"""
        }
    }

    # 一般的な指示（業種指定がない場合）
    general_instructions = _get_practical_analysis_instructions(data_type)

    # 業種別指示があれば使用、なければ一般的指示
    if industry in industry_instructions and data_type in industry_instructions[industry]:
        return industry_instructions[industry][data_type]
    else:
        return general_instructions

def _bedrock_converse(model_id: str, region: str, prompt: str, industry: str = "general") -> str:
    client = boto3.client("bedrock-runtime", region_name=region)

    # 業種名マッピング
    industry_names = {
        "retail": "小売業",
        "manufacturing": "製造業",
        "service": "サービス業",
        "general": "汎用"
    }
    industry_name = industry_names.get(industry, "汎用")

    system_ja = [{
        "text": f"""【業界特化型ビジネス改善AIアシスタント - {industry_name}専門】

あなたは{industry_name}の業界特性を深く理解した実践的なビジネスアドバイザーです。業界の商慣習・課題・成功パターンを考慮し、明日から実行できる具体的な改善案の提供に専念してください：

**専門特化領域**
• 売上・利益向上（価格戦略・営業効率化・顧客維持）
• コスト削減・効率化（人件費・固定費・在庫最適化）
• 資金繰り改善（キャッシュフロー・資金調達・支払い管理）
• 人事生産性向上（労働時間・人材配置・離職率改善）
• マーケティング効率化（広告費・顧客獲得・リピート率）

**必須アウトプット要件**
1. **具体的金額効果**: 「月○○万円の売上向上見込み」必須
2. **実行期限設定**: 「来週まで」「1ヶ月以内」の明確な期限
3. **担当者指定**: 「営業部長」「店長」など具体的な責任者
4. **低コスト重視**: 大規模投資不要、現有資源で実行可能
5. **ROI明示**: 投資対効果を具体的数値で表示

**アウトプット形式（厳守）**
✓ 結論ファースト（最重要改善策を最初に提示）
✓ 実行コスト明記（人件費・材料費・時間コスト）
✓ 期待効果の金額試算（保守的・現実的な数値）
✓ 実行手順の具体化（誰が・いつ・何を・どこで）
✓ 成功判定基準の設定（数値目標・測定方法）

**絶対に避けること**
× 抽象的提案（「戦略を見直す」「仕組みを構築」等）
× 高額投資案（システム導入・大型設備・外部コンサル）
× 実行期限なし（「中長期的に」「段階的に」等）
× 効果不明（「効率化される」「向上が期待」等）
× 大企業向け提案（複雑な組織変更・高度分析手法）

あなたの提案は、経営者が今日読んで明日から実行に移せる実用性を最優先してください。理論的完璧さより実践的価値を重視してください。"""
    }]
    resp = client.converse(
        modelId=model_id,
        system=system_ja,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": MAX_TOKENS, "temperature": TEMPERATURE}
    )
    msg = resp.get("output", {}).get("message", {})
    parts = msg.get("content", [])
    txts = []
    for p in parts:
        if "text" in p:  # DeepSeekのreasoningContentは無視
            txts.append(p["text"])
    return "\n".join([t for t in txts if t]).strip()

def _process_image_with_textract(image_data: str, mime_type: str) -> str:
    """AWS Textractを使用して画像からテキストを抽出"""
    try:
        textract = boto3.client('textract', region_name=REGION)
        
        # Base64デコード
        image_bytes = base64.b64decode(image_data)
        
        # Textractでテキスト抽出
        response = textract.detect_document_text(
            Document={'Bytes': image_bytes}
        )
        
        # テキストを結合
        extracted_text = []
        for item in response['Blocks']:
            if item['BlockType'] == 'LINE':
                extracted_text.append(item['Text'])
        
        return '\n'.join(extracted_text)
    
    except Exception as e:
        logger.error(f"Textract error: {str(e)}")
        return f"テキスト抽出エラー: {str(e)}"

def _analyze_document_image(image_data: str, mime_type: str, analysis_type: str) -> str:
    """画像書類を分析してビジネス分析を実行"""
    try:
        # Textractでテキスト抽出
        extracted_text = _process_image_with_textract(image_data, mime_type)
        
        if "エラー" in extracted_text:
            return extracted_text
            
        # 抽出されたテキストの種類を判定
        document_type = "不明な書類"
        if any(keyword in extracted_text for keyword in ["領収書", "レシート", "receipt"]):
            document_type = "領収書・レシート"
        elif any(keyword in extracted_text for keyword in ["請求書", "invoice", "bill"]):
            document_type = "請求書"
        elif any(keyword in extracted_text for keyword in ["名刺", "business card"]):
            document_type = "名刺"
        elif any(keyword in extracted_text for keyword in ["報告書", "レポート", "report"]):
            document_type = "報告書・レポート"
            
        # AI分析用プロンプト作成
        prompt = f"""
以下の{document_type}の内容を分析し、ビジネス上の洞察を提供してください：

【抽出されたテキスト】
{extracted_text}

【分析観点】
1. 書類の種類と内容の概要
2. 重要な数値・金額・日付の特定
3. ビジネス上の意味と活用可能な情報
4. 改善提案・注意点（該当する場合）
5. データ入力・管理上の推奨事項

日本語で分かりやすく分析結果を提供してください。
"""
        
        # Bedrockで分析実行
        analysis_result = _bedrock_converse(MODEL_ID, REGION, prompt)
        
        return f"""📄 **書類画像分析結果**

**書類種類**: {document_type}

**AI分析結果**:
{analysis_result}

---
**抽出された元テキスト**:
```
{extracted_text}
```"""
        
    except Exception as e:
        logger.error(f"Document image analysis error: {str(e)}")
        return f"書類画像分析エラー: {str(e)}"

# ====== LINE Notify & Sentry Webhook処理 ======
def send_line_notification(message: str) -> bool:
    """LINE Notify APIを使用してメッセージを送信"""
    if not LINE_NOTIFY_TOKEN:
        logger.error("LINE_NOTIFY_TOKEN not configured")
        return False
    
    try:
        headers = {
            'Authorization': f'Bearer {LINE_NOTIFY_TOKEN}',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
        data = {'message': message}
        
        # urllib使用でrequests依存を除去
        data_encoded = urllib.parse.urlencode(data).encode('utf-8')
        req = urllib.request.Request(
            'https://notify-api.line.me/api/notify',
            data=data_encoded,
            headers=headers
        )

        with urllib.request.urlopen(req, timeout=10) as response:
            if response.status == 200:
                logger.info("✅ LINE通知送信成功")
                return True
            else:
                response_text = response.read().decode('utf-8')
                logger.error(f"❌ LINE通知送信失敗: {response.status} - {response_text}")
                return False
            
    except Exception as e:
        logger.error(f"❌ LINE通知エラー: {str(e)}")
        return False

def process_sentry_webhook(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Sentryからのwebhookペイロードを処理してLINE通知を送信"""
    try:
        # Sentryペイロードの検出 - より柔軟に
        is_sentry_webhook = (
            "event" in data or 
            "action" in data or 
            ("data" in data and isinstance(data["data"], dict) and ("issue" in data["data"] or "event" in data["data"])) or
            ("installation" in data) or
            ("alert" in data)
        )
        
        if not is_sentry_webhook:
            # Sentryペイロードではない場合はNoneを返す（通常の処理に進む）
            return None
            
        logger.info("🔴 Sentryからのwebhookペイロードを検出")
        
        # エラー情報を抽出
        error_title = "不明なエラー"
        error_detail = ""
        project_name = ""
        environment = ""
        
        # Sentryのペイロード構造に応じて情報抽出
        if "data" in data:
            event_data = data["data"]
            if "issue" in event_data:
                issue = event_data["issue"]
                error_title = issue.get("title", error_title)
                project_name = issue.get("project", {}).get("name", "")
            elif "event" in event_data:
                event = event_data["event"]
                error_title = event.get("title", event.get("message", error_title))
                environment = event.get("environment", "")
        elif "event" in data:
            event = data["event"]
            error_title = event.get("title", event.get("message", error_title))
            environment = event.get("environment", "")
            
        # LINE通知メッセージを作成
        timestamp = ""
        try:
            from datetime import datetime
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass
            
        message = f"""🚨 【SAP Frontend - エラー通知】

📍 エラー: {error_title}

🏢 プロジェクト: {project_name or "SAP Frontend"}
🌍 環境: {environment or "production"}  
🕒 発生時刻: {timestamp}

🔗 Sentryで詳細を確認してください
"""
        
        # LINE通知を送信
        success = send_line_notification(message)
        
        # レスポンスを返す
        return response_json(200, {
            "message": "Sentry webhook processed",
            "line_notification": "success" if success else "failed",
            "error_title": error_title,
            "project": project_name,
            "environment": environment
        })
        
    except Exception as e:
        logger.error(f"❌ Sentry webhook処理エラー: {str(e)}")
        return response_json(500, {
            "message": "Sentry webhook processing failed",
            "error": str(e)
        })

# ====== Handler ======
def lambda_handler(event, context):
    # Early echo（必要時のみ）
    echo = _early_echo(event)
    if echo is not None:
        return echo

    # CORS/HTTP method
    method = (event.get("requestContext", {}) or {}).get("http", {}).get("method") or event.get("httpMethod", "")
    if method == "OPTIONS":
        return response_json(200, {"ok": True})
    if method != "POST":
        return response_json(405, {
            "response": {"summary": "Use POST", "key_insights": [], "recommendations": [], "data_analysis": {"total_records": 0}},
            "format": "json", "message": "Use POST", "engine": "bedrock", "model": MODEL_ID
        })

    # Parse body
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw).decode("utf-8", errors="ignore")
        except Exception:
            pass
    try:
        data = json.loads(raw)
    except Exception as e:
        return response_json(400, {
            "response": {"summary": f"INVALID_JSON: {str(e)}", "key_insights": [], "recommendations": [], "data_analysis": {"total_records": 0}},
            "format": "json", "message": "INVALID_JSON", "engine": "bedrock", "model": MODEL_ID
        })

    # デバッグ: 受信データの構造をログ出力
    logger.info(f"🔍 受信データの構造: {list(data.keys())}")
    
    # Sentry Webhook処理を最優先でチェック
    sentry_response = process_sentry_webhook(data)
    if sentry_response is not None:
        return sentry_response

    # Inputs
    instruction = (data.get("instruction") or data.get("prompt") or "").strip()
    fmt = (data.get("responseFormat") or DEFAULT_FORMAT or "json").lower()
    requested_analysis_type = data.get("analysisType", "").strip()
    industry = data.get("industry", "general").strip()  # 業種パラメータ
    
    # 画像処理の分岐（document分析 または fileType='image'）
    if requested_analysis_type == "document" or data.get("fileType") == "image":
        image_data = data.get("imageData", "")
        mime_type = data.get("mimeType", "image/jpeg")
        
        if not image_data:
            return response_json(400, {
                "response": {"summary": "画像データが含まれていません", "key_insights": [], "recommendations": []},
                "format": "json", "message": "Missing image data"
            })
        
        try:
            logger.info("Starting image analysis")
            analysis_result = _analyze_document_image(image_data, mime_type, requested_analysis_type)
            
            return response_json(200, {
                "response": {
                    "summary": analysis_result,
                    "key_insights": ["画像からテキスト抽出完了", "AI分析実行済み"],
                    "recommendations": ["抽出データの検証推奨", "重要情報の別途保存推奨"],
                    "data_analysis": {"total_records": 1, "document_type": "image"}
                },
                "format": "json", "message": "Image analysis completed", "engine": "bedrock+textract", "model": MODEL_ID
            })
            
        except Exception as e:
            logger.error(f"Image analysis error: {str(e)}")
            return response_json(500, {
                "response": {"summary": f"画像分析エラー: {str(e)}", "key_insights": [], "recommendations": []},
                "format": "json", "message": "Image analysis failed"
            })
    
    # FORCE_JA option
    force_ja = os.environ.get("FORCE_JA","false").lower() in ("1","true")
    if force_ja:
        instruction = ("日本語のみで、数値は半角。KPI・要点・トレンドを簡潔に。" + (" " + instruction if instruction else ""))

    # Prefer salesData (array). Optionally accept csv.
    sales: List[Dict[str, Any]] = []
    if isinstance(data.get("salesData"), list):
        sales = data["salesData"]
    elif isinstance(data.get("csv"), str):
        sales = _parse_csv_simple(data["csv"])
    # 最終フォールバック（稀に data/rows で来る場合）
    elif isinstance(data.get("rows"), list):
        sales = data["rows"]
    elif isinstance(data.get("data"), list):
        sales = data["data"]

    columns = list(sales[0].keys()) if sales else []
    total = len(sales)

    # 分析タイプの決定（ユーザー指定を優先）
    if requested_analysis_type:
        # ユーザーが明示的に指定した分析タイプを使用
        type_mapping = {
            'sales': 'sales_data',
            'hr': 'hr_data',
            'marketing': 'marketing_data',
            'inventory': 'inventory_data',
            'customer': 'customer_data',
            'financial': 'financial_data',
            'strategic': 'financial_data'  # 統合戦略は財務分析として扱う
        }
        data_type = type_mapping.get(requested_analysis_type, 'financial_data')
    else:
        # 分析タイプが指定されていない場合のみ自動判別
        detected_data_type = _identify_data_type(columns, sales[:5] if sales else [])
        data_type = detected_data_type
    
    stats = _compute_stats(sales)
    sample = sales[:50] if sales else []

    # データタイプ別プロンプト構築
    if fmt == "markdown":
        prompt = _build_prompt_markdown(stats, sample, data_type)
    elif fmt == "text":
        prompt = _build_prompt_text(stats, sample, data_type)
    else:
        prompt = _build_prompt_json(stats, sample, data_type, industry)

    # LLM call
    summary_ai = ""
    findings: List[str] = []
    kpis  = {"total_sales": stats.get("total_sales", 0.0), "top_products": stats.get("top_products", [])}
    trend = stats.get("timeseries", [])

    try:
        ai_text = _bedrock_converse(MODEL_ID, REGION, prompt, industry)
        if fmt == "json":
            # JSON想定。フェンス除去・部分抽出に軽く対応
            text = ai_text.strip()
            if text.startswith("```"):
                # ```json ... ``` のケースを剥がす
                text = text.strip("`").lstrip("json").strip()
            try:
                ai_json = json.loads(text)
            except Exception:
                # 最後の手段：先頭～末尾の最初の{}を探す
                start = text.find("{"); end = text.rfind("}")
                if start != -1 and end != -1 and end > start:
                    try: ai_json = json.loads(text[start:end+1])
                    except Exception: ai_json = {"overview": ai_text}
                else:
                    ai_json = {"overview": ai_text}
            summary_ai = ai_json.get("overview", "")
            findings   = ai_json.get("findings", [])
            kpis       = ai_json.get("kpis", kpis)
            trend      = ai_json.get("trend", trend)
            action_plan = ai_json.get("action_plan", [])
        else:
            summary_ai = ai_text
    except Exception as e:
        logger.exception("Bedrock error")
        summary_ai = f"(Bedrock error: {str(e)})"

    # presentation_md for enhanced readability
    def _fmt_yen(n):
        try: return f"{int(n):,} 円"
        except: return str(n)

    # 自然な日本語レポート（presentation_md） - 記号除去
    trend_list = stats.get('timeseries',[])[:3]
    trend_text = ""
    if trend_list:
        trend_parts = []
        for t in trend_list:
            date = t.get('date','')
            sales = t.get('sales',0)
            if date and sales:
                trend_parts.append(f"{date}に{int(sales):,}円")
        trend_text = "、".join(trend_parts) if trend_parts else "データがありません"
    
    total_sales = stats.get('total_sales',0)
    avg_sales = stats.get('avg_row_sales',0)
    
    presentation_md = f"""{total}件のデータを分析しました。売上合計は{int(total_sales):,}円で、1件あたり平均{int(avg_sales):,}円でした。主な売上は{trend_text}となっています。"""

    # 読みやすい体系的なレポート形式に整理
    if fmt == "markdown" or fmt == "text":
        # Markdown/Text形式は純粋な日本語のみ
        body = {
            "response": {
                "summary_ai": summary_ai
            },
            "format": fmt,
            "message": "OK",
            "model": MODEL_ID
        }
    else:
        # 汎用的で読みやすいレポート形式（全分析タイプ対応）

        # 分析タイプ別のデータ表示設定
        analysis_icons = {
            'sales_data': {'icon': '💰', 'name': '売上分析', 'unit': '円', 'metric': '売上'},
            'hr_data': {'icon': '👥', 'name': '人事分析', 'unit': '円', 'metric': '人件費'},
            'marketing_data': {'icon': '📢', 'name': 'マーケティング分析', 'unit': '円', 'metric': 'ROI'},
            'inventory_data': {'icon': '📦', 'name': '在庫分析', 'unit': '個', 'metric': '在庫'},
            'customer_data': {'icon': '🎯', 'name': '顧客分析', 'unit': '円', 'metric': 'LTV'},
            'financial_data': {'icon': '📊', 'name': '財務分析', 'unit': '円', 'metric': '損益'}
        }

        current_analysis = analysis_icons.get(data_type, analysis_icons['financial_data'])
        analysis_icon = current_analysis['icon']
        analysis_name = current_analysis['name']
        unit = current_analysis['unit']
        metric_name = current_analysis['metric']

        # データ概要を分析タイプに応じて整理
        data_overview = f"""
{analysis_icon} {analysis_name} - データ概要
• 分析対象: {total}件のデータ
• 総{metric_name}: {int(stats.get('total_sales', 0)):,}{unit}
• 平均{metric_name}: {int(stats.get('avg_row_sales', 0)):,}{unit}/件"""

        # 主要項目を分析タイプに応じて整理
        top_items_text = ""
        if stats.get('top_products'):
            # 分析タイプ別のラベル設定
            labels = {
                'sales_data': '🏆 主要商品・売上実績',
                'hr_data': '👑 高給与・人件費上位',
                'marketing_data': '🎯 効果的キャンペーン・ROI上位',
                'inventory_data': '📈 主要商品・在庫金額',
                'customer_data': '💎 優良顧客・LTV上位',
                'financial_data': '💼 主要項目・金額実績'
            }

            label = labels.get(data_type, labels['financial_data'])
            top_items_text = f"\n\n{label}:"

            for i, item in enumerate(stats['top_products'][:5], 1):
                top_items_text += f"\n  {i}位. {item['name']}: {int(item['sales']):,}{unit}"

        # トレンドデータを分析タイプに応じて整理
        trend_data_text = ""
        if stats.get('timeseries'):
            # 分析タイプ別のトレンドラベル
            trend_labels = {
                'sales_data': '📈 売上推移',
                'hr_data': '📊 人件費推移',
                'marketing_data': '📉 ROI推移',
                'inventory_data': '📦 在庫変動',
                'customer_data': '👥 顧客価値推移',
                'financial_data': '💹 財務指標推移'
            }

            trend_label = trend_labels.get(data_type, trend_labels['financial_data'])
            trend_data_text = f"\n\n{trend_label} (直近データ):"

            for trend_item in stats['timeseries'][:5]:
                trend_data_text += f"\n  • {trend_item['date']}: {int(trend_item['sales']):,}{unit}"

        # アクションプランを整理
        action_plan_text = ""
        if 'action_plan' in locals() and action_plan:
            action_plan_text = "\n\n🚀 実行アクションプラン:"
            for i, action in enumerate(action_plan, 1):
                action_plan_text += f"\n  {i}. {action}"

        # 重要な発見を整理
        insights_text = ""
        if findings:
            insights_text = "\n\n💡 重要な発見:"
            for i, insight in enumerate(findings, 1):
                insights_text += f"\n  {i}. {insight}"

        # 全体を結合した読みやすいレポート
        structured_report = f"""{summary_ai}

{data_overview}{top_items_text}{trend_data_text}{insights_text}{action_plan_text}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 {analysis_name}完了 | DeepSeek R1 による実践的ビジネス改善提案"""

        body = {
            "response": {
                "summary_ai": structured_report,
                "presentation_md": presentation_md
            },
            "format": fmt,
            "message": "OK",
            "model": MODEL_ID
        }
    return response_json(200, body)