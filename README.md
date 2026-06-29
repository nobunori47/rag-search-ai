# rag-search-ai

## TODO
- 同一source_fileの再取り込み時に重複しないよう改善する
  - 候補1: source_fileで既存データを削除してからINSERT
  - 候補2: file_hashを持って差分更新
  - 候補3: UPSERT対応
  ※ 現状はMVPのため未実装。再実行時はSupabase側でdocumentsテーブルを手動クリアすること。
