#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人事分析テスト用スクリプト
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

# 人事分析用テストデータ
test_hr_data = [
    {"社員ID": "E001", "氏名": "田中太郎", "部署": "営業部", "給与": 450000, "残業時間": 25},
    {"社員ID": "E002", "氏名": "佐藤花子", "部署": "IT部", "給与": 520000, "残業時間": 15},
    {"社員ID": "E003", "氏名": "山田次郎", "部署": "営業部", "給与": 380000, "残業時間": 35},
    {"社員ID": "E004", "氏名": "鈴木美穂", "部署": "人事部", "給与": 420000, "残業時間": 10},
    {"社員ID": "E005", "氏名": "高橋一郎", "部署": "IT部", "給与": 580000, "残業時間": 20},
]

def test_hr_analysis():
    """人事分析をテスト"""

    test_event = {
        "httpMethod": "POST",
        "body": json.dumps({
            "salesData": test_hr_data,
            "analysisType": "hr",
            "responseFormat": "json"
        }),
        "requestContext": {
            "http": {
                "method": "POST"
            }
        }
    }

    print("人事分析テスト開始...")
    print(f"テストデータ: {len(test_hr_data)}件の人事データ")
    print("=" * 60)

    try:
        result = lambda_handler(test_event, {})
        print("Lambda関数実行成功!")
        print(f"ステータスコード: {result['statusCode']}")

        if result['statusCode'] == 200:
            response_body = json.loads(result['body'])

            if 'response' in response_body and 'summary_ai' in response_body['response']:
                print("\n人事分析結果:")
                print("=" * 40)
                print(response_body['response']['summary_ai'])

            print("\n" + "=" * 60)
            print("人事分析完了！汎用システムとして動作確認済み")

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

    test_hr_analysis()