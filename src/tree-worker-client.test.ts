import { describe, expect, test } from "vitest";

import { buildTreeModel } from "./tree-model";
import {
  createBestAvailableTreeSearchIndex,
  createTreeWorkerSearchIndex,
} from "./tree-worker-client";

type FakeWorker = {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: {
    type: string;
    requestId?: number;
    query?: string;
    regex?: boolean;
  }): void;
  terminate(): void;
};

describe("tree worker search index", () => {
  test("worker-backed search returns ranked matches", async () => {
    const model = buildTreeModel({
      alpha: { target: "match" },
      beta: { target: "other" },
    });

    const messages: unknown[] = [];
    const worker: FakeWorker = {
      onmessage: null,
      onerror: null,
      postMessage(message: {
        type: string;
        requestId?: number;
        query?: string;
        regex?: boolean;
      }) {
        messages.push(message);
        if (message.type === "search") {
          this.onmessage?.({
            data: {
              type: "search-result",
              requestId: message.requestId!,
              matches: [model.pathToId.get("data.alpha.target")!],
            },
          } as MessageEvent);
        }
      },
      terminate() {},
    };

    const searchIndex = createTreeWorkerSearchIndex(model, () => worker);
    const matches = await searchIndex.search("match");

    expect(matches).toEqual([model.pathToId.get("data.alpha.target")]);
    expect(messages[0]).toMatchObject({ type: "init" });
    expect(messages[1]).toMatchObject({ type: "search", query: "match", regex: false });
  });

  test("forwards the regex flag to the worker", async () => {
    const model = buildTreeModel({ alpha: { target: "match" } });

    const messages: Array<{ type: string; regex?: boolean }> = [];
    const worker: FakeWorker = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        messages.push(message);
        if (message.type === "search") {
          this.onmessage?.({
            data: { type: "search-result", requestId: message.requestId!, matches: [] },
          } as MessageEvent);
        }
      },
      terminate() {},
    };

    const searchIndex = createTreeWorkerSearchIndex(model, () => worker);
    await searchIndex.search("ma.ch", { regex: true });

    expect(messages[1]).toMatchObject({ type: "search", query: "ma.ch", regex: true });
  });

  test("sync fallback honors the regex flag", async () => {
    const model = buildTreeModel({ alpha: { target: "match" } });

    const searchIndex = createBestAvailableTreeSearchIndex(model, () => {
      throw new Error("worker blocked");
    });

    // Regex matches the value; substring "ma.ch" would not.
    await expect(searchIndex.search("ma.ch", { regex: true })).resolves.toEqual([
      model.pathToId.get("data.alpha.target"),
    ]);
    await expect(searchIndex.search("ma.ch")).resolves.toEqual([]);
  });

  test("falls back to local search when worker creation fails", async () => {
    const model = buildTreeModel({
      alpha: { target: "match" },
      beta: { target: "other" },
    });

    const searchIndex = createBestAvailableTreeSearchIndex(model, () => {
      throw new Error("worker blocked");
    });

    await expect(searchIndex.search("match")).resolves.toEqual([
      model.pathToId.get("data.alpha.target"),
    ]);
  });

  test("does not construct the worker until search is used", () => {
    const model = buildTreeModel({
      alpha: { target: "match" },
    });
    let createWorkerCalls = 0;

    createBestAvailableTreeSearchIndex(model, () => {
      createWorkerCalls += 1;
      throw new Error("worker blocked");
    });

    expect(createWorkerCalls).toBe(0);
  });
});
