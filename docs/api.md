# Targetの共有API

TargetのVercel APIだけが専用のSupabase RPCとKGS連携用秘密を使用します。ブラウザへ渡す本人情報はユーザー名だけです。番号とPINはログイン時だけKGSへHTTPSで送り、TargetのDB・ブラウザ保存領域・ログには保存しません。

## 公開HTTP契約

すべてJSON。レスポンスは`private, no-store`、POSTは同一オリジンとJSONのContent-Typeを必須とし、本文上限は8KiBです。エラーはHTTP状態に合わせた`{error:{code,message,retryAfter?}}`。共有環境やKGS連携が未設定・停止中の場合は503等で明示し、ローカル保存成功へ切り替えません。

| API | 内容 |
| --- | --- |
| `GET /api/session` | `{member,correctCount,totalPoints,bonus,balance,totalIncome,spent,price,ownedStickers}`。未ログインの`member`はnullで金額・件数は0です。期限切れはCookieを解除してゲスト状態を返します。連携自体の障害は503です。 |
| `POST /api/login` | `{attendanceNumber,accountPin}`。KGSにある1〜40番と運用者が作成した99番のみ。新規登録や名前変更は行いません。 |
| `POST /api/logout` | 空オブジェクト。KGSのTarget専用セッションを失効し、Target Cookieを解除します。 |
| `GET /api/ranking` | `{ranking:[{rank,name,correctCount,totalPoints}],updatedAt}`。解答経験のある参加者だけ。番号・メンバーID・アイコン・クラス情報を含みません。 |
| `GET /api/mastery?book=target1900` | 本人の`{book,sections:[{section,from,to,total,mastered,percent,reviewCount}],reviewNumbers}`。教材はtarget1900またはtarget1000を1つ指定します。認証必須。各Sectionは100項目を分母とし、割合は整数へ切り捨てます。未出題は定着数に含めません。 |
| `POST /api/quiz/start` | `{book,direction,count,from,to,requestId}`。教材は`target1900`または`target1000`、方向は`english`（日本語→英語）か`japanese`（英語→日本語）、画面の出題数は10・50・100（旧APIの20も受理）。範囲内の件数が少ないときはその件数で出題します。 |
| `POST /api/quiz/review/start` | 通常の開始と同じ6項目。本人の間違えた単語のうち、まだ2回連続正解していない項目だけを選択範囲から出題します。件数が少なければその件数、0件なら409 `REVIEW_EMPTY`です。認証必須。 |
| `POST /api/quiz/answer` | `{quizId,questionId,choiceId,requestId}`。表示中の問題だけを採点。結果と次の問題を返します。 |

開始結果は`{quizId,total,answeredCount,correctCount,quizPoints,question,bonus}`。問題は`{id,prompt,number,choices:[{id,text}]}`で、未解答の正解キーを含みません。解答結果は`{correct,correctChoiceId,correctText,answeredCount,correctCount,total,finished,nextQuestion,awardPoints,quizPoints,totalPoints,bonus}`です。リクエストIDはUUIDを使います。HTTPの`X-Target-Now`・`X-Target-Processing-Ms`は、再送レスポンスにも新しい時刻・サーバー処理時間を付けます。

ゲストの暗記・練習テストは明示的な練習モードです。共有ランキングへ記録できるのはKGS連携の認証後にサーバーで採点した解答だけです。公開教材を見ながら解答することを完全に防ぐ試験システムとは扱いません。

## 認証と失効

KGS専用の`/api/integrations/target/login`・`verify`・`logout`を、新しい連携用Bearer秘密で呼びます。クラス全体のCookieやKGSのDB・管理者・セッション秘密はTargetへコピーしません。KGSが発行するTarget専用の推測困難なトークンを、`Secure; HttpOnly; SameSite=Strict; Path=/`の`__Host-target_session` Cookieに保存します。JavaScriptのJSONやlocalStorageへは返しません。

セッション取得と各テスト開始・解答のたびにKGSへ再照合し、停止・PIN変更・共通コード変更・期限切れを反映します。失効後は新しい採点を認めません。KGSのクラス用セッションとは独立してログアウトします。表示名は最後の本人照合時に更新し、過去の累積正解数を維持します。

Targetにも署名付き端末識別Cookieと永続的なログイン制限があり、KGS側の番号別制限と合わせて使います。生のIPアドレスは保存しません。個人PIN・トークン・SQL・秘密値をエラーログへ出さず、予期しない失敗のログも固定の識別子だけです。

## DBと採点

専用の`target_private`スキーマにプロフィール・問題・解答・試行制限・容量集計を保存します。RLSを有効にし、ブラウザ用の`anon`・`authenticated`から表へ直接アクセスできません。公開RPCは、別途生成した十分強い秘密のSHA-256を非公開表で照合してから処理します。秘密の初期値や公開bootstrapはありません。SQLと設定手順は[rpc.md](rpc.md)を参照してください。

正解判定と累積得点の加算はDB内の1トランザクションです。クライアントが送る得点・ユーザー名・所有者IDを採用しません。同じ開始操作、同じ解答の再送、連打、独立端末での同時送信による二重加算を防ぎ、違う内容で同じ操作IDを使うと409を返します。

同じトランザクションで本人・教材・単語番号ごとの連続正解数（最大2）を更新します。間違えると0へ戻り、解き直し対象となります。方向やテストを変えても、次の2回連続正解で定着し解き直し対象から外れます。未回答や1回だけ正解した単語は定着していませんが、間違えたことがなければ解き直し対象には含めません。古い回答詳細を削除しても、導入後の定着記録は保持します。既に削除済みの過去詳細は復元しません。

問題は取得済み2900件から生成し、同じ日本語訳や同じ英語表記の項目を誤答候補から除外します。英語／日本語はUnicode正規化と空白の統一を行って重複判定します。4つの選択肢は表示テキストとIDがそれぞれ重複しないようにします。

登録人数500人、問題・解答件数と論理保存容量、開始・解答回数に上限を設けます。期限の切れた問題の詳細は一定期間後に少しずつ削除し、累積正解数は保持します。上限では429／507で停止し、課金や無制限保存に切り替えません。

## ローカル検証

`NODE_ENV=test`で、`TARGET_DATABASE_URL`がループバックの`target_*_test` DBを指す場合だけ、同じRPCを`pg`から直接呼べます。通常環境では必ず専用SupabaseのHTTPS Data APIを使用します。ローカルのHTTP検証だけCookieのSecureと`__Host-`名を外し、クラウドでは必ず有効にします。テスト用DBやHTTPサーバーをクラウド共有の証拠として扱いません。
