# Target

KGS 11thの雰囲気に合わせた英単語・英熟語の暗記と4択テストです。

- Target 1900と英熟語Target 1000を選択し、英語と訳を左右に大きく表示して暗記できます。番号は青い英語欄にまとめ、横幅を広く使い、画面内に収まる件数を表示します。
- 英語／訳のどちらを答えるかを選び、1問ずつ4択でテストします。
- KGSアカウントの番号とPINでログインすると、サーバー採点した累積正解数をユーザー名でランキングに表示します。ゲストは記録なしで練習できます。
- ホームにはランキング上位10人を表示し、「ランキング」を押すと全員分を見られます。ホームへ戻るたびに再取得します。
- PIN・認証トークン・サーバー資格情報を公開ファイルやブラウザ保存領域へ保存しません。

公開先： https://kgs-target.vercel.app/

`npm ci` → `npm run build`。ローカルサーバーは`npm start`、単体検証は`npm test`です。共有機能の環境変数は[.env.example](.env.example)を非公開で設定してください。

教材の出典は[docs/materials.md](docs/materials.md)、APIは[docs/api.md](docs/api.md)、運用と無料枠は[docs/OPERATIONS.md](docs/OPERATIONS.md)、実測結果は[docs/VERIFICATION.md](docs/VERIFICATION.md)を参照してください。
