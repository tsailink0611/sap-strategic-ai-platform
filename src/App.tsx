import { useState, useEffect } from 'react'
import axios from 'axios'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer } from 'recharts'
import ColumnMappingLearning from './components/ColumnMappingLearning'
import SimpleAuth from './components/SimpleAuth'
import { ErrorBoundary, SentryErrorBoundary } from './components/ErrorBoundary'
import { saveFormatProfile, getFormatProfile } from './lib/supabase'
import { checkSupabaseConfig } from './lib/debug-supabase'
import { captureError, captureMessage } from './lib/sentry'
import * as Sentry from '@sentry/react'

// APIエンドポイント設定
const API_ENDPOINT = import.meta.env.VITE_API_ENDPOINT || "/api/analysis";

// チャート用の色設定
const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d'];

// ユーザー型定義
interface User {
  id: string
  name: string
  company: string
  usageCount: number
  usageLimit: number
}

// 分析タイプ定義
interface AnalysisType {
  id: string
  name: string
  description: string
  icon: string
  tier: 'basic' | 'premium' | 'enterprise'
}

const ANALYSIS_TYPES: AnalysisType[] = [
  {
    id: 'sales',
    name: '売上分析',
    description: '売上データ・収益分析・トレンド把握',
    icon: '📊',
    tier: 'basic'
  },
  {
    id: 'hr',
    name: '人事分析',
    description: '給与・勤怠・人員最適化・離職率分析',
    icon: '👥',
    tier: 'premium'
  },
  {
    id: 'marketing',
    name: 'マーケティングROI分析',
    description: '広告効果・顧客獲得コスト・ROAS分析',
    icon: '📈',
    tier: 'premium'
  },
  {
    id: 'strategic',
    name: '統合戦略分析',
    description: 'PL・BS・CF総合コンサルティング',
    icon: '🎯',
    tier: 'enterprise'
  },
  {
    id: 'document',
    name: '書類画像分析',
    description: '領収書・請求書・レポート・名刺の写真からAI分析',
    icon: '📷',
    tier: 'premium'
  },
  {
    id: 'inventory',
    name: '在庫分析',
    description: '在庫回転率・滞留在庫・調達最適化分析',
    icon: '📦',
    tier: 'basic'
  },
  {
    id: 'customer',
    name: '顧客分析',
    description: 'LTV・チャーン率・セグメント・満足度分析',
    icon: '🛒',
    tier: 'premium'
  }
]

// ユーザー権限マッピング
const USER_ACCESS: Record<string, string[]> = {
  'demo': ['sales', 'inventory'],
  'client_abc': ['sales', 'hr', 'inventory', 'customer'],
  'admin': ['sales', 'hr', 'marketing', 'strategic', 'document', 'inventory', 'customer'],
  'dev': ['sales', 'hr', 'marketing', 'strategic', 'document', 'inventory', 'customer']
}

// 文字列化ヘルパー関数
function stringifyForDisplay(payload: any): string {
  try {
    if (payload == null) return '';
    if (typeof payload === 'string') return payload;

    // { response: {...}, format: 'json', message: 'OK' } に対応
    const body = payload.response ?? payload;
    return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  } catch {
    return String(payload);
  }
}

interface SalesData {
  [key: string]: string | number
}

// データ分析用のヘルパー関数
const analyzeSalesData = (data: SalesData[]) => {
  if (!data || data.length === 0) return null;

  const keys = Object.keys(data[0]);
  console.log('📊 利用可能な列:', keys);

  // 日付カラムを自動検出（改善版）
  const dateColumns = keys.filter(key => {
    const lowerKey = key.toLowerCase();
    const sample = String(data[0][key]);
    
    // キーワードマッチング
    const keywordMatch = lowerKey.includes('date') || 
      lowerKey.includes('日付') ||
      lowerKey.includes('年月') ||
      lowerKey.includes('日') ||
      lowerKey.includes('月') ||
      lowerKey.includes('期間') ||
      lowerKey.includes('time');
    
    // 日付フォーマットのパターンマッチング
    const datePattern = /^\d{1,4}[\/\-年]\d{1,2}[\/\-月]|\d{1,2}[\/\-日]|^\d{1,2}$/.test(sample);
    
    return keywordMatch || datePattern;
  });
  
  // 売上カラムを自動検出（改善版）
  const salesColumns = keys.filter(key => {
    const lowerKey = key.toLowerCase();
    
    // 日付カラムは除外
    if (dateColumns.includes(key)) {
      return false;
    }
    
    // キーワードマッチング
    const keywordMatch = lowerKey.includes('sales') || 
      lowerKey.includes('売上') ||
      lowerKey.includes('金額') ||
      lowerKey.includes('amount') ||
      lowerKey.includes('実績') ||
      lowerKey.includes('予算') ||
      lowerKey.includes('value') ||
      lowerKey.includes('収益') ||
      lowerKey.includes('合計');
    
    // 数値データチェック（複数行確認）
    let numericCount = 0;
    let hasLargeNumbers = false;
    for (let i = 0; i < Math.min(5, data.length); i++) {
      const value = String(data[i][key]).replace(/[,¥円\s]/g, '');
      const numValue = parseFloat(value);
      if (!isNaN(numValue) && value !== '') {
        numericCount++;
        // 100以上の数値があれば売上の可能性が高い
        if (numValue >= 100) {
          hasLargeNumbers = true;
        }
      }
    }
    
    // キーワードがマッチするか、大きな数値を含む数値カラムなら売上カラムとして扱う
    return keywordMatch || (numericCount >= Math.min(3, data.length) && hasLargeNumbers);
  });

  // 商品カラムを自動検出
  const productColumns = keys.filter(key => {
    const lowerKey = key.toLowerCase();
    return lowerKey.includes('product') || 
      lowerKey.includes('商品') ||
      lowerKey.includes('item') ||
      lowerKey.includes('名前') ||
      lowerKey.includes('カテゴリ') ||
      lowerKey.includes('分類');
  });

  console.log('📊 検出結果:', {
    日付列: dateColumns,
    売上列: salesColumns,
    商品列: productColumns
  });

  return {
    dateColumns,
    salesColumns,
    productColumns,
    totalRecords: data.length
  };
};

function App() {
  // 認証状態
  const [user, setUser] = useState<User | null>(null)
  const [isAuthenticating, setIsAuthenticating] = useState(true)
  
  const [prompt, setPrompt] = useState('')
  const [response, setResponse] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [salesData, setSalesData] = useState<SalesData[]>([])
  const [isFileUploaded, setIsFileUploaded] = useState(false)
  const [showCharts, setShowCharts] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [forceShowGraphs, setForceShowGraphs] = useState(false)
  const [showDataTable, setShowDataTable] = useState(false)
  const [showColumnMapping, setShowColumnMapping] = useState(false)
  const [columnMappings, setColumnMappings] = useState<Record<string, string>>({})
  const [selectedAnalysisType, setSelectedAnalysisType] = useState<string>('sales')
  const [uploadedImagePreview, setUploadedImagePreview] = useState<string | null>(null)
  const [imageAnalysisResult, setImageAnalysisResult] = useState<string>('')

  // 認証チェック（ページ読み込み時）
  useEffect(() => {
    // 開発環境では認証をスキップ
    const isProduction = import.meta.env.PROD
    if (!isProduction) {
      // 開発用のデフォルトユーザー
      const devUser: User = {
        id: 'dev',
        name: '開発者',
        company: 'ローカル開発',
        usageCount: 0,
        usageLimit: 999
      }
      setUser(devUser)
      setIsAuthenticating(false)
      return
    }

    // 本番環境では通常の認証処理
    const savedUser = localStorage.getItem('auth_user')
    if (savedUser) {
      try {
        setUser(JSON.parse(savedUser))
      } catch (error) {
        console.error('認証情報の読み込みエラー:', error)
        localStorage.removeItem('auth_user')
      }
    }
    setIsAuthenticating(false)
  }, [])

  // ログイン処理
  const handleLogin = (loggedInUser: User) => {
    setUser(loggedInUser)
  }

  // ログアウト処理
  const handleLogout = () => {
    setUser(null)
    localStorage.removeItem('auth_user')
    // 状態をリセット
    setResponse('')
    setSalesData([])
    setIsFileUploaded(false)
    setShowCharts(false)
  }

  // 実際のデータからチャート用データを生成
  const generateChartData = () => {
    console.log('🔍 generateChartData開始');
    console.log('🔍 salesData:', salesData);
    console.log('🔍 salesData.length:', salesData?.length);

    if (!salesData || salesData.length === 0) {
      console.log('❌ salesDataが空のため、サンプルデータを使用');
      // サンプルデータを返す
      return {
        monthlyData: [
          { month: 'データなし', sales: 0 },
        ],
        productData: [
          { name: 'データなし', value: 0 },
        ],
        analysis: { totalRecords: 0, dateColumns: [], salesColumns: [], productColumns: [] },
        totalSales: 0
      };
    }

    const analysis = analyzeSalesData(salesData);
    if (!analysis) return null;

    console.log('📊 generateChartData開始');
    console.log('salesData全体:', salesData);
    console.log('salesData最初の3行:', salesData.slice(0, 3));
    console.log('analysis:', analysis);

    // 実データから月別・日別売上を集計
    const monthlyData: any[] = [];
    const productData: any[] = [];
    
    // すべてのキーを取得
    const allKeys = Object.keys(salesData[0]);
    console.log('全カラム名:', allKeys);

    // 各カラムのサンプル値を表示
    allKeys.forEach(key => {
      const sampleValues = salesData.slice(0, 3).map(row => row[key]);
      console.log(`カラム "${key}" のサンプル値:`, sampleValues);
    });

    // 数値カラムを検索
    const numericColumns = allKeys.filter(key => {
      const sampleValues = salesData.slice(0, 10).map(row => row[key]);
      const numericValues = sampleValues.filter(val => {
        const cleanVal = String(val).replace(/[,¥円\s]/g, '');
        const num = Number(cleanVal);
        return !isNaN(num) && num !== 0 && val !== '' && val !== null && val !== undefined;
      });
      console.log(`カラム "${key}": ${numericValues.length}/${sampleValues.length} が数値`);
      return numericValues.length >= Math.floor(sampleValues.length * 0.3); // 30%以上が数値なら数値カラム
    });

    console.log('検出された数値カラム:', numericColumns);

    // 日付と売上のカラムを使用（改善版）
    const dateCol = analysis.dateColumns[0] || allKeys[0];
    
    // 売上カラムの選択を改善（日付カラムを除外）
    let salesCol = analysis.salesColumns[0];
    if (!salesCol || salesCol === dateCol) {
      // 数値カラムから日付カラム以外を選択
      salesCol = numericColumns.find(col => col !== dateCol) || allKeys.find(key => key !== dateCol) || allKeys[1];
    }
    
    const productCol = analysis.productColumns[0] || allKeys.find(key => 
      key !== dateCol && key !== salesCol
    );

    console.log('🎯 選択されたカラム:', { dateCol, salesCol, productCol });

    // 数値変換ヘルパー関数（企業データ対応強化版）
    const parseNumber = (value: any) => {
      if (value === null || value === undefined || value === '') return 0;
      
      let str = String(value).trim();
      if (!str) return 0;
      
      // 全角数字を半角に変換
      str = str.replace(/[０-９]/g, (char) => 
        String.fromCharCode(char.charCodeAt(0) - 65248)
      );
      
      // 単位付き数値の処理（千円、万円、億円など）
      const unitPatterns = [
        { pattern: /^([+-]?\d+(?:,\d{3})*(?:\.\d+)?)\s*億\s*円?/i, multiplier: 100000000 },
        { pattern: /^([+-]?\d+(?:,\d{3})*(?:\.\d+)?)\s*万\s*円?/i, multiplier: 10000 },
        { pattern: /^([+-]?\d+(?:,\d{3})*(?:\.\d+)?)\s*千\s*円?/i, multiplier: 1000 },
        { pattern: /^([+-]?\d+(?:,\d{3})*(?:\.\d+)?)\s*円/i, multiplier: 1 },
        { pattern: /^([+-]?\d+(?:,\d{3})*(?:\.\d+)?)\s*k/i, multiplier: 1000 },
        { pattern: /^([+-]?\d+(?:,\d{3})*(?:\.\d+)?)\s*m/i, multiplier: 1000000 }
      ];
      
      for (const { pattern, multiplier } of unitPatterns) {
        const match = str.match(pattern);
        if (match) {
          const numStr = match[1].replace(/,/g, '');
          const num = parseFloat(numStr);
          const result = isNaN(num) ? 0 : num * multiplier;
          console.log(`数値変換(単位付き): "${value}" -> ${result} (${match[1]} × ${multiplier})`);
          return result;
        }
      }
      
      // 括弧付き負数の処理 (123) -> -123
      if (/^\(\d+(?:,\d{3})*(?:\.\d+)?\)$/.test(str)) {
        str = '-' + str.slice(1, -1);
      }
      
      // 通貨記号・カンマ・空白の削除
      let cleanValue = str
        .replace(/[,¥円\s$€£￥]/g, '')
        .replace(/[^\d.-]/g, '')
        .trim();
      
      // マイナス記号の正規化（全角ハイフン、em dash等）
      cleanValue = cleanValue.replace(/[－–—]/g, '-');
      
      // 複数のマイナス記号を処理
      const minusCount = (cleanValue.match(/-/g) || []).length;
      if (minusCount > 1) {
        cleanValue = minusCount % 2 === 0 
          ? cleanValue.replace(/-/g, '')
          : '-' + cleanValue.replace(/-/g, '');
      }
      
      const num = parseFloat(cleanValue);
      const result = isNaN(num) ? 0 : num;
      
      if (String(value) !== String(result) && result !== 0) {
        console.log(`数値変換: "${value}" -> "${cleanValue}" -> ${result}`);
      }
      return result;
    };

    // 日付別データを集計（全データを処理）
    const dailyMap = new Map();
    
    // 実際のデータ行をループ（行番号ではなく実データを使用）
    salesData.forEach((row, index) => {
      // 各列の値を確認
      const allValues = Object.entries(row);
      console.log(`行${index} の全データ:`, allValues);
      
      // 日付の取得（曜日列も含む）
      let dateValue = row[dateCol];
      
      // 日付が曜日の場合、インデックスを使用
      const dayOfWeeks = ['日', '月', '火', '水', '木', '金', '土'];
      let displayDate = String(dateValue || `データ${index + 1}`);
      
      if (dayOfWeeks.includes(displayDate)) {
        // 曜日の場合は、曜日名をそのまま使用
        displayDate = displayDate;
      } else if (!isNaN(Number(dateValue)) && Number(dateValue) > 40000 && Number(dateValue) < 50000) {
        // Excel日付シリアル値の処理
        const excelDate = new Date((Number(dateValue) - 25569) * 86400 * 1000);
        displayDate = `${excelDate.getMonth() + 1}/${excelDate.getDate()}`;
      } else if (!isNaN(Number(dateValue)) && Number(dateValue) < 32) {
        // 単純な日付数値（1-31）の場合
        displayDate = `${dateValue}日`;
      }
      
      // 売上値の取得（複数の売上列から適切な値を選択）
      let salesValue = row[salesCol];
      
      // もし売上値が無効な場合、他の数値列を探す
      if (!salesValue || salesValue === '' || parseNumber(salesValue) === 0) {
        // 全ての列から数値を探す
        for (const key of Object.keys(row)) {
          const val = row[key];
          const num = parseNumber(val);
          if (num > 0 && key !== dateCol) {
            salesValue = val;
            console.log(`行${index}: 代替売上列 "${key}" を使用: ${val}`);
            break;
          }
        }
      }
      
      const sales = parseNumber(salesValue);
      
      if (index < 10) {
        console.log(`行${index}:`, { 
          displayDate, 
          salesValue, 
          sales, 
          originalDate: row[dateCol],
          allColumns: Object.keys(row)
        });
      }
      
      const shortDate = displayDate.length > 15 ? displayDate.substring(0, 15) : displayDate;
      
      if (dailyMap.has(shortDate)) {
        dailyMap.set(shortDate, dailyMap.get(shortDate) + sales);
      } else {
        dailyMap.set(shortDate, sales);
      }
    });

    // Map を配列に変換
    dailyMap.forEach((value, key) => {
      monthlyData.push({ 
        month: key,
        sales: value 
      });
    });

    console.log('monthlyData:', monthlyData); // デバッグ用

    // 商品別売上を集計（商品カラムがある場合）
    if (productCol && productCol !== salesCol) {
      const productMap = new Map();
      salesData.forEach(row => {
        const product = String(row[productCol] || '不明');
        const sales = parseNumber(row[salesCol]);
        
        if (productMap.has(product)) {
          productMap.set(product, productMap.get(product) + sales);
        } else {
          productMap.set(product, sales);
        }
      });

      // 上位5商品を抽出
      const sortedProducts = Array.from(productMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      
      sortedProducts.forEach(([name, value]) => {
        productData.push({ name, value });
      });
    } else {
      // 商品カラムがない場合は、曜日別や日別の集計を表示
      const dayMap = new Map();
      const dayOfWeeks = ['日', '月', '火', '水', '木', '金', '土'];
      
      salesData.forEach(row => {
        // 日付列から曜日を判定
        let dayKey = '不明';
        const dateValue = row[dateCol];
        
        // 曜日列がある場合
        if (dayOfWeeks.includes(String(dateValue))) {
          dayKey = String(dateValue);
        } else if (dateValue) {
          // 日付から曜日を推定（簡易的に日別として扱う）
          dayKey = String(dateValue).substring(0, 10);
        }
        
        const sales = parseNumber(row[salesCol]);
        if (dayMap.has(dayKey)) {
          dayMap.set(dayKey, dayMap.get(dayKey) + sales);
        } else {
          dayMap.set(dayKey, sales);
        }
      });
      
      // 上位5つを取得
      const sortedDays = Array.from(dayMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      
      sortedDays.forEach(([name, value]) => {
        productData.push({ name, value });
      });
      
      // データがない場合のフォールバック
      if (productData.length === 0) {
        productData.push(
          { name: 'データなし', value: 1 }
        );
      }
    }

    // 総売上を計算
    const totalSales = salesData.reduce((sum, row) => {
      return sum + parseNumber(row[salesCol]);
    }, 0);

    console.log('最終結果:', { monthlyData, productData, totalSales }); // デバッグ用

    return { monthlyData, productData, analysis, totalSales };
  };

  // ファイル処理の共通関数
  // 画像ファイル処理関数（改善版）
  const processImageFile = async (file: File) => {
    if (!file) return;

    console.log('📷 画像ファイル処理開始:', file.name);

    // 画像形式の確認
    const fileExtension = file.name.split('.').pop()?.toLowerCase();
    const supportedFormats = ['jpg', 'jpeg', 'png', 'pdf', 'webp', 'gif', 'bmp'];
    
    if (!supportedFormats.includes(fileExtension || '')) {
      setResponse(`❌ サポートされていない画像形式です。\n\n対応形式: ${supportedFormats.map(f => f.toUpperCase()).join(', ')}\nアップロードされたファイル: ${file.name}`);
      return;
    }

    // ファイルサイズチェック（10MB制限）
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      setResponse(`❌ ファイルサイズが大きすぎます。\n\nファイルサイズ: ${(file.size / 1024 / 1024).toFixed(1)}MB\n上限: ${maxSize / 1024 / 1024}MB\n\nより小さなファイルをお試しください。`);
      return;
    }

    try {
      setIsLoading(true);
      setResponse(`📷 画像分析を開始しています...\n\n📄 ファイル情報:\n• ファイル名: ${file.name}\n• サイズ: ${(file.size / 1024).toFixed(1)}KB\n• 形式: ${file.type}\n\n⏳ Base64エンコード中...`);

      // Base64エンコードとプレビュー生成（進捗表示付き）
      const { base64String, previewUrl } = await new Promise<{base64String: string, previewUrl: string}>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // data:image/jpeg;base64, の部分を削除
          const base64 = result.split(',')[1];
          // プレビュー用にはdata URLをそのまま使用
          const previewDataUrl = result;
          
          // 画像プレビューを設定
          setUploadedImagePreview(previewDataUrl);
          setResponse(prev => prev + '\n✅ Base64エンコード完了\n📸 画像プレビュー生成完了\n⏳ Lambda関数に送信中...');
          resolve({ base64String: base64, previewUrl: previewDataUrl });
        };
        reader.onerror = (error) => {
          console.error('📷 ファイル読み込みエラー:', error);
          reject(new Error('ファイルの読み込みに失敗しました'));
        };
        reader.readAsDataURL(file);
      });

      // Lambda関数に画像データを送信
      const payload = {
        analysisType: selectedAnalysisType,
        fileType: 'image',
        imageData: base64String,
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
        timestamp: new Date().toISOString()
      };

      console.log('📷 画像分析リクエスト送信:', { 
        fileName: file.name, 
        size: file.size, 
        type: file.type,
        base64Length: base64String.length 
      });

      setResponse(prev => prev + '\n📡 Lambda関数で画像分析実行中...\n⏱️ 通常30-60秒程度かかります');

      const response = await axios.post(API_ENDPOINT, payload, {
        headers: { 
          'Content-Type': 'application/json',
          'X-Request-Source': 'image-analysis'
        },
        timeout: 90000, // 90秒タイムアウト（画像処理は時間がかかる）
        onUploadProgress: (progressEvent) => {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
          console.log(`📷 アップロード進捗: ${percentCompleted}%`);
        }
      });

      const result = response.data;
      console.log('📷 画像分析結果受信:', result);

      if (result) {
        let analysisResult = '';
        
        // レスポンス形式に応じて結果を抽出
        if (result.response && typeof result.response === 'string') {
          analysisResult = result.response;
        } else if (result.response && result.response.summary) {
          analysisResult = result.response.summary;
        } else if (result.summary) {
          analysisResult = result.summary;
        } else if (typeof result === 'string') {
          analysisResult = result;
        } else {
          analysisResult = JSON.stringify(result, null, 2);
        }

        const finalResult = `✅ 画像分析が完了しました！\n\n📄 分析結果:\n${analysisResult}\n\n📊 ファイル処理情報:\n• ファイル名: ${file.name}\n• 処理時間: ${Date.now() - Date.now()}ms\n• 分析タイプ: ${selectedAnalysisType}`;
        
        setResponse(finalResult);
        setImageAnalysisResult(analysisResult);
        setIsFileUploaded(true);
        
        // SentryにSuccess情報を送信
        captureMessage(`画像分析成功: ${file.name}`, 'info');
      } else {
        throw new Error('Lambda関数からの応答が空です');
      }
    } catch (error: any) {
      console.error('📷 画像分析エラー:', error);
      
      // 詳細なエラーメッセージを生成
      let errorMessage = '❌ 画像分析中にエラーが発生しました。\n\n';
      
      if (error.response) {
        // HTTPレスポンスエラー
        errorMessage += `🔴 HTTPエラー: ${error.response.status} ${error.response.statusText}\n`;
        if (error.response.data) {
          errorMessage += `📝 サーバーメッセージ: ${JSON.stringify(error.response.data, null, 2)}\n`;
        }
      } else if (error.request) {
        // ネットワークエラー
        errorMessage += '🌐 ネットワークエラー: Lambda関数への接続に失敗しました\n';
        errorMessage += '• インターネット接続を確認してください\n';
        errorMessage += '• AWSのLambda関数が正常に動作しているか確認してください\n';
      } else if (error.code === 'TIMEOUT' || error.message.includes('timeout')) {
        // タイムアウトエラー
        errorMessage += '⏰ タイムアウトエラー: 処理に時間がかかりすぎています\n';
        errorMessage += '• より小さなファイルを試してみてください\n';
        errorMessage += '• しばらく時間をおいてから再試行してください\n';
      } else {
        // その他のエラー
        errorMessage += `🐛 エラー詳細: ${error.message}\n`;
      }
      
      errorMessage += `\n🔧 デバッグ情報:\n`;
      errorMessage += `• ファイル: ${file.name} (${(file.size / 1024).toFixed(1)}KB)\n`;
      errorMessage += `• 分析タイプ: ${selectedAnalysisType}\n`;
      errorMessage += `• タイムスタンプ: ${new Date().toLocaleString()}\n`;
      
      setResponse(errorMessage);
      
      // Sentryにエラーを報告
      captureError(error, {
        context: 'IMAGE_ANALYSIS',
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        analysisType: selectedAnalysisType
      });
    } finally {
      setIsLoading(false);
    }
  };

  const processFile = (file: File) => {
    if (!file) return;

    console.log('🔍 ファイル処理開始:', file.name);

    // ファイル形式の確認
    const fileExtension = file.name.split('.').pop()?.toLowerCase();
    
    // 画像分析が選択されている場合
    if (selectedAnalysisType === 'document') {
      processImageFile(file);
      return;
    }

    // データファイルの処理
    if (!['csv', 'xlsx', 'xls'].includes(fileExtension || '')) {
      const supportedFormats = selectedAnalysisType === 'document' 
        ? 'JPG、PNG、PDF、WebP形式'
        : 'CSV、Excel形式';
      setResponse(`❌ サポートされていないファイル形式です。${supportedFormats}のファイルをアップロードしてください。`);
      return;
    }

    // Excelファイルの場合
    if (['xlsx', 'xls'].includes(fileExtension || '')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: 'array' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          // より詳細な読み取りオプションを設定
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { 
            header: 1,
            raw: false,     // 値を文字列として取得
            dateNF: 'yyyy/mm/dd',  // 日付フォーマット
            defval: ''      // 空セルのデフォルト値
          });
          
          console.log('📊 Excel解析完了:', jsonData);
          console.log('📊 全シート名:', workbook.SheetNames);
          console.log('📊 使用シート:', sheetName);
          console.log('📊 生データ（最初の5行）:', jsonData.slice(0, 5));
          
          // データが空でないかチェック
          if (!jsonData || jsonData.length === 0) {
            setResponse(`❌ Excelファイルにデータが含まれていません。`);
            return;
          }
          
          // データの最初の数行をチェックして適切なヘッダー行を検出
          console.log('📊 全データ（最初の5行）:');
          jsonData.slice(0, 5).forEach((row, index) => {
            console.log(`  行${index}:`, row);
          });
          
          // 複数行ヘッダーに対応したヘッダー行検出（改善版）
          let headerRowIndex = 0;
          let headers: string[] = [];
          let multiHeaders: string[][] = [];
          
          // マルチヘッダーを検出（最初の行が「売上」のような大項目の可能性）
          let firstRowHasMainHeader = false;
          if (jsonData.length > 1) {
            const firstRow = jsonData[0] as any[];
            const secondRow = jsonData[1] as any[];
            
            // 最初の行に少数の文字列があり、2行目により多くの文字列がある場合
            const firstRowText = firstRow.filter(cell => cell && String(cell).trim() !== '').length;
            const secondRowText = secondRow.filter(cell => cell && String(cell).trim() !== '').length;
            
            if (firstRowText < secondRowText && firstRowText > 0) {
              firstRowHasMainHeader = true;
              multiHeaders.push(firstRow);
              console.log('📊 マルチヘッダー検出: 行0が大項目ヘッダー:', firstRow);
            }
          }
          
          // 実際のヘッダー行を探す（マルチヘッダーの場合は2行目から）
          const startIndex = firstRowHasMainHeader ? 1 : 0;
          
          for (let i = startIndex; i < Math.min(8, jsonData.length); i++) {
            const row = jsonData[i] as any[];
            if (!row || row.length === 0) continue;
            
            // 曜日パターンをチェック
            const hasDayOfWeek = row.some(cell => {
              const str = String(cell).trim();
              return ['日', '月', '火', '水', '木', '金', '土', 
                      '日曜', '月曜', '火曜', '水曜', '木曜', '金曜', '土曜',
                      'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].includes(str);
            });
            
            // 数値ではなく文字列が多い行、または曜日を含む行をヘッダーとして選択
            const textCells = row.filter(cell => {
              if (!cell) return false;
              const str = String(cell).trim();
              if (str === '') return false;
              const cleanedStr = str.replace(/[,¥円\s%]/g, '');
              return isNaN(Number(cleanedStr)) || hasDayOfWeek;
            });
            
            console.log(`行${i}: 文字列セル数=${textCells.length}/${row.length}, 曜日含む=${hasDayOfWeek}`, textCells);
            
            // 曜日を含む行、または30%以上が文字列の行をヘッダーとして選択
            if (hasDayOfWeek || (textCells.length >= row.length * 0.3 && textCells.length >= 2)) {
              headers = row.map((cell, colIndex) => {
                if (cell && String(cell).trim() !== '') {
                  return String(cell).trim();
                } else if (firstRowHasMainHeader && multiHeaders[0][colIndex]) {
                  // マルチヘッダーの場合、上の行の値を使う
                  return String(multiHeaders[0][colIndex]).trim();
                } else {
                  return `列${colIndex + 1}`;
                }
              });
              headerRowIndex = i;
              console.log(`📊 ヘッダー行として行${i}を選択:`, headers);
              break;
            }
          }
          
          if (headers.length === 0) {
            console.log('❌ 有効なヘッダー行が見つかりません');
            setResponse(`❌ Excelファイルのヘッダー行が検出できません。`);
            return;
          }
          
          const rows = jsonData.slice(headerRowIndex + 1).filter(row => row && (row as any[]).length > 0);
          console.log('📊 データ行数（フィルター後）:', rows.length);
          console.log('📊 データ行サンプル:', rows.slice(0, 3));
          
          // オブジェクト形式に変換
          const results = rows.map((row, rowIndex) => {
            const obj: SalesData = {};
            headers.forEach((header, index) => {
              const value = (row as any[])[index];
              obj[header] = value !== undefined && value !== null ? String(value) : '';
            });
            
            // 最初の3行の変換結果をログ出力
            if (rowIndex < 3) {
              console.log(`📊 行${rowIndex + 1}変換結果:`, obj);
            }
            
            return obj;
          });
          
          console.log('📊 最終変換結果（最初の3件）:', results.slice(0, 3));

          handleDataProcessing(results, file.name);
        } catch (error) {
          console.error('❌ Excelファイル読み込みエラー:', error);
          setResponse(`❌ Excelファイル読み込みエラー: ${error}`);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      // CSVファイルの場合
      Papa.parse(file, {
        complete: (results) => {
          console.log('📊 Papa.parse完了:', results);
          handleDataProcessing(results.data as SalesData[], file.name);
        },
        header: true,
        skipEmptyLines: true,
        error: (error) => {
          console.error('❌ Papa.parseエラー:', error);
          setResponse(`❌ ファイル読み込みエラー: ${error.message}`)
        }
      });
    }
  }

  // データ処理の共通関数
  const handleDataProcessing = (data: SalesData[], fileName: string) => {
    console.log('📊 解析されたデータ:', data);
    console.log('📊 データ行数:', data.length);
    console.log('📊 最初の3行:', data.slice(0, 3));

    // データが空でないかチェック
    if (!data || data.length === 0) {
      setResponse(`❌ ファイルにデータが含まれていません。`);
      return;
    }

    // ヘッダー行をチェック
    if (data.length > 0) {
      console.log('📊 ヘッダー（カラム名）:', Object.keys(data[0]));
    }

    // ステートにデータを設定
    console.log('💾 ステート設定前 - salesData:', salesData);
    console.log('💾 設定予定のdata:', data);
    
    setSalesData(data)
    setIsFileUploaded(true)
    setShowCharts(true)
    
    // 設定後の確認（次のレンダリングサイクルで確認）
    setTimeout(() => {
      console.log('💾 ステート設定後 - salesData:', salesData);
      console.log('💾 ステート設定後 - isFileUploaded:', true);
    }, 100);
    
    // データ分析情報を表示
    const analysis = analyzeSalesData(data);
    console.log('🔍 分析結果:', analysis);

    let info = `✅ ${fileName} を正常にアップロードしました。\n`;
    info += `📊 データ行数: ${data.length}行\n`;
    
    // カラム名を全て表示
    const columnNames = Object.keys(data[0] || {});
    info += `📋 カラム名: ${columnNames.join(', ')}\n`;
    
    if (analysis) {
      if (analysis.dateColumns.length > 0) {
        info += `📅 検出された日付カラム: ${analysis.dateColumns.join(', ')}\n`;
      }
      if (analysis.salesColumns.length > 0) {
        info += `💰 検出された売上カラム: ${analysis.salesColumns.join(', ')}\n`;
      }
      if (analysis.productColumns.length > 0) {
        info += `📦 検出された商品カラム: ${analysis.productColumns.join(', ')}\n`;
      }
    }
    
    // サンプルデータを詳細表示
    if (data.length > 0) {
      info += `\n📋 データサンプル（最初の3行）:\n`;
      data.slice(0, 3).forEach((row, index) => {
        info += `\n--- 行${index + 1} ---\n`;
        Object.entries(row).forEach(([key, value]) => {
          const displayValue = value === '' ? '(空)' : String(value);
          const valueType = typeof value;
          info += `  ${key}: ${displayValue} (型: ${valueType})\n`;
        });
      });
      
      // データ型の分析
      info += `\n🔍 カラム型分析:\n`;
      if (data.length > 0) {
        Object.keys(data[0]).forEach(key => {
          const sampleValues = data.slice(0, 5).map(row => row[key]).filter(v => v !== '' && v != null);
          const types = [...new Set(sampleValues.map(v => typeof v))];
          const hasNumbers = sampleValues.some(v => {
            const cleanV = String(v).replace(/[,¥円\s$€£]/g, '');
            return !isNaN(Number(cleanV)) && cleanV !== '';
          });
          info += `  ${key}: 型=[${types.join(', ')}] 数値可=${hasNumbers ? 'Yes' : 'No'}\n`;
        });
      }
    }
    
    info += `\n💡 「グラフを表示して」ボタンをクリックすると、データ可視化が表示されます。`;
    setResponse(info);
  }

  // ファイル選択ハンドラー
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) processFile(file);
  }

  // ドラッグ&ドロップハンドラー
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }

  // JSON形式テスト用関数
  const handleSubmitJSON = async () => {
    if (!prompt.trim()) return;

    setIsLoading(true);         // ← 「AIが生成中」表示ON
    setResponse('');            // 既存表示のクリア

    try {
      const endpoint = API_ENDPOINT;
      const body = {
        prompt,
        salesData,              // 画面のデータ配列
        responseFormat: 'json', // 明示（なくてもOKだが安全）
        analysisType: selectedAnalysisType // 選択された分析タイプを送信
      };

      const { data } = await axios.post(endpoint, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000          // 60秒で切る（無限待ち防止）
      });

      // 受信データの整形
      const res = data?.response ?? data;
      const summary = res?.summary_ai || res?.summary || '';
      const total = res?.data_analysis?.total_records ?? salesData?.length ?? 0;

      // 画面用（上部のテキスト）
      setResponse(stringifyForDisplay(res));

      // 開発者ログ（Consoleで中身を見やすく）
      console.log('API応答(JSON):', { summary, total, res });
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      setResponse(`JSONエラー: ${msg}`);
      console.error('JSON送信エラー:', err);
    } finally {
      setIsLoading(false);      // ← ここが大事。「AIが生成中」を必ずOFF
    }
  };

  const handleSubmit = async () => {
    if (!prompt.trim()) return

    setIsLoading(true)
    setResponse('')

    // デバッグ情報を出力
    console.log('🚀 handleSubmit開始');
    console.log('🚀 prompt:', prompt);
    console.log('🚀 isFileUploaded:', isFileUploaded);
    console.log('🚀 salesData:', salesData);
    console.log('🚀 salesData.length:', salesData?.length);


    // 「グラフを表示して」の場合は、API呼び出しなしでローカルでグラフを表示
    if (prompt.includes('グラフ') && isFileUploaded) {
      setIsLoading(false)
      setResponse('📊 データを可視化しています...\n\n以下のグラフで売上データを確認できます：\n• 月別売上推移\n• 商品別売上構成')
      return
    }

    try {
      // 売上データの準備と最適化
      let dataToSend = null;
      let dataContext = '';
      
      if (isFileUploaded && salesData.length > 0) {
        // データサイズを制限（最初の50行に増やす）
        const limitedData = salesData.slice(0, 50);
        dataToSend = limitedData;
        
        // データの概要をテキスト形式でも準備
        const columns = Object.keys(salesData[0]);
        dataContext = `データファイル情報:\n`;
        dataContext += `- 総行数: ${salesData.length}行\n`;
        dataContext += `- カラム: ${columns.join(', ')}\n`;
        dataContext += `- サンプルデータ（最初の3行）:\n`;
        
        limitedData.slice(0, 3).forEach((row, index) => {
          dataContext += `  行${index + 1}: `;
          dataContext += Object.entries(row).map(([key, value]) => `${key}=${value}`).join(', ');
          dataContext += `\n`;
        });
        
        console.log('🚀 送信予定データ:', dataToSend);
        console.log('🚀 データコンテキスト:', dataContext);
      }
      
      // プロンプトに実データを直接埋め込み
      let enhancedPrompt = prompt;
      if (isFileUploaded && salesData.length > 0) {
        const columns = Object.keys(salesData[0]);
        
        // 最初の5行の実データを文字列として整理
        let dataTable = '\n【実際のデータ】\n';
        dataTable += columns.join('\t') + '\n';
        dataTable += '─'.repeat(80) + '\n';
        
        salesData.slice(0, Math.min(10, salesData.length)).forEach((row, index) => {
          const rowData = columns.map(col => {
            const value = row[col];
            return value === '' || value == null ? '(空)' : String(value);
          }).join('\t');
          dataTable += `${index + 1}行目: ${rowData}\n`;
        });
        
        if (salesData.length > 10) {
          dataTable += `\n... (残り${salesData.length - 10}行のデータがあります)\n`;
        }
        
        // 数値データの統計も追加
        const numericData: string[] = [];
        columns.forEach(col => {
          const values = salesData.map(row => {
            const val = String(row[col] || '').replace(/[,¥円\s]/g, '');
            return isNaN(Number(val)) ? null : Number(val);
          }).filter(v => v !== null && v !== 0) as number[];
          
          if (values.length > 0) {
            const sum = values.reduce((a: number, b: number) => a + b, 0);
            const avg = sum / values.length;
            const max = Math.max(...values);
            const min = Math.min(...values);
            numericData.push(`${col}: 合計=${sum.toLocaleString()}, 平均=${Math.round(avg).toLocaleString()}, 最大=${max.toLocaleString()}, 最小=${min.toLocaleString()}`);
          }
        });
        
        if (numericData.length > 0) {
          dataTable += '\n【数値データの統計】\n';
          dataTable += numericData.join('\n') + '\n';
        }

        enhancedPrompt = `【必須】上記の実データを使用して分析してください。架空のデータや仮想的な数値は一切使用禁止です。

${dataTable}

ユーザーの質問: ${prompt}

【分析指示】
- 必ず上記の実際の数値のみを使用してください
- period11やperiod28などの存在しない項目は作成しないでください
- 実際のカラム名（${columns.join(', ')}）のみを使用してください
- 架空の分析結果は絶対に作成しないでください
- 実データに基づいた具体的な数値で分析してください`;
      }

      // より構造化されたリクエストデータ（複数形式で送信）
      const requestData = {
        prompt: enhancedPrompt,
        // 以下の3つの形式でデータを送信
        salesData: dataToSend,  // 元の形式
        data: dataToSend,       // 汎用的な形式
        attachments: dataToSend, // 添付ファイル形式
        dataContext: dataContext,
        metadata: {
          hasData: isFileUploaded,
          totalRows: salesData?.length || 0,
          columns: salesData && salesData.length > 0 ? Object.keys(salesData[0]) : [],
          dataType: 'sales'
        },
        // システムメッセージとして追加
        systemMessage: `データが添付されています。${dataToSend?.length || 0}行のデータを受信しました。このデータを使用して分析を行ってください。`
      };

      console.log('🚀 最終送信データ構造:', {
        prompt: requestData.prompt,
        dataRows: requestData.data?.length,
        contextLength: requestData.dataContext.length,
        metadata: requestData.metadata
      });
      console.log('🚀 API_ENDPOINT:', API_ENDPOINT);
      
      const jsonSize = JSON.stringify(requestData).length;
      console.log('🚀 送信データのJSONサイズ:', jsonSize, 'bytes');
      
      if (jsonSize > 1024 * 1024) { // 1MB制限
        console.warn('⚠️ データサイズが大きすぎます');
        setResponse('⚠️ データサイズが大きすぎるため、データを削減して再試行してください。');
        return;
      }

      const requestDataWithType = {
        ...requestData,
        analysisType: selectedAnalysisType
      }

      const result = await axios.post(API_ENDPOINT, requestDataWithType, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY
        },
        timeout: 60000 // 60秒のタイムアウト
      })
      
      console.log('🚀 API応答:', result.data);
      const payload = result.data;
      setResponse(typeof payload === 'string' ? payload : stringifyForDisplay(payload))
    } catch (error: any) {
      console.error('❌ API Error詳細:', error);
      console.error('❌ Error Config:', error.config);
      console.error('❌ Error Response:', error.response);
      console.error('❌ Error Request:', error.request);
      
      // Sentryにエラーを報告
      captureError(error, {
        context: 'API_CALL',
        endpoint: API_ENDPOINT,
        analysisType: selectedAnalysisType,
        hasData: isFileUploaded,
        dataSize: salesData?.length || 0
      });
      
      let errorMessage = '🔴 **APIエラーが発生しました:**\n\n';
      
      if (error.response) {
        // サーバーからエラーレスポンスが返された
        errorMessage += `**ステータスコード:** ${error.response.status}\n`;
        errorMessage += `**ステータステキスト:** ${error.response.statusText}\n`;
        
        if (error.response.data) {
          errorMessage += `**サーバーメッセージ:** ${JSON.stringify(error.response.data, null, 2)}\n`;
        }
        
        // 一般的なHTTPステータスコードの説明
        if (error.response.status === 413) {
          errorMessage += '\n💡 **原因:** データサイズが大きすぎます。より少ないデータで試してください。';
        } else if (error.response.status === 500) {
          errorMessage += '\n💡 **原因:** サーバー内部エラー。APIサーバー側の問題です。';
        } else if (error.response.status === 400) {
          errorMessage += '\n💡 **原因:** リクエスト形式に問題があります。';
        }
        
      } else if (error.request) {
        // リクエストは送信されたが、レスポンスがない
        errorMessage += '**問題:** APIサーバーからのレスポンスがありません。\n';
        errorMessage += '**可能な原因:**\n';
        errorMessage += '• ネットワーク接続の問題\n';
        errorMessage += '• CORSポリシーの問題\n';
        errorMessage += '• APIサーバーがダウンしている\n';
        errorMessage += `• タイムアウト（${error.config?.timeout || 60000}ms）\n`;
        
      } else {
        // その他のエラー
        errorMessage += `**エラーメッセージ:** ${error.message}\n`;
      }
      
      errorMessage += `\n🔧 **デバッグ情報:**\n`;
      errorMessage += `• API URL: ${API_ENDPOINT}\n`;
      errorMessage += `• データ送信: ${isFileUploaded ? 'あり' : 'なし'}\n`;
      errorMessage += `• データ行数: ${salesData?.length || 0}\n`;
      
      setResponse(errorMessage);
    } finally {
      setIsLoading(false)
    }
  }

  // 認証チェック中
  if (isAuthenticating) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <div>🔄 認証確認中...</div>
      </div>
    )
  }

  // 未認証の場合ログイン画面
  if (!user) {
    return <SimpleAuth onLogin={handleLogin} />
  }

  // 認証済みの場合メインアプリ
  return (
    <SentryErrorBoundary>
      <div style={{
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '32px 24px',
        fontFamily: '"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif',
        backgroundColor: '#fafafa',
        minHeight: '100vh',
        lineHeight: 1.6,
        color: '#2c3e50'
      }}>
      {/* ヘッダー */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        marginBottom: '48px',
        padding: '24px',
        backgroundColor: 'white',
        borderRadius: '16px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
        border: '1px solid #e8eef7'
      }}>
        <div>
          <h1 style={{
            color: '#1a365d',
            margin: 0,
            fontSize: '2.25rem',
            fontWeight: '700',
            letterSpacing: '-0.02em',
            lineHeight: 1.2
          }}>
            Strategic AI Platform
          </h1>
          <p style={{
            color: '#4a5568',
            margin: '8px 0 0 0',
            fontSize: '1.125rem',
            fontWeight: '400',
            letterSpacing: '0.01em'
          }}>
            統合分析コンサルティング
          </p>
        </div>
        
        <div style={{ textAlign: 'right' }}>
          <div style={{ 
            fontSize: '1rem', 
            color: '#2d3748', 
            marginBottom: '8px',
            fontWeight: '500'
          }}>
            {user.name}
          </div>
          <div style={{ 
            fontSize: '0.875rem', 
            color: '#718096', 
            marginBottom: '12px',
            fontWeight: '400'
          }}>
            {user.company}
          </div>
          <div style={{ 
            fontSize: '0.875rem', 
            color: '#718096', 
            marginBottom: '16px',
            padding: '6px 12px',
            backgroundColor: '#f7fafc',
            borderRadius: '8px',
            border: '1px solid #e2e8f0'
          }}>
            使用回数: <span style={{ fontWeight: '600', color: '#2d3748' }}>{user.usageCount}</span> / {user.usageLimit}
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={() => {
                // Sentryテスト用のエラーを送信
                console.log('🧪 Sentryテストエラーを送信中...');
                captureMessage('テスト: フロントエンドからSentryへの接続確認', 'info');
                Sentry.captureException(new Error('テスト用エラー: Sentry接続確認'));
                alert('Sentryテストメッセージを送信しました。Sentryダッシュボードを確認してください。');
              }}
              style={{
                padding: '10px 16px',
                fontSize: '0.875rem',
                backgroundColor: '#fed7d7',
                color: '#c53030',
                border: '1px solid #feb2b2',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: '500',
                transition: 'all 0.2s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#feb2b2';
                e.currentTarget.style.borderColor = '#fc8181';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#fed7d7';
                e.currentTarget.style.borderColor = '#feb2b2';
              }}
            >
              🧪 Sentryテスト
            </button>
            <button
              onClick={handleLogout}
              style={{
                padding: '10px 16px',
                fontSize: '0.875rem',
                backgroundColor: '#4a5568',
                color: 'white',
                border: '1px solid #4a5568',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: '500',
                transition: 'all 0.2s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#2d3748';
                e.currentTarget.style.borderColor = '#2d3748';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#4a5568';
                e.currentTarget.style.borderColor = '#4a5568';
              }}
            >
              ログアウト
            </button>
          </div>
        </div>
      </div>

      {/* 分析タイプ選択セクション */}
      <div style={{ 
        marginBottom: '48px',
        padding: '32px',
        backgroundColor: 'white',
        borderRadius: '16px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
        border: '1px solid #e8eef7'
      }}>
        <h2 style={{ 
          color: '#1a365d', 
          marginBottom: '24px', 
          fontSize: '1.5rem',
          fontWeight: '600',
          letterSpacing: '-0.01em',
          display: 'flex',
          alignItems: 'center',
          gap: '12px'
        }}>
          <span style={{ 
            backgroundColor: '#e6fffa', 
            padding: '8px', 
            borderRadius: '12px',
            fontSize: '1.25rem'
          }}>🔍</span>
          分析タイプを選択
        </h2>
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', 
          gap: '20px' 
        }}>
          {ANALYSIS_TYPES.map(type => {
            const isAccessible = USER_ACCESS[user.id]?.includes(type.id) || false
            const isSelected = selectedAnalysisType === type.id
            
            return (
              <div
                key={type.id}
                onClick={() => isAccessible && setSelectedAnalysisType(type.id)}
                style={{
                  padding: '24px',
                  border: `2px solid ${isSelected ? '#3182ce' : (isAccessible ? '#e2e8f0' : '#f1f5f9')}`,
                  borderRadius: '12px',
                  backgroundColor: isSelected ? '#ebf8ff' : (isAccessible ? '#ffffff' : '#f8fafc'),
                  cursor: isAccessible ? 'pointer' : 'not-allowed',
                  opacity: isAccessible ? 1 : 0.6,
                  transition: 'all 0.3s ease',
                  position: 'relative',
                  boxShadow: isSelected ? '0 8px 25px rgba(49, 130, 206, 0.15)' : '0 2px 8px rgba(0, 0, 0, 0.06)',
                  transform: isSelected ? 'translateY(-2px)' : 'translateY(0)'
                }}
                onMouseEnter={(e) => {
                  if (isAccessible && !isSelected) {
                    e.currentTarget.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.12)';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                    e.currentTarget.style.borderColor = '#cbd5e0';
                  }
                }}
                onMouseLeave={(e) => {
                  if (isAccessible && !isSelected) {
                    e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.06)';
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.borderColor = '#e2e8f0';
                  }
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px' }}>
                  <span style={{ 
                    fontSize: '1.75rem', 
                    marginRight: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '48px',
                    height: '48px',
                    backgroundColor: isSelected ? '#3182ce' : (isAccessible ? '#f7fafc' : '#f8fafc'),
                    borderRadius: '12px',
                    color: isSelected ? 'white' : 'inherit'
                  }}>{type.icon}</span>
                  <h3 style={{ 
                    margin: 0, 
                    color: isAccessible ? '#2d3748' : '#a0aec0', 
                    fontSize: '1.25rem',
                    fontWeight: '600',
                    letterSpacing: '-0.01em'
                  }}>
                    {type.name}
                  </h3>
                  {!isAccessible && (
                    <span style={{ 
                      marginLeft: 'auto', 
                      fontSize: '1.25rem', 
                      color: '#cbd5e0',
                      opacity: 0.7
                    }}>🔒</span>
                  )}
                </div>
                <p style={{ 
                  margin: 0, 
                  color: isAccessible ? '#4a5568' : '#a0aec0', 
                  fontSize: '0.95rem',
                  lineHeight: '1.6',
                  fontWeight: '400'
                }}>
                  {type.description}
                </p>
                {isSelected && (
                  <div style={{
                    position: 'absolute',
                    top: '16px',
                    right: '16px',
                    backgroundColor: '#3182ce',
                    color: 'white',
                    borderRadius: '50%',
                    width: '28px',
                    height: '28px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '14px',
                    fontWeight: '600',
                    boxShadow: '0 2px 8px rgba(49, 130, 206, 0.3)'
                  }}>
                    ✓
                  </div>
                )}
                {!isAccessible && (
                  <div style={{
                    position: 'absolute',
                    bottom: '16px',
                    right: '16px',
                    backgroundColor: type.tier === 'premium' ? '#ed8936' : type.tier === 'enterprise' ? '#805ad5' : '#38b2ac',
                    color: 'white',
                    padding: '6px 12px',
                    borderRadius: '16px',
                    fontSize: '0.75rem',
                    fontWeight: '600',
                    letterSpacing: '0.025em',
                    textTransform: 'uppercase'
                  }}>
                    {type.tier === 'premium' ? 'プレミアム' : type.tier === 'enterprise' ? 'エンタープライズ' : 'ベーシック'}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        
        {/* 選択された分析タイプの説明 */}
        {selectedAnalysisType && (
          <div style={{
            marginTop: '32px',
            padding: '20px',
            backgroundColor: '#e6fffa',
            borderRadius: '12px',
            border: '2px solid #38b2ac',
            boxShadow: '0 2px 8px rgba(56, 178, 172, 0.1)'
          }}>
            {(() => {
              const selectedType = ANALYSIS_TYPES.find(t => t.id === selectedAnalysisType)
              return selectedType ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div style={{
                    backgroundColor: '#38b2ac',
                    color: 'white',
                    padding: '12px',
                    borderRadius: '12px',
                    fontSize: '1.5rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: '48px',
                    height: '48px'
                  }}>
                    {selectedType.icon}
                  </div>
                  <div>
                    <div style={{ 
                      color: '#1a202c', 
                      fontSize: '1.125rem',
                      fontWeight: '600',
                      marginBottom: '4px'
                    }}>
                      {selectedType.name}が選択されています
                    </div>
                    <p style={{ 
                      margin: 0, 
                      color: '#2d3748', 
                      fontSize: '0.95rem',
                      lineHeight: '1.5'
                    }}>
                      {selectedType.description}
                    </p>
                  </div>
                </div>
              ) : null
            })()}
          </div>
        )}
      </div>

      {/* ファイルアップロードセクション（ドラッグ&ドロップ対応） */}
      <div 
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          marginBottom: '48px',
          padding: '40px',
          border: `3px dashed ${isDragging ? '#3182ce' : '#cbd5e0'}`,
          borderRadius: '16px',
          backgroundColor: isDragging ? '#ebf8ff' : 'white',
          textAlign: 'center',
          transition: 'all 0.3s ease',
          cursor: 'pointer',
          boxShadow: isDragging ? '0 8px 30px rgba(49, 130, 206, 0.2)' : '0 4px 20px rgba(0, 0, 0, 0.08)',
          transform: isDragging ? 'scale(1.02)' : 'scale(1)'
        }}
        onMouseEnter={(e) => {
          if (!isDragging) {
            e.currentTarget.style.borderColor = '#a0aec0';
            e.currentTarget.style.boxShadow = '0 6px 25px rgba(0, 0, 0, 0.12)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isDragging) {
            e.currentTarget.style.borderColor = '#cbd5e0';
            e.currentTarget.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.08)';
          }
        }}
      >
        <div style={{ 
          fontSize: '4rem', 
          marginBottom: '20px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          width: '96px',
          height: '96px',
          backgroundColor: isDragging ? '#3182ce' : '#f7fafc',
          borderRadius: '24px',
          margin: '0 auto 24px',
          color: isDragging ? 'white' : '#4a5568',
          transition: 'all 0.3s ease'
        }}>
          {isDragging ? '📥' : '📊'}
        </div>
        <h3 style={{ 
          marginTop: 0, 
          color: '#2d3748', 
          marginBottom: '12px',
          fontSize: '1.5rem',
          fontWeight: '600',
          letterSpacing: '-0.01em'
        }}>
          {isDragging ? 'ここにファイルをドロップ' : 'データファイルをアップロード'}
        </h3>
        
        <p style={{ 
          fontSize: '1rem', 
          color: '#4a5568', 
          marginBottom: '32px',
          lineHeight: '1.6',
          maxWidth: '500px',
          margin: '0 auto 32px'
        }}>
          {selectedAnalysisType === 'document' ? 
            '領収書・請求書・レポート・名刺などの画像ファイルをアップロードしてAI分析を開始' :
            'CSV・Excelファイルをアップロードして高度な売上分析・トレンド予測を実行'
          }
        </p>
        
        <input
          type="file"
          accept={selectedAnalysisType === 'document' ? '.jpg,.jpeg,.png,.pdf,.webp' : '.csv,.xlsx,.xls'}
          onChange={handleFileUpload}
          id="file-input"
          style={{ display: 'none' }}
        />
        <label 
          htmlFor="file-input"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '12px',
            padding: '16px 32px',
            backgroundColor: '#3182ce',
            color: 'white',
            borderRadius: '12px',
            cursor: 'pointer',
            fontSize: '1.125rem',
            fontWeight: '600',
            transition: 'all 0.3s ease',
            boxShadow: '0 4px 14px rgba(49, 130, 206, 0.3)',
            border: 'none',
            letterSpacing: '-0.01em'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#2c5282';
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 6px 20px rgba(49, 130, 206, 0.4)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#3182ce';
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 4px 14px rgba(49, 130, 206, 0.3)';
          }}
        >
          <span style={{ fontSize: '1.25rem' }}>📁</span>
          ファイルを選択してアップロード
        </label>
        
        <div style={{ marginTop: '24px' }}>
          <p style={{ 
            margin: '0 0 16px 0', 
            fontSize: '0.875rem', 
            color: '#718096',
            fontWeight: '500'
          }}>
            対応形式: {selectedAnalysisType === 'document' 
              ? 'JPG, PNG, PDF, WebP (最大10MB)' 
              : 'CSV, Excel (.xlsx, .xls) (最大5MB)'
            }
          </p>
          {isFileUploaded && (
            <div style={{ 
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              backgroundColor: '#c6f6d5',
              color: '#22543d',
              padding: '8px 16px',
              borderRadius: '8px',
              fontSize: '0.875rem',
              fontWeight: '600',
              border: '1px solid #9ae6b4'
            }}>
              <span style={{ fontSize: '1rem' }}>✅</span>
              データアップロード完了
            </div>
          )}
        </div>
      </div>

      <div style={{
        marginBottom: '48px',
        padding: '32px',
        backgroundColor: 'white',
        borderRadius: '16px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
        border: '1px solid #e8eef7'
      }}>
        <h2 style={{ 
          color: '#1a365d', 
          marginBottom: '20px', 
          fontSize: '1.5rem',
          fontWeight: '600',
          letterSpacing: '-0.01em',
          display: 'flex',
          alignItems: 'center',
          gap: '12px'
        }}>
          <span style={{ 
            backgroundColor: '#e6fffa', 
            padding: '8px', 
            borderRadius: '12px',
            fontSize: '1.25rem'
          }}>💬</span>
          AIに質問・分析依頼
        </h2>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={isFileUploaded ? 
            "売上データについて質問してください\n\n例：\n• 売上トレンドを分析して詳しく教えて\n• 商品別の売上構成を教えて\n• 今月の売上予測を立てて" : 
            "データファイルをアップロード後、AIに質問や分析依頼ができます"
          }
          style={{
            width: '100%',
            minHeight: '140px',
            padding: '20px',
            fontSize: '1rem',
            border: '2px solid #e2e8f0',
            borderRadius: '12px',
            resize: 'vertical',
            boxSizing: 'border-box',
            fontFamily: '"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif',
            lineHeight: '1.6',
            backgroundColor: isFileUploaded ? '#ffffff' : '#f8fafc',
            color: '#2d3748',
            transition: 'all 0.3s ease',
            outline: 'none'
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = '#3182ce';
            e.currentTarget.style.boxShadow = '0 0 0 3px rgba(49, 130, 206, 0.1)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = '#e2e8f0';
            e.currentTarget.style.boxShadow = 'none';
          }}
          disabled={isLoading}
        />
        
        {/* 主要操作ボタン */}
        {isFileUploaded && (
          <div style={{ marginTop: '24px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px' }}>
              <button
                onClick={() => {
                  console.log('📊 グラフ表示ボタンがクリックされました');
                  console.log('📊 現在のsalesData:', salesData);
                  console.log('📊 salesData長さ:', salesData?.length);
                  
                  // プロンプトに影響せずにグラフを表示
                  setForceShowGraphs(true);
                  setShowDataTable(false);
                  setShowCharts(true);
                  
                  // データの存在確認
                  if (salesData && salesData.length > 0) {
                    setResponse(`📊 データを可視化しています...\n\n実データ（${salesData.length}行）を使用してグラフを生成します：\n• 期間別売上推移\n• データ構成比較\n• データサマリー`);
                  } else {
                    setResponse('⚠️ データがロードされていません。先にファイルをアップロードしてください。');
                  }
                }}
                style={{
                  padding: '16px 20px',
                  fontSize: '1rem',
                  fontWeight: '600',
                  backgroundColor: '#38b2ac',
                  color: 'white',
                  border: 'none',
                  borderRadius: '12px',
                  cursor: 'pointer',
                  transition: 'all 0.3s ease',
                  boxShadow: '0 4px 14px rgba(56, 178, 172, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#319795';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 6px 20px rgba(56, 178, 172, 0.4)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#38b2ac';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 14px rgba(56, 178, 172, 0.3)';
                }}
                disabled={isLoading}
              >
                <span style={{ fontSize: '1.25rem' }}>📊</span>
                グラフ可視化
              </button>
              
              <button
                onClick={() => {
                  console.log('📋 データテーブル表示ボタンがクリックされました');
                  setShowDataTable(!showDataTable);
                  setForceShowGraphs(false);
                  if (salesData && salesData.length > 0) {
                    setResponse(`📋 データテーブルを${showDataTable ? '非表示' : '表示'}にしました`);
                  }
                }}
                style={{
                  padding: '16px 20px',
                  fontSize: '1rem',
                  fontWeight: '600',
                  backgroundColor: '#4a5568',
                  color: 'white',
                  border: 'none',
                  borderRadius: '12px',
                  cursor: 'pointer',
                  transition: 'all 0.3s ease',
                  boxShadow: '0 4px 14px rgba(74, 85, 104, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#2d3748';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 6px 20px rgba(74, 85, 104, 0.4)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#4a5568';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 14px rgba(74, 85, 104, 0.3)';
                }}
                disabled={isLoading}
              >
                <span style={{ fontSize: '1.25rem' }}>📋</span>
                {showDataTable ? 'テーブル非表示' : 'テーブル表示'}
              </button>
              
              <button
                onClick={() => {
                  console.log('📚 データ学習ボタンがクリックされました');
                  checkSupabaseConfig(); // デバッグ情報を出力
                  setShowColumnMapping(true);
                }}
                style={{
                  padding: '16px 20px',
                  fontSize: '1rem',
                  fontWeight: '600',
                  backgroundColor: '#805ad5',
                  color: 'white',
                  border: 'none',
                  borderRadius: '12px',
                  cursor: 'pointer',
                  transition: 'all 0.3s ease',
                  boxShadow: '0 4px 14px rgba(128, 90, 213, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#6b46c1';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 6px 20px rgba(128, 90, 213, 0.4)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#805ad5';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 14px rgba(128, 90, 213, 0.3)';
                }}
                disabled={isLoading}
              >
                <span style={{ fontSize: '1.25rem' }}>📚</span>
                データ学習
              </button>
            </div>

            
            <div style={{ marginTop: '20px' }}>
              <h3 style={{ 
                fontSize: '1rem', 
                color: '#2d3748', 
                margin: '0 0 12px 0',
                fontWeight: '600'
              }}>
                よく使われる分析パターン
              </h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {[
                  { text: '売上トレンドを分析', icon: '📈' },
                  { text: '商品別売上構成を分析', icon: '🍎' },
                  { text: '季節性パターンを分析', icon: '🌱' },
                  { text: '売上予測とKPI分析', icon: '🔮' }
                ].map((question, index) => (
                  <button
                    key={index}
                    onClick={() => setPrompt(question.text + 'して詳しく教えてください')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '8px 16px',
                      fontSize: '0.875rem',
                      backgroundColor: '#f7fafc',
                      border: '2px solid #e2e8f0',
                      borderRadius: '24px',
                      cursor: 'pointer',
                      fontWeight: '500',
                      color: '#4a5568',
                      transition: 'all 0.2s ease'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#ebf8ff';
                      e.currentTarget.style.borderColor = '#3182ce';
                      e.currentTarget.style.color = '#2d3748';
                      e.currentTarget.style.transform = 'translateY(-1px)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = '#f7fafc';
                      e.currentTarget.style.borderColor = '#e2e8f0';
                      e.currentTarget.style.color = '#4a5568';
                      e.currentTarget.style.transform = 'translateY(0)';
                    }}
                    disabled={isLoading}
                  >
                    <span>{question.icon}</span>
                    {question.text}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={{
        marginBottom: '48px',
        padding: '32px',
        backgroundColor: 'white',
        borderRadius: '16px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
        border: '1px solid #e8eef7'
      }}>
        <h2 style={{ 
          color: '#1a365d', 
          marginBottom: '24px', 
          fontSize: '1.5rem',
          fontWeight: '600',
          letterSpacing: '-0.01em',
          display: 'flex',
          alignItems: 'center',
          gap: '12px'
        }}>
          <span style={{ 
            backgroundColor: '#e6fffa', 
            padding: '8px', 
            borderRadius: '12px',
            fontSize: '1.25rem'
          }}>🚀</span>
          AI分析実行
        </h2>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px' }}>
          <div style={{
            padding: '24px',
            backgroundColor: '#f8fafc',
            borderRadius: '12px',
            border: '2px solid #e2e8f0',
            transition: 'all 0.3s ease'
          }}>
            <button
              onClick={handleSubmit}
              disabled={isLoading || !prompt.trim()}
              style={{
                width: '100%',
                padding: '16px 24px',
                fontSize: '1.125rem',
                fontWeight: '600',
                color: 'white',
                backgroundColor: isLoading || !prompt.trim() ? '#a0aec0' : '#3182ce',
                border: 'none',
                borderRadius: '12px',
                cursor: isLoading || !prompt.trim() ? 'not-allowed' : 'pointer',
                transition: 'all 0.3s ease',
                boxShadow: isLoading || !prompt.trim() ? 'none' : '0 4px 14px rgba(49, 130, 206, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                transform: isLoading ? 'none' : 'translateY(0)',
                letterSpacing: '-0.01em'
              }}
              onMouseEnter={(e) => {
                if (!isLoading && prompt.trim()) {
                  e.currentTarget.style.backgroundColor = '#2c5282';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 6px 20px rgba(49, 130, 206, 0.4)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isLoading && prompt.trim()) {
                  e.currentTarget.style.backgroundColor = '#3182ce';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 14px rgba(49, 130, 206, 0.3)';
                }
              }}
            >
              <span style={{ fontSize: '1.25rem' }}>
                {isLoading ? '⏳' : '💬'}
              </span>
              {isLoading ? 'AI分析実行中...' : 'AI分析（文章レポート）'}
            </button>
            
            <div style={{ 
              marginTop: '16px',
              padding: '12px',
              backgroundColor: '#ebf8ff',
              borderRadius: '8px',
              border: '1px solid #bee3f8'
            }}>
              <p style={{ 
                margin: 0, 
                fontSize: '0.875rem', 
                color: '#2d3748',
                fontWeight: '500',
                marginBottom: '4px'
              }}>
                📖 文章形式のレポート
              </p>
              <p style={{ 
                margin: 0, 
                fontSize: '0.8rem', 
                color: '#4a5568',
                lineHeight: '1.5'
              }}>
                AIが分析結果を理解しやすい文章で説明します。プレゼンテーションや報告書に最適です。
              </p>
            </div>
          </div>
          
          <div style={{
            padding: '24px',
            backgroundColor: '#f0fff4',
            borderRadius: '12px',
            border: '2px solid #c6f6d5',
            transition: 'all 0.3s ease'
          }}>
            <button
              onClick={handleSubmitJSON}
              disabled={isLoading || !prompt.trim()}
              style={{
                width: '100%',
                padding: '16px 24px',
                fontSize: '1.125rem',
                fontWeight: '600',
                color: 'white',
                backgroundColor: isLoading || !prompt.trim() ? '#a0aec0' : '#38a169',
                border: 'none',
                borderRadius: '12px',
                cursor: isLoading || !prompt.trim() ? 'not-allowed' : 'pointer',
                transition: 'all 0.3s ease',
                boxShadow: isLoading || !prompt.trim() ? 'none' : '0 4px 14px rgba(56, 161, 105, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                transform: isLoading ? 'none' : 'translateY(0)',
                letterSpacing: '-0.01em'
              }}
              onMouseEnter={(e) => {
                if (!isLoading && prompt.trim()) {
                  e.currentTarget.style.backgroundColor = '#2f855a';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 6px 20px rgba(56, 161, 105, 0.4)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isLoading && prompt.trim()) {
                  e.currentTarget.style.backgroundColor = '#38a169';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 14px rgba(56, 161, 105, 0.3)';
                }
              }}
            >
              <span style={{ fontSize: '1.25rem' }}>
                {isLoading ? '⏳' : '📊'}
              </span>
              {isLoading ? 'AI分析実行中...' : 'AI分析（データ詳細）'}
            </button>
            
            <div style={{ 
              marginTop: '16px',
              padding: '12px',
              backgroundColor: '#f0fff4',
              borderRadius: '8px',
              border: '1px solid #9ae6b4'
            }}>
              <p style={{ 
                margin: 0, 
                fontSize: '0.875rem', 
                color: '#2d3748',
                fontWeight: '500',
                marginBottom: '4px'
              }}>
                📈 詳細データ分析
              </p>
              <p style={{ 
                margin: 0, 
                fontSize: '0.8rem', 
                color: '#4a5568',
                lineHeight: '1.5'
              }}>
                構造化されたデータと具体的な数値で分析結果を提供します。深い洞察が必要な場合に最適です。
              </p>
            </div>
          </div>
        </div>
      </div>

      <div style={{
        padding: '32px',
        backgroundColor: 'white',
        borderRadius: '16px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
        border: '1px solid #e8eef7',
        minHeight: '200px'
      }}>
        <h2 style={{ 
          color: '#1a365d', 
          marginBottom: '24px', 
          fontSize: '1.5rem',
          fontWeight: '600',
          letterSpacing: '-0.01em',
          display: 'flex',
          alignItems: 'center',
          gap: '12px'
        }}>
          <span style={{ 
            backgroundColor: '#e6fffa', 
            padding: '8px', 
            borderRadius: '12px',
            fontSize: '1.25rem'
          }}>📋</span>
          分析結果・AI応答
        </h2>
        
        <div style={{
          padding: '24px',
          backgroundColor: isLoading ? '#f7fafc' : (response ? '#ffffff' : '#fafafa'),
          borderRadius: '12px',
          border: isLoading ? '2px dashed #cbd5e0' : (response ? '2px solid #e2e8f0' : '2px dashed #e2e8f0'),
          minHeight: '120px',
          whiteSpace: 'pre-wrap',
          fontFamily: '"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif',
          fontSize: '1rem',
          lineHeight: '1.7',
          color: '#2d3748',
          position: 'relative',
          transition: 'all 0.3s ease'
        }}>
          {isLoading ? (
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '12px',
              color: '#4a5568',
              fontSize: '1.125rem',
              fontWeight: '500'
            }}>
              <div style={{
                width: '24px',
                height: '24px',
                border: '3px solid #e2e8f0',
                borderTop: '3px solid #3182ce',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite'
              }}></div>
              AIが高度な分析を実行しています...
              <style>
                {`
                  @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                  }
                `}
              </style>
            </div>
          ) : response ? (
            <div style={{ 
              position: 'relative'
            }}>
              <div style={{
                position: 'absolute',
                top: '-12px',
                right: '-12px',
                backgroundColor: '#38a169',
                color: 'white',
                padding: '4px 8px',
                borderRadius: '12px',
                fontSize: '0.75rem',
                fontWeight: '600',
                textTransform: 'uppercase',
                letterSpacing: '0.05em'
              }}>
                完了
              </div>
              {response}
            </div>
          ) : (
            <div style={{ 
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: '120px',
              color: '#a0aec0',
              textAlign: 'center'
            }}>
              <div style={{
                fontSize: '3rem',
                marginBottom: '16px',
                opacity: 0.6
              }}>
                🤖
              </div>
              <p style={{
                margin: 0,
                fontSize: '1.125rem',
                fontWeight: '500',
                marginBottom: '8px'
              }}>
                AI分析結果がここに表示されます
              </p>
              <p style={{
                margin: 0,
                fontSize: '0.875rem',
                color: '#718096'
              }}>
                データをアップロードして質問を入力し、AI分析を開始してください
              </p>
            </div>
          )}
        </div>
      </div>

      {/* データテーブル表示セクション */}
      {showDataTable && isFileUploaded && salesData.length > 0 && (
        <div style={{ marginTop: '30px' }}>
          <h2 style={{ color: '#333', marginBottom: '20px' }}>📋 データテーブル表示</h2>
          
          <div style={{ 
            backgroundColor: 'white', 
            padding: '20px', 
            borderRadius: '8px', 
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            overflowX: 'auto'
          }}>
            <p style={{ marginBottom: '15px', color: '#666' }}>
              総行数: {salesData.length}行 | 表示: 最初の10行
            </p>
            
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '14px'
            }}>
              <thead>
                <tr style={{ backgroundColor: '#f8f9fa' }}>
                  <th style={{ padding: '8px', border: '1px solid #ddd', fontWeight: 'bold' }}>行番号</th>
                  {salesData.length > 0 && Object.keys(salesData[0]).map(key => (
                    <th key={key} style={{ padding: '8px', border: '1px solid #ddd', fontWeight: 'bold' }}>
                      {key}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {salesData.slice(0, 10).map((row, index) => (
                  <tr key={index} style={{ backgroundColor: index % 2 === 0 ? '#ffffff' : '#f9f9f9' }}>
                    <td style={{ padding: '8px', border: '1px solid #ddd', fontWeight: 'bold', backgroundColor: '#e9ecef' }}>
                      {index + 1}
                    </td>
                    {Object.entries(row).map(([key, value]) => (
                      <td key={key} style={{ padding: '8px', border: '1px solid #ddd' }}>
                        {value === '' || value === null || value === undefined ? 
                          <span style={{ color: '#999', fontStyle: 'italic' }}>(空)</span> : 
                          String(value)
                        }
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            
            {salesData.length > 10 && (
              <p style={{ marginTop: '10px', color: '#666', fontSize: '12px' }}>
                ※ 最初の10行のみ表示しています（全{salesData.length}行）
              </p>
            )}
          </div>
        </div>
      )}

      {/* 画像プレビューセクション */}
      {uploadedImagePreview && selectedAnalysisType === 'document' && (
        <div style={{ marginTop: '30px' }}>
          <h2 style={{ color: '#333', marginBottom: '20px' }}>📸 アップロード画像プレビュー</h2>
          
          <div style={{ 
            backgroundColor: 'white', 
            padding: '20px', 
            borderRadius: '8px', 
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            display: 'flex',
            gap: '20px',
            alignItems: 'flex-start'
          }}>
            {/* 画像表示 */}
            <div style={{ flex: '0 0 auto', maxWidth: '400px' }}>
              <img 
                src={uploadedImagePreview} 
                alt="アップロード画像"
                style={{ 
                  width: '100%', 
                  height: 'auto',
                  maxHeight: '300px',
                  objectFit: 'contain',
                  border: '2px solid #e0e0e0',
                  borderRadius: '8px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                }}
              />
            </div>
            
            {/* 分析結果 */}
            {imageAnalysisResult && (
              <div style={{ flex: 1, minWidth: '200px' }}>
                <h3 style={{ color: '#555', marginBottom: '15px', fontSize: '1.1rem' }}>
                  🔍 分析結果
                </h3>
                <div style={{
                  backgroundColor: '#f8f9fa',
                  padding: '15px',
                  borderRadius: '6px',
                  border: '1px solid #e9ecef',
                  maxHeight: '250px',
                  overflowY: 'auto',
                  fontSize: '14px',
                  lineHeight: '1.6',
                  whiteSpace: 'pre-wrap'
                }}>
                  {imageAnalysisResult}
                </div>
                
                {/* 操作ボタン */}
                <div style={{ marginTop: '15px', display: 'flex', gap: '10px' }}>
                  <button
                    onClick={() => {
                      setUploadedImagePreview(null);
                      setImageAnalysisResult('');
                      setResponse('');
                      setIsFileUploaded(false);
                    }}
                    style={{
                      padding: '8px 16px',
                      fontSize: '14px',
                      backgroundColor: '#6c757d',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    🗑️ クリア
                  </button>
                  
                  <button
                    onClick={() => {
                      const link = document.createElement('a');
                      link.href = uploadedImagePreview;
                      link.download = 'analyzed-image.jpg';
                      link.click();
                    }}
                    style={{
                      padding: '8px 16px',
                      fontSize: '14px',
                      backgroundColor: '#007bff',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    💾 画像保存
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* データ可視化セクション */}
      {showCharts && isFileUploaded && (forceShowGraphs || prompt.includes('グラフ')) && (() => {
        const chartData = generateChartData();
        if (!chartData) return null;

        return (
          <div style={{ marginTop: '30px' }}>
            <h2 style={{ color: '#333', marginBottom: '20px' }}>📊 売上データ可視化</h2>
            
            {/* 月別売上推移グラフ */}
            <div style={{ marginBottom: '40px', backgroundColor: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
              <h3 style={{ color: '#555', marginBottom: '15px' }}>月別売上推移</h3>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData.monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" />
                  <YAxis />
                  <Tooltip formatter={(value) => [`¥${Number(value).toLocaleString()}`, '売上']} />
                  <Legend />
                  <Line type="monotone" dataKey="sales" stroke="#8884d8" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* 商品別売上構成 */}
            <div style={{ marginBottom: '40px', backgroundColor: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
              <h3 style={{ color: '#555', marginBottom: '15px' }}>商品別売上構成</h3>
              <div style={{ display: 'flex', gap: '20px' }}>
                {/* 円グラフ */}
                <div style={{ flex: 1 }}>
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={chartData.productData}
                        cx="50%"
                        cy="50%"
                        labelLine={false}
                        label={({name, percent}) => `${name} ${(percent * 100).toFixed(0)}%`}
                        outerRadius={80}
                        fill="#8884d8"
                        dataKey="value"
                      >
                        {chartData.productData.map((_entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => `¥${Number(value).toLocaleString()}`} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                
                {/* 棒グラフ */}
                <div style={{ flex: 1 }}>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={chartData.productData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" />
                      <YAxis />
                      <Tooltip formatter={(value) => `¥${Number(value).toLocaleString()}`} />
                      <Bar dataKey="value" fill="#8884d8" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* データサマリー */}
            <div style={{ backgroundColor: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
              <h3 style={{ color: '#555', marginBottom: '15px' }}>📈 データサマリー</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px' }}>
                <div style={{ textAlign: 'center', padding: '15px', backgroundColor: '#f8f9fa', borderRadius: '6px' }}>
                  <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#007bff' }}>
                    {chartData.analysis.totalRecords}
                  </div>
                  <div style={{ fontSize: '14px', color: '#666' }}>総レコード数</div>
                </div>
                <div style={{ textAlign: 'center', padding: '15px', backgroundColor: '#f8f9fa', borderRadius: '6px' }}>
                  <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#28a745' }}>
                    ¥{chartData.totalSales ? Math.round(chartData.totalSales).toLocaleString() : '計算中'}
                  </div>
                  <div style={{ fontSize: '14px', color: '#666' }}>総売上</div>
                </div>
                <div style={{ textAlign: 'center', padding: '15px', backgroundColor: '#f8f9fa', borderRadius: '6px' }}>
                  <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#ffc107' }}>
                    {chartData.productData.length}
                  </div>
                  <div style={{ fontSize: '14px', color: '#666' }}>商品数</div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* カラムマッピング学習モーダル */}
      {showColumnMapping && isFileUploaded && salesData.length > 0 && (
        <ColumnMappingLearning
          columns={Object.keys(salesData[0])}
          onSave={async (mappings) => {
            console.log('📚 学習データ保存:', mappings);
            setColumnMappings(mappings);
            
            // Supabaseに保存
            const tenantId = 'default'; // TODO: 実際のテナントIDを使用
            const headers = Object.keys(salesData[0]);
            
            setResponse('📊 学習データを保存中...');
            const result = await saveFormatProfile(tenantId, headers, mappings);
            
            if (result.success) {
              setResponse(`✅ カラムマッピングを学習・保存しました！\n\n保存内容:\n${JSON.stringify(mappings, null, 2)}`);
              console.log('✅ Supabase保存成功:', result.profile);
            } else {
              setResponse(`⚠️ カラムマッピングは学習しましたが、クラウド保存に失敗しました。\n\nエラー: ${result.error}`);
              console.error('❌ Supabase保存失敗:', result.error);
            }
            
            setShowColumnMapping(false);
          }}
          onCancel={() => {
            console.log('📚 学習をキャンセル');
            setShowColumnMapping(false);
          }}
        />
      )}
      </div>
    </SentryErrorBoundary>
  )
}

export default App