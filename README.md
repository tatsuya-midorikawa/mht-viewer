# mht-viewer

`mht-viewer` は PSR (psr.exe) で採取したログ ファイル (.mht) を表示させるための VSCode 拡張機能です。

Windows の「ステップ記録ツール (Steps Recorder / psr.exe)」が出力する `.mht`
(MHTML) ファイルを、VS Code 上でそのまま開いて閲覧できます。スクリーンショットや
手順の説明、各ステップに埋め込まれたスクリプト (スライドショー等) を再現します。

## 特長

- `.mht` / `.mhtml` ファイルを開くだけでプレビュー表示 (カスタム エディター)
- MIME マルチパート (`multipart/related`) の分解
- `quoted-printable` / `base64` のデコード
- 埋め込み画像・CSS を `data:` URI へ差し替えてオフラインで完結
- PSR が生成する `slide*.htm` / `pslide*.htm` などの HTML パート間リンクに対応
- スクリーンショット画像のクリックによる拡大・縮小に対応
- 元ファイルのスクリプトは隔離した `sandbox` iframe 内でのみ実行し、外部
  ネットワーク アクセスは遮断 (プライバシー・セキュリティに配慮)
- ツールバーから「ソース」表示に切り替え可能

## 設計方針

本拡張機能は **プレーンな JavaScript / HTML / CSS のみ** で実装しています。
Node.js のコア モジュール、サードパーティー ライブラリ、ビルド ツール
(バンドラー・トランスパイラー) は一切使用していません。VS Code 拡張機能ホスト側は
VS Code API だけを参照し、MHTML の解析・表示処理ではブラウザー標準 API のみを
使用します。

- 拡張機能ホスト ([src/extension.js](src/extension.js)) は VS Code API のみを
  利用し、カスタム エディターと Webview を用意します。
- MHTML の解析・デコード・再描画 ([media/viewer.js](media/viewer.js)) は、
  ブラウザー標準 API (`fetch` / `TextDecoder` / `atob` / `btoa` / `DOMParser` /
  `Blob` など) だけで Webview 内で実行します。

## 構成

| パス | 役割 |
| --- | --- |
| [package.json](package.json) | 拡張機能マニフェスト (カスタム エディター登録) |
| [src/extension.js](src/extension.js) | カスタム エディター プロバイダー |
| [media/viewer.js](media/viewer.js) | MHTML パーサー & レンダラー (Webview) |
| [media/viewer.css](media/viewer.css) | Webview のスタイル |
| [samples/sample.mht](samples/sample.mht) | 動作確認用サンプル |

## 使い方

1. VS Code でこのフォルダーを開きます。
2. `F5` キーを押して「拡張機能開発ホスト」を起動します。
3. 起動したウィンドウで任意の `.mht` ファイル
   (例: [samples/sample.mht](samples/sample.mht)) を開くと、プレビューが
   表示されます。

既定のテキスト エディターで開きたい場合は、エクスプローラーでファイルを
右クリックし **[アプリケーションを選択して開く]** から選択してください。

## 動作の仕組み

```mermaid
flowchart LR
  A[".mht ファイル"] --> B["extension.js<br/>カスタム エディター"]
  B --> C["Webview"]
  C -->|"fetch"| A
  C --> D["viewer.js<br/>MIME 分解 / デコード"]
  D --> E["画像・CSS を data: URI 化"]
  E --> F["sandbox iframe で描画"]
```

## ライセンス

[MIT](LICENSE)
