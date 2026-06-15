# 公開手順

VS Code Marketplace に公開する場合は、以下の手順で VSIX の確認と公開を行います。

## 事前準備

1. [Visual Studio Marketplace の管理ページ](https://marketplace.visualstudio.com/manage)
  で Publisher を作成します。
2. [package.json](package.json) の `publisher` が、Marketplace 上の Publisher ID
  と一致していることを確認します。
3. [Azure DevOps](https://dev.azure.com/) で Personal Access Token (PAT) を作成します。
  Marketplace の公開には Marketplace の `Manage` 権限が必要です。
4. Node.js は `20.18.1` 以上を使用します。

PAT は秘密情報です。リポジトリや設定ファイルには保存せず、`vsce login` のプロンプトに
直接入力してください。

## ローカル確認

パッケージに含まれるファイルを確認します。

```bash
npx @vscode/vsce ls
```

不要なファイルが含まれている場合は、[.vscodeignore](.vscodeignore) を更新してから
再度確認します。たとえば公開物に GitHub 用の設定やスキル ファイルを含めない場合は、
`.vscodeignore` に `.github/**` を追加します。

VSIX を作成します。

```bash
npx @vscode/vsce package
```

作成した VSIX をローカルの VS Code にインストールして動作確認します。

```bash
code --install-extension mht-viewer-0.0.1.vsix
```

## Marketplace への公開

初回または PAT を更新した場合は、Publisher ID でログインします。

```bash
npx @vscode/vsce login {Publisher ID}
```

公開します。

```bash
npx @vscode/vsce publish
```

バージョン番号を上げて公開する場合は、以下のいずれかを使います。

```bash
npx @vscode/vsce publish patch
npx @vscode/vsce publish minor
npx @vscode/vsce publish major
```

公開前に [package.json](package.json) の `version`、`description`、`categories`、
`keywords`、`license`、README の内容が最新であることを確認してください。
