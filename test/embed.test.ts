// EmbeddingService unit tests (no network).  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { EmbeddingService } from "../src/embed/embedding.service";

test("toVectorLiteral: pgvector literal form", () => {
  assert.equal(EmbeddingService.toVectorLiteral([1, 0.5, -2]), "[1,0.5,-2]");
});

test("disabled (lexical floor) when HARA_EMBED_* is unconfigured", () => {
  const prevBase = process.env.HARA_EMBED_BASE_URL;
  const prevModel = process.env.HARA_EMBED_MODEL;
  try {
    delete process.env.HARA_EMBED_BASE_URL;
    delete process.env.HARA_EMBED_MODEL;
    assert.equal(new EmbeddingService().enabled(), false);
  } finally {
    if (prevBase !== undefined) process.env.HARA_EMBED_BASE_URL = prevBase;
    if (prevModel !== undefined) process.env.HARA_EMBED_MODEL = prevModel;
  }
});
