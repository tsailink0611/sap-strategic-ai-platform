#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Lambda関数のローカルテスト用スクリプト
改良された実践的ビジネス改善AIの動作確認
"""

import json
import sys
import os

# Windows環境での文字エンコーディング設定
import locale
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Lambdaコードをインポート
sys.path.append('./lambda/sap-claude-handler')
from lambda_function import lambda_handler

# 分析タイプ別テストデータ
test_data_sets = {
    "sales": [
        {"日付": "2024-01-01", "商品名": "商品A", "売上金額": 50000, "数量": 10},
        {"日付": "2024-01-02", "商品名": "商品B", "売上金額": 30000, "数量": 5},
        {"日付": "2024-01-03", "商品名": "商品A", "売上金額": 75000, "数量": 15},
        {"日付": "2024-01-04", "商品名": "商品C", "売上金額": 20000, "数量": 2},
        {"日付": "2024-01-05", "商品名": "商品B", "売上金額": 45000, "数量": 9},
        {"日付": "2024-01-06", "商品名": "商品A", "売上金額": 60000, "数量": 12},
        {"日付": "2024-01-07", "商品名": "商品D", "売上金額": 80000, "数量": 8},
    ],
    "hr": [
        {"社員ID": "E001", "氏名": "田中太郎", "部署": "営業部", "給与": 450000, "残業時間": 25},
        {"社員ID": "E002", "氏名": "佐藤花子", "部署": "IT部", "給与": 520000, "残業時間": 15},
        {"社員ID": "E003", "氏名": "山田次郎", "部署": "営業部", "給与": 380000, "残業時間": 35},
        {"社員ID": "E004", "氏名": "鈴木美穂", "部署": "人事部", "給与": 420000, "残業時間": 10},
        {"社員ID": "E005", "氏名": "高橋一郎", "部署": "IT部", "給与": 580000, "残業時間": 20},
    ],
    "inventory": [
        {"商品コード": "P001", "商品名": "商品A", "在庫数": 150, "単価": 2500, "在庫金額": 375000},
        {"商品コード": "P002", "商品名": "商品B", "在庫数": 80, "単価": 1800, "在庫金額": 144000},
        {"商品コード": "P003", "商品名": "商品C", "在庫数": 200, "単価": 900, "在庫金額": 180000},
        {"商品コード": "P004", "商品名": "商品D", "在庫数": 50, "単価": 5000, "在庫金額": 250000},
        {"商品コード": "P005", "商品名": "商品E", "在庫数": 300, "単価": 600, "在庫金額": 180000},
    ],
    "marketing": [
        {"キャンペーン": "Google広告", "予算": 500000, "クリック数": 2500, "CV数": 125, "ROI": 2.5},
        {"キャンペーン": "Facebook広告", "予算": 300000, "クリック数": 1800, "CV数": 90, "ROI": 3.0},
        {"キャンペーン": "YouTube広告", "予算": 400000, "クリック数": 1200, "CV数": 60, "ROI": 1.8},
        {"キャンペーン": "LINE広告", "予算": 200000, "クリック数": 800, "CV数": 50, "ROI": 3.5},
    ]
}

def test_lambda_function(analysis_type="sales"):
    """Lambda関数をローカルでテスト（複数分析タイプ対応）"""

    # テストデータを選択
    test_data = test_data_sets.get(analysis_type, test_data_sets["sales"])

    # テスト用のイベントデータ作成
    test_event = {
        "httpMethod": "POST",
        "body": json.dumps({
            "salesData": test_data,
            "analysisType": analysis_type,
            "responseFormat": "json"
        }),
        "requestContext": {
            "http": {
                "method": "POST"
            }
        }
    }

    analysis_names = {
        "sales": "売上データ",
        "hr": "人事データ",
        "inventory": "在庫データ",
        "marketing": "マーケティングデータ"
    }

    print(f"Lambda関数テスト開始... ({analysis_names.get(analysis_type, '不明')})")
    print(f"テストデータ: {len(test_data)}件の{analysis_names.get(analysis_type, '不明')}")
    print("=" * 60)

    try:
        # Lambda関数実行
        result = lambda_handler(test_event, {})

        print("Lambda関数実行成功!")
        print(f"ステータスコード: {result['statusCode']}")

        # レスポンス内容を解析
        if result['statusCode'] == 200:
            response_body = json.loads(result['body'])

            print("\n分析結果:")
            print("=" * 40)

            if 'response' in response_body:
                response = response_body['response']

                # 概要表示
                if 'summary_ai' in response:
                    print("概要:")
                    print(response['summary_ai'])
                    print()

                # 重要な発見
                if 'key_insights' in response:
                    print("重要な発見:")
                    for i, insight in enumerate(response['key_insights'], 1):
                        print(f"  {i}. {insight}")
                    print()

                # ★ 新機能: アクションプラン
                if 'action_plan' in response:
                    print("実行アクションプラン:")
                    for i, action in enumerate(response['action_plan'], 1):
                        print(f"  {i}. {action}")
                    print()

                # データ分析結果
                if 'data_analysis' in response:
                    data_analysis = response['data_analysis']
                    print("データ分析:")
                    print(f"  • 総レコード数: {data_analysis.get('total_records', 0)}")

                    if 'kpis' in data_analysis:
                        kpis = data_analysis['kpis']
                        if 'total_sales' in kpis:
                            print(f"  • 総売上: {int(kpis['total_sales']):,}円")

                        if 'top_products' in kpis:
                            print("  • トップ商品:")
                            for product in kpis['top_products'][:3]:
                                print(f"    - {product['name']}: {int(product['sales']):,}円")

            print("\n" + "=" * 60)
            print("改良されたAIが実践的な提案を生成しました!")
            print("中小企業向けの即実行可能なアクションプランが含まれています")

        else:
            print(f"エラー: {result}")

    except Exception as e:
        print(f"テスト実行エラー: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    # 環境変数設定（テスト用）
    os.environ.setdefault('BEDROCK_MODEL_ID', 'us.deepseek.r1-v1:0')
    os.environ.setdefault('AWS_REGION', 'us-east-1')
    os.environ.setdefault('MAX_TOKENS', '8000')
    os.environ.setdefault('TEMPERATURE', '0.15')

    print("実践的ビジネス改善AI Lambda関数 - 汎用分析システムテスト")
    print("=" * 70)

    # 複数分析タイプをテスト
    test_types = ["sales", "hr", "inventory", "marketing"]

    for i, analysis_type in enumerate(test_types, 1):
        print(f"\n【テスト {i}/4】")
        test_lambda_function(analysis_type)

        if i < len(test_types):
            print("\n" + "="*50)
            input("次のテストに進むにはEnterキーを押してください...")
            print("="*50)