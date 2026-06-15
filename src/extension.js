// @ts-check
"use strict";

const vscode = require("vscode");

const VIEW_TYPE = "mhtViewer.preview";

/**
 * MHT (MHTML) ファイルを表示するためのカスタム エディター プロバイダー。
 *
 * パース処理 (MIME マルチパートの分解・base64 / quoted-printable のデコード・
 * 画像の差し替えなど) はすべて Webview 側のプレーンな JavaScript で行います。
 * 拡張機能ホスト側は Webview を用意し、対象ファイルの URI を渡すだけです。
 *
 * @implements {vscode.CustomReadonlyEditorProvider<vscode.CustomDocument>}
 */
class MhtEditorProvider {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
  }

  /**
   * @param {vscode.Uri} uri
   * @returns {vscode.CustomDocument}
   */
  openCustomDocument(uri) {
    return { uri, dispose() {} };
  }

  /**
   * @param {vscode.CustomDocument} document
   * @param {vscode.WebviewPanel} webviewPanel
   */
  async resolveCustomEditor(document, webviewPanel) {
    const webview = webviewPanel.webview;
    const fileUri = document.uri;
    // 対象ファイルと同じフォルダーを Webview からアクセス可能にする。
    const fileDir = vscode.Uri.joinPath(fileUri, "..");

    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri, fileDir],
    };

    webview.html = this.buildHtml(webview, fileUri);

    webview.onDidReceiveMessage((message) => {
      if (!message || typeof message !== "object") {
        return;
      }
      if (message.type === "error" && typeof message.text === "string") {
        vscode.window.showErrorMessage(`MHT Viewer: ${message.text}`);
      }
    });
  }

  /**
   * Webview に表示するホスト ページの HTML を生成します。
   *
   * @param {vscode.Webview} webview
   * @param {vscode.Uri} fileUri
   * @returns {string}
   */
  buildHtml(webview, fileUri) {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "viewer.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "viewer.css")
    );
    // Webview から fetch でファイル本体を取得するための URI。
    const resourceUri = webview.asWebviewUri(fileUri);
    const cspSource = webview.cspSource;

    // パースした PSR の HTML は blob: の iframe (sandbox) 内で描画します。
    // VS Code Webview では blob: 側にも親 CSP が効くため、PSR が生成した
    // zoomToggle などのインライン スクリプトが動けるよう script-src で
    // 'unsafe-inline' を許可します。MHT 本体は sandbox iframe 内に閉じ込め、
    // connect-src は Webview 自身に限定します。
    const csp = [
      "default-src 'none'",
      `img-src ${cspSource} data: blob:`,
      `script-src ${cspSource} 'unsafe-inline'`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `font-src ${cspSource} data:`,
      `connect-src ${cspSource}`,
      "frame-src blob:",
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>MHT Viewer</title>
</head>
<body data-file-uri="${escapeAttribute(String(resourceUri))}">
  <header id="toolbar" hidden>
    <div class="meta">
      <span id="subject" class="subject"></span>
      <span id="date" class="date"></span>
    </div>
    <div class="actions">
      <span id="count" class="count"></span>
      <button id="toggle-source" type="button" title="ソース表示を切り替えます">ソース</button>
    </div>
  </header>
  <div id="status" class="status">読み込んでいます&hellip;</div>
  <iframe id="content" title="MHT contents" sandbox="allow-scripts" hidden></iframe>
  <pre id="source" class="source" hidden></pre>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeAttribute(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const provider = new MhtEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
