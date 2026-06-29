import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { encoding_for_model } from "tiktoken";
import { PDFParse } from "pdf-parse";

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

function tokenCount(text: string): number {
  const enc = encoding_for_model("text-embedding-3-small");
  const n = enc.encode(text).length;
  enc.free();
  return n;
}

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
    if (tokenCount(last) < CHUNK_MIN_TOKENS) {
      const merged = chunks[chunks.length - 2] + "\n" + last;
      chunks.splice(chunks.length - 2, 2, merged);
    }
  }

  return chunks.filter((c) => c.length > 0);
}

// 見出しパターンでテキストをセクション分割する共通ロジック
function splitByHeadingPattern(text: string, re: RegExp): string[] {
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return [text];

  const sections: string[] = [];

  if (matches[0].index! > 0) {
    const preamble = text.slice(0, matches[0].index).trim();
    if (preamble) sections.push(preamble);
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    const section = text.slice(start, end).trim();
    if (section) sections.push(section);
  }

  return sections;
}

// 「第◯章」または「1. 」形式の見出しで本文をセクション分割する
function splitByChapters(text: string): string[] {
  // 「第◯章」を優先
  const chapterRe = /第[0-9０-９一二三四五六七八九十百]+章/g;
  if (chapterRe.test(text)) {
    return splitByHeadingPattern(text, /第[0-9０-９一二三四五六七八九十百]+章/g);
  }

  // 「1. 見出し」形式（句点・複数スペースの後に来る1〜9の番号見出し）
  const numRe = /(?<=。 |。　|\s{2,})([1-9]\. )(?=[^\d])/g;
  if (numRe.test(text)) {
    return splitByHeadingPattern(text, /(?<=。 |。　|\s{2,})([1-9]\. )(?=[^\d])/g);
  }

  return [text];
}

// 段落（句点 or 改行）単位でさらに分割する（大きい章向け）
function splitByParagraph(text: string): string[] {
  const paras = text.split(/(?<=。)\s*|\n+/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let buffer = "";
  let bufferTokens = 0;

  for (const para of paras) {
    const pt = tokenCount(para);
    if (bufferTokens > 0 && bufferTokens + pt > CHUNK_MAX_TOKENS) {
      chunks.push(buffer.trim());
      buffer = para;
      bufferTokens = pt;
    } else {
      buffer += (buffer ? " " : "") + para;
      bufferTokens += pt;
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

// PDF用: 章単位チャンキング
// - 章ごとに1チャンク（意味的まとまりを優先）
// - 前文は第1章に結合
// - 見出しのみの空章（≤20トークン）は直前チャンクに結合
// - 1000トークン超の章は段落分割
const CHAPTER_HEADING_ONLY_TOKENS = 20;

function chunkPdfText(text: string): string[] {
  const sections = splitByChapters(text);

  // 章見出しが見つからない場合は既存ロジックにフォールバック
  if (sections.length <= 1) return chunkText(text);

  const result: string[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const st = tokenCount(section);

    if (st > CHUNK_MAX_TOKENS) {
      // 大きい章: 段落分割
      result.push(...splitByParagraph(section));
    } else if (st <= CHAPTER_HEADING_ONLY_TOKENS) {
      // 見出しのみの空章: 直前チャンクに結合（なければ次のチャンクと結合するため保留）
      if (result.length > 0) {
        result[result.length - 1] += "\n" + section;
      } else {
        // 先頭に空章が来た場合は次のセクションと結合するためバッファ
        sections[i + 1] = section + "\n" + (sections[i + 1] ?? "");
      }
    } else if (i === 0) {
      // 前文（章見出しなし）は次の章と結合
      sections[1] = section + "\n" + (sections[1] ?? "");
    } else {
      result.push(section);
    }
  }

  return result.filter((c) => c.length > 0);
}

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

// --- TXT ---

async function ingestTxtFile(filePath: string): Promise<void> {
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

// --- PDF ---

interface PdfPage {
  pageNumber: number;
  text: string;
}

async function extractPdfPages(filePath: string): Promise<PdfPage[]> {
  const parser = new PDFParse({ url: filePath });
  try {
    const result = await parser.getText({ parsePageInfo: true } as any);
    return (result.pages as any[]).map((p: any) => ({
      pageNumber: p.num as number,
      // NFKC正規化: PDF由来の互換漢字(⼊⽇⽉等)を標準Unicodeに変換
      text: (p.text as string).normalize("NFKC").replace(/\s+/g, " ").trim(),
    }));
  } finally {
    await (parser as any).destroy?.();
  }
}

async function ingestPdfFile(filePath: string): Promise<void> {
  const fileName = path.basename(filePath);
  console.log(`  ${fileName}: ページを抽出中...`);

  const pages = await extractPdfPages(filePath);
  const nonEmptyPages = pages.filter((p) => p.text.trim().length > 0);
  console.log(
    `  ${pages.length}ページ中 ${nonEmptyPages.length}ページにテキストあり`
  );

  let totalChunks = 0;

  for (const { pageNumber, text } of nonEmptyPages) {
    const chunks = chunkPdfText(text);
    totalChunks += chunks.length;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(
        `  ページ ${pageNumber} チャンク ${i + 1}/${chunks.length} のEmbeddingを生成中...`
      );

      const embedding = await generateEmbedding(chunk);

      const { error } = await supabase.from("documents").insert({
        content: chunk,
        embedding,
        source_file: fileName,
        page_number: pageNumber,
        metadata: { chunk_index: i, total_chunks: chunks.length },
      });

      if (error) {
        console.error(
          `  エラー (${fileName} ページ${pageNumber} チャンク${i + 1}):`,
          error.message
        );
      } else {
        console.log(`  ページ ${pageNumber} チャンク ${i + 1} を保存しました`);
      }
    }
  }

  console.log(`  合計 ${totalChunks} チャンクを保存しました`);
}

// --- メイン ---

async function main(): Promise<void> {
  // 引数でファイル名を指定した場合はそのファイルのみ処理
  const targetFile = process.argv[2];

  const allFiles = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".txt") || f.endsWith(".pdf"))
    .filter((f) => !targetFile || f === targetFile)
    .map((f) => path.join(DATA_DIR, f));

  if (allFiles.length === 0) {
    console.log(
      targetFile
        ? `ファイルが見つかりません: ${targetFile}`
        : "dataフォルダにtxt/pdfファイルが見つかりません"
    );
    return;
  }

  console.log(`${allFiles.length}件のファイルを処理します\n`);

  for (const filePath of allFiles) {
    const fileName = path.basename(filePath);
    console.log(`処理中: ${fileName}`);

    if (fileName.endsWith(".pdf")) {
      await ingestPdfFile(filePath);
    } else {
      await ingestTxtFile(filePath);
    }

    console.log();
  }

  console.log("取り込み完了");
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
