#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
単一分析タイプテスト用スクリプト
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

# 在庫分析用テストデータ
test_inventory_data = [
    {"商品コード": "P001", "商品名": "商品A", "在庫数": 150, "単価": 2500, "在庫金額": 375000},
    {"商品コード": "P002", "商品名": "商品B", "在庫数": 80, "単価": 1800, "在庫金額": 144000},
    {"商品コード": "P003", "商品名": "商品C", "在庫数": 200, "単価": 900, "在庫金額": 180000},
    {"商品コード": "P004", "商品名": "商品D", "在庫数": 50, "単価": 5000, "在庫金額": 250000},
    {"商品コード": "P005", "商品名": "商品E", "在庫数": 300, "単価": 600, "在庫金額": 180000},
]

def test_inventory_analysis():
    """在庫分析をテスト"""

    test_event = {
        "httpMethod": "POST",
        "body": json.dumps({
            "salesData": test_inventory_data,
            "analysisType": "inventory",
            "responseFormat": "json"
        }),
        "requestContext": {
            "http": {
                "method": "POST"
            }
        }
    }

    print("在庫分析テスト開始...")
    print(f"テストデータ: {len(test_inventory_data)}件の在庫データ")
    print("=" * 60)

    try:
        result = lambda_handler(test_event, {})
        print("Lambda関数実行成功!")
        print(f"ステータスコード: {result['statusCode']}")

        if result['statusCode'] == 200:
            response_body = json.loads(result['body'])

            if 'response' in response_body and 'summary_ai' in response_body['response']:
                print("\n在庫分析結果:")
                print("=" * 40)
                print(response_body['response']['summary_ai'])

            print("\n" + "=" * 60)
            print("在庫分析完了！汎用システムとして動作確認済み")

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

    test_inventory_analysis()