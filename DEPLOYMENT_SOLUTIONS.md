# SAP Strategic AI Platform - デプロイ問題解決ガイド

## 現在の状況
- ローカル環境: ✅ 完全動作
- Lambda API: ✅ DeepSeek R1正常動作
- Vercelデプロイ: ❌ 古いAPIエンドポイント使用問題

## 根本原因
Vercelの複雑なキャッシュ・DNS・CDN干渉により、新しいリポジトリでも過去の設定が影響

## 即座に試せる解決策

### 1. Netlify デプロイ (推奨)
```bash
# Netlifyアカウント作成
# https://netlify.com でサインアップ

# サイト作成
# 1. "Import from Git" 選択
# 2. GitHub: sap-strategic-ai-platform 選択
# 3. Build settings:
#    - Build command: npm run build
#    - Publish directory: dist
# 4. Environment variables:
#    - VITE_API_ENDPOINT: https://h6util56iwzeyadx6kbjyuakbi0zuucm.lambda-url.us-east-1.on.aws/
# 5. Deploy site
```

### 2. AWS Amplify デプロイ
```bash
# AWS Amplifyコンソール
# 1. "Host web app" 選択
# 2. GitHub連携
# 3. リポジトリ選択: sap-strategic-ai-platform
# 4. Build settings自動検出
# 5. Environment variables追加
# 6. Save and deploy
```

### 3. Cloudflare Pages
```bash
# Cloudflareアカウント作成
# 1. Pages → Create a project
# 2. Connect to Git → GitHub
# 3. Select repository: sap-strategic-ai-platform
# 4. Build settings:
#    - Framework: Vite
#    - Build command: npm run build
#    - Build output: dist
# 5. Environment variables設定
# 6. Save and deploy
```

## 各プラットフォームの利点

### Netlify
- ✅ 最も簡単
- ✅ 自動HTTPS
- ✅ 高速CDN
- ✅ GitHub連携簡単

### AWS Amplify
- ✅ AWS統合でLambdaと相性良い
- ✅ 同じAWSアカウント内で管理
- ✅ セキュリティ強化

### Cloudflare Pages
- ✅ 最高速CDN
- ✅ 無料プラン充実
- ✅ DDoS保護

## Vercel問題の技術的詳細

### 発生している問題
1. **DNS/CDN キャッシュ競合**
   - 削除したプロジェクトのルーティング情報が残存
   - 新プロジェクトが古い設定を継承

2. **ビルド時環境変数問題**
   - `VITE_API_ENDPOINT`が正しく設定されてもビルド時に反映されない
   - Vercelの環境変数とViteの変数システムの不整合

3. **デプロイメントID競合**
   - 内部的なプロジェクトIDが競合
   - 同一ユーザー内での名前空間汚染

### 一時的回避策
```typescript
// App.tsx内で強制的にLambda URL使用
const API_ENDPOINT = "https://h6util56iwzeyadx6kbjyuakbi0zuucm.lambda-url.us-east-1.on.aws/";
```

## 推奨行動計画

### Phase 1: 即座実行 (今日)
1. **Netlify**で緊急デプロイ実行
2. 動作確認とURL取得

### Phase 2: 中期対応 (今週)
1. AWS Amplifyでの正式デプロイ検討
2. Vercel問題の根本調査継続

### Phase 3: 長期対応 (来週以降)
1. デプロイプラットフォーム統一
2. CI/CD パイプライン構築

## 確認事項

### ✅ 動作確認済み
- ローカル環境: http://localhost:5179
- Lambda API直接テスト: 200 OK応答確認
- GitHub新リポジトリ: コミット履歴正常

### ❌ 問題継続中
- Vercelデプロイ: `/api/analysis` エンドポイント使用
- 環境変数: ビルド時に正しく反映されない
- キャッシュ: 複数回のクリア実行でも解決されず

## 結論

Vercelの問題は非常に稀で複雑です。最も確実な解決策は**別のデプロイプラットフォーム使用**です。
特に**Netlify**は設定が簡単で、即座に本番環境を構築できます。

## 次のアクション

**即座に実行**: Netlifyでのデプロイを開始してください。