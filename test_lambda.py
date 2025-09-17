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

# テスト用の売上データ
test_sales_data = [
    {"日付": "2024-01-01", "商品名": "商品A", "売上金額": 50000, "数量": 10},
    {"日付": "2024-01-02", "商品名": "商品B", "売上金額": 30000, "数量": 5},
    {"日付": "2024-01-03", "商品名": "商品A", "売上金額": 75000, "数量": 15},
    {"日付": "2024-01-04", "商品名": "商品C", "売上金額": 20000, "数量": 2},
    {"日付": "2024-01-05", "商品名": "商品B", "売上金額": 45000, "数量": 9},
    {"日付": "2024-01-06", "商品名": "商品A", "売上金額": 60000, "数量": 12},
    {"日付": "2024-01-07", "商品名": "商品D", "売上金額": 80000, "数量": 8},
]

def test_lambda_function():
    """Lambdaファンクションをローカルでテスト"""

    # テスト用のイベントデータ作成
    test_event = {
        "httpMethod": "POST",
        "body": json.dumps({
            "salesData": test_sales_data,
            "analysisType": "sales",
            "responseFormat": "json"
        }),
        "requestContext": {
            "http": {
                "method": "POST"
            }
        }
    }

    print("Lambda関数テスト開始...")
    print(f"テストデータ: {len(test_sales_data)}件の売上データ")
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

    print("実践的ビジネス改善AI Lambda関数 - ローカルテスト")
    print("=" * 60)
    test_lambda_function()