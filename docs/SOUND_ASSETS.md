# 効果音

2026-11-06に提供されたZIP内のShort版を、そのまま配信しています。音量加工・再エンコード・切り取りは行っていません。MP3のID3情報に記載された制作者はOtoLogicです。

| 用途 | 配信ファイル | 提供ZIP内のファイル | サイズ | MP3の長さ |
| --- | --- | --- | ---: | ---: |
| 正解 | `public/audio/correct.mp3` | `Quiz-Ding_Dong03/Quiz-Ding_Dong03-1(Short).mp3` | 21,585 bytes | 2.481633秒 |
| 不正解 | `public/audio/wrong.mp3` | `Quiz-Buzzer05/Quiz-Buzzer05-2(Short).mp3` | 12,198 bytes | 1.802449秒 |

SHA-256:

```text
correct.mp3  9a36c84f1810ab755ff2e5814da880466c923ba04f660c971f1f228464f04aa3
wrong.mp3    62459b81bdd8763eb808d9a63251f2d9e1f50f28ead614d43568368dea3d5f51
```

正解元ZIPは`1-Quiz-Ding_Dong03-mp3.zip`、不正解元ZIPは`2-Quiz-Buzzer05-mp3.zip`です。旧自作WAVと生成スクリプトは削除しました。

効果音：OtoLogic（https://otologic.jp/）、[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。[公式利用規約](https://otologic.jp/free/license)でクレジットを表示した無料利用を確認し、アプリの既存の出典画面にも表示しています。

既存の1秒後の自動進行・途中タップは維持しています。次問・画面移動・音なしへの変更では再生を停止します。正解音の末尾の余韻は1秒より長いものの、最初の1秒に音声エネルギーの97.28%があり、不正解音は約0.3秒で鳴り終わります。音ありへの変更時の試聴では元ファイルの最後まで再生します。

音あり／音なしはこの端末の設定として保存します。音源は同一オリジン配信で、外部音源への実行時接続やCSP変更、依存追加はありません。
