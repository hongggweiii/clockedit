import { describe, expect, it } from "vitest";
import {
  buildCommitRequest,
  buildCreateTasksRequest,
  buildDoneRequest,
  buildEnvelope,
  buildFetchRequest,
  buildListFilesRequest,
} from "./request-builders.js";

describe("router request builders", () => {
  it("derives request kinds from the router schemas", () => {
    expect(buildListFilesRequest()).toEqual({ kind: "list_files" });
    expect(buildFetchRequest(["src/App.tsx"])).toEqual({
      kind: "fetch",
      paths: ["src/App.tsx"],
    });
    expect(buildCommitRequest(
      [{ path: "src/App.tsx", content: "updated", based_on: 3 }],
      [{ path: "contracts/order-api.json", version: 2 }],
    )).toEqual({
      kind: "commit",
      writes: [{ path: "src/App.tsx", content: "updated", based_on: 3 }],
      reads: [{ path: "contracts/order-api.json", version: 2 }],
    });
    expect(buildDoneRequest()).toEqual({ kind: "done" });
  });

  it("validates task requests with the router schema", () => {
    const tasks = [{
      id: "backend-contract",
      detail: "Update the API contract",
      owner: "backend",
      depends_on: [],
      writes: ["contracts/order-api.json"],
    }];
    expect(buildCreateTasksRequest(tasks)).toEqual({
      kind: "create_tasks",
      tasks,
    });
    expect(() => buildCreateTasksRequest([
      // @ts-expect-error owner is intentionally missing for the validation check.
      { id: "backend-contract", detail: "Update the API contract", depends_on: [], writes: [] },
    ])).toThrow();
  });

  it("validates the complete envelope with the router schema", () => {
    const body = buildDoneRequest();
    expect(buildEnvelope(
      "f047eef4-9583-43bb-85ee-5fc5f80e38f4",
      "frontend",
      "frontend-button",
      body,
    )).toEqual({
      msg_id: "f047eef4-9583-43bb-85ee-5fc5f80e38f4",
      agent: "frontend",
      task_id: "frontend-button",
      body,
    });
    expect(() => buildEnvelope(
      "f047eef4-9583-43bb-85ee-5fc5f80e38f4",
      "frontend",
      null,
      body,
    )).toThrow();
  });
});
