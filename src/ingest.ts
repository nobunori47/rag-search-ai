import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { encoding_for_model } from "tiktoken";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DATA_DIR = path.join(__dirname, "../data");
const CHUNK_MIN_TOKENS = 500;
const CHUNK_MAX_TOKENS = 1000;
const EMBEDDING_MODEL = "text-embedding-3-small";

function chunkText(text: string): string[] {
  const enc = encoding_for_model("text-embedding-3-small");
  const tokens = enc.encode(text);
  const chunks: string[] = [];

  let start = 0;
  while (start < tokens.length) {
    const end = Math.min(start + CHUNK_MAX_TOKENS, tokens.length);
    const chunkTokens = tokens.slice(start, end);
    const chunkText = new TextDecoder().decode(enc.decode(chunkTokens));
    chunks.push(chunkText.trim());
    start = end;
  }

  enc.free();

  // 末尾の短いチャンクを直前のチャンクに結合する（CHUNK_MIN_TOKENS未満の場合）
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    const lastTokenCount = last.split(/\s+/).length; // 簡易トークン推定
    const enc2 = encoding_for_model("text-embedding-3-small");
    const lastTokens = enc2.encode(last).length;
    enc2.free();

    if (lastTokens < CHUNK_MIN_TOKENS) {
      const merged = chunks[chunks.length - 2] + "\n" + last;
      chunks.splice(chunks.length - 2, 2, merged);
    }
  }

  return chunks.filter((c) => c.length > 0);
}

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

async function ingestFile(filePath: string): Promise<void> {
  const fileName = path.basename(filePath);
  const rawText = fs.readFileSync(filePath, "utf-8");

  const chunks = chunkText(rawText);
  console.log(`  ${fileName}: ${chunks.length}チャンクに分割`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  チャンク ${i + 1}/${chunks.length} のEmbeddingを生成中...`);

    const embedding = await generateEmbedding(chunk);

    const { error } = await supabase.from("documents").insert({
      content: chunk,
      embedding,
      source_file: fileName,
      page_number: null,
      metadata: { chunk_index: i, total_chunks: chunks.length },
    });

    if (error) {
      console.error(`  エラー (${fileName} チャンク${i + 1}):`, error.message);
    } else {
      console.log(`  チャンク ${i + 1} を保存しました`);
    }
  }
}

async function main(): Promise<void> {
  const txtFiles = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => path.join(DATA_DIR, f));

  if (txtFiles.length === 0) {
    console.log("dataフォルダにtxtファイルが見つかりません");
    return;
  }

  console.log(`${txtFiles.length}件のtxtファイルを処理します\n`);

  for (const filePath of txtFiles) {
    console.log(`処理中: ${path.basename(filePath)}`);
    await ingestFile(filePath);
    console.log();
  }

  console.log("取り込み完了");
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
